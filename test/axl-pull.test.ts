import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authedFetch } from "./helpers";

// The bulk SQL pulls (device→line map, pickup membership, route plan) select
// whole CUCM tables. numplan alone is tens of thousands of rows on a real
// cluster, which is exactly what CUCM's response throttle rejects. This drives
// a full pull against a stubbed CUCM and checks every executeSQLQuery is paged.

let sqlQueries: string[] = [];

function soap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

/** Answer every AXL method with an empty result, recording the SQL it was asked for. */
function stubCucm(): void {
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    const method = /<ns:(\w+)>/.exec(body)?.[1] ?? "unknown";
    if (method === "executeSQLQuery") {
      sqlQueries.push(/<sql>([\s\S]*?)<\/sql>/.exec(body)?.[1] ?? "");
    }
    return new Response(soap(`<ns:${method}Response xmlns:ns="http://www.cisco.com/AXL/API/12.5"><return></return></ns:${method}Response>`), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });
  });
}

beforeEach(() => {
  sqlQueries = [];
  stubCucm();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pullFromAxl pages its bulk SQL queries", () => {
  it("issues every executeSQLQuery with SKIP/FIRST and an ORDER BY", async () => {
    const created = await authedFetch("http://x/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "AXL Paging Pull", customer: "Test Co" }),
    });
    const { id } = (await created.json()) as { id: string };

    const saved = await authedFetch(`http://x/api/projects/${id}/axl`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://cucm.example.com", username: "axluser", password: "secret" }),
    });
    expect(saved.status).toBe(200);

    const pull = await authedFetch(`http://x/api/projects/${id}/axl/pull`, { method: "POST" });
    expect(pull.status).toBe(200);

    // Device→line map, pickup membership, route plan.
    expect(sqlQueries).toHaveLength(3);
    for (const q of sqlQueries) {
      expect(q).toMatch(/^select skip 0 first \d+ /);
      expect(q).toMatch(/ order by .*pkid/);
    }
  });
});
