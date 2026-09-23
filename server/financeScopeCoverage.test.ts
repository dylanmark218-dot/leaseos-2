/**
 * F1 — the regression net for tenant isolation of money, read from the LIVE router rather than from
 * source text. A string count can be satisfied by a comment; these checks cannot:
 *
 *   1. Every procedure mounted under a finance namespace carries the `moneyScoped` mark (tRPC meta,
 *      set only by `moneyScoped()` in `_core/trpc.ts`) AND its handler reads `ctx.money` — the mark
 *      alone would prove the boundary was resolved, not that the handler used it.
 *   2. Across the whole API, a procedure whose input takes a book (`financialEntityId`) or names a
 *      money record by its key is either money-scoped, or proves the book with an entity-scope helper,
 *      or is a NAMED exception below with the reason it is one. A new procedure in a new router that
 *      takes a book and proves nothing fails here.
 *
 * The exception list is a ratchet, not a permission: fixing one means deleting its line, and the
 * test fails if a listed procedure stops needing to be listed.
 *
 * What this cannot see: a handler that reads `ctx.money` and then also queries a row without it. The
 * cross-tenant refusal suite (`tenantScopeFinance.db.test.ts`) is the behavioural half of this net.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

type Proc = { _def: { meta?: { moneyScoped?: true }; inputs?: { shape?: Record<string, unknown> }[]; resolver?: unknown } };
const procs = (appRouter as unknown as { _def: { procedures: Record<string, Proc> } })._def.procedures;

/** The ten F1 routers, as mounted (the CCA procedures live under `asset`). */
const FINANCE_NAMESPACES = ["bank", "ar", "period", "gst", "roadside", "purchasing", "vendor", "recovery", "invoicing", "asset", "fuel", "ifta", "commercial", "portalAdmin", "audit"];
const MONEY_KEYS = ["financialEntityId", "invoiceNumber", "billRef", "paymentRef", "creditRef", "assetRef", "tankRef", "fuelRef", "distanceRef", "caseNumber"];
/** A handler that proves the book itself, in the payroll / commercial-setup / commercial-office convention. */
const SELF_SCOPED = /assertEntityInScope|entityIdsInScope|assertPeriodInScope|bookFor\(/;

/**
 * Known and reported, not fixed in F1 — each outside the ten approved routers. Deleting a line is how
 * one is closed. Reported in docs/finance/LEASEOS_FINANCE_F1_TENANT_ISOLATION.md.
 */
const KNOWN_UNSCOPED: Record<string, string> = {
  "insurance.policyRecord": "insurance router (12 procedures, no scope) — reported, owner decision pending",
  "insurance.coverageForEntity": "insurance router — reported",
  "insurance.requirementMatch": "insurance router — reported",
  "insurance.renewalCalendar": "insurance router — reported",
  "compliance.programPublish": "safety compliance, not finance — reported",
  "compliance.profileReviewRecord": "safety compliance, not finance — reported",
  "requirement.packActivate": "requirement engine, not finance — reported",
  "requirement.workAuthorization": "requirement engine, not finance — reported",
  "requirement.authorize": "requirement engine, not finance — reported",
  "calibration.deviceRegister": "calibration, not finance — reported",
  "dispatch.enforcementSet": "dispatch settings; dispatch is under change on PR #9 — reported",
  // Not a gap: the customer portal is externalProcedure, scoped by the identity's own account binding (B21.12).
  "portal.invoiceView": "externalProcedure — scoped by the portal identity's account",
  "portal.invoiceAccept": "externalProcedure — scoped by the portal identity's account",
  "portal.invoiceDispute": "externalProcedure — scoped by the portal identity's account",
};

const inputKeys = (p: Proc) => Object.keys(p._def.inputs?.[0]?.shape ?? {});
const source = (p: Proc) => String(p._def.resolver);

describe("F1 — every finance procedure is money-scoped, structurally", () => {
  const finance = Object.entries(procs).filter(([k]) => FINANCE_NAMESPACES.includes(k.split(".")[0]!));

  it("finds the finance procedures it is guarding (the router shape did not move out from under it)", () => {
    expect(finance.length).toBe(72);
  });

  it("marks every one of them moneyScoped", () => {
    expect(finance.filter(([, p]) => !p._def.meta?.moneyScoped).map(([k]) => k)).toEqual([]);
  });

  it("and every one of their handlers reads the boundary it was given", () => {
    expect(finance.filter(([, p]) => !/ctx\.money|caller\.money/.test(source(p))).map(([k]) => k)).toEqual([]);
  });

  it("uses the mark nowhere else — it means these routers, not a general-purpose label", () => {
    expect(Object.entries(procs).filter(([k, p]) => p._def.meta?.moneyScoped && !FINANCE_NAMESPACES.includes(k.split(".")[0]!)).map(([k]) => k)).toEqual([]);
  });
});

describe("F1 — anywhere in the API, a procedure that takes a book or names a money record proves the book", () => {
  const unscoped = Object.entries(procs)
    .filter(([, p]) => inputKeys(p).some(key => MONEY_KEYS.includes(key)))
    .filter(([, p]) => !p._def.meta?.moneyScoped && !SELF_SCOPED.test(source(p)))
    .map(([k]) => k).sort();

  it("has no unscoped money procedure except the named, reported exceptions", () => {
    expect(unscoped.filter(k => !(k in KNOWN_UNSCOPED))).toEqual([]);
  });

  it("lists no exception that has since been fixed (the list only shrinks)", () => {
    expect(Object.keys(KNOWN_UNSCOPED).filter(k => !unscoped.includes(k)).sort()).toEqual([]);
  });
});
