import { XMLParser } from "fast-xml-parser";

// Minimal AXL SOAP client. CUCM serves AXL at https://<host>:8443/axl/.
// Workers can only fetch ports 80/443, so the base URL is typically a
// Cloudflare Tunnel hostname fronting CUCM 8443 (see README).

const AXL_NS = "http://www.cisco.com/AXL/API/12.5";
const AXL_VER = "12.5";

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
  private parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false });

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(method: string, innerXml: string): Promise<any> {
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
      });
    } catch (e) {
      throw new AxlError(
        `Cannot reach AXL at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}. ` +
          `If CUCM is on-prem on port 8443, expose it on 443 via a Cloudflare Tunnel.`,
      );
    }

    const bodyText = await res.text();
    if (res.status === 401) throw new AxlError("AXL authentication failed (401) — check username/password and that the user has the 'Standard AXL API Access' role.", 401);

    let parsed: any;
    try {
      parsed = this.parser.parse(bodyText);
    } catch {
      throw new AxlError(`AXL returned non-XML response (HTTP ${res.status}): ${bodyText.slice(0, 300)}`, res.status);
    }
    const body = parsed?.Envelope?.Body;
    const fault = body?.Fault;
    if (fault) {
      throw new AxlError(`AXL fault: ${text(fault.faultstring) || JSON.stringify(fault).slice(0, 300)}`, res.status);
    }
    if (!res.ok) throw new AxlError(`AXL HTTP ${res.status}: ${bodyText.slice(0, 300)}`, res.status);
    return body?.[`${method}Response`]?.return;
  }

  async getVersion(): Promise<string> {
    const ret = await this.request("getCCMVersion", "");
    return text(ret?.componentVersion?.version);
  }

  async listUsers(): Promise<any[]> {
    const ret = await this.request(
      "listUser",
      `<searchCriteria><userid>%</userid></searchCriteria>
       <returnedTags>
         <userid/><firstName/><lastName/><mailid/><department/>
         <primaryExtension><pattern/><routePartitionName/></primaryExtension>
       </returnedTags>`,
    );
    return ensureArray(ret?.user);
  }

  async listPhones(): Promise<any[]> {
    const ret = await this.request(
      "listPhone",
      `<searchCriteria><name>%</name></searchCriteria>
       <returnedTags><name/><description/><model/><ownerUserName/><devicePoolName/><locationName/></returnedTags>`,
    );
    return ensureArray(ret?.phone);
  }

  async listLines(): Promise<any[]> {
    const ret = await this.request(
      "listLine",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><routePartitionName/></returnedTags>`,
    );
    return ensureArray(ret?.line);
  }

  async listHuntPilots(): Promise<any[]> {
    const ret = await this.request(
      "listHuntPilot",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><huntListName/></returnedTags>`,
    );
    return ensureArray(ret?.huntPilot);
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
    const ret = await this.request(
      "listTransPattern",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><description/><routePartitionName/><calledPartyTransformationMask/><prefixDigitsOut/></returnedTags>`,
    );
    return ensureArray(ret?.transPattern);
  }

  async listPickupGroups(): Promise<any[]> {
    const ret = await this.request(
      "listCallPickupGroup",
      `<searchCriteria><pattern>%</pattern></searchCriteria>
       <returnedTags><pattern/><name/><description/></returnedTags>`,
    );
    return ensureArray(ret?.callPickupGroup);
  }

  /** Thin SQL escape hatch — used for pickup group membership. */
  async sql(query: string): Promise<any[]> {
    const ret = await this.request("executeSQLQuery", `<sql>${escapeXml(query)}</sql>`);
    return ensureArray(ret?.row);
  }
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
