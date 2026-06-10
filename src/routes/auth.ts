import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppContext } from "../env";
import { exchangeCode, REQUESTED_SCOPES, storeTokens, WebexClient } from "../webex/client";

export const auth = new Hono<AppContext>();

// Kick off OAuth for a project. State = projectId.nonce, nonce mirrored in a cookie.
auth.get("/login", async (c) => {
  const projectId = c.req.query("project");
  if (!projectId) return c.text("project query param required", 400);
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) return c.text("project not found", 404);

  const nonce = crypto.randomUUID();
  setCookie(c, "wx_oauth", nonce, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });

  const url = new URL("https://webexapis.com/v1/authorize");
  url.searchParams.set("client_id", c.env.WEBEX_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", c.env.WEBEX_REDIRECT_URL);
  url.searchParams.set("scope", REQUESTED_SCOPES);
  url.searchParams.set("state", `${projectId}.${nonce}`);
  return c.redirect(url.toString());
});

auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  const error = c.req.query("error");
  if (error) return c.text(`Webex authorization failed: ${error} — ${c.req.query("error_description") ?? ""}`, 400);
  if (!code) return c.text("Missing code", 400);

  const [projectId, nonce] = state.split(".");
  const cookieNonce = getCookie(c, "wx_oauth");
  if (!projectId || !nonce || nonce !== cookieNonce) return c.text("State mismatch — restart the connection from the app", 400);
  deleteCookie(c, "wx_oauth", { path: "/" });

  try {
    const tokens = await exchangeCode(c.env, code);
    // Identify the org for display before storing.
    const temp = WebexClient.fromToken(c.env, projectId, tokens.accessToken);
    const me = (await temp.me()) as any;
    let orgName = "";
    try {
      orgName = ((await temp.org(me.orgId)) as any)?.displayName ?? "";
    } catch {
      orgName = me.orgId;
    }
    await storeTokens(c.env, projectId, tokens, { id: me.orgId, name: orgName });
    await c.env.DB.prepare("UPDATE projects SET webex_org_id = ? WHERE id = ?").bind(me.orgId, projectId).run();
    return c.redirect(`/projects/${projectId}/webex?connected=1`);
  } catch (e) {
    return c.text(`Webex connection failed: ${e instanceof Error ? e.message : e}`, 502);
  }
});
