/**
 * Server-side URL guards for outbound fetches (SSRF hardening).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ip, base, bits) {
  const shift = 32 - bits;
  return ipv4ToInt(ip) >>> shift === ipv4ToInt(base) >>> shift;
}

export function isBlockedIpv4(ip) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return true;
  const parts = ip.split(".").map(Number);
  if (parts.some((n) => n > 255)) return true;
  return (
    inCidr(ip, "0.0.0.0", 8) ||
    inCidr(ip, "10.0.0.0", 8) ||
    inCidr(ip, "127.0.0.0", 8) ||
    inCidr(ip, "169.254.0.0", 16) ||
    inCidr(ip, "172.16.0.0", 12) ||
    inCidr(ip, "192.168.0.0", 16) ||
    inCidr(ip, "100.64.0.0", 10) ||
    inCidr(ip, "192.0.0.0", 24) ||
    inCidr(ip, "192.0.2.0", 24) ||
    inCidr(ip, "198.51.100.0", 24) ||
    inCidr(ip, "203.0.113.0", 24) ||
    inCidr(ip, "224.0.0.0", 4) ||
    inCidr(ip, "240.0.0.0", 4)
  );
}

export function isBlockedIpv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true; // fe80::/10
  }
  // IPv4-mapped IPv6
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return isBlockedIpv4(v4);
  }
  return false;
}

export function isBlockedIp(ip) {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const version = isIP(host);
  if (version) return isBlockedIp(host);
  return false;
}

/**
 * Parse and reject non-http(s), credentials, and blocked hostnames/IP literals.
 * Does not perform DNS — call assertSafeResolvedUrl before fetch.
 */
export function parsePublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("invalid_scheme");
  }
  if (url.username || url.password) {
    throw new Error("credentials_forbidden");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error("blocked_host");
  }
  return url;
}

export async function assertSafeResolvedUrl(raw) {
  const url = parsePublicHttpUrl(raw);
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("dns_failed");
  }
  if (!addresses.length) throw new Error("dns_failed");
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new Error("blocked_resolved_ip");
  }
  return url;
}

/**
 * Fetch a public http(s) URL with redirect validation (no private hops).
 */
export async function safeFetch(raw, { signal, headers, maxRedirects = 5 } = {}) {
  let current = String(raw);
  for (let i = 0; i <= maxRedirects; i += 1) {
    await assertSafeResolvedUrl(current);
    const res = await fetch(current, {
      signal,
      headers,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("redirect_missing_location");
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new Error("too_many_redirects");
}
