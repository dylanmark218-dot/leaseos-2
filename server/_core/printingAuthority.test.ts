/**
 * v23.27 — who may print, and who may say which printer is where. Pins the gaps, not the grants.
 */
import { describe, expect, it } from "vitest";
import { OPERATIONAL_PROCEDURE_PERMISSIONS, permissionsForDomainRole, type DomainRole } from "./recordsAuthorization";

const ROLES: DomainRole[] = ["driver", "dispatcher", "mechanic", "shop_lead", "safety", "office",
  "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller",
  "external_accountant"];
const holders = (perm: string) => ROLES.filter(r => (permissionsForDomainRole(r) as readonly string[]).includes(perm)).sort();

describe("the print permissions", () => {
  it("gates all six procedures", () => {
    const map = OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, string>;
    for (const p of ["registerPrinter", "assignPrinter", "listPrinters", "assess", "record", "staleCopies"]) {
      expect(map[`printing.${p}`]).toBeDefined();
    }
  });

  it("lets a driver record a print, because the printer is in their cab", () => {
    expect(holders("print.record")).toContain("driver");
  });

  it("keeps saying which printer is in which unit with office and management", () => {
    // A driver moving a printer between trucks is an event to record, not a registry to rewrite.
    expect(holders("printer.manage")).toEqual(["management", "office"]);
  });

  it("never lets anyone record a print they could not then read back", () => {
    for (const r of holders("print.record")) expect(holders("print.read")).toContain(r);
  });

  it("keeps the whole print surface to the four roles that handle paper", () => {
    /*
     * Unlike permits, there is no separation of duties to protect between these three: office prints
     * at the yard and runs the printer registry, and assignments are superseded rather than edited, so
     * holding both cannot hide which unit printed what. What is pinned instead is the surface itself —
     * a finance or audit role gaining the right to record prints should have to argue with this line.
     */
    const any = ROLES.filter(r => ["print.read", "print.record", "printer.manage"].some(p => holders(p).includes(r))).sort();
    expect(any).toEqual(["dispatcher", "driver", "management", "office"]);
  });
});
