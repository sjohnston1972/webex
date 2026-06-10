import type { Env } from "../env";
import { nowIso, uuid } from "../lib/util";
import { pickCallingLicense, WebexClient } from "../webex/client";

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

const GROUP_TYPES = ["hunt_group", "call_pickup"];

export async function startPush(env: Env, projectId: string, batchId: string): Promise<{ queued: number }> {
  await env.DB.prepare("UPDATE batches SET status = 'pushing' WHERE id = ?").bind(batchId).run();

  const items = (
    await env.DB.prepare(
      `SELECT bi.id, m.target_type FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id
       WHERE bi.batch_id = ? AND bi.push_status IN ('pending','failed')`,
    )
      .bind(batchId)
      .all<{ id: string; target_type: string }>()
  ).results;

  // Create job rows for everything; queue only people now (groups wait for people).
  const people = items.filter((i) => i.target_type === "person");
  const groups = items.filter((i) => GROUP_TYPES.includes(i.target_type));
  let queued = 0;

  for (const item of [...people, ...groups]) {
    const jobId = uuid();
    const isPerson = item.target_type === "person";
    await env.DB.prepare(
      "INSERT INTO push_jobs (id, batch_id, batch_item_id, action, status) VALUES (?, ?, ?, 'push', ?)",
    )
      .bind(jobId, batchId, item.id, isPerson ? "pending" : "waiting")
      .run();
    await env.DB.prepare("UPDATE batch_items SET push_status = 'queued' WHERE id = ?").bind(item.id).run();
    if (isPerson) {
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

  // Groups first, then people.
  const ordered = [...items.filter((i) => GROUP_TYPES.includes(i.target_type)), ...items.filter((i) => i.target_type === "person")];
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
  if (!job || job.status === "done") return;
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
    const final = attempts >= 3;
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

  // If this was the last person push in the batch, release the waiting group jobs.
  if (job.action === "push" && item.target_type === "person") {
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_jobs pj
       JOIN batch_items bi ON bi.id = pj.batch_item_id
       JOIN mappings m ON m.id = bi.mapping_id
       WHERE pj.batch_id = ? AND pj.action = 'push' AND m.target_type = 'person' AND pj.status IN ('pending','running')`,
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
    if (!loc) throw new Error(`Location "${payload.locationName}" not found in Control Hub`);
    return loc;
  };

  if (item.target_type === "person") {
    const existing = payload.email ? await client.findPersonByEmail(payload.email) : null;
    if (existing) {
      await recordSuccess(env, item.id, existing.id, { created: false, note: "already existed" });
      return;
    }
    const loc = await resolveLocation();
    const licenses = await client.listLicenses();
    const calling = pickCallingLicense(licenses);
    if (!calling) throw new Error("No Webex Calling licence with available units");

    const body: Record<string, unknown> = {
      emails: [payload.email],
      firstName: payload.firstName ?? undefined,
      lastName: payload.lastName ?? undefined,
      displayName: payload.displayName ?? undefined,
      locationId: loc.id,
      licenses: [calling.id],
    };
    if (payload.extension) body.extension = payload.extension;
    if (payload.phoneNumber) body.phoneNumbers = [{ type: "work", value: payload.phoneNumber }];

    const person = (await client.createPerson(body)) as any;
    await recordSuccess(env, item.id, person.id, { created: true, type: "person" });

    if (payload.voicemail) {
      try {
        await client.setVoicemail(person.id, true);
      } catch (e) {
        await appendError(env, item.id, `Person created, but enabling voicemail failed: ${e instanceof Error ? e.message : e}`);
      }
    }
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
    const agents: string[] = [];
    const missing: string[] = [];
    for (const email of payload.agentEmails ?? []) {
      const person = await client.findPersonByEmail(email);
      if (person) agents.push(person.id);
      else missing.push(email);
    }
    const result = (await client.createCallPickup(loc.id, { name: payload.name, agents })) as any;
    await recordSuccess(env, item.id, result.id, { created: true, type: "call_pickup", locationId: loc.id });
    if (missing.length > 0) await appendError(env, item.id, `Created without unresolvable members: ${missing.join(", ")}`);
  } else {
    throw new Error(`Unsupported target type: ${item.target_type}`);
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
    else if (info.type === "hunt_group") await client.deleteHuntGroup(info.locationId, item.webex_resource_id);
    else if (info.type === "call_pickup") await client.deleteCallPickup(info.locationId, item.webex_resource_id);
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
