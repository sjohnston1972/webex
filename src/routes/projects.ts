import { Hono } from "hono";
import type { AppContext } from "../env";
import { uuid } from "../lib/util";
import { listUnattachedDns } from "../mapping/engine";

const SRC_TABLES = [
  "src_users",
  "src_phones",
  "src_lines",
  "src_hunt_pilots",
  "src_hunt_members",
  "src_pickup_groups",
  "src_vm_boxes",
  "src_trans_patterns",
  "src_dialplan",
  "src_vm_greetings",
];

export const projects = new Hono<AppContext>();

projects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM src_users u WHERE u.project_id = p.id) AS user_count,
       (SELECT COUNT(*) FROM axl_connections a WHERE a.project_id = p.id AND a.verified_at IS NOT NULL) AS cucm_linked,
       (SELECT COUNT(*) FROM webex_tokens t WHERE t.project_id = p.id) AS webex_connected
     FROM projects p ORDER BY p.created_at DESC`,
  ).all();
  return c.json(results);
});

projects.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; customer?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const id = uuid();
  await c.env.DB.prepare("INSERT INTO projects (id, name, customer) VALUES (?, ?, ?)")
    .bind(id, name, body.customer?.trim() || null)
    .run();
  const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  return c.json(row, 201);
});

projects.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

projects.get("/:id/summary", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!project) return c.json({ error: "not found" }, 404);

  const counts: Record<string, number> = {};
  for (const table of SRC_TABLES) {
    const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).bind(id).first<{ n: number }>();
    counts[table.replace("src_", "")] = r?.n ?? 0;
  }
  const mappings = await c.env.DB.prepare(
    `SELECT confidence, COUNT(*) AS n, SUM(selected) AS selected FROM mappings WHERE project_id = ? GROUP BY confidence`,
  )
    .bind(id)
    .all<{ confidence: string; n: number; selected: number }>();
  const mappingsByType = await c.env.DB.prepare(
    `SELECT target_type, COUNT(*) AS n, SUM(selected) AS selected FROM mappings WHERE project_id = ? GROUP BY target_type`,
  )
    .bind(id)
    .all<{ target_type: string; n: number; selected: number }>();
  const batches = await c.env.DB.prepare(
    `SELECT id, name, status, created_at FROM batches WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(id)
    .all();
  const snapshots = await c.env.DB.prepare(
    `SELECT id, type, source, status, counts_json, error_text, created_at, parsed_at FROM source_snapshots WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(id)
    .all();
  const axl = await c.env.DB.prepare(
    `SELECT base_url, username, cucm_version, verified_at FROM axl_connections WHERE project_id = ?`,
  )
    .bind(id)
    .first();
  const webex = await c.env.DB.prepare(
    `SELECT org_id, org_name, scopes, expires_at, updated_at FROM webex_tokens WHERE project_id = ?`,
  )
    .bind(id)
    .first();

  return c.json({
    project,
    counts,
    mappings: mappings.results,
    mappingsByType: mappingsByType.results,
    unattachedDns: (await listUnattachedDns(c.env, id)).length,
    batches: batches.results,
    snapshots: snapshots.results,
    axl: axl ?? null,
    webex: webex ?? null,
  });
});

projects.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first();
  if (!project) return c.json({ error: "not found" }, 404);

  // Purge R2 objects under the project prefix.
  let cursor: string | undefined;
  do {
    const listing = await c.env.UPLOADS.list({ prefix: `projects/${id}/`, cursor });
    if (listing.objects.length > 0) {
      await c.env.UPLOADS.delete(listing.objects.map((o) => o.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  // Purge D1 rows explicitly (don't rely on FK cascade settings).
  const tables = [
    ...SRC_TABLES,
    "mappings",
    "batch_items",
    "batches",
    "source_snapshots",
    "axl_connections",
    "webex_tokens",
    "site_mappings",
  ];
  for (const table of tables) {
    if (table === "batch_items") {
      await c.env.DB.prepare(
        "DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM batches WHERE project_id = ?)",
      )
        .bind(id)
        .run();
    } else {
      await c.env.DB.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(id).run();
    }
  }
  await c.env.DB.prepare(
    "DELETE FROM push_jobs WHERE batch_id NOT IN (SELECT id FROM batches)",
  ).run();
  await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
  return c.json({ deleted: true });
});
