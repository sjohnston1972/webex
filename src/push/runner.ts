import type { Env } from "../env";
import { nowIso, uuid } from "../lib/util";
import { pickCallingLicense, WebexClient, WebexError } from "../webex/client";

// Push order: people first; hunt groups / pickup groups only after every
// person job in the batch has finished (members must exist). Rollback runs
// in reverse: groups first, then people, deleting only what we created.

type JobRow = {
  id: string;
  batch_id: string;
  batch_item_id: string;
  action: string;
  attempts: number;
  status: string;
};

type ItemRow = {
  id: string;
  batch_id: string;
  mapping_id: string;
  push_status: string;
  webex_resource_id: string | null;
  rollback_info: string | null;
  project_id: string;
  target_type: string;
  target_payload: string;
};

const GROUP_TYPES = ["hunt_group", "call_pickup", "translation_pattern", "route_pattern", "call_park"];

export async function startPush(env: Env, projectId: string, batchId: string): Promise<{ queued: number }> {
  await env.DB.prepare("UPDATE batches SET status = 'pushing' WHERE id = ?").bind(batchId).run();

  // Supersede any dangling jobs from a previous run so late queue
  // redeliveries become no-ops; we create fresh jobs below.
  await env.DB.prepare(
    "UPDATE push_jobs SET status = 'superseded' WHERE batch_id = ? AND action = 'push' AND status IN ('pending','waiting','running')",
  )
    .bind(batchId)
    .run();

  const items = (
    await env.DB.prepare(
      `SELECT bi.id, m.target_type FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id
       WHERE bi.batch_id = ?
         AND (
           bi.push_status IN ('pending','failed')
           OR (bi.push_status IN ('queued','pushing')
               AND COALESCE(replace(substr(bi.updated_at,1,19),'T',' '), '') < datetime('now','-2 minutes'))
         )`,
    )
      .bind(batchId)
      .all<{ id: string; target_type: string }>()
  ).results;

  // Create job rows for everything; queue people + workspaces now (groups wait for people).
  const people = items.filter((i) => i.target_type === "person" || i.target_type === "workspace");
  const groups = items.filter((i) => GROUP_TYPES.includes(i.target_type));
  let queued = 0;

  for (const item of [...people, ...groups]) {
    const jobId = uuid();
    const firstWave = item.target_type === "person" || item.target_type === "workspace";
    await env.DB.prepare(
      "INSERT INTO push_jobs (id, batch_id, batch_item_id, action, status) VALUES (?, ?, ?, 'push', ?)",
    )
      .bind(jobId, batchId, item.id, firstWave ? "pending" : "waiting")
      .run();
    await env.DB.prepare("UPDATE batch_items SET push_status = 'queued' WHERE id = ?").bind(item.id).run();
    if (firstWave) {
      await env.PUSH_QUEUE.send({ jobId });
      queued++;
    }
  }
  // No people in the batch? Release the group jobs immediately.
  if (people.length === 0) queued += await releaseWaitingJobs(env, batchId);
  return { queued };
}

export async function startRollback(env: Env, projectId: string, batchId: string): Promise<{ queued: number }> {
  await env.DB.prepare("UPDATE batches SET status = 'rolling_back' WHERE id = ?").bind(batchId).run();
  const items = (
    await env.DB.prepare(
      `SELECT bi.id, m.target_type FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id
       WHERE bi.batch_id = ? AND bi.push_status = 'done' AND bi.rollback_info IS NOT NULL`,
    )
      .bind(batchId)
      .all<{ id: string; target_type: string }>()
  ).results;

  // Groups first, then people/workspaces (reverse of push order).
  const ordered = [
    ...items.filter((i) => GROUP_TYPES.includes(i.target_type)),
    ...items.filter((i) => i.target_type === "person" || i.target_type === "workspace"),
  ];
  let queued = 0;
  for (const item of ordered) {
    const jobId = uuid();
    await env.DB.prepare(
      "INSERT INTO push_jobs (id, batch_id, batch_item_id, action, status) VALUES (?, ?, ?, 'rollback', 'pending')",
    )
      .bind(jobId, batchId, item.id)
      .run();
    await env.PUSH_QUEUE.send({ jobId });
    queued++;
  }
  return { queued };
}

async function releaseWaitingJobs(env: Env, batchId: string): Promise<number> {
  const waiting = (
    await env.DB.prepare("SELECT id FROM push_jobs WHERE batch_id = ? AND status = 'waiting'").bind(batchId).all<{ id: string }>()
  ).results;
  for (const job of waiting) {
    await env.DB.prepare("UPDATE push_jobs SET status = 'pending' WHERE id = ?").bind(job.id).run();
    await env.PUSH_QUEUE.send({ jobId: job.id });
  }
  return waiting.length;
}

async function loadItem(env: Env, batchItemId: string): Promise<ItemRow | null> {
  return env.DB.prepare(
    `SELECT bi.id, bi.batch_id, bi.mapping_id, bi.push_status, bi.webex_resource_id, bi.rollback_info,
            b.project_id, m.target_type, m.target_payload
     FROM batch_items bi
     JOIN batches b ON b.id = bi.batch_id
     JOIN mappings m ON m.id = bi.mapping_id
     WHERE bi.id = ?`,
  )
    .bind(batchItemId)
    .first<ItemRow>();
}

export async function processJob(env: Env, jobId: string): Promise<void> {
  const job = await env.DB.prepare("SELECT * FROM push_jobs WHERE id = ?").bind(jobId).first<JobRow>();
  if (!job || job.status === "done" || job.status === "superseded") return;
  await env.DB.prepare("UPDATE push_jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").bind(jobId).run();

  const item = await loadItem(env, job.batch_item_id);
  if (!item) {
    await env.DB.prepare("UPDATE push_jobs SET status = 'failed' WHERE id = ?").bind(jobId).run();
    return;
  }

  try {
    if (job.action === "push") await pushItem(env, item);
    else await rollbackItem(env, item);
    await env.DB.prepare("UPDATE push_jobs SET status = 'done' WHERE id = ?").bind(jobId).run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const attempts = job.attempts + 1;
    // 4xx (except 429) from Webex won't heal on retry — fail fast.
    const status = (e as { status?: number }).status;
    const permanent = typeof status === "number" && status >= 400 && status < 500 && status !== 429;
    const final = permanent || attempts >= 3;
    await env.DB.prepare("UPDATE push_jobs SET status = ? WHERE id = ?")
      .bind(final ? "failed" : "pending", jobId)
      .run();
    await env.DB.prepare("UPDATE batch_items SET push_status = ?, error_text = ?, updated_at = ? WHERE id = ?")
      .bind(final ? "failed" : "queued", message, nowIso(), item.id)
      .run();
    if (!final) throw e; // let the queue retry
  } finally {
    await finalizeBatchIfComplete(env, item.batch_id);
  }

  // If this was the last person/workspace push in the batch, release the waiting group jobs.
  if (job.action === "push" && (item.target_type === "person" || item.target_type === "workspace")) {
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_jobs pj
       JOIN batch_items bi ON bi.id = pj.batch_item_id
       JOIN mappings m ON m.id = bi.mapping_id
       WHERE pj.batch_id = ? AND pj.action = 'push' AND m.target_type IN ('person','workspace') AND pj.status IN ('pending','running')`,
    )
      .bind(item.batch_id)
      .first<{ n: number }>();
    if ((remaining?.n ?? 0) === 0) await releaseWaitingJobs(env, item.batch_id);
  }
}

async function pushItem(env: Env, item: ItemRow): Promise<void> {
  if (item.webex_resource_id) {
    await env.DB.prepare("UPDATE batch_items SET push_status = 'done', updated_at = ? WHERE id = ?").bind(nowIso(), item.id).run();
    return; // idempotent re-run
  }
  await env.DB.prepare("UPDATE batch_items SET push_status = 'pushing', updated_at = ? WHERE id = ?").bind(nowIso(), item.id).run();

  const client = await WebexClient.forProject(env, item.project_id);
  const payload = JSON.parse(item.target_payload);

  const resolveLocation = async (): Promise<any> => {
    const locations = await client.listLocations();
    const loc = locations.find((l: any) => String(l.name).toLowerCase() === String(payload.locationName ?? "").toLowerCase());
    // 422: permanent — retrying cannot conjure a missing location.
    if (!loc) throw new WebexError(`Location "${payload.locationName}" not found in Control Hub`, 422);
    return loc;
  };

  if (item.target_type === "person") {
    const existing = payload.email ? await client.findPersonByEmail(payload.email) : null;
    if (existing) {
      await recordSuccess(env, item.id, existing.id, { created: false, note: "already existed" });
      if (payload.voicemail) {
        await appendError(env, item.id, "Person already existed — applied voicemail settings to the existing person");
        await applyVoicemail(env, client, item.id, existing.id, payload);
      }
      return;
    }
    const body: Record<string, unknown> = {
      emails: [payload.email],
      firstName: payload.firstName ?? undefined,
      lastName: payload.lastName ?? undefined,
      displayName: payload.displayName ?? undefined,
    };
    // Webex rejects a calling user with no number — create numberless people
    // as plain persons (no calling licence) instead of failing.
    const numberless = !payload.extension && !payload.phoneNumber;
    if (!numberless) {
      const loc = await resolveLocation();
      const licenses = await client.listLicenses();
      const calling = pickCallingLicense(licenses);
      // 422: permanent — seats don't free themselves mid-run.
      if (!calling) throw new WebexError("No Webex Calling licence with available units — org seat capacity exhausted", 422);
      body.locationId = loc.id;
      body.licenses = [calling.id];
      if (payload.extension) body.extension = payload.extension;
      if (payload.phoneNumber) body.phoneNumbers = [{ type: "work", value: payload.phoneNumber }];
    }

    const person = (await client.createPerson(body)) as any;
    await recordSuccess(env, item.id, person.id, { created: true, type: "person" });
    if (numberless) {
      await appendError(env, item.id, "Created without Webex Calling (no number available) — assign a licence and number manually if needed");
    } else {
      await applyVoicemail(env, client, item.id, person.id, payload);
    }
  } else if (item.target_type === "workspace") {
    const loc = await resolveLocation();
    const calling: Record<string, unknown> = { locationId: loc.id };
    if (payload.extension) calling.extension = payload.extension;
    if (payload.phoneNumber) calling.phoneNumber = payload.phoneNumber;
    const body = {
      displayName: payload.name,
      locationId: loc.id,
      type: "other",
      calling: { type: "webexCalling", webexCalling: calling },
      notes: payload.deviceName ? `Migrated from CUCM device ${payload.deviceName}` : undefined,
    };
    const ws = (await client.createWorkspace(body)) as any;
    await recordSuccess(env, item.id, ws.id, { created: true, type: "workspace" });
  } else if (item.target_type === "hunt_group") {
    const loc = await resolveLocation();
    const agents: { id: string }[] = [];
    const missing: string[] = [];
    for (const email of payload.agentEmails ?? []) {
      const person = await client.findPersonByEmail(email);
      if (person) agents.push({ id: person.id });
      else missing.push(email);
    }
    const body = {
      name: payload.name,
      extension: payload.extension ?? undefined,
      callPolicies: { policy: payload.policy ?? "REGULAR" },
      agents,
      enabled: true,
    };
    const result = (await client.createHuntGroup(loc.id, body)) as any;
    await recordSuccess(env, item.id, result.id, { created: true, type: "hunt_group", locationId: loc.id });
    if (missing.length > 0) await appendError(env, item.id, `Created without unresolvable members: ${missing.join(", ")}`);
  } else if (item.target_type === "call_pickup") {
    const loc = await resolveLocation();
    let agents: string[] = [];
    const missing: string[] = [];
    for (const email of payload.agentEmails ?? []) {
      const person = await client.findPersonByEmail(email);
      if (person) agents.push(person.id);
      else missing.push(email);
    }
    // Webex rejects members without calling ("Error 4470: user not available
    // for assignment") — drop the offender and retry rather than fail the group.
    const dropped: string[] = [];
    let result: any = null;
    for (let attempt = 0; attempt <= (payload.agentEmails?.length ?? 0); attempt++) {
      try {
        result = (await client.createCallPickup(loc.id, { name: payload.name, agents })) as any;
        break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const match = /not available for assignment:\s*([0-9a-f-]{36})/i.exec(message);
        if (!match) throw e;
        const uuid = match[1];
        const offender = agents.find((id) => {
          try {
            return atob(id).includes(uuid);
          } catch {
            return false;
          }
        });
        if (!offender) throw e;
        agents = agents.filter((id) => id !== offender);
        dropped.push(uuid);
      }
    }
    if (!result) throw new Error("Call pickup creation failed after removing unassignable members");
    await recordSuccess(env, item.id, result.id, { created: true, type: "call_pickup", locationId: loc.id });
    if (missing.length > 0) await appendError(env, item.id, `Created without unresolvable members: ${missing.join(", ")}`);
    if (dropped.length > 0) await appendError(env, item.id, `Created without ${dropped.length} member(s) not assignable to pickup (no calling licence): ${dropped.join(", ")}`);
  } else if (item.target_type === "call_park") {
    if (!payload.extension) throw new Error("Call park range/pattern cannot push — edit the mapping to a single extension first");
    const loc = await resolveLocation();
    const result = (await client.createCallParkExtension(loc.id, { name: payload.name, extension: payload.extension })) as any;
    await recordSuccess(env, item.id, result.id, { created: true, type: "call_park", locationId: loc.id });
  } else if (item.target_type === "translation_pattern") {
    if (!payload.replacementPattern) throw new Error("No replacement pattern derived — review and edit this mapping before pushing");
    // Idempotent: a pattern matching the same digits may already exist (e.g. a
    // previous attempt, or CUCM descriptions colliding on name).
    const existing = (await client.listTranslationPatterns()).find((t: any) => t.matchingPattern === payload.matchingPattern);
    if (existing) {
      await recordSuccess(env, item.id, existing.id, { created: false, type: "translation_pattern", note: "already existed" });
      return;
    }
    // CUCM descriptions are not unique — suffix with the pattern.
    const name = `${String(payload.name).replace(/[^a-zA-Z0-9_ -]/g, "_")} ${payload.matchingPattern}`.slice(0, 30).trim();
    const result = (await client.createTranslationPattern({
      name,
      matchingPattern: payload.matchingPattern,
      replacementPattern: payload.replacementPattern,
    })) as any;
    await recordSuccess(env, item.id, result.id, { created: true, type: "translation_pattern" });
  } else if (item.target_type === "route_pattern") {
    const rc = payload.routeChoice as { type?: string; id?: string; name?: string } | null;
    if (!rc?.id || !rc?.type) throw new Error("No route target selected — choose a trunk or route group on the Review page");
    // One Webex dial plan per route target; create on first use.
    const planName = `CUCM via ${rc.name ?? rc.id}`.slice(0, 40);
    const plans = await client.listDialPlans();
    let plan = plans.find((p: any) => p.name === planName);
    if (!plan) {
      plan = (await client.createDialPlan({ name: planName, routeType: rc.type, routeId: rc.id })) as any;
    }
    await client.modifyDialPlanPatterns(plan.id, [{ dialPattern: payload.dialPattern, action: "ADD" }]);
    await recordSuccess(env, item.id, plan.id, { created: true, type: "route_pattern", dialPlanId: plan.id, dialPattern: payload.dialPattern });
  } else {
    throw new Error(`Unsupported target type: ${item.target_type}`);
  }
}

/** Enable voicemail and, when a Unity greeting was matched, upload it as the no-answer greeting. */
async function applyVoicemail(env: Env, client: WebexClient, itemId: string, personId: string, payload: Record<string, any>): Promise<void> {
  if (!payload.voicemail) return;
  try {
    await client.setVoicemail(personId, true, false);
  } catch (e) {
    await appendError(env, itemId, `Enabling voicemail failed: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (!payload.greetingKey) return;
  try {
    const obj = await env.UPLOADS.get(payload.greetingKey);
    if (!obj) {
      await appendError(env, itemId, `Greeting file missing from storage (${payload.greetingKey})`);
      return;
    }
    await client.uploadVoicemailGreeting(personId, await obj.arrayBuffer(), payload.greetingKey.split("/").pop() ?? "greeting.wav");
    await client.setVoicemail(personId, true, true);
  } catch (e) {
    // Format problems (Webex wants CCITT u-law 8kHz mono WAV) surface here verbatim — flagged, never transcoded.
    await appendError(env, itemId, `Voicemail enabled, but greeting upload failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function rollbackItem(env: Env, item: ItemRow): Promise<void> {
  const info = item.rollback_info ? JSON.parse(item.rollback_info) : null;
  if (!info?.created || !item.webex_resource_id) {
    // Never touch resources this batch didn't create.
    await env.DB.prepare("UPDATE batch_items SET push_status = 'skipped', updated_at = ? WHERE id = ?").bind(nowIso(), item.id).run();
    return;
  }
  const client = await WebexClient.forProject(env, item.project_id);
  try {
    if (info.type === "person") await client.deletePerson(item.webex_resource_id);
    else if (info.type === "workspace") await client.deleteWorkspace(item.webex_resource_id);
    else if (info.type === "hunt_group") await client.deleteHuntGroup(info.locationId, item.webex_resource_id);
    else if (info.type === "call_pickup") await client.deleteCallPickup(info.locationId, item.webex_resource_id);
    else if (info.type === "call_park") await client.deleteCallParkExtension(info.locationId, item.webex_resource_id);
    else if (info.type === "translation_pattern") await client.deleteTranslationPattern(item.webex_resource_id);
    else if (info.type === "route_pattern") {
      // Remove only this pattern; the dial plan itself stays (other patterns may share it).
      await client.modifyDialPlanPatterns(info.dialPlanId, [{ dialPattern: info.dialPattern, action: "DELETE" }]);
    }
  } catch (e) {
    // 404 means it's already gone — that's a successful rollback.
    const status = (e as { status?: number }).status;
    if (status !== 404) throw e;
  }
  await env.DB.prepare(
    "UPDATE batch_items SET push_status = 'rolled_back', webex_resource_id = NULL, rollback_info = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(nowIso(), item.id)
    .run();
}

async function recordSuccess(env: Env, itemId: string, resourceId: string, rollbackInfo: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    "UPDATE batch_items SET push_status = 'done', webex_resource_id = ?, rollback_info = ?, error_text = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(resourceId, JSON.stringify(rollbackInfo), nowIso(), itemId)
    .run();
}

async function appendError(env: Env, itemId: string, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE batch_items SET error_text = COALESCE(error_text || char(10), '') || ?, updated_at = ? WHERE id = ?",
  )
    .bind(message, nowIso(), itemId)
    .run();
}

async function finalizeBatchIfComplete(env: Env, batchId: string): Promise<void> {
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM push_jobs WHERE batch_id = ? AND status IN ('pending','running','waiting')",
  )
    .bind(batchId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) > 0) return;
  const batch = await env.DB.prepare("SELECT status FROM batches WHERE id = ?").bind(batchId).first<{ status: string }>();
  if (!batch) return;
  if (batch.status === "rolling_back") {
    await env.DB.prepare("UPDATE batches SET status = 'rolled_back' WHERE id = ?").bind(batchId).run();
  } else if (batch.status === "pushing") {
    const failed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM batch_items WHERE batch_id = ? AND push_status = 'failed'",
    )
      .bind(batchId)
      .first<{ n: number }>();
    await env.DB.prepare("UPDATE batches SET status = ? WHERE id = ?")
      .bind((failed?.n ?? 0) > 0 ? "failed" : "pushed", batchId)
      .run();
  }
}
