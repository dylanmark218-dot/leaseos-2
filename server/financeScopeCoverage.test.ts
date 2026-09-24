/**
 * F1 / F1.1 — the regression net for tenant isolation, read from the LIVE router rather than from
 * source text. A string count can be satisfied by a comment; these checks cannot:
 *
 *   1. Every procedure mounted under a money namespace (the ten F1 finance routers, and insurance since
 *      F1.1) carries the `moneyScoped` mark (tRPC meta, set only by `moneyScoped()` in `_core/trpc.ts`)
 *      AND its handler uses the boundary: it reads `ctx.money`, or it refuses unowned rows outright
 *      through `requireProvableOwnership`.
 *   2. Across the whole API, a procedure whose input takes a book (`financialEntityId`) or names a
 *      money record by its key is money-scoped, or proves the book itself (entity-scope helpers), or is
 *      listed below as scoped by an external identity. There are NO known unscoped exceptions: F1.1
 *      closed the last of them. The list of external-identity procedures only shrinks.
 *   3. Every shop procedure is classified: scoped through its unit or work order (P4.1), a shared
 *      public directory, or refused while ownership is unprovable (inventory, until F4). A new shop
 *      procedure fails here until someone decides which it is.
 *
 * What this cannot see: a handler that reads `ctx.money` and then also queries a row without it. The
 * refusal suite (`tenantScopeFinance.db.test.ts`) is the behavioural half of this net.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

type ZodLike = { shape?: Record<string, unknown>; _def?: { innerType?: ZodLike; schema?: ZodLike }; unwrap?: () => ZodLike };
type Proc = { _def: { meta?: { moneyScoped?: true }; inputs?: ZodLike[]; resolver?: unknown } };
const procs = (appRouter as unknown as { _def: { procedures: Record<string, Proc> } })._def.procedures;

/** The ten F1 routers as mounted (CCA lives under `asset`), plus insurance (F1.1). */
const MONEY_NAMESPACES = ["bank", "ar", "period", "gst", "roadside", "purchasing", "vendor", "recovery", "invoicing", "asset", "fuel", "ifta", "commercial", "portalAdmin", "audit", "insurance"];
/**
 * Keys that name a money record wherever they appear. Generic names that other domains reuse for
 * something else (`deviceRef` is also a field device, `policyRef` a comms policy, `claimRef` a funding
 * claim) are not here; the procedures that use them for money are asserted by name below.
 */
const MONEY_KEYS = ["financialEntityId", "invoiceNumber", "billRef", "paymentRef", "creditRef", "assetRef", "tankRef", "fuelRef", "distanceRef", "caseNumber", "expenseRef", "opportunityRef"];
/** A handler that proves the book itself: the payroll / commercial-setup / commercial-office convention, or the F1.1 generic helper. */
const SELF_SCOPED = /assertEntityInScope|entityIdsInScope|assertPeriodInScope|bookFor\(|assertCallerOwnsEntity|deviceOwnedByCaller|financeScopeFor|requireOwnExpense|assertEnforcementScope/;
const USES_BOUNDARY = /ctx\.money|caller\.money|requireProvableOwnership/;

/** Not gaps: the customer portal is `externalProcedure`, scoped by the portal identity's own account binding (B21.12). */
const EXTERNALLY_SCOPED: Record<string, string> = {
  "portal.invoiceView": "externalProcedure — scoped by the portal identity's account",
  "portal.invoiceAccept": "externalProcedure — scoped by the portal identity's account",
  "portal.invoiceDispute": "externalProcedure — scoped by the portal identity's account",
};

/**
 * Shop procedures, each classified. OWNERSHIP_GATED ones touch parts, bins, movements, the tire registry,
 * serialized tools or warranty records — tables with no organization — and are refused
 * (OWNERSHIP_UNRESOLVED) unless the deployment is one ownership domain. Blocked on F4 (schema).
 */
const SHOP: Record<string, "unit_or_work_order_scoped" | "shared_public_directory" | "ownership_gated_until_F4"> = {
  partCreate: "ownership_gated_until_F4", partReceive: "ownership_gated_until_F4", partIssue: "ownership_gated_until_F4", partReturn: "ownership_gated_until_F4",
  coreReturn: "ownership_gated_until_F4", partCount: "ownership_gated_until_F4", stock: "ownership_gated_until_F4",
  tireRegister: "ownership_gated_until_F4", tireInstall: "ownership_gated_until_F4", tireRemove: "ownership_gated_until_F4", tireMeasure: "ownership_gated_until_F4", tireHistory: "ownership_gated_until_F4",
  warrantyPolicyRecord: "ownership_gated_until_F4", warrantyClaimRaise: "ownership_gated_until_F4", warrantyClaimDecide: "ownership_gated_until_F4",
  toolRegister: "ownership_gated_until_F4", toolCheckout: "ownership_gated_until_F4", toolReturn: "ownership_gated_until_F4",
  workOrderAdvance: "unit_or_work_order_scoped", workOrderRelease: "unit_or_work_order_scoped", workOrderCost: "unit_or_work_order_scoped", unitCost: "unit_or_work_order_scoped",
  recallRecord: "unit_or_work_order_scoped", recallUnitDecide: "unit_or_work_order_scoped",
  // A recall notice is a manufacturer's or regulator's public notice; verifying it is a fact about the notice, not about any company's records.
  recallVerify: "shared_public_directory",
};

/** Top-level input keys, through `.optional()` / `.default()` / `.strict()` wrappers. */
function inputKeys(p: Proc): string[] {
  let z: ZodLike | undefined = p._def.inputs?.[0];
  for (let i = 0; i < 5 && z && !z.shape; i++) z = z._def?.innerType ?? z._def?.schema ?? (typeof z.unwrap === "function" ? z.unwrap() : undefined);
  return Object.keys(z?.shape ?? {});
}
const source = (p: Proc) => String(p._def.resolver);

describe("F1 / F1.1 — every money procedure is money-scoped, structurally", () => {
  const money = Object.entries(procs).filter(([k]) => MONEY_NAMESPACES.includes(k.split(".")[0]!));

  it("finds the procedures it is guarding: 72 in the ten F1 routers and 12 in insurance", () => {
    expect(money.filter(([k]) => k.startsWith("insurance.")).length).toBe(12);
    expect(money.length).toBe(84);
  });

  it("marks every one of them moneyScoped", () => {
    expect(money.filter(([, p]) => !p._def.meta?.moneyScoped).map(([k]) => k)).toEqual([]);
  });

  it("and every one of their handlers uses the boundary it was given", () => {
    expect(money.filter(([, p]) => !USES_BOUNDARY.test(source(p))).map(([k]) => k)).toEqual([]);
  });

  it("uses the mark nowhere else — it means these routers, not a general-purpose label", () => {
    expect(Object.entries(procs).filter(([k, p]) => p._def.meta?.moneyScoped && !MONEY_NAMESPACES.includes(k.split(".")[0]!)).map(([k]) => k)).toEqual([]);
  });
});

describe("F1 / F1.1 — anywhere in the API, a procedure that takes a book or names a money record proves the book", () => {
  const unscoped = Object.entries(procs)
    .filter(([, p]) => inputKeys(p).some(key => MONEY_KEYS.includes(key)))
    .filter(([, p]) => !p._def.meta?.moneyScoped && !SELF_SCOPED.test(source(p)))
    .map(([k]) => k).sort();

  it("sees through optional inputs (dispatch.enforcementGet takes an optional object)", () => {
    expect(inputKeys(procs["dispatch.enforcementGet"]!)).toContain("financialEntityId");
  });

  it("has no unscoped money procedure at all, outside the external-identity portal", () => {
    expect(unscoped.filter(k => !(k in EXTERNALLY_SCOPED))).toEqual([]);
  });

  it("lists no portal procedure that no longer needs listing (the list only shrinks)", () => {
    expect(Object.keys(EXTERNALLY_SCOPED).filter(k => !unscoped.includes(k)).sort()).toEqual([]);
  });

  it("proves the book in each F1.1 procedure outside the money namespaces that takes one, directly or by reference", () => {
    for (const k of ["funding.opportunitiesList", "funding.opportunityAdvance", "funding.claimRecord", "funding.stackingCheck", "finance.expenseSetTreatment", "compliance.programPublish", "compliance.profileReviewRecord", "requirement.packActivate", "requirement.workAuthorization", "requirement.authorize", "calibration.deviceRegister", "calibration.eventRecord", "calibration.impact", "requirement.calibrationSweep", "dispatch.enforcementSet", "dispatch.enforcementGet"])
      expect(SELF_SCOPED.test(source(procs[k]!)), k).toBe(true);
  });
});

describe("F1.1 — every shop procedure is classified, and the unowned ones fail closed", () => {
  const shop = Object.keys(procs).filter(k => k.startsWith("shop.")).map(k => k.slice(5)).sort();

  it("has no unclassified shop procedure (a new one must be decided, not defaulted)", () => {
    expect(shop).toEqual(Object.keys(SHOP).sort());
  });

  it("refuses every inventory procedure whose rows carry no organization, first thing in the handler", () => {
    for (const [name, cls] of Object.entries(SHOP)) if (cls === "ownership_gated_until_F4") {
      const src = source(procs[`shop.${name}`]!);
      expect(src.includes("requireProvableOwnership"), name).toBe(true);
    }
  });

  it("gates unowned insurance requirements and equipment credentials the same way", () => {
    for (const k of ["insurance.requirementSet", "insurance.requirementMatch", "requirement.workAuthorization"]) expect(source(procs[k]!).includes("requireProvableOwnership"), k).toBe(true);
  });
});
