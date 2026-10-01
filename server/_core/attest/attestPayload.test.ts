import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { consentTextHash, eventHash, markPayloadBytes, markPayloadHash, receiptManifest, sessionPayloadBytes, signerIdentityOf, verifyChain, type ChainEventInput } from "./attestPayload";
import { canonicalAttestPayload } from "../deviceSignature";
import { canonicalJson as clientCanonicalJson } from "../../../client/src/runtime/crypto";
import { CONSENT_TEXT_V1, CONSENT_VERSION_V1 } from "../../../shared/attest";

const H = (c: string) => c.repeat(64);
const at = new Date("2026-10-01T12:00:00.000Z");

describe("one canonicalizer for what a device signs (§1.4)", () => {
  it("matches the client's sorted-key JSON byte for byte on plain JSON", () => {
    const payload = { z: 1, a: [3, { y: null, b: "x" }], m: true, s: "2026-10-01T12:00:00.000Z" };
    expect(canonicalAttestPayload(payload).toString("utf8")).toBe(clientCanonicalJson(payload));
  });
  it("hashes the consent sentence, and knows no other version", () => {
    expect(consentTextHash(CONSENT_VERSION_V1)).toBe(createHash("sha256").update(CONSENT_TEXT_V1).digest("hex"));
    expect(consentTextHash("leaseos-esign-consent/99")).toBeNull();
  });
});

describe("the mark payload binds a mark to the revision hash (§8.2)", () => {
  const base = { revisionRef: "ATR-1", revisionHash: H("a"), instanceRef: "FT-1", fieldRef: "ATF-1", fieldKey: "sig", fieldType: "signature", signerRef: "ATSG-1", signerIdentity: "user:7", markKind: "drawn", strokeHash: H("b"), renderedHash: null, valueText: null, consentTextHash: H("c"), completedAt: at };
  it("is stable, and changes when the revision hash, the field or the stroke changes", () => {
    const h = markPayloadHash(base);
    expect(h).toBe(markPayloadHash({ ...base }));
    expect(markPayloadHash({ ...base, revisionHash: H("d") })).not.toBe(h);
    expect(markPayloadHash({ ...base, fieldRef: "ATF-2" })).not.toBe(h);
    expect(markPayloadHash({ ...base, strokeHash: H("e") })).not.toBe(h);
    expect(markPayloadBytes(base).toString("utf8")).toContain(`"revisionHash":"${H("a")}"`);
  });
  it("contains nothing the device did not know in the session payload", () => {
    const bytes = sessionPayloadBytes({ sessionRef: "dev:1", revisionRef: "ATR-1", revisionHash: H("a"), signerRef: "ATSG-1", marks: [{ fieldKey: "sig", markKind: "drawn", strokeHash: H("b"), renderedHash: null, valueText: null }], consentTextHash: H("c"), signedAt: at }).toString("utf8");
    expect(bytes).not.toMatch(/"id"|"sessionId"|"completedAt"/);
    expect(bytes).toContain('"signedAt":"2026-10-01T12:00:00.000Z"');
  });
  it("names a signer by account or by a hash of the name, never by email", () => {
    expect(signerIdentityOf({ partyKind: "internal_user", userId: 7, externalIdentityId: null, displayName: "A" })).toBe("user:7");
    expect(signerIdentityOf({ partyKind: "external_identity", userId: null, externalIdentityId: 9, displayName: "A" })).toBe("ext:9");
    expect(signerIdentityOf({ partyKind: "named_witnessed", userId: null, externalIdentityId: null, displayName: "M. Johnson" })).toBe(`named:${createHash("sha256").update("M. Johnson").digest("hex")}`);
  });
});

describe("the event chain (§8.3)", () => {
  const ev = (sequence: number, over: Partial<ChainEventInput> = {}): ChainEventInput => ({ revisionRef: "ATR-1", sequence, eventType: "document_created", sessionId: null, fieldId: null, markId: null, artifactId: null, actorSource: "human", actorUserId: 1, actorExternalIdentityId: null, deviceRef: null, previousState: null, newState: "open", detailJson: null, occurredAt: at, ...over });
  const chain = () => {
    const e1 = ev(1); const h1 = eventHash(null, e1);
    const e2 = ev(2, { eventType: "fields_placed" }); const h2 = eventHash(h1, e2);
    const e3 = ev(3, { eventType: "field_signed", markId: 5 }); const h3 = eventHash(h2, e3);
    return [{ ...e1, prevEventHash: null, eventHash: h1 }, { ...e2, prevEventHash: h1, eventHash: h2 }, { ...e3, prevEventHash: h2, eventHash: h3 }];
  };
  it("verifies an intact chain and reports its head", () => {
    const c = chain();
    expect(verifyChain(c)).toEqual({ ok: true, head: c[2]!.eventHash, length: 3 });
    expect(verifyChain([])).toEqual({ ok: true, head: null, length: 0 });
  });
  it("detects an edited event, a removed event and a relinked event", () => {
    const edited = chain(); edited[1] = { ...edited[1]!, detailJson: "{\"x\":1}" };
    expect(verifyChain(edited)).toMatchObject({ ok: false, brokenAtSequence: 2 });
    const removed = chain().filter(e => e.sequence !== 2);
    expect(verifyChain(removed)).toMatchObject({ ok: false, brokenAtSequence: 3 });
    const relinked = chain(); relinked[2] = { ...relinked[2]!, prevEventHash: relinked[0]!.eventHash };
    expect(verifyChain(relinked)).toMatchObject({ ok: false, brokenAtSequence: 3 });
  });
});

describe("the audit receipt (§9.4)", () => {
  it("is canonical and deterministic, and names no email or token", () => {
    const input = {
      revision: { revisionRef: "ATR-1", instanceRef: "FT-1", revision: 1, subjectType: "field_ticket_revision", subjectRef: "FT-1-R1", revisionHash: H("a"), state: "finalized", pageCount: 1, completionRule: "all_required_fields" },
      fields: [{ fieldRef: "ATF-1", fieldKey: "sig", fieldType: "signature", page: 1, box: { xFrac: 0.1, yFrac: 0.2, widthFrac: 0.3, heightFrac: 0.1 }, signerRef: "ATSG-1", subjectLineRef: null, required: true, state: "completed", markRef: "ATM-1", payloadHash: H("b"), strokeHash: null, renderedHash: null }],
      signers: [{ signerRef: "ATSG-1", partyKind: "external_identity", identity: "ext:9", role: "customer_representative", requiredAuth: "portal_link", state: "completed" }],
      sessions: [{ sessionRef: "ATS-1", signerRef: "ATSG-1", authMethod: "portal_link", deviceRef: null, keyFingerprint: null, deviceSignatureBase64: null, capturedOffline: false, clockSkewMs: null, startedAt: at, completedAt: at, state: "completed", rejectionCode: null }],
      events: [{ sequence: 1, eventType: "document_created", eventHash: H("c") }],
      chainHead: H("c"), notCompletedOptional: [], generatedAt: at,
    };
    const a = receiptManifest(input), b = receiptManifest({ ...input, fields: [...input.fields].map(f => ({ ...f, box: { heightFrac: f.box.heightFrac, widthFrac: f.box.widthFrac, yFrac: f.box.yFrac, xFrac: f.box.xFrac } })) });
    expect(a.receiptHash).toBe(createHash("sha256").update(a.manifestJson).digest("hex"));
    expect(b.manifestJson).toBe(a.manifestJson);
    expect(b.receiptHash).toBe(a.receiptHash);
    expect(a.manifestJson).not.toMatch(/@|token/i);
    expect(a.manifestJson.startsWith("{")).toBe(true);
  });
});
