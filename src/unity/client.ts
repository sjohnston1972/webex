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
    // Don't reflect the raw upstream body — with a misconfigured baseUrl that
    // would echo an arbitrary endpoint's response back to the caller.
    if (!res.ok) throw new CupiError(`CUPI request failed (HTTP ${res.status}).`, res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CupiError(`CUPI returned a non-JSON response (HTTP ${res.status}) — check the baseUrl points at Unity's /vmrest endpoint.`, res.status);
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
    const id = encodeURIComponent(callHandlerObjectId);
    try {
      const r = await this.request<any>(`/handlers/callhandlers/${id}/greetings/Standard/greetingstreamfiles`);
      return ensureArray(r.GreetingStreamFile).map((g: any) => ({ languageCode: String(g.LanguageCode ?? "1033") }));
    } catch (e) {
      if (e instanceof CupiError && e.httpStatus === 404) return [];
      throw e;
    }
  }

  /** Download the Standard greeting WAV, or null if none recorded. */
  downloadGreeting(callHandlerObjectId: string, languageCode: string): Promise<ArrayBuffer | null> {
    const id = encodeURIComponent(callHandlerObjectId);
    const lang = encodeURIComponent(languageCode);
    return this.requestBinary(`/handlers/callhandlers/${id}/greetings/Standard/greetingstreamfiles/${lang}/audio`);
  }

  /** Non-primary call handlers (the real IVR/menu handlers, not per-user mailbox handlers). */
  async listCallHandlers(): Promise<any[]> {
    const r = await this.request<any>(`/handlers/callhandlers?query=(IsPrimary%20is%200)&rowsPerPage=200`);
    return ensureArray(r.Callhandler);
  }

  async getMenuEntries(callHandlerObjectId: string): Promise<any[]> {
    const r = await this.request<any>(`/handlers/callhandlers/${encodeURIComponent(callHandlerObjectId)}/menuentries`);
    return ensureArray(r.MenuEntry);
  }

  /** All voicemail users (paged). */
  async listUsers(): Promise<any[]> {
    const users: any[] = [];
    const pageSize = 200;
    const maxPages = 500; // ceiling of 100k mailboxes — larger than any real Unity
    for (let page = 1; page <= maxPages; page++) {
      const r = await this.request<any>(`/users?rowsPerPage=${pageSize}&pageNumber=${page}`);
      const batch = ensureArray(r.User);
      users.push(...batch);
      const total = Number(r["@total"] ?? users.length);
      if (users.length >= total || batch.length === 0) return users;
      // Guard against silent truncation: if we hit the ceiling with more to
      // come, fail loudly rather than quietly dropping the remaining mailboxes.
      if (page === maxPages && users.length < total) {
        throw new CupiError(`Unity reports ${total} mailboxes — exceeds the ${pageSize * maxPages} paging ceiling; narrow the export.`);
      }
    }
    return users;
  }
}
