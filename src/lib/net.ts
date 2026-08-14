// SSRF guard for connector base URLs (AXL / CUPI). The intended target is a
// *public* Cloudflare Tunnel hostname fronting on-prem CUCM/Unity, so we allow
// public https hosts but reject loopback, private, link-local and cloud-metadata
// addresses — whether supplied as IP literals or obvious internal names — so the
// Worker can't be pointed at internal edge services.

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (m.slice(1).some((o) => Number(o) > 255)) return false; // not a valid dotted-quad
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  return false;
}

/**
 * Validate and normalise a connector base URL, throwing if it is not a public
 * https endpoint. Returns the parsed URL on success.
 */
export function assertAllowedConnectorUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("baseUrl is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("baseUrl must be https://");

  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) throw new Error("baseUrl has no host");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new Error("baseUrl must be a public host, not localhost or an internal name");
  }
  if (isPrivateIPv4(host)) throw new Error("baseUrl must not point at a private, loopback or link-local address");
  if (host.includes(":")) {
    // IPv6 literal: block loopback (::1), unique-local (fc00::/7 → fc/fd) and link-local (fe80::/10).
    if (host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) {
      throw new Error("baseUrl must not point at a private, loopback or link-local address");
    }
  }
  return url;
}
