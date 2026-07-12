// Stateless PIN session: cookie value is "<expiryMs>.<hmac>". The HMAC is keyed
// by a subkey derived from ENC_KEY *and* the PIN, so (a) the raw data-encryption
// key isn't reused directly as the cookie MAC key, and (b) rotating PIN_CODE
// invalidates every live session. No DB rows, survives deploys.

const SESSION_DAYS = 30;

function b64urlFromBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importHmacKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Session-signing subkey = HMAC(ENC_KEY, "domain|PIN"). Binds sessions to the current PIN. */
async function sessionKey(encKey: string, pinCode: string): Promise<CryptoKey> {
  const encBytes = Uint8Array.from(atob(encKey.trim()), (c) => c.charCodeAt(0));
  const root = await importHmacKey(encBytes);
  const derived = await crypto.subtle.sign("HMAC", root, new TextEncoder().encode(`wx-pin-session-v1|${pinCode}`));
  return importHmacKey(new Uint8Array(derived));
}

async function sign(encKey: string, pinCode: string, message: string): Promise<string> {
  const key = await sessionKey(encKey, pinCode);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlFromBytes(new Uint8Array(sig));
}

/** Constant-time string comparison — no early exit, so it leaks no timing oracle. */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function issueSession(encKey: string, pinCode: string): Promise<{ cookieValue: string; maxAge: number }> {
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  const sig = await sign(encKey, pinCode, `pin-session:${exp}`);
  return { cookieValue: `${exp}.${sig}`, maxAge: SESSION_DAYS * 24 * 3600 };
}

export async function verifySession(encKey: string, pinCode: string, cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const [expStr, sig] = cookieValue.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now()) return false;
  const expected = await sign(encKey, pinCode, `pin-session:${exp}`);
  return timingSafeEqual(expected, sig);
}
