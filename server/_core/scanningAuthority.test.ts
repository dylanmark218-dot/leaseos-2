/**
 * v23.28 — who may read paperwork guidance, and what the scanner is not allowed to become.
 *
 * Pins the gaps rather than the grants. Two of these exist because the obvious shortcuts both
 * shipped a real bug during this checkpoint:
 *
 *   reusing `compliance.read`  drivers do not hold it, and the driver at the facility gate is the
 *                              entire reason the feature exists.
 *   reusing `scan.read`        already taken, and it means the QR scan-AUDIT trail behind
 *                              `scans.list`. Granting it to everyone who needs paperwork guidance
 *                              would have handed them that audit log as well.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OPERATIONAL_PROCEDURE_PERMISSIONS, permissionsForDomainRole, type DomainRole } from "./recordsAuthorization";

const ROLES: DomainRole[] = ["driver", "dispatcher", "mechanic", "shop_lead", "safety", "office",
  "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller",
  "external_accountant"];
const holders = (perm: string) => ROLES.filter(r => (permissionsForDomainRole(r) as readonly string[]).includes(perm)).sort();

const SCAN_PROCEDURES = ["paperwork.guidance", "paperwork.retention", "paperwork.reviewScan"];

describe("the paperwork permission", () => {
  it("gates all three procedures", () => {
    const map = OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, string>;
    for (const p of SCAN_PROCEDURES) expect(map[p], p).toBe("paperwork.read");
  });

  it("lets a driver read it, because the ticket is in their hand at the gate", () => {
    expect(holders("paperwork.read")).toContain("driver");
  });

  it("does not settle for compliance.read, which the driver does not hold", () => {
    expect(holders("compliance.read")).not.toContain("driver");
    const map = OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, string>;
    for (const p of SCAN_PROCEDURES) expect(map[p], p).not.toBe("compliance.read");
  });

  it("does not reuse scan.read, which is the QR scan-audit trail and means something else", () => {
    /*
     * The regression that matters. `scan.read` gates `scans.list` — who photographed which
     * roadside panel. Pointing paperwork guidance at it would widen that audit to the driver,
     * mechanic, shop lead, legal and bookkeeper roles in one line, and nothing would have said so.
     */
    const map = OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, string>;
    for (const p of SCAN_PROCEDURES) expect(map[p], p).not.toBe("scan.read");
    expect(map["scans.list"]).toBe("scan.read");
    expect(holders("scan.read")).not.toContain("driver");
    // The two sets are deliberately different. If they ever coincide, somebody has merged them.
    expect(holders("paperwork.read")).not.toEqual(holders("scan.read"));
    // And the QR audit's own holder set is pinned, so widening it is a deliberate edit.
    expect(holders("scan.read")).toEqual(
      ["auditor", "dispatcher", "management", "mechanic", "office", "safety", "shop_lead"],
    );
  });

  it("reaches everyone who already reads compliance material, plus the driver, and nobody else", () => {
    const expected = Array.from(new Set(holders("compliance.read").concat(["driver"]))).sort();
    expect(holders("paperwork.read")).toEqual(expected);
  });

  it("stays read-only: every procedure on this permission is a query that writes nothing", () => {
    /*
     * The moment something persists — a scan session row, an accepted auto-link — it needs its own
     * permission and its own procedure. This assertion makes that a deliberate act rather than a
     * quiet widening of `paperwork.read`.
     */
    const map = OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, string>;
    const onPaperworkRead = Object.keys(map).filter(k => map[k] === "paperwork.read").sort();
    expect(onPaperworkRead).toEqual(SCAN_PROCEDURES);
  });
});

/* ------------------------------------------------------------------ */
/* Structural: which procedures are allowed to touch rows              */
/* ------------------------------------------------------------------ */

describe("the scanning router keeps its pure and row-reading halves apart", () => {
  const src = readFileSync("server/scanningRouter.ts", "utf8");
  const bodyOf = (name: string) => {
    const start = src.indexOf(`${name}: roleProcedure(`);
    expect(start, `${name} is not mounted`).toBeGreaterThan(-1);
    const next = ["guidance: roleProcedure(", "reviewScan: roleProcedure(", "retention: roleProcedure("]
      .map(m => src.indexOf(m))
      .filter(i => i > start)
      .sort((a, b) => a - b)[0] ?? src.length;
    return src.slice(start, next);
  };

  it("gives the pure procedures no database handle and no scope lookup", () => {
    /*
     * `printing.assess` — the one pure procedure on the sibling router — resolves no scope either,
     * because there is nothing to scope: the answer is the same for every organization. What this
     * pins is the converse: a pure procedure must not quietly acquire row-reading authority by
     * someone adding a getDb() to it. If it needs rows, it needs the scope lookup too, and that
     * should be a deliberate edit that fails this test first.
     */
    for (const name of ["guidance", "retention"]) {
      const body = bodyOf(name);
      expect(body, `${name} must not read rows`).not.toContain("getDb(");
      expect(body, `${name} must not read rows`).not.toContain("scopeFor(");
      expect(body, `${name} must not take a db handle`).not.toContain("configuredBindings(");
      expect(body, `${name} must not resolve links`).not.toContain("existingLinkFor(");
    }
  });

  it("makes the row-reading procedure resolve the acting scope before it reads anything", () => {
    const body = bodyOf("reviewScan");
    expect(body).toContain("scopeFor(ctx.user.id)");
    // The scope lookup must come BEFORE the row reads, or a two-organization caller would have
    // their rows fetched and only then be refused.
    expect(body.indexOf("scopeFor(ctx.user.id)")).toBeLessThan(body.indexOf("configuredBindings("));
    expect(body.indexOf("scopeFor(ctx.user.id)")).toBeLessThan(body.indexOf("existingLinkFor("));
  });

  it("mounts no mutation on the scanning surface at all", () => {
    expect(src).not.toContain(".mutation(");
  });

  it("takes no tracking format from any input schema", () => {
    /*
     * A caller-supplied pattern would defeat the whole point of deriving the matcher from the
     * office's configuration. Note `format: z.string()` DOES appear legitimately — it is the
     * barcode symbology a device reports (QR_CODE, CODE_128), which is an observation about the
     * page and not a matcher. What must never be accepted are the SequenceFormat fields.
     */
    expect(src).not.toMatch(/trackingBindings:\s*z\./);
    expect(src).not.toMatch(/prefix:\s*z\./);
    expect(src).not.toMatch(/separator:\s*z\./);
    expect(src).not.toMatch(/sequenceDigits:\s*z\./);
    expect(src).not.toMatch(/yearDigits:\s*z\./);
  });
});
