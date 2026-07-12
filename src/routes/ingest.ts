import { Hono } from "hono";
import { unzipSync } from "fflate";
import type { AppContext, Env } from "../env";
import { parseExport } from "../parsers/csv";
import { matchGreeting, VmBoxRef } from "../parsers/greetings";
import { batchAll, nowIso, uuid } from "../lib/util";

export const ingest = new Hono<AppContext>();

// Upload one or more export files; stored in R2, one snapshot per upload.
ingest.post("/:id/uploads", async (c) => {
  const projectId = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) return c.json({ error: "project not found" }, 404);

  const form = await c.req.formData();
  const type = (form.get("type") as string) === "unity" ? "unity" : "cucm";
  const files = (form.getAll("file") as unknown[]).filter((f): f is File => typeof f === "object" && f !== null && "stream" in f);
  if (files.length === 0) return c.json({ error: "no files" }, 400);

  const keys: string[] = [];
  for (const file of files) {
    const key = `projects/${projectId}/uploads/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
    await c.env.UPLOADS.put(key, file.stream(), {
      customMetadata: { filename: file.name, type },
    });
    keys.push(key);
  }

  const snapshotId = uuid();
  await c.env.DB.prepare(
    "INSERT INTO source_snapshots (id, project_id, type, source, r2_keys, status) VALUES (?, ?, ?, 'upload', ?, 'pending')",
  )
    .bind(snapshotId, projectId, type, JSON.stringify(keys))
    .run();
  return c.json({ snapshotId, keys }, 201);
});

// Parse a pending uploaded snapshot's CSV files into src_* tables.
ingest.post("/:id/snapshots/:snapshotId/parse", async (c) => {
  const projectId = c.req.param("id");
  const snapshotId = c.req.param("snapshotId");
  const snap = await c.env.DB.prepare("SELECT * FROM source_snapshots WHERE id = ? AND project_id = ?")
    .bind(snapshotId, projectId)
    .first<{ r2_keys: string; type: string }>();
  if (!snap) return c.json({ error: "snapshot not found" }, 404);

  await c.env.DB.prepare("UPDATE source_snapshots SET status = 'parsing' WHERE id = ?").bind(snapshotId).run();

  // Re-parsing must replace, not append — otherwise a double-clicked/retried
  // parse doubles every src_* row and inflates counts. Clear this snapshot's
  // prior rows first so parse is idempotent.
  for (const table of ["src_users", "src_phones", "src_lines", "src_vm_boxes", "src_vm_greetings"]) {
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE snapshot_id = ?`).bind(snapshotId).run();
  }

  const counts: Record<string, number> = {};
  const warnings: string[] = [];
  try {
    const keys: string[] = JSON.parse(snap.r2_keys || "[]");
    for (const key of keys) {
      const obj = await c.env.UPLOADS.get(key);
      if (!obj) {
        warnings.push(`${key}: missing from storage`);
        continue;
      }
      const filename = obj.customMetadata?.filename ?? key;
      // Guard the isolate's ~128 MB memory: parsing buffers whole files (and
      // decompresses zips) in memory, so refuse anything unreasonably large
      // rather than OOM-killing the parse mid-run.
      const MAX_BYTES = 80 * 1024 * 1024;
      if (obj.size > MAX_BYTES) {
        warnings.push(`${filename}: ${(obj.size / 1048576).toFixed(0)} MB exceeds the ${MAX_BYTES / 1048576} MB parse limit — split the export and re-upload`);
        continue;
      }
      if (/\.wav$/i.test(filename)) {
        const matched = await storeGreeting(c.env, projectId, snapshotId, filename, key, warnings);
        counts.vm_greetings = (counts.vm_greetings ?? 0) + (matched ? 1 : 0);
        continue;
      }
      if (/\.zip$/i.test(filename)) {
        try {
          const entries = unzipSync(new Uint8Array(await obj.arrayBuffer()));
          for (const [entryName, bytes] of Object.entries(entries)) {
            if (!/\.wav$/i.test(entryName) || bytes.length === 0) continue;
            const wavKey = `projects/${projectId}/greetings/${Date.now()}-${entryName.split("/").pop()!.replace(/[^\w.\-]+/g, "_")}`;
            await c.env.UPLOADS.put(wavKey, bytes, { customMetadata: { filename: entryName } });
            const matched = await storeGreeting(c.env, projectId, snapshotId, entryName, wavKey, warnings);
            counts.vm_greetings = (counts.vm_greetings ?? 0) + (matched ? 1 : 0);
          }
        } catch (e) {
          warnings.push(`${filename}: could not extract zip (${e instanceof Error ? e.message : e})`);
        }
        continue;
      }
      if (!/\.(csv|txt)$/i.test(filename)) {
        warnings.push(`${filename}: unsupported file type — upload CSVs, WAVs or a zip of WAVs`);
        continue;
      }
      const { kind, rows } = parseExport(await obj.text());
      if (kind === "unknown") {
        warnings.push(`${filename}: could not detect export type from headers — skipped`);
        continue;
      }
      const stmts: D1PreparedStatement[] = [];
      for (const row of rows) {
        const f = row.fields;
        const raw = JSON.stringify(row.raw);
        if (kind === "users") {
          if (!f.userid) continue;
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO src_users (id, project_id, snapshot_id, userid, first_name, last_name, email, department, primary_extension, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(uuid(), projectId, snapshotId, f.userid, f.first_name, f.last_name, f.email, f.department, f.primary_extension, raw),
          );
        } else if (kind === "phones") {
          if (!f.device_name) continue;
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO src_phones (id, project_id, snapshot_id, device_name, description, model, owner_userid, device_pool, location_name, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(uuid(), projectId, snapshotId, f.device_name, f.description, f.model, f.owner_userid, f.device_pool, f.location_name, raw),
          );
        } else if (kind === "lines") {
          if (!f.pattern) continue;
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO src_lines (id, project_id, snapshot_id, pattern, partition_name, description, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).bind(uuid(), projectId, snapshotId, f.pattern, f.partition_name, f.description, raw),
          );
        } else if (kind === "vm_boxes") {
          if (!f.alias) continue;
          stmts.push(
            c.env.DB.prepare(
              `INSERT INTO src_vm_boxes (id, project_id, snapshot_id, alias, display_name, extension, email, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(uuid(), projectId, snapshotId, f.alias, f.display_name, f.extension, f.email, raw),
          );
        }
      }
      await batchAll(c.env.DB, stmts);
      counts[kind] = (counts[kind] ?? 0) + stmts.length;
    }
    await c.env.DB.prepare(
      "UPDATE source_snapshots SET status = 'parsed', counts_json = ?, parsed_at = ?, error_text = ? WHERE id = ?",
    )
      .bind(JSON.stringify(counts), nowIso(), warnings.length ? warnings.join("\n") : null, snapshotId)
      .run();
    return c.json({ counts, warnings });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare("UPDATE source_snapshots SET status = 'failed', error_text = ? WHERE id = ?")
      .bind(msg, snapshotId)
      .run();
    return c.json({ error: msg }, 500);
  }
});

/** Store a greeting WAV row, matching it to a mailbox by filename. Returns true if matched. */
async function storeGreeting(env: Env, projectId: string, snapshotId: string, filename: string, r2Key: string, warnings: string[]): Promise<boolean> {
  const boxes = (
    await env.DB.prepare("SELECT alias, extension FROM src_vm_boxes WHERE project_id = ?").bind(projectId).all<VmBoxRef>()
  ).results;
  if (boxes.length === 0) warnings.push("No Unity mailboxes parsed yet — upload the mailbox CSV first so greetings can be matched");
  const alias = matchGreeting(filename, boxes);
  await env.DB.prepare(
    "INSERT INTO src_vm_greetings (id, project_id, snapshot_id, filename, r2_key, matched_alias) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(uuid(), projectId, snapshotId, filename, r2Key, alias)
    .run();
  if (!alias) warnings.push(`Greeting "${filename}": no mailbox matches its name (expected <alias>.wav or <extension>.wav) — orphaned`);
  return alias !== null;
}

// Stream a greeting WAV from R2 (inline for the player, attachment for download).
ingest.get("/:id/greetings/:greetingId/audio", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key, filename FROM src_vm_greetings WHERE id = ? AND project_id = ?")
    .bind(c.req.param("greetingId"), c.req.param("id"))
    .first<{ r2_key: string; filename: string }>();
  if (!row) return c.json({ error: "greeting not found" }, 404);
  const obj = await c.env.UPLOADS.get(row.r2_key);
  if (!obj) return c.json({ error: "audio file missing from storage" }, 404);
  const headers: Record<string, string> = { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=300" };
  if (c.req.query("download") !== undefined) {
    headers["Content-Disposition"] = `attachment; filename="${row.filename.replace(/[^\w.\- ]+/g, "_")}"`;
  }
  return new Response(obj.body, { headers });
});

// List parsed source objects for review tables.
const OBJECT_TABLES: Record<string, string> = {
  users: "src_users",
  phones: "src_phones",
  lines: "src_lines",
  hunt_pilots: "src_hunt_pilots",
  pickup_groups: "src_pickup_groups",
  vm_boxes: "src_vm_boxes",
  trans_patterns: "src_trans_patterns",
  dialplan: "src_dialplan",
  hunt_members: "src_hunt_members",
  vm_greetings: "src_vm_greetings",
  call_handlers: "src_call_handlers",
};

ingest.get("/:id/objects/:type", async (c) => {
  const table = OBJECT_TABLES[c.req.param("type")];
  if (!table) return c.json({ error: "unknown object type" }, 400);
  const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE project_id = ? LIMIT 2000`)
    .bind(c.req.param("id"))
    .all();
  return c.json(results);
});
