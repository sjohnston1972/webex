import type { Env } from "../env";

export type BatchRow = { id: string; project_id: string; name: string; status: string };

/**
 * Load a batch only if it really belongs to the project in the URL. Every
 * /:id/batches/:batchId/* route must go through this: a batch id alone is not
 * an authorisation — validating batch A through project B's URL would run it
 * against B's Webex org tokens.
 */
export async function loadBatch(env: Env, projectId: string, batchId: string): Promise<BatchRow | null> {
  return env.DB.prepare("SELECT id, project_id, name, status FROM batches WHERE id = ? AND project_id = ?")
    .bind(batchId, projectId)
    .first<BatchRow>();
}
