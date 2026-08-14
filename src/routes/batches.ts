import { Hono } from "hono";
import type { AppContext } from "../env";
import { loadBatch } from "../lib/batch";
import { batchAll, uuid } from "../lib/util";
import { validateBatch } from "../push/validate";
import { startPush, startRollback } from "../push/runner";

export const batches = new Hono<AppContext>();

// Create a batch from the currently-selected mappings.
batches.post("/:id/batches", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const selected = (
    await c.env.DB.prepare("SELECT id FROM mappings WHERE project_id = ? AND selected = 1").bind(projectId).all<{ id: string }>()
  ).results;
  if (selected.length === 0) return c.json({ error: "No mappings selected" }, 400);

  const batchId = uuid();
  const name = body.name?.trim() || `Batch ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  await c.env.DB.prepare("INSERT INTO batches (id, project_id, name) VALUES (?, ?, ?)").bind(batchId, projectId, name).run();
  // Insert items atomically (chunked D1 batch) so a mid-loop failure can't leave
  // a batch with a partial item set.
  await batchAll(
    c.env.DB,
    selected.map((m) => c.env.DB.prepare("INSERT INTO batch_items (id, batch_id, mapping_id) VALUES (?, ?, ?)").bind(uuid(), batchId, m.id)),
  );
  return c.json({ id: batchId, name, items: selected.length }, 201);
});

batches.get("/:id/batches/:batchId", async (c) => {
  const batch = await c.env.DB.prepare("SELECT * FROM batches WHERE id = ? AND project_id = ?")
    .bind(c.req.param("batchId"), c.req.param("id"))
    .first();
  if (!batch) return c.json({ error: "not found" }, 404);
  const items = (
    await c.env.DB.prepare(
      `SELECT bi.*, m.src_type, m.target_type, m.target_payload, m.confidence, m.notes AS mapping_notes
       FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id WHERE bi.batch_id = ?`,
    )
      .bind(c.req.param("batchId"))
      .all()
  ).results;
  return c.json({ batch, items });
});

batches.post("/:id/batches/:batchId/validate", async (c) => {
  const batch = await loadBatch(c.env, c.req.param("id"), c.req.param("batchId"));
  if (!batch) return c.json({ error: "not found" }, 404);
  try {
    const result = await validateBatch(c.env, c.req.param("id"), c.req.param("batchId"));
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

batches.post("/:id/batches/:batchId/push", async (c) => {
  const batch = await loadBatch(c.env, c.req.param("id"), c.req.param("batchId"));
  if (!batch) return c.json({ error: "not found" }, 404);
  if (!["validated", "failed", "pushed", "pushing"].includes(batch.status)) {
    return c.json({ error: `Batch must be validated before pushing (status: ${batch.status})` }, 400);
  }
  const result = await startPush(c.env, c.req.param("id"), c.req.param("batchId"));
  return c.json(result);
});

batches.post("/:id/batches/:batchId/rollback", async (c) => {
  const batch = await loadBatch(c.env, c.req.param("id"), c.req.param("batchId"));
  if (!batch) return c.json({ error: "not found" }, 404);
  // Rolling back mid-push interleaves creates and deletes: items that finish
  // pushing after the rollback pass keep their Webex resources, so the batch
  // ends up half rolled back with orphans. Make the operator wait for the push
  // to settle first.
  if (batch.status === "pushing" || batch.status === "validating") {
    return c.json(
      { error: `Batch is still ${batch.status} — wait for it to finish before rolling back (status: ${batch.status})` },
      400,
    );
  }
  const result = await startRollback(c.env, c.req.param("id"), c.req.param("batchId"));
  return c.json(result);
});
