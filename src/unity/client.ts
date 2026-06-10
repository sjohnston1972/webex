// Minimal Unity Connection CUPI (REST) client. Unity serves CUPI at
// https://<host>/vmrest/ — like AXL, on-prem boxes are fronted by the
// Cloudflare Tunnel so the Worker can reach them on 443.

export class CupiError extends Error {
  constructor(
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
  }
}

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export class UnityClient {
  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T = any>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/vmrest${path}`, {
        headers: {
          Authorization: "Basic " + btoa(`${this.username}:${this.password}`),
          Accept: "application/json",
        },
      });
    } catch (e) {
      throw new CupiError(
        `Cannot reach Unity CUPI at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}. ` +
          `If Unity is on-prem, expose it on 443 via the Cloudflare Tunnel.`,
      );
    }
    if (res.status === 401) throw new CupiError("Unity authentication failed (401) — check username/password", 401);
    const text = await res.text();
    if (!res.ok) throw new CupiError(`CUPI HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CupiError(`CUPI returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
    }
  }

  async getVersion(): Promise<string> {
    try {
      const v = await this.request<any>("/version");
      return String(v.version ?? v.name ?? "unknown");
    } catch (e) {
      // Older builds lack /version — fall back to proving auth against users.
      if (e instanceof CupiError && e.httpStatus && e.httpStatus !== 401) {
        await this.request("/users?rowsPerPage=1&pageNumber=1");
        return "reachable (version endpoint unavailable)";
      }
      throw e;
    }
  }

  private async requestBinary(path: string): Promise<ArrayBuffer | null> {
    const res = await fetch(`${this.baseUrl}/vmrest${path}`, {
      headers: { Authorization: "Basic " + btoa(`${this.username}:${this.password}`) },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new CupiError(`CUPI HTTP ${res.status} downloading ${path}`, res.status);
    return res.arrayBuffer();
  }

  /** Recorded stream files for a call handler's Standard greeting (empty = no custom recording). */
  async listGreetingStreams(callHandlerObjectId: string): Promise<{ languageCode: string }[]> {
    try {
      const r = await this.request<any>(`/handlers/callhandlers/${callHandlerObjectId}/greetings/Standard/greetingstreamfiles`);
      return ensureArray(r.GreetingStreamFile).map((g: any) => ({ languageCode: String(g.LanguageCode ?? "1033") }));
    } catch (e) {
      if (e instanceof CupiError && e.httpStatus === 404) return [];
      throw e;
    }
  }

  /** Download the Standard greeting WAV, or null if none recorded. */
  downloadGreeting(callHandlerObjectId: string, languageCode: string): Promise<ArrayBuffer | null> {
    return this.requestBinary(`/handlers/callhandlers/${callHandlerObjectId}/greetings/Standard/greetingstreamfiles/${languageCode}/audio`);
  }

  /** All voicemail users (paged). */
  async listUsers(): Promise<any[]> {
    const users: any[] = [];
    const pageSize = 200;
    for (let page = 1; page <= 50; page++) {
      const r = await this.request<any>(`/users?rowsPerPage=${pageSize}&pageNumber=${page}`);
      const batch = ensureArray(r.User);
      users.push(...batch);
      const total = Number(r["@total"] ?? users.length);
      if (users.length >= total || batch.length === 0) break;
    }
    return users;
  }
}
