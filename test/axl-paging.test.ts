import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxlClient, AxlError } from "../src/axl/client";

// CUCM throttles large AXL responses ("Query request too large"). A lab cluster
// answers a single unpaged list fine; a production estate of a few thousand
// phones does not. These tests drive the client against a stubbed CUCM so the
// paging loop is exercised without a live cluster.

let bodies: string[] = [];
let inits: RequestInit[] = [];
let pages: string[] = [];

function soap(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function userPage(ids: string[]): string {
  const users = ids.map((id) => `<user uuid="{${id}}"><userid>${id}</userid><firstName>F${id}</firstName></user>`).join("");
  return soap(`<ns:listUserResponse xmlns:ns="http://www.cisco.com/AXL/API/12.5"><return>${users}</return></ns:listUserResponse>`);
}

function rowPage(dns: string[]): string {
  const rows = dns.map((dn) => `<row><dn>${dn}</dn></row>`).join("");
  return soap(`<ns:executeSQLQueryResponse xmlns:ns="http://www.cisco.com/AXL/API/12.5"><return>${rows}</return></ns:executeSQLQueryResponse>`);
}

function fault(message: string): string {
  return soap(`<soapenv:Fault><faultcode>Server</faultcode><faultstring>${message}</faultstring></soapenv:Fault>`);
}

beforeEach(() => {
  bodies = [];
  inits = [];
  pages = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    inits.push(init);
    const page = pages.shift();
    if (page === undefined) throw new Error(`stub CUCM ran out of pages after ${bodies.length} request(s)`);
    return new Response(page, { status: 200, headers: { "Content-Type": "text/xml" } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** skip/first values the client actually asked CUCM for, in request order. */
function requestedWindows(): [number, number][] {
  return bodies.map((b) => {
    const skip = /<skip>(\d+)<\/skip>/.exec(b);
    const first = /<first>(\d+)<\/first>/.exec(b);
    return [Number(skip?.[1] ?? -1), Number(first?.[1] ?? -1)] as [number, number];
  });
}

describe("AxlClient list paging", () => {
  it("concatenates pages until a short one, advancing skip each time", async () => {
    pages = [userPage(["a", "b"]), userPage(["c", "d"]), userPage(["e"])];
    const client = new AxlClient("https://cucm.example.com", "u", "p", { pageSize: 2 });

    const users = await client.listUsers();

    expect(users.map((u) => u.userid)).toEqual(["a", "b", "c", "d", "e"]);
    expect(requestedWindows()).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);
  });

  it("makes exactly one request when the first page is already short", async () => {
    pages = [userPage(["only"])];
    const client = new AxlClient("https://cucm.example.com", "u", "p", { pageSize: 2 });

    const users = await client.listUsers();

    expect(users).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });

  it("stops on the empty page after an exactly-full last page", async () => {
    pages = [userPage(["a", "b"]), userPage([])];
    const client = new AxlClient("https://cucm.example.com", "u", "p", { pageSize: 2 });

    const users = await client.listUsers();

    expect(users.map((u) => u.userid)).toEqual(["a", "b"]);
    expect(bodies).toHaveLength(2);
  });

  it("unwraps a single-element page (AXL returns an object, not an array)", async () => {
    pages = [userPage(["solo"])];
    const client = new AxlClient("https://cucm.example.com", "u", "p", { pageSize: 5 });

    const users = await client.listUsers();

    expect(users).toHaveLength(1);
    expect(users[0].userid).toBe("solo");
  });

  it("gives every request a timeout, not just getVersion", async () => {
    pages = [userPage([])];
    const client = new AxlClient("https://cucm.example.com", "u", "p", { pageSize: 2 });

    await client.listUsers();

    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a query-too-large fault into actionable guidance", async () => {
    pages = [fault("Query request too large. Please specify a smaller result set.")];
    const client = new AxlClient("https://cucm.example.com", "u", "p", { pageSize: 2000 });

    await expect(client.listUsers()).rejects.toThrow(AxlError);
    pages = [fault("Query request too large. Please specify a smaller result set.")];
    await expect(client.listUsers()).rejects.toThrow(/smaller page size/i);
  });
});

describe("AxlClient SQL paging", () => {
  it("pages executeSQLQuery with Informix SKIP/FIRST and a stable ORDER BY", async () => {
    pages = [rowPage(["1001", "1002"]), rowPage(["1003"])];
    const client = new AxlClient("https://cucm.example.com", "u", "p");

    const rows = await client.sqlPaged("n.dnorpattern as dn from numplan n", "n.pkid", 2);

    expect(rows.map((r) => r.dn)).toEqual([1001, 1002, 1003]);
    expect(bodies[0]).toContain("select skip 0 first 2 n.dnorpattern as dn from numplan n order by n.pkid");
    expect(bodies[1]).toContain("select skip 2 first 2 n.dnorpattern as dn from numplan n order by n.pkid");
  });

  it("makes exactly one request when the first SQL page is short", async () => {
    pages = [rowPage(["1001"])];
    const client = new AxlClient("https://cucm.example.com", "u", "p");

    const rows = await client.sqlPaged("n.dnorpattern as dn from numplan n", "n.pkid", 2);

    expect(rows).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });

  it("leaves the unpaged sql() escape hatch working", async () => {
    pages = [rowPage(["1001", "1002"])];
    const client = new AxlClient("https://cucm.example.com", "u", "p");

    const rows = await client.sql("select 1 from dual");

    expect(rows).toHaveLength(2);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("skip");
  });
});
