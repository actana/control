import { isIP, isIPv4, isIPv6 } from "node:net";

/**
 * SSRF address checks for webhook delivery (#574): refuse private, loopback,
 * link-local, unique-local, multicast and unspecified addresses for IPv4 and
 * IPv6, including IPv4-mapped IPv6. The delivery worker resolves the host,
 * runs every answer through {@link isBlockedWebhookAddress}, then connects to
 * the checked IP with the original host for TLS SNI and the Host header.
 */

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

/** Strip brackets and a zone id (`fe80::1%eth0`) so `isIP` / range checks see a bare address. */
function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  return ip;
}

/** Embedded IPv4 in an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:aabb:ccdd`). */
function ipv4MappedEmbedded(ip: string): string | null {
  if (ip.startsWith("::ffff:")) {
    const rest = ip.slice("::ffff:".length);
    if (isIPv4(rest)) return rest;
    // Hex form ::ffff:7f00:1 → 127.0.0.1
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
    if (m) {
      const hi = Number.parseInt(m[1]!, 16);
      const lo = Number.parseInt(m[2]!, 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

function isBlockedIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return true;
  const [a, b] = o;
  // Unspecified 0.0.0.0/8
  if (a === 0) return true;
  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // Private 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16
  if (a === 169 && b === 254) return true;
  // Multicast 224.0.0.0/4 and reserved 240.0.0.0/4
  if (a! >= 224) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const embedded = ipv4MappedEmbedded(ip);
  if (embedded) return isBlockedIpv4(embedded);

  // Unspecified ::
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return true;
  // Loopback ::1
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;

  // Expand enough of the first hextet for prefix checks.
  const first = ip.split(":")[0] ?? "";
  const firstNum = Number.parseInt(first || "0", 16);
  if (!Number.isFinite(firstNum)) return true;
  // Unique-local fc00::/7
  if ((firstNum & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((firstNum & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((firstNum & 0xff00) === 0xff00) return true;
  return false;
}

/** True when `address` must not be dialed for a webhook delivery. */
export function isBlockedWebhookAddress(address: string): boolean {
  const ip = normalizeIp(address);
  if (!isIP(ip)) return true;
  if (isIPv4(ip)) return isBlockedIpv4(ip);
  if (isIPv6(ip)) return isBlockedIpv6(ip);
  return true;
}
