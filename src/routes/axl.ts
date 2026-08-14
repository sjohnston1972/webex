import { Hono } from "hono";
import type { AppContext } from "../env";
import { AxlClient, AxlError } from "../axl/client";
import { getAxlClient, pullFromAxl } from "../axl/pull";
import { encrypt } from "../lib/crypto";
import { assertAllowedConnectorUrl } from "../lib/net";
import { nowIso } from "../lib/util";

export const axl = new Hono<AppContext>();

// Save/replace the AXL connection for a project.
axl.put("/:id/axl", async (c) => {
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

// Live reachability check for the UI (fired on page load). Pings CUCM via AXL
// with an 8s cap so a dead tunnel can't stall the page, and reports the real
// state rather than the cached verified_at flag.
axl.get("/:id/axl/status", async (c) => {
  const projectId = c.req.param("id");
  const conn = await c.env.DB.prepare("SELECT base_url, cucm_version, verified_at FROM axl_connections WHERE project_id = ?")
    .bind(projectId)
    .first<{ base_url: string; cucm_version: string | null; verified_at: string | null }>();
  if (!conn) return c.json({ configured: false, connected: false });
  const client = await getAxlClient(c.env, projectId);
  if (!client) return c.json({ configured: false, connected: false });
  try {
    const version = await client.getVersion(8000);
    const checkedAt = nowIso();
    await c.env.DB.prepare("UPDATE axl_connections SET verified_at = ?, cucm_version = ? WHERE project_id = ?")
      .bind(checkedAt, version, projectId)
      .run();
    return c.json({ configured: true, connected: true, cucmVersion: version, checkedAt });
  } catch (e) {
    return c.json({
      configured: true,
      connected: false,
      error: e instanceof AxlError || e instanceof Error ? e.message : String(e),
      cucmVersion: conn.cucm_version,
      lastVerifiedAt: conn.verified_at,
    });
  }
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
