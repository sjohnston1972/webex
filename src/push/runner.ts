import type { Env } from "../env";
import { CALL_PERMISSION_LEVELS, callPermissionsFor, type CallPermissionLevel } from "../mapping/engine";
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
  error_text: string | null;
  project_id: string;
  target_type: string;
  target_payload: string;
};

const GROUP_TYPES = ["hunt_group", "call_pickup", "translation_pattern", "route_pattern", "call_park", "auto_attendant"];

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
  if (people.length === 0) queued += await releaseWaitingJobs(env, batchId, "push");
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

  // Groups first, then people/workspaces (reverse of push order). Groups run in
  // the first wave; people wait until every group rollback has finished so we
  // never delete a member while a hunt/pickup group still references them.
  const groups = items.filter((i) => GROUP_TYPES.includes(i.target_type));
  const people = items.filter((i) => i.target_type === "person" || i.target_type === "workspace");
  let queued = 0;
  for (const item of [...groups, ...people]) {
    const jobId = uuid();
    const firstWave = GROUP_TYPES.includes(item.target_type);
    await env.DB.prepare(
      "INSERT INTO push_jobs (id, batch_id, batch_item_id, action, status) VALUES (?, ?, ?, 'rollback', ?)",
    )
      .bind(jobId, batchId, item.id, firstWave ? "pending" : "waiting")
      .run();
    if (firstWave) {
      await env.PUSH_QUEUE.send({ jobId });
      queued++;
    }
  }
  // No groups to remove first? Release the people rollbacks immediately.
  if (groups.length === 0) queued += await releaseWaitingJobs(env, batchId, "rollback");
  return { queued };
}

async function releaseWaitingJobs(env: Env, batchId: string, action: string): Promise<number> {
  const waiting = (
    await env.DB.prepare("SELECT id FROM push_jobs WHERE batch_id = ? AND action = ? AND status = 'waiting'")
      .bind(batchId, action)
      .all<{ id: string }>()
  ).results;
  let released = 0;
  for (const job of waiting) {
    // Only enqueue jobs this call actually transitions. Two finishers can race
    // into releaseWaitingJobs concurrently; the conditional UPDATE ensures each
    // waiting job is sent to the queue exactly once.
    const r = await env.DB.prepare("UPDATE push_jobs SET status = 'pending' WHERE id = ? AND status = 'waiting'").bind(job.id).run();
    if (r.meta.changes === 1) {
      await env.PUSH_QUEUE.send({ jobId: job.id });
      released++;
    }
  }
  return released;
}

async function loadItem(env: Env, batchItemId: string): Promise<ItemRow | null> {
  return env.DB.prepare(
    `SELECT bi.id, bi.batch_id, bi.mapping_id, bi.push_status, bi.webex_resource_id, bi.rollback_info, bi.error_text,
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

  // Atomic claim: only the worker that transitions this job out of
  // pending/waiting proceeds. Cloudflare Queues are at-least-once, so the same
  // jobId can be delivered concurrently; without this claim two deliveries both
  // run pushItem and double-create the Webex object. The failure path resets a
  // job to 'pending' (below), so the queue's own retries still get through.
  const claim = await env.DB.prepare(
    "UPDATE push_jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status IN ('pending','waiting')",
  )
    .bind(jobId)
    .run();
  if (claim.meta.changes !== 1) return; // a concurrent delivery already owns it

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

  // Once the first wave for this action has fully drained, release the second
  // (waiting) wave. Push runs people/workspaces then groups; rollback reverses
  // it (groups then people), so the dependency ordering holds both directions.
  const firstWave = job.action === "push" ? ["person", "workspace"] : GROUP_TYPES;
  if (firstWave.includes(item.target_type)) {
    const placeholders = firstWave.map(() => "?").join(",");
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_jobs pj
       JOIN batch_items bi ON bi.id = pj.batch_item_id
       JOIN mappings m ON m.id = bi.mapping_id
       WHERE pj.batch_id = ? AND pj.action = ? AND m.target_type IN (${placeholders}) AND pj.status IN ('pending','running')`,
    )
      .bind(item.batch_id, job.action, ...firstWave)
      .first<{ n: number }>();
    if ((remaining?.n ?? 0) === 0) await releaseWaitingJobs(env, item.batch_id, job.action);
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

  // If a prior attempt may already have created the object, an "existing"
  // object found now was almost certainly created by that attempt — attribute
  // it to this batch so rollback can remove it. Two ways a prior attempt can
  // create-then-not-record: it threw after the create (error_text set), or the
  // isolate was evicted mid-run so push_status is stuck at 'pushing' (line ~189
  // committed 'pushing' but no terminal state was ever written).
  const priorAttemptMayHaveCreated = !!item.error_text || item.push_status === "pushing";

  if (item.target_type === "person") {
    const existing = payload.email ? await client.findPersonByEmail(payload.email) : null;
    if (existing) {
      await recordSuccess(env, item.id, existing.id, {
        created: priorAttemptMayHaveCreated,
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
        type: "person",
      });
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

    let person: any;
    let fellBackNumberless = false;
    try {
      person = (await client.createPerson(body)) as any;
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 409 with a number attached usually means the extension/number is taken
      // (shared lines) — retry as a plain person. If the email itself is the
      // conflict (domain owned by another org), this fails too and we rethrow.
      if (status === 409 && !numberless) {
        try {
          person = (await client.createPerson({
            emails: [payload.email],
            firstName: payload.firstName ?? undefined,
            lastName: payload.lastName ?? undefined,
            displayName: payload.displayName ?? undefined,
          })) as any;
          fellBackNumberless = true;
        } catch {
          throw e;
        }
      } else {
        throw e;
      }
    }
    await recordSuccess(env, item.id, person.id, { created: true, type: "person" });
    if (numberless) {
      await appendError(env, item.id, "Created without Webex Calling (no number available) — assign a licence and number manually if needed");
    } else if (fellBackNumberless) {
      await appendError(env, item.id, "Number/extension already assigned in Webex (shared line) — created without a number; assign manually if needed");
    } else {
      await applyVoicemail(env, client, item.id, person.id, payload);
      // Outgoing call permission class (cumulative): internal < toll free < national < international.
      const level = (CALL_PERMISSION_LEVELS as readonly string[]).includes(payload.callPermission)
        ? (payload.callPermission as CallPermissionLevel)
        : "international";
      try {
        await client.setOutgoingPermission(person.id, callPermissionsFor(level));
      } catch (e) {
        await appendError(env, item.id, `Setting call permission class "${level}" failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } else if (item.target_type === "workspace") {
    const loc = await resolveLocation();
    // Idempotent: a workspace with this name at this location may already exist
    // (a previous attempt of this batch, or genuinely pre-existing). Creating
    // unconditionally would duplicate it on an at-least-once queue redelivery.
    const existingWs = (await client.listWorkspaces()).find(
      (w: any) =>
        String(w.displayName ?? "").toLowerCase() === String(payload.name).toLowerCase() &&
        (w.locationId === undefined || w.locationId === loc.id),
    );
    if (existingWs) {
      await recordSuccess(env, item.id, existingWs.id, {
        created: priorAttemptMayHaveCreated,
        type: "workspace",
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
      });
      return;
    }
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
    // Idempotent guard (see workspace above): skip creation if a hunt group
    // with this name or extension already exists in the location.
    const existingHg = (await client.listHuntGroups()).find(
      (h: any) =>
        (h.locationId === undefined || h.locationId === loc.id) &&
        (String(h.name ?? "").toLowerCase() === String(payload.name).toLowerCase() ||
          (payload.extension && String(h.extension ?? "") === String(payload.extension))),
    );
    if (existingHg) {
      await recordSuccess(env, item.id, existingHg.id, {
        created: priorAttemptMayHaveCreated,
        type: "hunt_group",
        locationId: loc.id,
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
      });
      return;
    }
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
    // Idempotent guard (see workspace above): call pickups are location-scoped.
    const existingCp = (await client.listCallPickups(loc.id)).find(
      (cp: any) => String(cp.name ?? "").toLowerCase() === String(payload.name).toLowerCase(),
    );
    if (existingCp) {
      await recordSuccess(env, item.id, existingCp.id, {
        created: priorAttemptMayHaveCreated,
        type: "call_pickup",
        locationId: loc.id,
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
      });
      return;
    }
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
  } else if (item.target_type === "auto_attendant") {
    if (!payload.extension) throw new Error("Auto attendant needs an extension — edit the mapping first");
    const loc = await resolveLocation();
    // Idempotent guard (see workspace above): skip if an AA with this name or
    // extension already exists in the location.
    const existingAa = (await client.listAutoAttendants()).find(
      (a: any) =>
        (a.locationId === undefined || a.locationId === loc.id) &&
        (String(a.name ?? "").toLowerCase() === String(payload.name).toLowerCase() ||
          String(a.extension ?? "") === String(payload.extension)),
    );
    if (existingAa) {
      await recordSuccess(env, item.id, existingAa.id, {
        created: priorAttemptMayHaveCreated,
        type: "auto_attendant",
        locationId: loc.id,
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
      });
      return;
    }
    // Auto attendants require a business schedule at the location.
    let scheduleName: string;
    const schedules = (await client.listSchedules(loc.id)).filter((sc: any) => String(sc.type).toLowerCase() === "businesshours");
    if (schedules.length > 0) {
      scheduleName = schedules[0].name;
    } else {
      const created = (await client.createSchedule(loc.id, { type: "businessHours", name: "All Hours (CUCM migration)" })) as any;
      scheduleName = created.name ?? "All Hours (CUCM migration)";
    }
    const keyConfigurations = (payload.keys ?? []).map((k: any) => ({
      key: k.key,
      action: k.action,
      ...(k.value ? { value: k.value } : {}),
    }));
    if (keyConfigurations.length === 0) keyConfigurations.push({ key: "0", action: "REPEAT_MENU" });
    const menu = { greeting: "DEFAULT", extensionEnabled: true, keyConfigurations };
    const body = {
      name: payload.name,
      extension: payload.extension,
      firstName: "Auto",
      lastName: payload.name,
      businessSchedule: scheduleName,
      businessHoursMenu: menu,
      afterHoursMenu: menu,
    };
    const result = (await client.createAutoAttendant(loc.id, body)) as any;
    await recordSuccess(env, item.id, result.id, { created: true, type: "auto_attendant", locationId: loc.id });
    if ((payload.unmappedKeys ?? []).length > 0) {
      await appendError(env, item.id, `Created without ${payload.unmappedKeys.length} untranslatable menu key(s): ${payload.unmappedKeys.join("; ")}`);
    }
  } else if (item.target_type === "call_park") {
    if (!payload.extension) throw new Error("Call park range/pattern cannot push — edit the mapping to a single extension first");
    const loc = await resolveLocation();
    // Idempotent guard (see workspace above): a park extension is unique per
    // location on its extension.
    const existingPark = (await client.listCallParkExtensions()).find(
      (pk: any) =>
        String(pk.extension ?? "") === String(payload.extension) && (pk.locationId === undefined || pk.locationId === loc.id),
    );
    if (existingPark) {
      await recordSuccess(env, item.id, existingPark.id, {
        created: priorAttemptMayHaveCreated,
        type: "call_park",
        locationId: loc.id,
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
      });
      return;
    }
    const result = (await client.createCallParkExtension(loc.id, { name: payload.name, extension: payload.extension })) as any;
    await recordSuccess(env, item.id, result.id, { created: true, type: "call_park", locationId: loc.id });
  } else if (item.target_type === "translation_pattern") {
    if (!payload.replacementPattern) throw new Error("No replacement pattern derived — review and edit this mapping before pushing");
    // Idempotent: a pattern matching the same digits may already exist (e.g. a
    // previous attempt, or CUCM descriptions colliding on name).
    const existing = (await client.listTranslationPatterns()).find((t: any) => t.matchingPattern === payload.matchingPattern);
    if (existing) {
      await recordSuccess(env, item.id, existing.id, {
        created: priorAttemptMayHaveCreated,
        type: "translation_pattern",
        note: priorAttemptMayHaveCreated ? "created by an earlier attempt of this batch" : "already existed",
      });
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
    else if (info.type === "auto_attendant") await client.deleteAutoAttendant(info.locationId, item.webex_resource_id);
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
