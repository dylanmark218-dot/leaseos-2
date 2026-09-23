/**
 * 0179 — the ELD ledger's pure half.
 *
 * What these assert: that the same event hashes the same everywhere, that any change to content
 * changes the hash, that a batch which contradicts itself is refused whole, that no field exists
 * through which a driver's name could become identity, and that a chain assessment reports gaps
 * and mismatches without ever filling them. The byte-level rules of the canonical form are pinned
 * separately against independently generated vectors in eldCanonicalVectors.test.ts.
 */
import { describe, expect, it } from "vitest";
import { assessDeviceChain, canonicalEldBatch, hashEldEvent, prepareEldBatch, ELD_EVENT_INPUT, type ChainRow } from "./eld/ledger";
import {
  CANONICAL_ELD_EVENT_KEYS, CanonicalEncodingError, canonicalEldEvent, canonicalEldEventJson, canonicalEncode, canonicalInteger, canonicalString,
  eldEventHashPreimage, validateEldEventShape, type EldEventInput,
} from "../../shared/eld/eldEvent";

const DEVICE = "DEV-TEST-0001";
const REF = (n: number) => `0f2c1a4e-3b5d-4c7e-8f9a-${String(n).padStart(12, "0")}`;
const at = (s: string) => new Date(s);
const T0 = Date.UTC(2026, 8, 11, 14, 0, 0);

const base = (o: Partial<EldEventInput> = {}): EldEventInput => ({
  eventRef: REF(1), deviceSequence: 1, eventType: "duty_status_change", dutyStatus: "on_duty", recordOrigin: "driver",
  eventAtMs: T0, previousEventHash: null, ...o,
});

describe("hashing is deterministic and total", () => {
  it("hashes the same event to the same two hashes every time, on any side", () => {
    const a = hashEldEvent(DEVICE, base()), b = hashEldEvent(DEVICE, base());
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.eventHash).toBe(b.eventHash);
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.canonicalJson).toBe(canonicalEldEventJson(DEVICE, base()));
  });

  it("carries exactly the 21 participating fields and nothing the server assigns", () => {
    const keys = Object.keys(canonicalEldEvent(DEVICE, base())).sort();
    expect(keys).toEqual([...CANONICAL_ELD_EVENT_KEYS].sort());
    for (const serverOnly of ["id", "orgRef", "operatorId", "unitId", "receivedAt", "sourceKind", "sourceRef", "submittedByUserId", "createdAt"]) {
      expect(keys).not.toContain(serverOnly);
    }
    // Absent optional fields are explicit nulls, so "absent" and "null" cannot hash differently.
    expect(canonicalEldEventJson(DEVICE, base())).toBe(canonicalEldEventJson(DEVICE, base({ annotation: null, unitNumber: null, latitudeE7: null })));
  });

  it("emits keys sorted by code point regardless of how the input object was built", () => {
    const forward = base({ annotation: "x", unitNumber: "U1" });
    const reversed = Object.fromEntries(Object.entries(forward).reverse()) as unknown as EldEventInput;
    expect(canonicalEldEventJson(DEVICE, reversed)).toBe(canonicalEldEventJson(DEVICE, forward));
    expect(canonicalEldEventJson(DEVICE, forward)).toMatch(/^\{"annotation":"x","deviceRef":/);
  });

  it("changes the payload hash and the event hash when any content changes", () => {
    const a = hashEldEvent(DEVICE, base());
    for (const patch of [{ dutyStatus: "driving" }, { eventAtMs: T0 + 1 }, { annotation: "fuel stop" }, { unitNumber: "VAC-7" }, { deviceSequence: 2 }, { eventRef: REF(2) }, { latitudeE7: 1 }, { eventUtcOffsetMinutes: 0 }] as Partial<EldEventInput>[]) {
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
    expect(eldEventHashPreimage(first.payloadHash, null)).toBe(`eld-h1\n\n${first.payloadHash}`);
  });

  it("has no timestamp text to disagree about: the instant is an integer and the offset is separate", () => {
    const z = hashEldEvent(DEVICE, base({ eventAtMs: T0 }));
    expect(z.canonicalJson).toContain(`"eventAtMs":${T0}`);
    expect(z.canonicalJson).not.toMatch(/2026-09-11/);
    expect(hashEldEvent(DEVICE, base({ eventAtMs: T0, eventUtcOffsetMinutes: -360 })).payloadHash).not.toBe(z.payloadHash);
  });

  it("normalizes a UUID to lowercase before it participates, so case cannot make a second identity", () => {
    const lower = hashEldEvent(DEVICE, base({ eventRef: REF(7) }));
    const upper = hashEldEvent(DEVICE, base({ eventRef: REF(7).toUpperCase() }));
    expect(upper.payloadHash).toBe(lower.payloadHash);
    expect(upper.canonicalJson).toContain(`"eventRef":"${REF(7)}"`);
  });
});

describe("the canonical encoder follows the stated rules and refuses everything else", () => {
  it("escapes exactly the seven short forms plus \\u00xx for other controls, and leaves the rest raw", () => {
    expect(canonicalString("\"\\\b\t\n\f\r")).toBe('"\\"\\\\\\b\\t\\n\\f\\r"');
    expect(canonicalString("\x00\x01\x1f")).toBe('"\\u0000\\u0001\\u001f"');
    expect(canonicalString("\x7f é € 🚚  ")).toBe('"\x7f é € 🚚  "');
    expect(() => canonicalString("\ud800")).toThrow(CanonicalEncodingError);
    expect(() => canonicalString("x\udc00")).toThrow(CanonicalEncodingError);
  });

  it("encodes integers as plain decimals and refuses floats, NaN, infinities and out-of-range magnitudes", () => {
    expect(canonicalInteger(0)).toBe("0");
    expect(canonicalInteger(-0)).toBe("0");
    expect(canonicalInteger(-42)).toBe("-42");
    expect(canonicalInteger(9007199254740991)).toBe("9007199254740991");
    for (const bad of [1.5, 1e21, NaN, Infinity, -Infinity, 9007199254740992]) expect(() => canonicalInteger(bad), String(bad)).toThrow(CanonicalEncodingError);
  });

  it("sorts object keys by code point at every depth and preserves array order", () => {
    expect(canonicalEncode({ z: 1, a: { y: null, b: [3, 1, 2], c: { k: true } }, B: "x" })).toBe('{"B":"x","a":{"b":[3,1,2],"c":{"k":true},"y":null},"z":1}');
    expect(canonicalEncode({ b: 1, B: 2, "1": 3, a: 4, aa: 5, A: 6 })).toBe('{"1":3,"A":6,"B":2,"a":4,"aa":5,"b":1}');
    expect(canonicalEncode([])).toBe("[]");
    expect(canonicalEncode({})).toBe("{}");
    expect(canonicalEncode("")).toBe('""');
  });

  it("refuses values that have no canonical form", () => {
    expect(() => canonicalEncode(undefined as never)).toThrow(CanonicalEncodingError);
    expect(() => canonicalEncode({ a: 1.25 })).toThrow(CanonicalEncodingError);
  });
});

describe("no field is a name, and the schema is strict", () => {
  it("refuses an event that carries a driver's name, an organization or a database id, rather than ignoring it", () => {
    for (const extra of [{ operatorName: "D. Reid" }, { operatorRef: "D. Reid" }, { driver: "Reid" }, { orgRef: "org-x" }, { operatorId: 4 }, { fieldDeviceId: 9 }, { unitId: 3 }]) {
      const r = ELD_EVENT_INPUT.safeParse({ ...base(), ...extra });
      expect(r.success, JSON.stringify(extra)).toBe(false);
      const p = prepareEldBatch(DEVICE, [{ ...base(), ...extra }]);
      expect(p.ok).toBe(false);
      expect(!p.ok && p.problems[0]!.code).toBe("schema_invalid");
    }
  });

  it("refuses floating-point quantities and the old float field names", () => {
    for (const bad of [{ latitudeE7: 53.5 }, { odometerM: 12.5 }, { latitude: 53.5 }, { odometerKm: 1 }, { eventAt: "2026-09-11T14:00:00Z" }, { eventAtMs: 1.5 }]) {
      const p = prepareEldBatch(DEVICE, [{ ...base(), ...bad }]);
      expect(!p.ok && p.problems[0]!.code, JSON.stringify(bad)).toBe("schema_invalid");
    }
  });

  it("requires a duty status only on a duty-status change and a target only on a correction", () => {
    expect(validateEldEventShape(base({ dutyStatus: null }))).toContain("duty_status_change requires dutyStatus");
    expect(validateEldEventShape(base({ eventType: "engine_power_up", dutyStatus: "driving" }))).toContain("dutyStatus is only carried by duty_status_change");
    expect(validateEldEventShape(base({ eventType: "correction", dutyStatus: null }))).toContain("correction requires supersedesEventRef");
    expect(validateEldEventShape(base({ supersedesEventRef: REF(9) }))).toContain("supersedesEventRef is only carried by a correction");
    expect(validateEldEventShape(base({ eventType: "correction", dutyStatus: null, supersedesEventRef: REF(1).toUpperCase() }))).toContain("an event cannot supersede itself");
    expect(validateEldEventShape(base({ eventType: "correction", dutyStatus: null, supersedesEventRef: REF(2) }))).toEqual([]);
    expect(validateEldEventShape(base({ eventRef: "not-a-uuid" }))).toContain("eventRef must be a UUID v4");
  });

  it("refuses an instant outside the storable range, and a string that is not well-formed Unicode", () => {
    expect(validateEldEventShape(base({ eventAtMs: 2147483647001 }))[0]).toMatch(/eventAtMs/);
    expect(validateEldEventShape(base({ eventAtMs: 0 }))[0]).toMatch(/eventAtMs/);
    expect(validateEldEventShape(base({ annotation: "bad\ud800" }))[0]).toMatch(/annotation: unpaired/);
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

  it("compares a declared hash against its own computation and never accepts the declaration on its own", () => {
    const h = hashEldEvent(DEVICE, base());
    expect(prepareEldBatch(DEVICE, [base({ declaredEventHash: h.eventHash })]).ok).toBe(true);
    // A well-formed hash that is not the hash of these bytes.
    const bad = prepareEldBatch(DEVICE, [base({ declaredEventHash: "0".repeat(64) })]);
    expect(!bad.ok && bad.problems[0]!.code).toBe("declared_hash_mismatch");
    // The genuine hash of DIFFERENT content, declared for this content: refused, because the server hashes what it received.
    const other = hashEldEvent(DEVICE, base({ dutyStatus: "driving" }));
    const swapped = prepareEldBatch(DEVICE, [base({ declaredEventHash: other.eventHash })]);
    expect(!swapped.ok && swapped.problems[0]!.code).toBe("declared_hash_mismatch");
    // Without a declaration the server's computation stands alone; the hashes are the same either way.
    const undeclared = prepareEldBatch(DEVICE, [base()]);
    expect(undeclared.ok && undeclared.events[0]!.eventHash).toBe(h.eventHash);
  });

  it("refuses the whole batch when one event is malformed, naming it", () => {
    const r = prepareEldBatch(DEVICE, [base(), { ...base({ eventRef: REF(2), deviceSequence: 2 }), eventAtMs: -5 }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map(p => p.eventRef)).toEqual([REF(2)]);
  });
});

describe("the chain assessment reports and never repairs", () => {
  const row = (seq: number, prev: string | null, hash: string, t = `2026-09-11T14:${String(seq).padStart(2, "0")}:00Z`): ChainRow => ({ eventRef: REF(seq), deviceSequence: seq, eventAt: at(t), previousEventHash: prev, eventHash: hash });

  it("keeps sequence continuity and hash continuity as separate answers", () => {
    const a = assessDeviceChain([row(0, null, "h0"), row(1, "h0", "h1"), row(2, "h1", "h2"), row(5, "h4", "h5")]);
    expect(a.gaps).toEqual([{ from: 3, to: 4 }]);
    expect(a.verifiedLinks).toBe(2);
    expect(a.unverifiableLinks).toEqual([{ eventRef: REF(5), deviceSequence: 5, declaredPreviousEventHash: "h4" }]);
    expect(a.links.map(l => l.state)).toEqual(["first", "linked", "linked", "predecessor_missing"]);
    expect(a.eventCount).toBe(4);
  });

  it("verifies a late predecessor once it arrives, without touching the successor", () => {
    const late = [row(0, null, "h0"), row(2, "h1", "h2")];
    expect(assessDeviceChain(late).links.map(l => l.state)).toEqual(["first", "predecessor_missing"]);
    const complete = [...late, row(1, "h0", "h1")];
    const a = assessDeviceChain(complete);
    expect(a.unverifiableLinks).toEqual([]);
    expect(a.gaps).toEqual([]);
    expect(a.verifiedLinks).toBe(2);
    expect(a.links.map(l => l.state)).toEqual(["first", "linked", "linked"]);
  });

  it("names a mismatch, a missing claim, a dangling first link and an impossible ordering", () => {
    const a = assessDeviceChain([row(0, "ghost", "h0"), row(1, "not-h0", "h1"), row(2, null, "h2", "2026-09-11T13:00:00Z")]);
    expect(a.chainMismatches).toEqual([
      { eventRef: REF(1), deviceSequence: 1, declaredPreviousEventHash: "not-h0", predecessorEventHash: "h0" },
      { eventRef: REF(2), deviceSequence: 2, declaredPreviousEventHash: "", predecessorEventHash: "h1" },
    ]);
    expect(a.links.map(l => l.state)).toEqual(["dangling_first", "hash_mismatch", "missing_claim"]);
    expect(a.danglingFirstLink?.declaredPreviousEventHash).toBe("ghost");
    expect(a.timingInconsistencies).toHaveLength(1);
    expect(a.timingInconsistencies[0]!.deviceSequence).toBe(2);
    expect(a.verifiedLinks).toBe(0);
  });

  it("is empty for an empty device", () => {
    expect(assessDeviceChain([])).toMatchObject({ eventCount: 0, lowestSequence: null, highestSequence: null, gaps: [], links: [], verifiedLinks: 0 });
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
