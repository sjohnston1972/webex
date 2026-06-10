import type { Env } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { nowIso } from "../lib/util";

const BASE = "https://webexapis.com/v1";

// Scopes requested at authorize time — must be a subset of the integration's configured scopes.
export const REQUESTED_SCOPES = [
  "spark-admin:people_read",
  "spark-admin:people_write",
  "spark-admin:telephony_config_read",
  "spark-admin:telephony_config_write",
  "spark-admin:locations_read",
  "spark-admin:locations_write",
  "spark-admin:licenses_read",
  "spark:kms",
].join(" ");

export class WebexError extends Error {
  constructor(
    message: string,
    public status: number,
    public trackingId?: string,
  ) {
    super(message);
  }
}

type TokenRow = {
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
};

export async function exchangeCode(env: Env, code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const res = await fetch(`${BASE}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.WEBEX_CLIENT_ID,
      client_secret: env.WEBEX_SECRET,
      code,
      redirect_uri: env.WEBEX_REDIRECT_URL,
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new WebexError(`Token exchange failed: ${body.message ?? JSON.stringify(body)}`, res.status);
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
}

export async function storeTokens(
  env: Env,
  projectId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  org?: { id: string; name: string },
): Promise<void> {
  const accessEnc = await encrypt(env.ENC_KEY, tokens.accessToken);
  const refreshEnc = await encrypt(env.ENC_KEY, tokens.refreshToken);
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO webex_tokens (project_id, access_token_enc, refresh_token_enc, expires_at, scopes, org_id, org_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at,
       scopes = COALESCE(excluded.scopes, webex_tokens.scopes),
       org_id = COALESCE(excluded.org_id, webex_tokens.org_id),
       org_name = COALESCE(excluded.org_name, webex_tokens.org_name),
       updated_at = excluded.updated_at`,
  )
    .bind(projectId, accessEnc, refreshEnc, expiresAt, REQUESTED_SCOPES, org?.id ?? null, org?.name ?? null, nowIso())
    .run();
}

export class WebexClient {
  private constructor(
    private env: Env,
    private projectId: string,
    private accessToken: string,
  ) {}

  /** Load tokens for a project, refreshing if within 5 minutes of expiry. */
  static async forProject(env: Env, projectId: string): Promise<WebexClient> {
    const row = await env.DB.prepare("SELECT access_token_enc, refresh_token_enc, expires_at FROM webex_tokens WHERE project_id = ?")
      .bind(projectId)
      .first<TokenRow>();
    if (!row) throw new WebexError("Webex is not connected for this project", 401);

    let accessToken = await decrypt(env.ENC_KEY, row.access_token_enc);
    if (new Date(row.expires_at).getTime() - Date.now() < 5 * 60 * 1000) {
      const refreshToken = await decrypt(env.ENC_KEY, row.refresh_token_enc);
      const res = await fetch(`${BASE}/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.WEBEX_CLIENT_ID,
          client_secret: env.WEBEX_SECRET,
          refresh_token: refreshToken,
        }),
      });
      const body = (await res.json()) as any;
      if (!res.ok) throw new WebexError(`Token refresh failed: ${body.message ?? res.status} — reconnect Webex`, 401);
      accessToken = body.access_token;
      await storeTokens(env, projectId, {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? refreshToken,
        expiresIn: body.expires_in,
      });
    }
    return new WebexClient(env, projectId, accessToken);
  }

  static fromToken(env: Env, projectId: string, accessToken: string): WebexClient {
    return new WebexClient(env, projectId, accessToken);
  }

  async request<T = any>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, Math.min(waitMs, 30_000)));
          continue;
        }
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (!res.ok) {
        const trackingId = res.headers.get("trackingid") ?? undefined;
        const message = (json as any)?.message ?? text.slice(0, 300) ?? res.statusText;
        throw new WebexError(`${method} ${path} → ${res.status}: ${message}`, res.status, trackingId);
      }
      return json as T;
    }
    throw new WebexError(`${method} ${path}: retries exhausted`, 429);
  }

  // --- helpers used across validation/push ---

  me() {
    return this.request("GET", "/people/me");
  }

  async org(orgId: string) {
    return this.request("GET", `/organizations/${orgId}`);
  }

  async listLocations(): Promise<any[]> {
    // The locations API rejects max > 500.
    const r = await this.request("GET", "/locations", undefined, { max: "500" });
    return r.items ?? [];
  }

  async listLicenses(): Promise<any[]> {
    const r = await this.request("GET", "/licenses");
    return r.items ?? [];
  }

  async findPersonByEmail(email: string): Promise<any | null> {
    const r = await this.request("GET", "/people", undefined, { email });
    return r.items?.[0] ?? null;
  }

  async listNumbers(filter?: Record<string, string>): Promise<any[]> {
    const r = await this.request("GET", "/telephony/config/numbers", undefined, { max: "2000", ...filter });
    return r.phoneNumbers ?? [];
  }

  createPerson(payload: Record<string, unknown>) {
    return this.request("POST", "/people", payload, { callingData: "true" });
  }

  deletePerson(personId: string) {
    return this.request("DELETE", `/people/${personId}`);
  }

  createHuntGroup(locationId: string, payload: Record<string, unknown>) {
    return this.request("POST", `/telephony/config/locations/${locationId}/huntGroups`, payload);
  }

  deleteHuntGroup(locationId: string, huntGroupId: string) {
    return this.request("DELETE", `/telephony/config/locations/${locationId}/huntGroups/${huntGroupId}`);
  }

  createCallPickup(locationId: string, payload: Record<string, unknown>) {
    return this.request("POST", `/telephony/config/locations/${locationId}/callPickups`, payload);
  }

  deleteCallPickup(locationId: string, callPickupId: string) {
    return this.request("DELETE", `/telephony/config/locations/${locationId}/callPickups/${callPickupId}`);
  }

  createLocation(payload: Record<string, unknown>) {
    return this.request("POST", "/locations", payload);
  }

  /** Enable an existing location for Webex Calling (requires full location details incl. name). */
  enableLocationCalling(location: { id: string; name: string; timeZone: string; preferredLanguage: string; announcementLanguage: string; address: Record<string, string> }) {
    return this.request("POST", "/telephony/config/locations", location);
  }

  createTranslationPattern(payload: Record<string, unknown>) {
    return this.request("POST", "/telephony/config/callRouting/translationPatterns", payload);
  }

  deleteTranslationPattern(translationPatternId: string) {
    return this.request("DELETE", `/telephony/config/callRouting/translationPatterns/${translationPatternId}`);
  }

  setVoicemail(personId: string, enabled: boolean) {
    return this.request("PUT", `/people/${personId}/features/voicemail`, {
      enabled,
      sendBusyCalls: { enabled: true },
      sendUnansweredCalls: { enabled: true, numberOfRings: 4 },
      messageStorage: { mwiEnabled: true, storageType: "INTERNAL" },
    });
  }
}

/** Pick the licence used for migrated people: prefer Calling Professional, never Workspaces/Hot-desk. */
export function pickCallingLicense(licenses: any[]): any | undefined {
  const usable = licenses.filter(
    (l: any) =>
      /webex calling/i.test(l.name) &&
      !/workspaces|hot desk/i.test(l.name) &&
      (l.totalUnits === undefined || l.consumedUnits < l.totalUnits),
  );
  return usable.find((l: any) => /professional/i.test(l.name)) ?? usable[0];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
