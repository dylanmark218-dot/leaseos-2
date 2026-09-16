import { describe, it, expect } from "vitest";
import { buildSerial, parseSerial, resolveSheetScan, ticketClassOf, type SheetRegistryRow } from "./sheetSerial";

const NOW = new Date("2026-09-12T12:00:00Z");
const SERIAL = buildSerial({ ticketCode: "T1", courseVersionRef: "CV-TDG-ROAD-2026.1", sequence: 147 });

function row(o: Partial<SheetRegistryRow> = {}): SheetRegistryRow {
  return { serial: SERIAL, ticketCode: "T1", courseVersionRef: "CV-TDG-ROAD-2026.1",
    itemSetRef: "ITEM-TDG-ROAD-v0.1", itemSetReviewStatus: "approved",
    courseVersionSupersededAt: null, state: "returned", voidedReason: null,
    transcribedAt: null, transcribedByUserId: null, ...o };
}
const scan = (s: string, r: SheetRegistryRow | null) => resolveSheetScan({ scanned: s, row: r, asOf: NOW });

describe("serial round-trip", () => {
  it("parses what it builds", () => { expect(parseSerial(SERIAL).ok).toBe(true); });
  it("rejects a mistyped sequence", () => {
    const bad = SERIAL.replace(".000147.", ".000148.");
    const p = parseSerial(bad); expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("checksum_invalid");
  });
  it("is case-insensitive on input", () => { expect(parseSerial(SERIAL.toLowerCase()).ok).toBe(true); });
  it("classifies P-sheets as practice", () => {
    expect(ticketClassOf("P1")).toBe("practice"); expect(ticketClassOf("T1")).toBe("assessment");
  });
});

describe("scan resolution fails closed", () => {
  it("rejects a bad checksum without guessing the nearest serial", () => {
    const r = scan(SERIAL.replace(".000147.", ".000148."), row());
    expect(r.verdict).toBe("reject"); expect(r.code).toBe("serial_checksum_invalid"); expect(r.supports).toBe("nothing");
  });
  it("rejects an unknown serial rather than creating a record", () => {
    const r = scan(SERIAL, null);
    expect(r.code).toBe("serial_unknown"); expect(r.supports).toBe("nothing");
  });
  it("refuses a second filing of the same physical sheet", () => {
    const r = scan(SERIAL, row({ state: "transcribed", transcribedAt: new Date("2026-08-01T00:00:00Z") }));
    expect(r.code).toBe("sheet_already_transcribed");
    expect(r.message).toContain("2026-08-01");
  });
  it("rejects a voided sheet and says why", () => {
    const r = scan(SERIAL, row({ state: "void", voidedReason: "misprint" }));
    expect(r.code).toBe("sheet_void"); expect(r.message).toContain("misprint");
  });
});

describe("a practice sheet can never become credential evidence", () => {
  const p = buildSerial({ ticketCode: "P1", courseVersionRef: "STUDY-AIRBRAKE-v0.1", sequence: 149 });
  it("files as a study record only", () => {
    const r = scan(p, row({ serial: p, ticketCode: "P1", courseVersionRef: "STUDY-AIRBRAKE-v0.1" }));
    expect(r.supports).toBe("study_record_only");
  });
  it("stays study-only even when the item set is approved", () => {
    const r = scan(p, row({ serial: p, ticketCode: "P1", itemSetReviewStatus: "approved" }));
    expect(r.supports).toBe("study_record_only");
  });
});

describe("review status and version drift", () => {
  it("downgrades an unapproved item set to competency evidence", () => {
    const r = scan(SERIAL, row({ itemSetReviewStatus: "draft" }));
    expect(r.verdict).toBe("accept_with_flag");
    expect(r.supports).toBe("competency_evidence");
    expect(r.message).toContain("cannot support a certificate");
  });
  it("flags stock printed against a superseded course version", () => {
    const r = scan(SERIAL, row({ courseVersionSupersededAt: new Date("2026-06-01T00:00:00Z") }));
    expect(r.verdict).toBe("accept_with_flag");
    expect(r.flags[0]).toContain("superseded");
  });
  it("accepts a current, approved, first-time scan", () => {
    const r = scan(SERIAL, row());
    expect(r.verdict).toBe("accept"); expect(r.supports).toBe("certificate_evidence");
  });
  it("does not let an accepted scan claim to complete issuance", () => {
    expect(scan(SERIAL, row()).message).toContain("does not itself complete");
  });
});
