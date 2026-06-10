// Stateless PIN session: cookie value is "<expiryMs>.<hmac>" where the HMAC
// is keyed by ENC_KEY. No DB rows, survives deploys.

const SESSION_DAYS = 30;

async function hmac(keyB64: string, message: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyB64.trim()), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function issueSession(encKey: string): Promise<{ cookieValue: string; maxAge: number }> {
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  const sig = await hmac(encKey, `pin-session:${exp}`);
  return { cookieValue: `${exp}.${sig}`, maxAge: SESSION_DAYS * 24 * 3600 };
}

export async function verifySession(encKey: string, cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const [expStr, sig] = cookieValue.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  return (await hmac(encKey, `pin-session:${exp}`)) === sig;
}
