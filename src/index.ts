import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext, Env } from "./env";
import { verifySession } from "./lib/pin";
import { ai } from "./routes/ai";
import { pin } from "./routes/pin";
import { auth } from "./routes/auth";
import { axl } from "./routes/axl";
import { batches } from "./routes/batches";
import { ingest } from "./routes/ingest";
import { mappings } from "./routes/mappings";
import { projects } from "./routes/projects";
import { reports } from "./routes/reports";
import { unity } from "./routes/unity";
import { webex } from "./routes/webex";
import { processJob } from "./push/runner";
import { keepTokensWarm } from "./webex/client";

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

app.route("/api/pin", pin);

// PIN gate: everything except health and the PIN endpoints needs a session.
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path.startsWith("/api/pin")) return next();
  if (!(await verifySession(c.env.ENC_KEY, c.env.PIN_CODE, getCookie(c, "wx_pin")))) {
    return c.json({ error: "PIN required", code: "pin_required" }, 401);
  }
  return next();
});
app.use("/auth/*", async (c, next) => {
  if (!(await verifySession(c.env.ENC_KEY, c.env.PIN_CODE, getCookie(c, "wx_pin")))) {
    return c.text("PIN required — open the app and sign in first", 401);
  }
  return next();
});

app.route("/auth", auth);
app.route("/api/projects", ai);
app.route("/api/projects", projects);
app.route("/api/projects", ingest);
app.route("/api/projects", axl);
app.route("/api/projects", unity);
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

  // Daily cron: roll Webex refresh tokens before their ~90-day window can lapse,
  // so a connected project never silently needs re-authorising after idle time.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const results = await keepTokensWarm(env);
    const refreshed = results.filter((r) => r.refreshed).length;
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      console.error(`Webex token keep-alive: refreshed ${refreshed}, ${failed.length} failed`, failed);
    } else {
      console.log(`Webex token keep-alive: refreshed ${refreshed}/${results.length} project(s)`);
    }
  },

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
