import { describe, expect, it } from "vitest";
import { assertAllowedConnectorUrl } from "../src/lib/net";

describe("assertAllowedConnectorUrl", () => {
  it("allows a public https host (e.g. a Cloudflare Tunnel hostname)", () => {
    expect(() => assertAllowedConnectorUrl("https://cucm.tunnel.example.com/axl/")).not.toThrow();
    expect(assertAllowedConnectorUrl("https://cucm.example.com").hostname).toBe("cucm.example.com");
  });

  it("rejects non-https", () => {
    expect(() => assertAllowedConnectorUrl("http://cucm.example.com")).toThrow(/https/);
  });

  it("rejects localhost and internal names", () => {
    expect(() => assertAllowedConnectorUrl("https://localhost/axl")).toThrow();
    expect(() => assertAllowedConnectorUrl("https://cucm.internal/axl")).toThrow();
    expect(() => assertAllowedConnectorUrl("https://box.local/axl")).toThrow();
  });

  it("rejects private, loopback and link-local IPv4 (incl. cloud metadata)", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.9.9", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(() => assertAllowedConnectorUrl(`https://${h}/axl`), h).toThrow();
    }
  });

  it("rejects IPv6 loopback / unique-local / link-local literals", () => {
    for (const h of ["[::1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]"]) {
      expect(() => assertAllowedConnectorUrl(`https://${h}/axl`), h).toThrow();
    }
  });

  it("does not falsely block public hosts that start with f-letters", () => {
    expect(() => assertAllowedConnectorUrl("https://fdicorp.example.com")).not.toThrow();
    expect(() => assertAllowedConnectorUrl("https://fe-labs.example.com")).not.toThrow();
  });

  it("rejects a public IPv4 that is not private (still allowed)", () => {
    // 8.8.8.8 is public — the guard is about blocking internal ranges, not all IPs.
    expect(() => assertAllowedConnectorUrl("https://8.8.8.8/axl")).not.toThrow();
  });
});
