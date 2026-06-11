import type { Env } from "../env";
import { decrypt } from "../lib/crypto";
import { matchGreeting } from "../parsers/greetings";
import { batchAll, nowIso, uuid } from "../lib/util";
import { UnityClient } from "./client";

export async function getUnityClient(env: Env, projectId: string): Promise<UnityClient | null> {
  const conn = await env.DB.prepare("SELECT * FROM unity_connections WHERE project_id = ?")
    .bind(projectId)
    .first<{ base_url: string; username: string; password_enc: string }>();
  if (!conn) return null;
  return new UnityClient(conn.base_url, conn.username, await decrypt(env.ENC_KEY, conn.password_enc));
}

/**
 * Download recorded Standard greetings for every pulled mailbox via CUPI
 * into R2 (replaces prior CUPI-sourced greeting rows; uploads are kept).
 */
export async function pullGreetingsFromUnity(env: Env, projectId: string): Promise<{ snapshotId: string; counts: Record<string, number>; warnings: string[] }> {
  const unity = await getUnityClient(env, projectId);
  if (!unity) throw new Error("No Unity connection configured for this project");

  const boxes = (
    await env.DB.prepare("SELECT alias, raw_json FROM src_vm_boxes WHERE project_id = ?").bind(projectId).all<{ alias: string; raw_json: string }>()
  ).results;
  if (boxes.length === 0) throw new Error("No mailboxes pulled yet — run 'Pull mailboxes' first");

  const snapshotId = uuid();
  await env.DB.prepare(
    "INSERT INTO source_snapshots (id, project_id, type, source, status) VALUES (?, ?, 'unity', 'cupi-greetings', 'parsing')",
  )
    .bind(snapshotId, projectId)
    .run();

  const warnings: string[] = [];
  const counts: Record<string, number> = { mailboxes_checked: 0, greetings_downloaded: 0 };
  try {
    await env.DB.prepare(
      `DELETE FROM src_vm_greetings WHERE project_id = ? AND snapshot_id IN
        (SELECT id FROM source_snapshots WHERE project_id = ? AND source = 'cupi-greetings')`,
    )
      .bind(projectId, projectId)
      .run();

    for (const box of boxes) {
      counts.mailboxes_checked++;
      let callHandlerId: string | null = null;
      try {
        callHandlerId = JSON.parse(box.raw_json)?.CallHandlerObjectId ?? null;
      } catch {
        /* our own JSON */
      }
      if (!callHandlerId) continue;
      try {
        const streams = await unity.listGreetingStreams(callHandlerId);
        if (streams.length === 0) continue; // no custom recording
        const audio = await unity.downloadGreeting(callHandlerId, streams[0].languageCode);
        if (!audio || audio.byteLength === 0) continue;
        const safeAlias = box.alias.replace(/[^\w.\-]+/g, "_");
        const key = `projects/${projectId}/greetings/cupi/${safeAlias}.wav`;
        await env.UPLOADS.put(key, audio, { customMetadata: { filename: `${box.alias}.wav`, source: "cupi" } });
        await env.DB.prepare(
          "INSERT INTO src_vm_greetings (id, project_id, snapshot_id, filename, r2_key, matched_alias) VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(uuid(), projectId, snapshotId, `${box.alias}.wav`, key, box.alias)
          .run();
        counts.greetings_downloaded++;
      } catch (e) {
        if (warnings.length < 20) warnings.push(`${box.alias}: ${e instanceof Error ? e.message : e}`);
      }
    }

    await env.DB.prepare(
      "UPDATE source_snapshots SET status = 'parsed', counts_json = ?, parsed_at = ?, error_text = ? WHERE id = ?",
    )
      .bind(JSON.stringify(counts), nowIso(), warnings.length ? warnings.join("\n") : null, snapshotId)
      .run();
    return { snapshotId, counts, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE source_snapshots SET status = 'failed', error_text = ? WHERE id = ?").bind(msg, snapshotId).run();
    throw e;
  }
}

/** Pull voicemail users from Unity via CUPI into src_vm_boxes (replaces prior CUPI-sourced rows). */
export async function pullFromUnity(env: Env, projectId: string): Promise<{ snapshotId: string; counts: Record<string, number>; warnings: string[] }> {
  const unity = await getUnityClient(env, projectId);
  if (!unity) throw new Error("No Unity connection configured for this project");

  const snapshotId = uuid();
  await env.DB.prepare(
    "INSERT INTO source_snapshots (id, project_id, type, source, status) VALUES (?, ?, 'unity', 'cupi', 'parsing')",
  )
    .bind(snapshotId, projectId)
    .run();

  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  try {
    await env.DB.prepare(
      `DELETE FROM src_vm_boxes WHERE project_id = ? AND snapshot_id IN
        (SELECT id FROM source_snapshots WHERE project_id = ? AND source = 'cupi')`,
    )
      .bind(projectId, projectId)
      .run();

    const users = await unity.listUsers();
    await batchAll(
      env.DB,
      users.map((u) =>
        env.DB.prepare(
          `INSERT INTO src_vm_boxes (id, project_id, snapshot_id, alias, display_name, extension, email, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uuid(),
          projectId,
          snapshotId,
          String(u.Alias ?? ""),
          u.DisplayName ? String(u.DisplayName) : null,
          u.DtmfAccessId ? String(u.DtmfAccessId) : null,
          u.EmailAddress ? String(u.EmailAddress) : null,
          JSON.stringify(u),
        ),
      ),
    );
    counts.vm_boxes = users.length;

    // Call handlers (non-primary) with their menus — mapped to auto attendants.
    try {
      await env.DB.prepare(
        `DELETE FROM src_call_handlers WHERE project_id = ? AND snapshot_id IN
          (SELECT id FROM source_snapshots WHERE project_id = ? AND source = 'cupi')`,
      )
        .bind(projectId, projectId)
        .run();
      const handlers = await unity.listCallHandlers();
      for (const h of handlers) {
        let menu: any[] = [];
        try {
          menu = await unity.getMenuEntries(String(h.ObjectId));
        } catch (e) {
          warnings.push(`Call handler ${h.DisplayName}: menu entries unavailable (${e instanceof Error ? e.message : e})`);
        }
        await env.DB.prepare(
          `INSERT INTO src_call_handlers (id, project_id, snapshot_id, object_id, name, extension, menu_json, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            uuid(),
            projectId,
            snapshotId,
            String(h.ObjectId),
            String(h.DisplayName ?? h.ObjectId),
            h.DtmfAccessId ? String(h.DtmfAccessId) : null,
            JSON.stringify(menu),
            JSON.stringify(h),
          )
          .run();
      }
      counts.call_handlers = handlers.length;
    } catch (e) {
      warnings.push(`Call handlers not pulled: ${e instanceof Error ? e.message : e}`);
    }

    // Re-match any orphaned greeting files against the fresh mailbox list.
    const orphans = (
      await env.DB.prepare("SELECT id, filename FROM src_vm_greetings WHERE project_id = ? AND matched_alias IS NULL")
        .bind(projectId)
        .all<{ id: string; filename: string }>()
    ).results;
    if (orphans.length > 0) {
      const boxes = users.map((u) => ({ alias: String(u.Alias ?? ""), extension: u.DtmfAccessId ? String(u.DtmfAccessId) : null }));
      let rematched = 0;
      for (const orphan of orphans) {
        const alias = matchGreeting(orphan.filename, boxes);
        if (alias) {
          await env.DB.prepare("UPDATE src_vm_greetings SET matched_alias = ? WHERE id = ?").bind(alias, orphan.id).run();
          rematched++;
        }
      }
      counts.greetings_rematched = rematched;
      if (rematched < orphans.length) warnings.push(`${orphans.length - rematched} greeting file(s) still match no mailbox`);
    }

    await env.DB.prepare(
      "UPDATE source_snapshots SET status = 'parsed', counts_json = ?, parsed_at = ?, error_text = ? WHERE id = ?",
    )
      .bind(JSON.stringify(counts), nowIso(), warnings.length ? warnings.join("\n") : null, snapshotId)
      .run();
    return { snapshotId, counts, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE source_snapshots SET status = 'failed', error_text = ? WHERE id = ?").bind(msg, snapshotId).run();
    throw e;
  }
}
