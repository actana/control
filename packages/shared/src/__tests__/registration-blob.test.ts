import { describe, it, expect } from "vitest";
import {
  encodeRegistrationBlob,
  decodeRegistrationBlob,
  type RegistrationBlob,
} from "../registration-blob";

// The credential a paired client holds, as the blob registry keeps it on disk.
// It was the hand-carried artifact too until #287; what is asserted here is the
// codec, which outlived the hand-carry because `local-core-wiring.ts` still
// writes a machine's own Core into the registry with it. In the Panel,
// `endpoint` + `label` go to the Core registry and the secret fields — caCert,
// clientCert, clientKey, bearer — are sealed. See CONTEXT.md "Registration
// blob".

describe("registration blob", () => {
  const sample: RegistrationBlob = {
    endpoint: "wss://10.0.0.5:443",
    label: "prod-vm-1",
    caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
    clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
    clientKey: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
    bearer: "eyJjb3JlSW.abc123",
  };

  describe("encodeRegistrationBlob / decodeRegistrationBlob", () => {
    it("round-trips a full blob", () => {
      const encoded = encodeRegistrationBlob(sample);
      // The at-rest form is one base64 line, which is what a registry file holds.
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+=*$/);
      expect(decodeRegistrationBlob(encoded)).toEqual(sample);
    });

    it("encodes as base64 (not raw JSON)", () => {
      const encoded = encodeRegistrationBlob(sample);
      // Decoding the outer layer must yield JSON; the raw encoded string must
      // not be the JSON itself.
      expect(() => JSON.parse(encoded)).toThrow();
    });

    it("decodes a blob with optional label omitted", () => {
      const minimal: RegistrationBlob = {
        endpoint: "wss://host:443",
        caCert: "ca",
        clientCert: "client",
        clientKey: "key",
        bearer: "b",
      };
      const encoded = encodeRegistrationBlob(minimal);
      const decoded = decodeRegistrationBlob(encoded);
      expect(decoded).toEqual({ ...minimal, label: "" });
    });

    it("returns null for a malformed base64 string", () => {
      expect(decodeRegistrationBlob("!!!not base64!!!")).toBeNull();
    });

    it("returns null for a payload missing required fields", () => {
      // Missing endpoint, caCert, clientCert, clientKey, bearer.
      const partial = Buffer.from(
        JSON.stringify({ endpoint: "wss://h", label: "x" }),
      ).toString("base64");
      expect(decodeRegistrationBlob(partial)).toBeNull();
    });

    it("returns null for a payload with wrong-typed fields", () => {
      const bad = Buffer.from(
        JSON.stringify({
          endpoint: 123,
          label: "x",
          caCert: "ca",
          clientCert: "c",
          clientKey: "k",
          bearer: "b",
        }),
      ).toString("base64");
      expect(decodeRegistrationBlob(bad)).toBeNull();
    });

    it("rejects a blob whose endpoint is not wss:// (transport security required)", () => {
      const bad = encodeRegistrationBlob({ ...sample, endpoint: "ws://10.0.0.5:443" });
      expect(decodeRegistrationBlob(bad)).toBeNull();
    });

    it("whitespace-trims and ignores surrounding whitespace in the file", () => {
      const encoded = encodeRegistrationBlob(sample);
      // A registry file often has a trailing newline.
      expect(decodeRegistrationBlob(`  ${encoded}\n`)).toEqual(sample);
    });
  });
});
