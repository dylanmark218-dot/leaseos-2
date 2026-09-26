import { readFileSync } from "fs";
/**
 * v22.20 — a full folder is not a current one.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityStatus, capabilitySummary, EXPIRY_OPTIONAL_TYPES, NotVerifiable, reject, validityOf, verify,
  type DocumentVersion,
} from "./_core/documentValidity";
import type { DocumentType } from "./_core/documentExtraction";

const AT = new Date("2026-10-20T00:00:00Z");
const days = (n: number) => new Date(AT.getTime() + n * 86_400_000);
const TYPE = "insurance" as DocumentType;

const version = (n: number, o: Partial<DocumentVersion> = {}): DocumentVersion => ({
  documentRef: "DOC-1", version: n, type: TYPE, subjectRef: "UNIT-127",
  state: "uploaded", effectiveFrom: null, expiresAt: null,
  verifiedByUserId: null, verifiedAt: null, supersededByVersion: null,
  uploadedAt: AT, ...o,
});

describe("uploading is not verifying", () => {
  it("reports no document when there is none", () => {
    expect(validityOf([], AT)).toMatchObject({ state: "none" });
  });

  it("reports an uploaded document as unverified, not as cover", () => {
    const v = validityOf([version(1)], AT);
    expect(v.state).toBe("unverified");
    expect(v.reason).toContain("not a document in force until somebody has checked it");
  });

  it("treats an OCR extraction as still nobody's assertion", () => {
    expect(validityOf([version(1, { state: "extracted", expiresAt: days(365) })], AT).state).toBe("unverified");
  });

  it("reports a rejection as its own state, because a rejection is a finding", () => {
    expect(validityOf(reject([version(1)], 1), AT)).toMatchObject({ state: "rejected", version: 1 });
  });

  it("is in force once a person has verified it", () => {
    const verified = verify({ versions: [version(1)], version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: days(200) });
    expect(validityOf(verified, AT)).toMatchObject({ state: "in_force", version: 1, daysRemaining: 200 });
  });
});

describe("a new version is not automatically the valid one", () => {
  const inForce = () => verify({ versions: [version(1)], version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: days(40) });

  it("leaves the verified version in force while a newer one sits unverified", () => {
    const withUpload = [...inForce(), version(2, { uploadedAt: days(1) })];
    // The 2027 certificate uploaded in November does not displace the 2026 one.
    expect(validityOf(withUpload, AT)).toMatchObject({ state: "in_force", version: 1 });
  });

  it("switches only when the new version is verified, and supersedes rather than deletes", () => {
    const after = verify({ versions: [...inForce(), version(2)], version: 2, byUserId: 9, at: days(2), effectiveFrom: null, expiresAt: days(400) });
    expect(validityOf(after, days(2))).toMatchObject({ state: "in_force", version: 2 });
    const old = after.find(v => v.version === 1)!;
    expect(old.state).toBe("superseded");
    expect(old.supersededByVersion).toBe(2);
  });

  it("does not treat a version as in force before its effective date", () => {
    // Checked but not yet current is its own state now. It used to read "unverified", with a
    // reason saying nobody had checked a document somebody had.
    const future = verify({ versions: [version(1)], version: 1, byUserId: 9, at: AT, effectiveFrom: days(30), expiresAt: days(400) });
    expect(validityOf(future, AT)).toMatchObject({ state: "not_yet_effective", version: 1 });
    expect(validityOf(future, AT).reason).toContain(`not in force until ${days(30).toISOString().slice(0, 10)}`);
    expect(validityOf(future, days(31)).state).toBe("in_force");
  });

  it("keeps the earlier verified version in force while the next waits for its effective date", () => {
    const first = verify({ versions: [version(1), version(2)], version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: days(40) });
    const both = verify({ versions: first, version: 2, byUserId: 9, at: AT, effectiveFrom: days(30), expiresAt: days(400) });
    expect(validityOf(both, AT)).toMatchObject({ state: "in_force", version: 1 });
    expect(validityOf(both, days(31))).toMatchObject({ state: "in_force", version: 2 });
  });

  it("refuses to verify something already verified, superseded or absent", () => {
    const v = inForce();
    expect(() => verify({ versions: v, version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: null })).toThrow(NotVerifiable);
    expect(() => verify({ versions: v, version: 9, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: null })).toThrow(/No version 9/);
  });
});

describe("a missing expiry is not a permanent one", () => {
  // Owner's ruling, 2026-09-25: a verified document with no expiry is in force only when its type
  // is named as never-expiring. No type is named yet, so every one fails closed.
  const noExpiry = (type = TYPE) =>
    verify({ versions: [version(1, { type })], version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: null });

  it("reports a verified document with no expiry as incomplete, not in force", () => {
    const v = validityOf(noExpiry(), AT);
    expect(v).toMatchObject({ state: "incomplete", version: 1, expiresAt: null });
    expect(v.reason).toContain("no expiry is recorded");
  });

  it("names no never-expiring type yet — the list is added to one type at a time, with a reason", () => {
    expect(Array.from(EXPIRY_OPTIONAL_TYPES)).toEqual([]);
  });

  it("would read a named never-expiring type as in force", () => {
    const optional = "__test_never_expires" as DocumentType;
    (EXPIRY_OPTIONAL_TYPES as Set<DocumentType>).add(optional);
    try {
      expect(validityOf(noExpiry(optional), AT)).toMatchObject({ state: "in_force", expiresAt: null });
      expect(validityOf(noExpiry(TYPE), AT).state).toBe("incomplete");
    } finally {
      (EXPIRY_OPTIONAL_TYPES as Set<DocumentType>).delete(optional);
    }
  });

  it("blocks the capability that depends on an incomplete document", () => {
    const s = capabilityStatus({ requirements: [{ capability: "haul", requires: [TYPE] }], at: AT, documents: { [TYPE]: noExpiry() } });
    expect(s[0]).toMatchObject({ allowed: false });
    expect(s[0]!.blockedBy[0]).toMatchObject({ state: "incomplete" });
  });
});

describe("expiry warns before it blocks", () => {
  const withExpiry = (d: number) => verify({ versions: [version(1)], version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: days(d) });

  it("names the window rather than only the day it breaks", () => {
    expect(validityOf(withExpiry(10), AT)).toMatchObject({ state: "expiring", daysRemaining: 10 });
    expect(validityOf(withExpiry(10), AT).reason).toBe("Expires in 10 day(s)");
  });

  it("reports how long it has been expired", () => {
    const v = validityOf(withExpiry(-5), AT);
    expect(v.state).toBe("expired");
    expect(v.reason).toBe("Expired 5 day(s) ago");
  });
});

describe("an expiry blocks what depends on it and nothing else", () => {
  const DG = "tdg_certificate" as DocumentType;
  const LICENCE = "drivers_licence" as DocumentType;
  const requirements = [
    { capability: "haul_water", requires: [LICENCE] },
    { capability: "haul_dangerous_goods", requires: [LICENCE, DG] },
  ];
  const verified = (expiresIn: number) => verify({ versions: [version(1)], version: 1, byUserId: 9, at: AT, effectiveFrom: null, expiresAt: days(expiresIn) });

  it("keeps water hauling when the dangerous-goods endorsement expires", () => {
    const s = capabilityStatus({
      requirements, at: AT,
      documents: { [LICENCE]: verified(300), [DG]: verified(-2) },
    });
    const water = s.find(x => x.capability === "haul_water")!;
    const dg = s.find(x => x.capability === "haul_dangerous_goods")!;
    expect(water.allowed).toBe(true);
    expect(dg.allowed).toBe(false);
    expect(dg.blockedBy[0]).toMatchObject({ type: DG, state: "expired" });
  });

  it("blocks everything that depends on the licence when the licence goes", () => {
    const s = capabilityStatus({ requirements, at: AT, documents: { [LICENCE]: verified(-1), [DG]: verified(300) } });
    expect(s.every(x => !x.allowed)).toBe(true);
  });

  it("blocks on an unverified document exactly as on an expired one", () => {
    // Both mean nobody has established it is in force.
    const s = capabilityStatus({ requirements, at: AT, documents: { [LICENCE]: verified(300), [DG]: [version(1)] } });
    const dg = s.find(x => x.capability === "haul_dangerous_goods")!;
    expect(dg.allowed).toBe(false);
    expect(dg.blockedBy[0].state).toBe("unverified");
  });

  it("blocks on a missing document rather than assuming it is fine", () => {
    const s = capabilityStatus({ requirements, at: AT, documents: { [LICENCE]: verified(300) } });
    expect(s.find(x => x.capability === "haul_dangerous_goods")!.blockedBy[0].state).toBe("none");
  });

  it("warns without blocking while something is merely expiring", () => {
    const s = capabilityStatus({ requirements, at: AT, documents: { [LICENCE]: verified(300), [DG]: verified(9) } });
    const dg = s.find(x => x.capability === "haul_dangerous_goods")!;
    expect(dg.allowed).toBe(true);
    expect(dg.warnings[0]).toMatchObject({ type: DG });
  });

  it("gives a dispatcher the line: what is kept and what is lost", () => {
    const s = capabilityStatus({ requirements, at: AT, documents: { [LICENCE]: verified(300), [DG]: verified(-2) } });
    const line = capabilitySummary(s);
    expect(line).toContain("1 retained (haul_water)");
    expect(line).toContain("haul_dangerous_goods: tdg_certificate");
  });

  it("says so plainly when nothing is lost", () => {
    const s = capabilityStatus({ requirements, at: AT, documents: { [LICENCE]: verified(300), [DG]: verified(300) } });
    expect(capabilitySummary(s)).toBe("All 2 capability(ies) retained");
  });
});

describe("one rule, shared", () => {
  /**
   * `documentValidity` was written as the canonical answer and then nothing
   * imported it, while four routers each decided the same question inline.
   * Four correct-looking implementations of one rule is how they stop agreeing.
   */
  it("is reached through the adapter by the routers that need it", () => {
    const adapter = readFileSync("server/_core/qualificationValidity.ts", "utf8");
    expect(adapter).toContain('from "./documentValidity"');
    // C1b-3: the four qualification readers go through the D-05 read adapter, which decides through
    // qualificationValidity / documentValidity — not through their own reading of a store.
    const reads = readFileSync("server/qualificationReads.ts", "utf8");
    expect(reads).toContain('from "./_core/qualificationValidity"');
    expect(reads).toContain('from "./_core/documentValidity"');
    for (const f of ["openShiftsRouter", "readinessRouter", "crewRouter", "calendarRouter"]) {
      const src = readFileSync(`server/${f}.ts`, "utf8");
      expect(src, f).toContain('from "./qualificationReads"');
    }
  });

  it("leaves no router deciding a verification state by hand", () => {
    for (const f of ["openShiftsRouter", "readinessRouter"]) {
      const src = readFileSync(`server/${f}.ts`, "utf8");
      // Reading the column to load rows is fine; branching on its values is the
      // second implementation.
      expect(src).not.toMatch(/verificationState\s*!==\s*"verified"/);
      expect(src).not.toMatch(/verificationState\s*===\s*"extracted"/);
    }
  });

  it("classifies by a returned code rather than by matching prose", () => {
    const src = readFileSync("server/openShiftsRouter.ts", "utf8");
    expect(src).toContain("gap.why ===");
    // Matching on wording reclassified every unverified ticket the moment the
    // wording improved.
    expect(src).not.toContain('gap.reason.includes("verified it")');
  });
});
