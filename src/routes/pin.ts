import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../env";
import { issueSession, verifySession } from "../lib/pin";

export const pin = new Hono<AppContext>();

pin.get("/status", async (c) => {
  const ok = await verifySession(c.env.ENC_KEY, getCookie(c, "wx_pin"));
  return c.json({ ok });
});

pin.post("/", async (c) => {
  const body = await c.req.json<{ pin?: string }>().catch(() => ({ pin: undefined }));
  if (!body.pin || body.pin !== c.env.PIN_CODE) {
    return c.json({ ok: false, error: "Incorrect PIN" }, 401);
  }
  const session = await issueSession(c.env.ENC_KEY);
  setCookie(c, "wx_pin", session.cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: session.maxAge,
  });
  return c.json({ ok: true });
});
