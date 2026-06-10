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
