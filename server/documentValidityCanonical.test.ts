/**
 * C1b-3 — the expiry reading, and a census that keeps the qualification reads in one place.
 *
 * Numbered cases are the owner's required list (document validity 1–10; source census, Part N).
 *
 * Reconciled with #52 (SPINE item 2), which unified the four document-validity decisions first and was
 * merged: the owner ruled that #52's model governs. The cases here that pinned C1b-3's own version of
 * that unification (claimValidity/governingClaim, the exported per-surface helpers, census 1 and 10)
 * were removed with it; #52's complianceValidity* suites cover those surfaces. What remains is what
 * C1b-3 still owns: `readExpiry` and the D-05 qualification read adapter.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readExpiry, validityOf, type DocumentVersion } from "./_core/documentValidity";

const AT = new Date("2026-10-15T12:00:00Z");
const D = 86_400_000;
const at = (ms: number) => new Date(AT.getTime() + ms);
const read = (f: string) => readFileSync(path.resolve(__dirname, f), "utf8");

describe("the expiry reading", () => {
  it("2/4. future is current, past is expired, and the days are whole days", () => {
    expect(readExpiry(at(400 * D), AT, 30)).toEqual({ expiry: "current", daysRemaining: 400 });
    expect(readExpiry(at(-10 * D), AT, 30)).toEqual({ expiry: "expired", daysRemaining: -10 });
    expect(readExpiry(at(30.5 * D), AT, 30)).toEqual({ expiry: "expiring", daysRemaining: 30 });
  });

  it("3. the exact boundary is deterministic: in force at the instant, expired one millisecond later", () => {
    expect(readExpiry(AT, AT, 30).expiry).toBe("expiring");
    expect(readExpiry(AT, AT, 0).expiry).toBe("current");
    expect(readExpiry(at(-1), AT, 30).expiry).toBe("expired");
    expect(readExpiry(at(1000), AT, 0).expiry).toBe("current");
    // A warning window of zero or less never warns.
    expect(readExpiry(at(3600_000), AT, 0).expiry).toBe("current");
  });

  it("5. a missing expiry is reported as such", () => {
    expect(readExpiry(null, AT, 30)).toEqual({ expiry: "no_expiry", daysRemaining: null });
  });

  it("7. a superseded version yields to its successor", () => {
    const v = (version: number, state: DocumentVersion["state"], days: number): DocumentVersion => ({
      documentRef: "x", version, type: "tdg_certificate" as never, subjectRef: "s", state, effectiveFrom: null, expiresAt: at(days * D),
      verifiedByUserId: 1, verifiedAt: AT, supersededByVersion: null, uploadedAt: AT,
    });
    expect(validityOf([v(1, "superseded", 400), v(2, "verified", -1)], AT)).toMatchObject({ state: "expired", version: 2 });
  });

  it("8. a date-only expiry is midnight UTC; a local end-of-day is an absolute instant", () => {
    expect(readExpiry(new Date("2026-10-15"), AT, 30).expiry).toBe("expired");
    expect(readExpiry(new Date("2026-10-15T23:59:59-07:00"), AT, 30)).toEqual({ expiry: "expiring", daysRemaining: 0 });
    expect(readExpiry(new Date("2026-10-16"), AT, 0)).toEqual({ expiry: "current", daysRemaining: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* Census (Part N)                                                      */
/* ------------------------------------------------------------------ */

const productionFiles = (() => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) { if (f !== "node_modules") walk(full); continue; }
      if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(full);
    }
  };
  walk(path.resolve(__dirname));
  walk(path.resolve(__dirname, "../client/src"));
  return out;
})();
const rel = (f: string) => path.relative(path.resolve(__dirname, ".."), f);

describe("census", () => {
  it("the four qualification readers no longer read workerQualifications; only the adapter does", () => {
    for (const f of ["readinessRouter.ts", "openShiftsRouter.ts", "crewRouter.ts", "calendarRouter.ts"]) {
      expect(read(f), f).not.toContain("workerQualifications");
      expect(read(f), f).toContain('from "./qualificationReads"');
    }
    const readers = productionFiles.filter((f) => /from\(workerQualifications\)/.test(readFileSync(f, "utf8"))).map(rel);
    expect(readers).toEqual(["server/qualificationReads.ts"]);
  });

  it("24. no production writer of workerQualifications exists, and none was added", () => {
    const writers = productionFiles.filter((f) => /insert\(workerQualifications\)|update\(workerQualifications\)|INTO\s+`?workerQualifications/.test(readFileSync(f, "utf8"))).map(rel);
    expect(writers).toEqual([]);
  });

  it("operatorCapabilities gained no reader or writer, and no second qualification authority exists", () => {
    const touching = productionFiles.filter((f) => readFileSync(f, "utf8").includes("operatorCapabilities")).map(rel);
    expect(touching).toEqual([]);
    // The adapter reads the stores; it writes none of them.
    expect(read("qualificationReads.ts")).not.toMatch(/\.(insert|update|delete)\(/);
  });
});
