import { Hono } from "hono";
import type { AppContext, Env } from "./env";
import { auth } from "./routes/auth";
import { axl } from "./routes/axl";
import { batches } from "./routes/batches";
import { ingest } from "./routes/ingest";
import { mappings } from "./routes/mappings";
import { projects } from "./routes/projects";
import { reports } from "./routes/reports";
import { webex } from "./routes/webex";
import { processJob } from "./push/runner";

const app = new Hono<AppContext>();

app.get("/api/health", async (c) => {
  let d1 = false;
  let r2 = false;
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    d1 = row?.one === 1;
  } catch {
    d1 = false;
  }
  try {
    await c.env.UPLOADS.list({ limit: 1 });
    r2 = true;
  } catch {
    r2 = false;
  }
  const ok = d1 && r2;
  return c.json({ ok, d1, r2, time: new Date().toISOString() }, ok ? 200 : 503);
});

app.route("/auth", auth);
app.route("/api/projects", projects);
app.route("/api/projects", ingest);
app.route("/api/projects", axl);
app.route("/api/projects", mappings);
app.route("/api/projects", webex);
app.route("/api/projects", batches);
app.route("/api/projects", reports);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processJob(env, message.body.jobId);
        message.ack();
      } catch (e) {
        console.error(`Job ${message.body.jobId} failed, will retry:`, e);
        message.retry({ delaySeconds: 10 });
      }
    }
  },
};
