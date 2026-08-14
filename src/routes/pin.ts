import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../env";
import { issueSession, timingSafeEqual, verifySession } from "../lib/pin";
import { clearPinFailures, pinLockoutSeconds, recordPinFailure } from "../lib/pin-throttle";

export const pin = new Hono<AppContext>();

pin.get("/status", async (c) => {
  const ok = await verifySession(c.env.ENC_KEY, c.env.PIN_CODE, getCookie(c, "wx_pin"));
  return c.json({ ok });
});

pin.post("/", async (c) => {
  const ip = c.req.header("CF-Connecting-IP");
  const retryAfter = await pinLockoutSeconds(c.env, ip);
  if (retryAfter > 0) {
    return c.json({ ok: false, error: "Too many attempts — try again later" }, 429, { "Retry-After": String(retryAfter) });
  }

  const body = await c.req.json<{ pin?: string }>().catch(() => ({ pin: undefined }));
  if (!body.pin || !timingSafeEqual(body.pin, c.env.PIN_CODE)) {
    await recordPinFailure(c.env, ip);
    return c.json({ ok: false, error: "Incorrect PIN" }, 401);
  }
  await clearPinFailures(c.env, ip);
  const session = await issueSession(c.env.ENC_KEY, c.env.PIN_CODE);
  setCookie(c, "wx_pin", session.cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: session.maxAge,
  });
  return c.json({ ok: true });
});
