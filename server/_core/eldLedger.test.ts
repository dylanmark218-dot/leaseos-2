/**
 * 0170 — the ELD ledger's pure half.
 *
 * What these assert: that the same event hashes the same everywhere, that any change to content
 * changes the hash, that a batch which contradicts itself is refused whole, that no field exists
 * through which a driver's name could become identity, and that a chain assessment reports gaps
 * and mismatches without ever filling them.
 */
import { describe, expect, it } from "vitest";
import { assessDeviceChain, canonicalEldBatch, hashEldEvent, prepareEldBatch, ELD_EVENT_INPUT, type ChainRow } from "./eld/ledger";
import { canonicalEldEvent, canonicalEldEventJson, eldEventHashPreimage, validateEldEventShape, type EldEventInput } from "../../shared/eld/eldEvent";

const DEVICE = "DEV-TEST-0001";
const REF = (n: number) => `0f2c1a4e-3b5d-4c7e-8f9a-${String(n).padStart(12, "0")}`;
const at = (s: string) => new Date(s);

const base = (o: Partial<EldEventInput> = {}): EldEventInput => ({
  eventRef: REF(1), deviceSequence: 1, eventType: "duty_status_change", dutyStatus: "on_duty", recordOrigin: "driver",
  eventAt: "2026-09-11T14:00:00.000Z", previousEventHash: null, ...o,
});

describe("hashing is deterministic and total", () => {
  it("hashes the same event to the same two hashes every time, on any side", () => {
    const a = hashEldEvent(DEVICE, base()), b = hashEldEvent(DEVICE, base());
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.eventHash).toBe(b.eventHash);
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.canonicalJson).toBe(canonicalEldEventJson(DEVICE, base()));
  });

  it("serializes an explicitly ordered object with every participating field present", () => {
    const keys = Object.keys(canonicalEldEvent(DEVICE, base()));
    expect(keys).toEqual([
      "hashVersion", "deviceRef", "eventRef", "deviceSequence", "eventType", "eventCode", "dutyStatus", "recordOrigin", "eventAt",
      "eventUtcOffsetMinutes", "unitId", "latitude", "longitude", "locationAccuracyM", "locationSource", "jurisdiction",
      "odometerKm", "engineHours", "vehicleSpeedKph", "annotation", "supersedesEventRef",
    ]);
    // Absent optional fields are explicit nulls, so "absent" and "null" cannot hash differently.
    expect(canonicalEldEventJson(DEVICE, base())).toBe(canonicalEldEventJson(DEVICE, base({ annotation: null, unitId: null })));
  });

  it("changes the payload hash and the event hash when any content changes", () => {
    const a = hashEldEvent(DEVICE, base());
    for (const patch of [{ dutyStatus: "driving" }, { eventAt: "2026-09-11T14:00:01.000Z" }, { annotation: "fuel stop" }, { unitId: 7 }, { deviceSequence: 2 }, { eventRef: REF(2) }] as Partial<EldEventInput>[]) {
      const b = hashEldEvent(DEVICE, base(patch));
      expect(b.payloadHash, JSON.stringify(patch)).not.toBe(a.payloadHash);
      expect(b.eventHash, JSON.stringify(patch)).not.toBe(a.eventHash);
    }
    // A different device recording the same facts is a different record.
    expect(hashEldEvent("DEV-OTHER", base()).payloadHash).not.toBe(a.payloadHash);
  });

  it("carries the predecessor in the event hash but not in the payload hash", () => {
    const first = hashEldEvent(DEVICE, base());
    const linked = hashEldEvent(DEVICE, base({ previousEventHash: first.eventHash }));
    expect(linked.payloadHash).toBe(first.payloadHash);
    expect(linked.eventHash).not.toBe(first.eventHash);
    expect(eldEventHashPreimage(first.payloadHash, first.eventHash)).toBe(`eld-h1\n${first.eventHash}\n${first.payloadHash}`);
  });

  it("treats two spellings of the same instant as the same event, and keeps the reported offset apart", () => {
    const z = hashEldEvent(DEVICE, base({ eventAt: "2026-09-11T14:00:00.000Z" }));
    const local = hashEldEvent(DEVICE, base({ eventAt: "2026-09-11T08:00:00.000-06:00" }));
    expect(local.payloadHash).toBe(z.payloadHash);
    expect(hashEldEvent(DEVICE, base({ eventUtcOffsetMinutes: -360 })).payloadHash).not.toBe(z.payloadHash);
  });
});

describe("no field is a name, and the schema is strict", () => {
  it("refuses an event that carries a driver's name or an organization, rather than ignoring it", () => {
    for (const extra of [{ operatorName: "D. Reid" }, { operatorRef: "D. Reid" }, { driver: "Reid" }, { orgRef: "org-x" }, { operatorId: 4 }, { fieldDeviceId: 9 }]) {
      const r = ELD_EVENT_INPUT.safeParse({ ...base(), ...extra });
      expect(r.success, JSON.stringify(extra)).toBe(false);
      const p = prepareEldBatch(DEVICE, [{ ...base(), ...extra }]);
      expect(p.ok).toBe(false);
      expect(!p.ok && p.problems[0]!.code).toBe("schema_invalid");
    }
  });

  it("requires a duty status only on a duty-status change and a target only on a correction", () => {
    expect(validateEldEventShape(base({ dutyStatus: null }))).toContain("duty_status_change requires dutyStatus");
    expect(validateEldEventShape(base({ eventType: "engine_power_up", dutyStatus: "driving" }))).toContain("dutyStatus is only carried by duty_status_change");
    expect(validateEldEventShape(base({ eventType: "correction", dutyStatus: null }))).toContain("correction requires supersedesEventRef");
    expect(validateEldEventShape(base({ supersedesEventRef: REF(9) }))).toContain("supersedesEventRef is only carried by a correction");
    expect(validateEldEventShape(base({ eventType: "correction", dutyStatus: null, supersedesEventRef: REF(1) }))).toContain("an event cannot supersede itself");
    expect(validateEldEventShape(base({ eventType: "correction", dutyStatus: null, supersedesEventRef: REF(2) }))).toEqual([]);
    expect(validateEldEventShape(base({ eventRef: "not-a-uuid" }))).toContain("eventRef must be a UUID v4");
  });

  it("refuses an office-only record origin from a device", () => {
    expect(prepareEldBatch(DEVICE, [base({ recordOrigin: "office_edit" as never })]).ok).toBe(false);
  });
});

describe("a batch is prepared whole or refused whole", () => {
  it("collapses identical copies, orders by device sequence, and refuses contradictions", () => {
    const e1 = base({ deviceSequence: 3, eventRef: REF(3) }), e2 = base({ deviceSequence: 1, eventRef: REF(1) });
    const ok = prepareEldBatch(DEVICE, [e1, e2, { ...e1 }]);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.events.map(e => e.input.deviceSequence)).toEqual([1, 3]);

    const sameRef = prepareEldBatch(DEVICE, [e1, base({ deviceSequence: 4, eventRef: REF(3) })]);
    expect(!sameRef.ok && sameRef.problems[0]!.code).toBe("batch_internal_duplicate");
    const sameSeq = prepareEldBatch(DEVICE, [e1, base({ deviceSequence: 3, eventRef: REF(4) })]);
    expect(!sameSeq.ok && sameSeq.problems[0]!.code).toBe("batch_internal_duplicate");
  });

  it("refuses the batch when the device declares a hash its own bytes do not produce, and accepts when they do", () => {
    const h = hashEldEvent(DEVICE, base());
    expect(prepareEldBatch(DEVICE, [base({ declaredEventHash: h.eventHash })]).ok).toBe(true);
    const bad = prepareEldBatch(DEVICE, [base({ declaredEventHash: "0".repeat(64) })]);
    expect(!bad.ok && bad.problems[0]!.code).toBe("declared_hash_mismatch");
  });

  it("refuses the whole batch when one event is malformed, naming it", () => {
    const r = prepareEldBatch(DEVICE, [base(), { ...base({ eventRef: REF(2), deviceSequence: 2 }), eventAt: "yesterday" }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map(p => p.eventRef)).toEqual([REF(2)]);
  });
});

describe("the chain assessment reports and never repairs", () => {
  const row = (seq: number, prev: string | null, hash: string, t = `2026-09-11T14:${String(seq).padStart(2, "0")}:00Z`): ChainRow => ({ eventRef: REF(seq), deviceSequence: seq, eventAt: at(t), previousEventHash: prev, eventHash: hash });

  it("finds a gap and leaves it", () => {
    const a = assessDeviceChain([row(0, null, "h0"), row(1, "h0", "h1"), row(2, "h1", "h2"), row(5, "h4", "h5")]);
    expect(a.gaps).toEqual([{ from: 3, to: 4 }]);
    expect(a.verifiedLinks).toBe(2);
    expect(a.unverifiableLinks).toEqual([{ eventRef: REF(5), deviceSequence: 5, declaredPreviousEventHash: "h4" }]);
    expect(a.eventCount).toBe(4);
  });

  it("verifies a late predecessor once it arrives, without touching the successor", () => {
    const late = [row(0, null, "h0"), row(2, "h1", "h2")];
    expect(assessDeviceChain(late).unverifiableLinks).toHaveLength(1);
    const complete = [...late, row(1, "h0", "h1")];
    const a = assessDeviceChain(complete);
    expect(a.unverifiableLinks).toEqual([]);
    expect(a.gaps).toEqual([]);
    expect(a.verifiedLinks).toBe(2);
  });

  it("names a mismatch between what the device claimed and what the predecessor hashes to", () => {
    const a = assessDeviceChain([row(0, null, "h0"), row(1, "not-h0", "h1")]);
    expect(a.chainMismatches).toEqual([{ eventRef: REF(1), deviceSequence: 1, declaredPreviousEventHash: "not-h0", predecessorEventHash: "h0" }]);
    expect(a.verifiedLinks).toBe(0);
  });

  it("notices a first event that claims a predecessor, and a clock that runs backwards against the sequence", () => {
    const a = assessDeviceChain([row(0, "ghost", "h0"), row(1, "h0", "h1", "2026-09-11T13:00:00Z")]);
    expect(a.danglingFirstLink?.declaredPreviousEventHash).toBe("ghost");
    expect(a.timingInconsistencies).toHaveLength(1);
    expect(a.timingInconsistencies[0]!.deviceSequence).toBe(1);
  });

  it("is empty for an empty device", () => {
    expect(assessDeviceChain([])).toMatchObject({ eventCount: 0, lowestSequence: null, highestSequence: null, gaps: [], verifiedLinks: 0 });
  });
});

describe("the signed batch envelope", () => {
  it("is byte-stable regardless of key order", () => {
    const signedAt = at("2026-09-11T14:00:00Z");
    const a = canonicalEldBatch({ deviceRef: DEVICE, batchRef: "B1", signedAt, nonce: "n".repeat(16), events: [{ b: 1, a: 2 }] });
    const b = canonicalEldBatch({ deviceRef: DEVICE, batchRef: "B1", signedAt, nonce: "n".repeat(16), events: [{ a: 2, b: 1 }] });
    expect(a.equals(b)).toBe(true);
  });
});
