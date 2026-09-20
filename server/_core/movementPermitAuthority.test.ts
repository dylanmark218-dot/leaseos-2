/**
 * v23.26 — who may say what about a permit.
 *
 * Three permissions rather than one, and this pins the gaps between them. The risk a single
 * `permit.manage` would have carried is not abstract: the determination is what releases a job
 * through the gate, so whoever holds it can declare any load within legal limits — and if the same
 * grant also covered verification, the person who typed a permit number could vouch for it too.
 */
import { describe, expect, it } from "vitest";
import { OPERATIONAL_PROCEDURE_PERMISSIONS, permissionsForDomainRole, type DomainRole } from "./recordsAuthorization";

const ROLES: DomainRole[] = ["driver", "dispatcher", "mechanic", "shop_lead", "safety", "office",
  "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller",
  "external_accountant"];

const holders = (perm: string) =>
  ROLES.filter(r => (permissionsForDomainRole(r) as readonly string[]).includes(perm)).sort();

describe("the permit permissions are three acts, not one", () => {
  it("gates all five procedures", () => {
    for (const p of ["statusFor", "listForJob", "record", "determine", "verify"]) {
      expect(OPERATIONAL_PROCEDURE_PERMISSIONS[`movementPermit.${p}`]).toBeDefined();
    }
  });

  it("lets a dispatcher determine but not verify their own entry", () => {
    /*
     * The one separation worth keeping here. A dispatcher decides whether a load is oversize —
     * that is the job — but confirming the permit with the issuing authority is somebody else's.
     */
    expect(holders("permit.determine")).toContain("dispatcher");
    expect(holders("permit.verify")).not.toContain("dispatcher");
  });

  it("lets office verify but not determine", () => {
    // Office does the authority-portal check; whether the load needs a permit is a call about the
    // load, made where the load is known.
    expect(holders("permit.verify")).toContain("office");
    expect(holders("permit.determine")).not.toContain("office");
  });

  it("gives a driver read and nothing else", () => {
    expect(holders("permit.read")).toContain("driver");
    for (const p of ["permit.record", "permit.determine", "permit.verify"]) {
      expect(holders(p)).not.toContain("driver");
    }
  });

  it("keeps determination narrower than recording", () => {
    // Recording a number off a fax is ordinary work. Claiming a movement is legal is not.
    expect(holders("permit.determine").length).toBeLessThan(holders("permit.record").length);
  });

  it("gives nobody outside management all four", () => {
    const all = ["permit.read", "permit.record", "permit.determine", "permit.verify"];
    const full = ROLES.filter(r => all.every(p => holders(p).includes(r)));
    expect(full).toEqual(["management"]);
  });
});
