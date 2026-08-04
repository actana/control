import { describe, it, expect } from "vitest";
import {
  encodeRegistrationBlob,
  decodeRegistrationBlob,
  type RegistrationBlob,
} from "../registration-blob";

// The single base64 artifact emitted by `core install` (ADR 0003), pasted
// once into the Panel's "Add Core". `endpoint` + `label` go to the Core
// registry; the secret fields (caCert, clientCert, clientKey, bearer) go to
// `safeStorage`. See CONTEXT.md "Registration blob".

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
      // The on-the-wire form is one base64 line — the single paste artifact.
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

    it("whitespace-trims and ignores surrounding whitespace in the paste", () => {
      const encoded = encodeRegistrationBlob(sample);
      // A user paste often has a trailing newline or surrounding spaces.
      expect(decodeRegistrationBlob(`  ${encoded}\n`)).toEqual(sample);
    });
  });
});
