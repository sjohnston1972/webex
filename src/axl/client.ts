import { XMLParser } from "fast-xml-parser";

// Minimal AXL SOAP client. CUCM serves AXL at https://<host>:8443/axl/.
// Workers can only fetch ports 80/443, so the base URL is typically a
// Cloudflare Tunnel hostname fronting CUCM 8443 (see README).

const AXL_NS = "http://www.cisco.com/AXL/API/12.5";
const AXL_VER = "12.5";

// CUCM throttles large AXL responses ("Query request too large", commonly a few
// thousand rows / 8 MB), so every list and bulk SQL pull is paged. 1000 rows a
// page keeps a comfortable margin on default throttle settings.
const DEFAULT_PAGE_SIZE = 1000;
// Only getVersion used to pass a timeout; a hung tunnel stalled every other call
// until the Worker's own limit killed the pull.
const DEFAULT_TIMEOUT_MS = 60_000;
// Backstop: a CUCM that ignored <skip> would otherwise loop forever re-reading
// page one. 500 pages is far past any real cluster.
const MAX_PAGES = 500;

export class AxlError extends Error {
  constructor(
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
  }
}

export function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** fast-xml-parser may give a string or { "#text": string } depending on attrs. */
export function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    const t = (value as Record<string, unknown>)["#text"];
    return t === undefined || t === null ? "" : String(t);
  }
  return String(value);
}

export class AxlClient {
  // processEntities:false disables DTD/entity expansion so a hostile or
  // MITM'd response can't mount a billion-laughs expansion DoS against the isolate.
  private parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, processEntities: false });

  private pageSize: number;
  private timeoutMs: number;

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
    opts: { pageSize?: number; timeoutMs?: number } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(method: string, innerXml: string, timeoutMs: number = this.timeoutMs): Promise<any> {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${AXL_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:${method}>${innerXml}</ns:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/axl/`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${this.username}:${this.password}`),
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"CUCM:DB ver=${AXL_VER} ${method}"`,
        },
        body: envelope,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      const reason =
        e instanceof Error && e.name === "TimeoutError"
          ? `timed out after ${timeoutMs}ms (tunnel down or CUCM unreachable)`
          : e instanceof Error
            ? e.message
            : String(e);
      throw new AxlError(
        `Cannot reach AXL at ${this.baseUrl}: ${reason}. ` +
          `If CUCM is on-prem on port 8443, expose it on 443 via a Cloudflare Tunnel.`,
      );
    }

    const bodyText = await res.text();
    if (res.status === 401) throw new AxlError("AXL authentication failed (401) — check username/password and that the user has the 'Standard AXL API Access' role.", 401);

    let parsed: any;
    try {
      parsed = this.parser.parse(bodyText);
    } catch {
      // Don't reflect the raw upstream body — with a misconfigured baseUrl that
      // would echo an arbitrary endpoint's response back to the caller.
      throw new AxlError(`AXL returned a non-XML response (HTTP ${res.status}) — check the baseUrl points at CUCM's /axl endpoint.`, res.status);
    }
    const body = parsed?.Envelope?.Body;
    const fault = body?.Fault;
    if (fault) {
      // faultstring is a parsed AXL error field, safe to surface for debugging.
      const faultString = text(fault.faultstring) || "unspecified AXL fault";
      // Paging should prevent this, but a cluster with a tighter throttle than
      // the default page size assumes still needs to say so in plain English.
      if (/too large|throttle/i.test(faultString)) {
        throw new AxlError(
          `CUCM refused the query as too large ("${faultString}") — retry with a smaller page size (AxlClient pageSize option).`,
          res.status,
        );
      }
      throw new AxlError(`AXL fault: ${faultString}`, res.status);
    }
    if (!res.ok) throw new AxlError(`AXL request failed (HTTP ${res.status}).`, res.status);
    return body?.[`${method}Response`]?.return;
  }

  async getVersion(timeoutMs?: number): Promise<string> {
    const ret = await this.request("getCCMVersion", "", timeoutMs);
    return text(ret?.componentVersion?.version);
  }

  /**
   * Run a list* request in pages. AXL takes <skip>/<first> as siblings of
   * searchCriteria/returnedTags; a page shorter than pageSize is the last one.
   * Return shape is identical to the old single-shot call, so callers are
   * unaffected.
   */
  private async listPaged(method: string, innerXml: string, key: string, pageSize = this.pageSize): Promise<any[]> {
    const all: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const skip = page * pageSize;
      const ret = await this.request(method, `${innerXml}<skip>${skip}</skip><first>${pageSize}</first>`);
      const rows = ensureArray(ret?.[key]);
      all.push(...rows);
      if (rows.length < pageSize) return all;
    }
    throw new AxlError(
      `${method} did not terminate after ${MAX_PAGES} pages of ${pageSize} — CUCM may be ignoring <skip>; check the AXL version.`,
    );
  }

  async listUsers(): Promise<any[]> {
    return this.listPaged(
      "listUser",
      `<searchCriteria><userid>%</userid></searchCriteria>
       <returnedTags>
         <userid/><firstName/><lastName/><mailid/><department/>
         <primaryExtension><pattern/><routePartitionName/></primaryExtension>
       </returnedTags>`,
      "user",
    );
  }

  async listPhones(): Promise<any[]> {
    return this.listPaged(
      "listPhone",
      `<searchCriteria><name>%</name></searchCriteria>
       <returnedTags><name/><description/><model/><ownerUserName/><devicePoolName/><locationName/></returnedTags>`,
      "phone",
    );
  }

  async listLines(): Promise<any[]> {
    return this.listPaged(
      "listLine",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><routePartitionName/></returnedTags>`,
      "line",
    );
  }

  async listHuntPilots(): Promise<any[]> {
    return this.listPaged(
      "listHuntPilot",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><huntListName/></returnedTags>`,
      "huntPilot",
    );
  }

  /** Returns ordered line group names for a hunt list. */
  async getHuntListMembers(huntListName: string): Promise<string[]> {
    const ret = await this.request(
      "getHuntList",
      `<name>${escapeXml(huntListName)}</name>
       <returnedTags><name/><members><member><lineGroupName/><selectionOrder/></member></members></returnedTags>`,
    );
    const members = ensureArray(ret?.huntList?.members?.member);
    return members
      .sort((a: any, b: any) => Number(text(a.selectionOrder)) - Number(text(b.selectionOrder)))
      .map((m: any) => text(m.lineGroupName))
      .filter(Boolean);
  }

  /** Returns the distribution algorithm and ordered member DNs of a line group. */
  async getLineGroup(name: string): Promise<{ algorithm: string; members: string[] }> {
    const ret = await this.request(
      "getLineGroup",
      `<name>${escapeXml(name)}</name>
       <returnedTags>
         <name/><distributionAlgorithm/>
         <members><member><lineSelectionOrder/><directoryNumber><pattern/><routePartitionName/></directoryNumber></member></members>
       </returnedTags>`,
    );
    const lg = ret?.lineGroup;
    const members = ensureArray(lg?.members?.member)
      .sort((a: any, b: any) => Number(text(a.lineSelectionOrder)) - Number(text(b.lineSelectionOrder)))
      .map((m: any) => text(m.directoryNumber?.pattern))
      .filter(Boolean);
    return { algorithm: text(lg?.distributionAlgorithm), members };
  }

  async listTranslationPatterns(): Promise<any[]> {
    return this.listPaged(
      "listTransPattern",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><routePartitionName/><calledPartyTransformationMask/><prefixDigitsOut/></returnedTags>`,
      "transPattern",
    );
  }

  async listPickupGroups(): Promise<any[]> {
    return this.listPaged(
      "listCallPickupGroup",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><name/><description/></returnedTags>`,
      "callPickupGroup",
    );
  }

  // --- dial plan (report-only objects) ---

  async listRoutePartitions(): Promise<any[]> {
    return this.listPaged(
      "listRoutePartition",
      `<searchCriteria><name>%</name></searchCriteria><returnedTags><name/><description/></returnedTags>`,
      "routePartition",
    );
  }

  async listCss(): Promise<any[]> {
    return this.listPaged(
      "listCss",
      `<searchCriteria><name>%</name></searchCriteria><returnedTags><name/><description/><clause/></returnedTags>`,
      "css",
    );
  }

  async listRoutePatterns(): Promise<any[]> {
    return this.listPaged(
      "listRoutePattern",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><routePartitionName/><blockEnable/></returnedTags>`,
      "routePattern",
    );
  }

  async listRouteLists(): Promise<any[]> {
    return this.listPaged(
      "listRouteList",
      `<searchCriteria><name>%</name></searchCriteria><returnedTags><name/><description/></returnedTags>`,
      "routeList",
    );
  }

  async listRouteGroups(): Promise<any[]> {
    return this.listPaged(
      "listRouteGroup",
      `<searchCriteria><name>%</name></searchCriteria><returnedTags><name/></returnedTags>`,
      "routeGroup",
    );
  }

  async listSipTrunks(): Promise<any[]> {
    return this.listPaged(
      "listSipTrunk",
      `<searchCriteria><name>%</name></searchCriteria><returnedTags><name/><description/></returnedTags>`,
      "sipTrunk",
    );
  }

  /** Thin SQL escape hatch — for queries small enough to answer in one response. */
  async sql(query: string): Promise<any[]> {
    const ret = await this.request("executeSQLQuery", `<sql>${escapeXml(query)}</sql>`);
    return ensureArray(ret?.row);
  }

  /**
   * Page a bulk SQL pull. Informix wants SKIP/FIRST immediately after `select`,
   * so pass the query *without* its leading `select` — e.g.
   * `sqlPaged("n.dnorpattern as dn from numplan n", "n.pkid")`. The ORDER BY key
   * must be unique and stable (a pkid), otherwise rows can shift between pages
   * and be skipped or double-counted.
   */
  async sqlPaged(baseQuery: string, orderBy: string, pageSize = this.pageSize): Promise<any[]> {
    const all: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const skip = page * pageSize;
      const rows = await this.sql(`select skip ${skip} first ${pageSize} ${baseQuery} order by ${orderBy}`);
      all.push(...rows);
      if (rows.length < pageSize) return all;
    }
    throw new AxlError(
      `SQL query did not terminate after ${MAX_PAGES} pages of ${pageSize} — check the ORDER BY key "${orderBy}" is unique.`,
    );
  }
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
