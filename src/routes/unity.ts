import { Hono } from "hono";
import type { AppContext } from "../env";
import { encrypt } from "../lib/crypto";
import { assertAllowedConnectorUrl } from "../lib/net";
import { nowIso } from "../lib/util";
import { CupiError } from "../unity/client";
import { getUnityClient, pullFromUnity, pullGreetingsFromUnity } from "../unity/pull";

export const unity = new Hono<AppContext>();

unity.put("/:id/unity", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ baseUrl?: string; username?: string; password?: string }>();
  const baseUrl = body.baseUrl?.trim();
  const username = body.username?.trim();
  if (!baseUrl || !username) return c.json({ error: "baseUrl and username are required" }, 400);
  try {
    assertAllowedConnectorUrl(baseUrl);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid baseUrl" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT password_enc FROM unity_connections WHERE project_id = ?")
    .bind(projectId)
    .first<{ password_enc: string }>();
  let passwordEnc = existing?.password_enc;
  if (body.password) passwordEnc = await encrypt(c.env.ENC_KEY, body.password);
  if (!passwordEnc) return c.json({ error: "password is required" }, 400);

  await c.env.DB.prepare(
    `INSERT INTO unity_connections (project_id, base_url, username, password_enc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET base_url = excluded.base_url, username = excluded.username, password_enc = excluded.password_enc, verified_at = NULL, unity_version = NULL`,
  )
    .bind(projectId, baseUrl, username, passwordEnc)
    .run();
  return c.json({ saved: true });
});

unity.post("/:id/unity/test", async (c) => {
  const client = await getUnityClient(c.env, c.req.param("id"));
  if (!client) return c.json({ ok: false, error: "No Unity connection configured" }, 400);
  try {
    const version = await client.getVersion();
    await c.env.DB.prepare("UPDATE unity_connections SET verified_at = ?, unity_version = ? WHERE project_id = ?")
      .bind(nowIso(), version, c.req.param("id"))
      .run();
    return c.json({ ok: true, unityVersion: version });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof CupiError || e instanceof Error ? e.message : String(e) }, 502);
  }
});

unity.post("/:id/unity/pull", async (c) => {
  try {
    return c.json(await pullFromUnity(c.env, c.req.param("id")));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

unity.post("/:id/unity/pull-greetings", async (c) => {
  try {
    return c.json(await pullGreetingsFromUnity(c.env, c.req.param("id")));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
