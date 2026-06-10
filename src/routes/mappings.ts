import { Hono } from "hono";
import type { AppContext } from "../env";
import { generateMappings } from "../mapping/engine";

export const mappings = new Hono<AppContext>();

mappings.post("/:id/mappings/generate", async (c) => {
  const result = await generateMappings(c.env, c.req.param("id"));
  return c.json(result);
});

mappings.get("/:id/mappings", async (c) => {
  const type = c.req.query("type");
  const query = type
    ? c.env.DB.prepare("SELECT * FROM mappings WHERE project_id = ? AND target_type = ? ORDER BY src_type").bind(c.req.param("id"), type)
    : c.env.DB.prepare("SELECT * FROM mappings WHERE project_id = ? ORDER BY src_type").bind(c.req.param("id"));
  const { results } = await query.all();
  return c.json(results);
});

// Edit one mapping: selection, payload (merged), or both.
mappings.patch("/:id/mappings/:mappingId", async (c) => {
  const body = await c.req.json<{ selected?: boolean; payload?: Record<string, unknown> }>();
  const row = await c.env.DB.prepare("SELECT * FROM mappings WHERE id = ? AND project_id = ?")
    .bind(c.req.param("mappingId"), c.req.param("id"))
    .first<{ target_payload: string }>();
  if (!row) return c.json({ error: "not found" }, 404);

  if (body.payload !== undefined) {
    const merged = { ...JSON.parse(row.target_payload), ...body.payload };
    await c.env.DB.prepare("UPDATE mappings SET target_payload = ?, status = 'edited' WHERE id = ?")
      .bind(JSON.stringify(merged), c.req.param("mappingId"))
      .run();
  }
  if (body.selected !== undefined) {
    await c.env.DB.prepare("UPDATE mappings SET selected = ? WHERE id = ?")
      .bind(body.selected ? 1 : 0, c.req.param("mappingId"))
      .run();
  }
  const updated = await c.env.DB.prepare("SELECT * FROM mappings WHERE id = ?").bind(c.req.param("mappingId")).first();
  return c.json(updated);
});

// Bulk operations: select/deselect all (optionally by type), set location on all selected.
mappings.post("/:id/mappings/bulk", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ action: "select" | "deselect" | "setLocation"; targetType?: string; locationName?: string }>();

  if (body.action === "select" || body.action === "deselect") {
    const sel = body.action === "select" ? 1 : 0;
    if (body.targetType) {
      await c.env.DB.prepare("UPDATE mappings SET selected = ? WHERE project_id = ? AND target_type = ?")
        .bind(sel, projectId, body.targetType)
        .run();
    } else {
      await c.env.DB.prepare("UPDATE mappings SET selected = ? WHERE project_id = ?").bind(sel, projectId).run();
    }
    return c.json({ ok: true });
  }

  if (body.action === "setLocation") {
    if (!body.locationName) return c.json({ error: "locationName required" }, 400);
    const { results } = await c.env.DB.prepare("SELECT id, target_payload FROM mappings WHERE project_id = ?")
      .bind(projectId)
      .all<{ id: string; target_payload: string }>();
    for (const row of results) {
      const payload = JSON.parse(row.target_payload);
      payload.locationName = body.locationName;
      await c.env.DB.prepare("UPDATE mappings SET target_payload = ? WHERE id = ?")
        .bind(JSON.stringify(payload), row.id)
        .run();
    }
    return c.json({ ok: true, updated: results.length });
  }
  return c.json({ error: "unknown action" }, 400);
});
