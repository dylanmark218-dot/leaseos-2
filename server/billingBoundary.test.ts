/**
 * v23.32 — the boundaries Billing, Invoicing and AR keep, read from the source so they cannot drift silently.
 *
 *   - AR never reaches a field device: no field runtime module, portal panel or device-sync procedure reads it, and
 *     no field role holds a billing authority.
 *   - Billing consumes the commercial source of truth: it prices only through resolveRateForJob (the job's frozen
 *     snapshot), never through the live-definition pricer, and restates no customer, contract or rate table.
 *   - Money is integers: every money and quantity column 0233 adds is an integer type, never a float or decimal.
 *   - History is never deleted: the billing service issues no DELETE; corrections are rows.
 *   - One audit ledger, one outbox, one document register: billing writes commercialAuditEvents, domainEventOutbox
 *     and the Document Control register, and creates no table of its own for any of them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { permissionsFor } from "./_core/recordsAuthorization";
import { OPERATIONAL_PROCEDURE_PERMISSIONS } from "./_core/recordsAuthorization";

const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
/** The migration's SQL, without its comments (which say, in words, what it does not do). */
const migration = readFileSync("drizzle/0233_billing_invoicing_ar.sql", "utf8").split("\n").filter(l => !/^\s*--/.test(l)).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const service = readFileSync("server/billingService.ts", "utf8");
const router = readFileSync("server/billingRouter.ts", "utf8");

describe("AR never reaches a field device", () => {
  it("no field runtime module or portal panel calls billing, and the device sync router reads no billing table", () => {
    const field = [...walk("client/src/runtime"), ...walk("client/src/portal")].filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    expect(field.length).toBeGreaterThan(5);
    const offenders = field.filter(f => /trpc\.billing\.|\bbilling\.(invoice|payment|receivables|customerBalance|workspace)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    const device = readFileSync("server/deviceRouter.ts", "utf8");
    for (const t of ["invoices", "invoiceLines", "billableCharges", "customerPayments", "paymentAllocations", "customerCredits", "invoiceAdjustments", "accountingSyncRecords", "billingWorkspaces"]) expect(device, t).not.toMatch(new RegExp(`\\b${t}\\b`));
  });
  it("no field role holds any billing.* procedure's permission", () => {
    const billing = Object.entries(OPERATIONAL_PROCEDURE_PERMISSIONS).filter(([k]) => k.startsWith("billing."));
    expect(billing).toHaveLength(38);
    for (const role of ["driver", "mechanic", "shop_lead", "dispatcher"]) {
      const held = new Set(permissionsFor([role]));
      expect(billing.filter(([, p]) => held.has(p as never)).map(([k]) => k), role).toEqual([]);
    }
    // an owner-operator who is also office staff: deny beats grant for the new billing authorities
    const ownerOperator = new Set(permissionsFor(["driver", "office"]));
    expect(["billing.workspace.read", "billing.prepare", "invoicing.submit", "invoicing.issue"].filter(p => ownerOperator.has(p as never))).toEqual([]);
  });
  it("every billing procedure is money-scoped (the strict F1 boundary) and role-authorized by name", () => {
    const procs = (appRouter as unknown as { _def: { procedures: Record<string, { _def: { meta?: { moneyScoped?: boolean } } }> } })._def.procedures;
    const billing = Object.entries(procs).filter(([k]) => k.startsWith("billing."));
    expect(billing).toHaveLength(38);
    expect(billing.filter(([, p]) => !p._def.meta?.moneyScoped).map(([k]) => k)).toEqual([]);
    expect(router).not.toMatch(/protectedProcedure|publicProcedure/);
  });
});

describe("billing consumes the commercial source of truth", () => {
  it("prices only from the frozen snapshot, never from live definitions, and restates no customer, contract or rate table", () => {
    expect(service).toMatch(/resolveRateForJob\(/);
    expect(service).toMatch(/getBillableCommercialContext\(/);
    expect(service).not.toMatch(/priceLineAndRecord|resolveRate\(\s*\[|from\(chargeDefinitions\)/);
    expect(migration).not.toMatch(/CREATE TABLE `(customer|contract|rate|charge)/i);
  });
});

describe("money is integers, history is rows", () => {
  it("every money and quantity column 0233 adds is an integer type", () => {
    // column definitions only (a CREATE TABLE line or an ADD COLUMN), not the names inside CHECK expressions
    const cols = Array.from(migration.matchAll(/(?:^\s+|ADD COLUMN\s+)`(\w*(?:Cents|Millis|Bps))`\s+(\w+)/gm)).map(m => [m[1]!, m[2]!.toLowerCase()]);
    expect(cols.length).toBe(14);   // billableCharges 9, invoices 1, invoiceLines 2, invoiceAdjustments 1, disputeCases 1
    expect(cols.filter(([, t]) => t !== "int" && t !== "bigint")).toEqual([]);
    expect(migration).not.toMatch(/\b(decimal|double|float)\b/i);
  });
  it("the billing service deletes nothing, and the migration declares no foreign key and drops no table", () => {
    expect(service).not.toMatch(/\.delete\(|DELETE FROM/i);
    expect(migration).not.toMatch(/FOREIGN KEY|DROP TABLE|TRUNCATE/i);
  });
  it("one audit ledger, one outbox, one document register", () => {
    expect(migration).not.toMatch(/CREATE TABLE `\w*(Audit|Outbox|Event|Document)\w*`/);
    expect(service).toMatch(/import \{ audit, emit,/);
    expect(service).toMatch(/registerControlledDocument\(/);
  });
});
