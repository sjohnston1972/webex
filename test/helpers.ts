import { SELF } from "cloudflare:test";

let cookie: string | null = null;

/** Unlock the PIN gate once and reuse the session cookie. */
export async function pinCookie(): Promise<string> {
  if (cookie) return cookie;
  const res = await SELF.fetch("http://x/api/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "435040" }),
  });
  if (res.status !== 200) throw new Error(`PIN unlock failed in tests: ${res.status}`);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return cookie;
}

export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const c = await pinCookie();
  return SELF.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: c } });
}
