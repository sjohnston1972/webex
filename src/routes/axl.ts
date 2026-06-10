import { Hono } from "hono";
import type { AppContext } from "../env";
import { AxlClient, AxlError } from "../axl/client";
import { getAxlClient, pullFromAxl } from "../axl/pull";
import { encrypt } from "../lib/crypto";
import { nowIso } from "../lib/util";

export const axl = new Hono<AppContext>();

// Save/replace the AXL connection for a project.
axl.put("/:id/axl", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json<{ baseUrl?: string; username?: string; password?: string }>();
  const baseUrl = body.baseUrl?.trim();
  const username = body.username?.trim();
  if (!baseUrl || !username) return c.json({ error: "baseUrl and username are required" }, 400);
  if (!/^https:\/\//i.test(baseUrl)) return c.json({ error: "baseUrl must be https://" }, 400);

  const existing = await c.env.DB.prepare("SELECT password_enc FROM axl_connections WHERE project_id = ?")
    .bind(projectId)
    .first<{ password_enc: string }>();
  let passwordEnc = existing?.password_enc;
  if (body.password) passwordEnc = await encrypt(c.env.ENC_KEY, body.password);
  if (!passwordEnc) return c.json({ error: "password is required" }, 400);

  await c.env.DB.prepare(
    `INSERT INTO axl_connections (project_id, base_url, username, password_enc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET base_url = excluded.base_url, username = excluded.username, password_enc = excluded.password_enc, verified_at = NULL, cucm_version = NULL`,
  )
    .bind(projectId, baseUrl, username, passwordEnc)
    .run();
  return c.json({ saved: true });
});

axl.post("/:id/axl/test", async (c) => {
  const projectId = c.req.param("id");
  const client = await getAxlClient(c.env, projectId);
  if (!client) return c.json({ ok: false, error: "No AXL connection configured" }, 400);
  try {
    const version = await client.getVersion();
    await c.env.DB.prepare("UPDATE axl_connections SET verified_at = ?, cucm_version = ? WHERE project_id = ?")
      .bind(nowIso(), version, projectId)
      .run();
    return c.json({ ok: true, cucmVersion: version });
  } catch (e) {
    const message = e instanceof AxlError || e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: message }, 502);
  }
});

axl.post("/:id/axl/pull", async (c) => {
  const projectId = c.req.param("id");
  try {
    const result = await pullFromAxl(c.env, projectId);
    return c.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 502);
  }
});
