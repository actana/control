import { describe, expect, it } from "vitest";
import { isBlockedWebhookAddress } from "../webhook-ssrf";

/**
 * Addresses a webhook delivery must refuse (#574): private, loopback,
 * link-local, unique-local, multicast and unspecified, IPv4 and IPv6,
 * including IPv4-mapped IPv6.
 */

const REFUSED: { address: string; why: string }[] = [
  { address: "127.0.0.1", why: "IPv4 loopback" },
  { address: "127.0.0.2", why: "IPv4 loopback range" },
  { address: "0.0.0.0", why: "IPv4 unspecified" },
  { address: "10.0.0.1", why: "IPv4 private 10/8" },
  { address: "172.16.0.1", why: "IPv4 private 172.16/12" },
  { address: "172.31.255.255", why: "IPv4 private 172.16/12 end" },
  { address: "192.168.1.1", why: "IPv4 private 192.168/16" },
  { address: "169.254.1.1", why: "IPv4 link-local" },
  { address: "224.0.0.1", why: "IPv4 multicast" },
  { address: "255.255.255.255", why: "IPv4 broadcast / reserved" },
  { address: "::1", why: "IPv6 loopback" },
  { address: "::", why: "IPv6 unspecified" },
  { address: "fc00::1", why: "IPv6 unique-local" },
  { address: "fd12:3456:789a::1", why: "IPv6 unique-local fd" },
  { address: "fe80::1", why: "IPv6 link-local" },
  { address: "ff02::1", why: "IPv6 multicast" },
  { address: "::ffff:127.0.0.1", why: "IPv4-mapped loopback" },
  { address: "::ffff:10.1.2.3", why: "IPv4-mapped private 10/8" },
  { address: "::ffff:192.168.0.1", why: "IPv4-mapped private 192.168/16" },
  { address: "::ffff:169.254.1.1", why: "IPv4-mapped link-local" },
  { address: "::ffff:7f00:1", why: "IPv4-mapped loopback hex form" },
];

const ALLOWED = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "93.184.216.34"];

describe("isBlockedWebhookAddress", () => {
  it.each(REFUSED)("refuses $address ($why)", ({ address }) => {
    expect(isBlockedWebhookAddress(address)).toBe(true);
  });

  it.each(ALLOWED)("allows public address %s", (address) => {
    expect(isBlockedWebhookAddress(address)).toBe(false);
  });

  it("refuses a non-IP string", () => {
    expect(isBlockedWebhookAddress("not-an-ip")).toBe(true);
    expect(isBlockedWebhookAddress("")).toBe(true);
  });
});
