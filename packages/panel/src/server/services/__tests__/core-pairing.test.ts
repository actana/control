import { describe, expect, it } from "vitest";
import { PairingError } from "@actana/sdk/pairing";
import { dialedEndpoint } from "../core-pairing";

describe("dialedEndpoint", () => {
  it("spells the address the SDK dials as a core-link endpoint", () => {
    expect(dialedEndpoint("core:8443")).toBe("wss://core:8443");
    expect(dialedEndpoint("https://core:8443")).toBe("wss://core:8443");
    expect(dialedEndpoint("wss://CORE:8443")).toBe("wss://core:8443");
  });

  it("keeps an explicit default port, drops a path, lowercases IPv6", () => {
    expect(dialedEndpoint("wss://core:443")).toBe("wss://core:443");
    expect(dialedEndpoint("https://core:8443/some/path")).toBe("wss://core:8443");
    expect(dialedEndpoint("[FD00::1]:8443")).toBe("wss://[fd00::1]:8443");
  });

  it("defaults the port the way the SDK dials", () => {
    expect(dialedEndpoint("core")).toBe("wss://core:443");
  });

  it("keeps the brackets an IPv6 authority needs", () => {
    expect(dialedEndpoint("[fd00::1]:8443")).toBe("wss://[fd00::1]:8443");
  });

  it("refuses an address the SDK would refuse", () => {
    expect(() => dialedEndpoint("ws://core:8443")).toThrow(PairingError);
    try {
      dialedEndpoint("ws://core:8443");
    } catch (err) {
      expect((err as PairingError).failure).toBe("bad-address");
    }
  });
});
