import { Hono } from "hono";
import type { AppContext } from "../env";
import { WebexClient } from "../webex/client";

export const webex = new Hono<AppContext>();

webex.get("/:id/webex/status", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT org_id, org_name, scopes, expires_at, updated_at FROM webex_tokens WHERE project_id = ?",
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) return c.json({ connected: false });
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    const me = (await client.me()) as any;
    return c.json({ connected: true, ...row, adminEmail: me.emails?.[0] ?? null });
  } catch (e) {
    return c.json({ connected: false, ...row, error: e instanceof Error ? e.message : String(e) });
  }
});

webex.get("/:id/webex/locations", async (c) => {
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    return c.json(await client.listLocations());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

webex.get("/:id/webex/licenses", async (c) => {
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    return c.json(await client.listLicenses());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

webex.get("/:id/webex/numbers", async (c) => {
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    return c.json(await client.listNumbers());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
