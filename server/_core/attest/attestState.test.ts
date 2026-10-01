import { describe, expect, it } from "vitest";
import { authMethodSatisfies, bindingVerdict, completionVerdict, earlierOrderPending, fieldVerdict, markShapeVerdict, revisionTransition, type FieldForVerdict } from "./attestState";

const H = "a".repeat(64);
const field = (over: Partial<FieldForVerdict> = {}): FieldForVerdict => ({ fieldRef: "ATF-1", fieldType: "signature", state: "pending", assignedSignerRef: "ATSG-1", signingOrder: null, required: true, ...over });

describe("revision transitions (§14)", () => {
  it("finalizes from completed or open, voids only before finalization, supersedes anything but voided/superseded", () => {
    expect(revisionTransition("completed", "finalize").ok).toBe(true);
    expect(revisionTransition("open", "finalize").ok).toBe(true);
    expect(revisionTransition("finalized", "void")).toMatchObject({ ok: false, code: "DOCUMENT_FINALIZED" });
    expect(revisionTransition("finalized", "supersede").ok).toBe(true);
    expect(revisionTransition("voided", "supersede")).toMatchObject({ ok: false, code: "DOCUMENT_VOIDED" });
    expect(revisionTransition("superseded", "finalize")).toMatchObject({ ok: false, code: "DOCUMENT_SUPERSEDED" });
  });
});

describe("binding (§6.5 races 1, 2, 4)", () => {
  it("refuses a stale copy, a voided document and a finalized one, each by its own code", () => {
    expect(bindingVerdict({ revisionState: "open", revisionHash: H, revisionHashAtStart: H }).ok).toBe(true);
    expect(bindingVerdict({ revisionState: "open", revisionHash: H, revisionHashAtStart: "b".repeat(64) })).toMatchObject({ ok: false, code: "REVISION_MISMATCH" });
    expect(bindingVerdict({ revisionState: "voided", revisionHash: H, revisionHashAtStart: H })).toMatchObject({ ok: false, code: "DOCUMENT_VOIDED" });
    expect(bindingVerdict({ revisionState: "finalized", revisionHash: H, revisionHashAtStart: H })).toMatchObject({ ok: false, code: "DOCUMENT_FINALIZED" });
  });
});

describe("who may complete a field (§13, race 3)", () => {
  it("refuses a completed field, another signer's field and an unassigned field by distinct codes", () => {
    expect(fieldVerdict({ field: field(), signerRef: "ATSG-1", markKind: "electronic_ack", earlierPending: false, rule: "all_required_fields" }).ok).toBe(true);
    expect(fieldVerdict({ field: field({ state: "completed" }), signerRef: "ATSG-1", markKind: "drawn", earlierPending: false, rule: "all_required_fields" })).toMatchObject({ ok: false, code: "FIELD_ALREADY_COMPLETED" });
    expect(fieldVerdict({ field: field(), signerRef: "ATSG-2", markKind: "drawn", earlierPending: false, rule: "all_required_fields" })).toMatchObject({ ok: false, code: "WRONG_SIGNER" });
    expect(fieldVerdict({ field: field({ assignedSignerRef: null }), signerRef: "ATSG-1", markKind: "drawn", earlierPending: false, rule: "all_required_fields" })).toMatchObject({ ok: false, code: "FIELD_NOT_ASSIGNED" });
  });
  it("refuses a mark kind the field type does not take, and enforces order only under the ordered rule", () => {
    expect(fieldVerdict({ field: field({ fieldType: "checkbox" }), signerRef: "ATSG-1", markKind: "drawn", earlierPending: false, rule: "all_required_fields" })).toMatchObject({ ok: false, code: "MALFORMED" });
    expect(fieldVerdict({ field: field(), signerRef: "ATSG-1", markKind: "drawn", earlierPending: true, rule: "all_required_fields" }).ok).toBe(true);
    expect(fieldVerdict({ field: field(), signerRef: "ATSG-1", markKind: "drawn", earlierPending: true, rule: "all_required_fields_in_order" })).toMatchObject({ ok: false, code: "MALFORMED" });
  });
  it("sees an earlier-ordered pending field", () => {
    const a = field({ fieldRef: "A", signingOrder: 1 }), b = field({ fieldRef: "B", signingOrder: 2 });
    expect(earlierOrderPending(b, [a, b])).toBe(true);
    expect(earlierOrderPending(b, [{ ...a, state: "completed" }, b])).toBe(false);
    expect(earlierOrderPending(a, [a, b])).toBe(false);
  });
});

describe("completion (§14)", () => {
  it("needs every required field and tolerates pending optional ones", () => {
    const v = completionVerdict([field({ fieldRef: "r1", state: "completed" }), field({ fieldRef: "o1", required: false }), field({ fieldRef: "r2" })]);
    expect(v).toEqual({ complete: false, pendingRequired: ["r2"], pendingOptional: ["o1"] });
    expect(completionVerdict([field({ fieldRef: "r1", state: "completed" }), field({ fieldRef: "o1", required: false })]).complete).toBe(true);
  });
});

describe("authentication strength (§4.2)", () => {
  it("never lets a witness stand in for a signer who must log in, and lets a device prove more than a login", () => {
    expect(authMethodSatisfies("witnessed", "session_login")).toBe(false);
    expect(authMethodSatisfies("paper_scan", "portal_link")).toBe(false);
    expect(authMethodSatisfies("device_auth", "session_login")).toBe(true);
    expect(authMethodSatisfies("session_login", "device_auth")).toBe(false);
    expect(authMethodSatisfies("witnessed", "witnessed")).toBe(true);
    expect(authMethodSatisfies("session_login", "nonsense")).toBe(false);
  });
});

describe("a drawn mark is a drawing (§1.3)", () => {
  it("refuses drawn without a sealed stroke record, paper_scan without a scan, and empty values", () => {
    expect(markShapeVerdict({ markKind: "drawn", strokeEvidenceRecordId: null, strokeHash: null, renderedEvidenceRecordId: null, valueText: null })).toMatchObject({ ok: false, code: "MARK_NOT_SEALED" });
    expect(markShapeVerdict({ markKind: "drawn", strokeEvidenceRecordId: 7, strokeHash: H, renderedEvidenceRecordId: null, valueText: null }).ok).toBe(true);
    expect(markShapeVerdict({ markKind: "paper_scan", strokeEvidenceRecordId: null, strokeHash: null, renderedEvidenceRecordId: null, valueText: null })).toMatchObject({ ok: false, code: "MARK_NOT_SEALED" });
    expect(markShapeVerdict({ markKind: "typed_name", strokeEvidenceRecordId: null, strokeHash: null, renderedEvidenceRecordId: null, valueText: "  " })).toMatchObject({ ok: false, code: "MALFORMED" });
    expect(markShapeVerdict({ markKind: "approval", strokeEvidenceRecordId: null, strokeHash: null, renderedEvidenceRecordId: null, valueText: "maybe" })).toMatchObject({ ok: false, code: "MALFORMED" });
    expect(markShapeVerdict({ markKind: "adopted_saved", strokeEvidenceRecordId: null, strokeHash: null, renderedEvidenceRecordId: null, valueText: null }).ok).toBe(false);
  });
});
