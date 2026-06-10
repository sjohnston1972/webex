import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

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

export default app;
