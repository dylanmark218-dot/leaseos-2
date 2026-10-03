/**
 * Payroll P1 — compensation agreements, effective-dated versions, earning rules and the earning-code
 * catalogue (docs/payroll/LEASEOS_PAYROLL_ARCHITECTURE_SURVEY.md, P1 checkpoint).
 *
 * Every procedure wraps its role gate in `moneyScoped`: the caller's books arrive as `ctx.money` and every
 * record named in input is proved against them; anything outside is "not found". Organization and book
 * ownership are never read from input — a `financialEntityId` in input is a claim the handler checks.
 *
 * D3 — NEW compensation configuration lives here and is authoritative for it. The legacy `payRates` path
 * (payroll.rateCreate / ratesList, P0-scoped) is not called, converted or superseded from this file.
 * D4 — approval goes through the commercial approval ladder (`decide`, 0136): the proposer may not approve,
 * revoked roles do not count, and nobody approves their own compensation.
 * D9 — the classification is `organizationWorkers.workerType`, or a deterministic legacy mapping; an
 * unmappable profile is refused visibly, and an owner-driver never gets an employee agreement.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { assertProfileInScope, ownsEntity, requireOwnedEntity } from "./_core/entityScope";
import {
  DATE_TEXT,
  agreementEligibility,
  normalizeClassification,
  supersessionPlan,
  validateRules,
  versionInForce,
  windowContains,
} from "./_core/payrollCompensation";
import { COMPENSATION_BASES, RULE_CALCULATIONS, RULE_UNITS } from "../drizzle/schema";
import * as comp from "./payrollCompensationService";

const notFound = (m: string) => new TRPCError({ code: "NOT_FOUND", message: m });
const badRequest = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const precondition = (m: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: m });
const forbidden = (m: string) => new TRPCError({ code: "FORBIDDEN", message: m });
const conflict = (m: string) => new TRPCError({ code: "CONFLICT", message: m });

const DATE = z.string().regex(DATE_TEXT, "a calendar date, YYYY-MM-DD");
const CURRENCY = z.string().regex(/^[A-Za-z]{3}$/, "a three-letter currency code");
/** A unique-key refusal, through drizzle's error wrapping (the MySQL error is the `cause`). */
const isDuplicate = (e: unknown): boolean => {
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    const o = x as { code?: unknown; errno?: unknown; message?: unknown };
    if (o.code === "ER_DUP_ENTRY" || o.errno === 1062 || /Duplicate entry/.test(String(o.message ?? ""))) return true;
  }
  return false;
};

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** The agreement, if its book is one of the caller's; otherwise "not found", as a missing one. */
async function agreementInScope(agreementRef: string, money: { entityIds: readonly number[]; tenantId: string }) {
  const a = await comp.loadAgreement(agreementRef);
  if (!a || !ownsEntity(money as never, a.financialEntityId)) throw notFound(`Compensation agreement ${agreementRef} not found`);
  return a;
}
async function versionInScope(versionRef: string, money: { entityIds: readonly number[]; tenantId: string }) {
  const v = await comp.loadVersion(versionRef);
  if (!v || !ownsEntity(money as never, v.financialEntityId)) throw notFound(`Compensation version ${versionRef} not found`);
  return v;
}

/** D9 — the classification for a profile, from its worker row or the legacy map; refused visibly when neither decides. */
async function classifyProfile(profile: NonNullable<Awaited<ReturnType<typeof comp.loadProfile>>>) {
  const worker = await comp.loadOrganizationWorkerForProfile(profile);
  const legacy = await comp.legacyClassificationEvidence(profile);
  return normalizeClassification({ organizationWorker: worker, legacy });
}

const RULE = z.object({
  earningCode: z.string().min(1).max(40),
  calculation: z.enum(RULE_CALCULATIONS),
  unit: z.enum(RULE_UNITS),
  rateMillis: z.number().int().nonnegative().nullable().optional(),
  percentMillis: z.number().int().min(0).max(100_000).nullable().optional(),
  overtimeRule: z.record(z.string(), z.unknown()).nullable().optional(),
  eligibleRevenueBasis: z.record(z.string(), z.unknown()).nullable().optional(),
  minimumMeasurementAuthority: z.enum(["authority_certified", "instrument_calibrated", "instrument_measured", "system_derived"]).nullable().optional(),
  requiresJob: z.boolean().optional(),
  requiresUnit: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export const payrollCompensationRouter = router({
  /* ---------------- Earning-code catalogue ---------------- */

  /** The shared seed plus the caller's books' own codes. A book's row with a seed's code is that book's override. */
  earningCodesList: moneyScoped(roleProcedure("payrollCompensation.earningCodesList")).query(async ({ ctx }) => {
    const rows = await comp.listEarningCodesForBooks(ctx.money.entityIds);
    return rows.map(r => ({ ...r, scope: r.financialEntityId === null ? ("shared" as const) : ("book" as const) }));
  }),

  /**
   * A book's own code. Writing a seed's code for a book is an override for that book only: the shared row is
   * never written, and another book still resolves the seed. The book is the caller's or "not found".
   */
  earningCodeCreate: moneyScoped(roleProcedure("payrollCompensation.earningCodeCreate"))
    .input(z.object({
      financialEntityId: z.number().int(),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, "upper-case letters, digits and underscores"),
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
      calculationType: z.enum(RULE_CALCULATIONS),
      rateSource: z.enum(["agreement", "pay_group", "manual", "none"]).default("agreement"),
      kind: z.enum(["earning", "reimbursement", "deduction", "employer_cost", "allowance"]).default("earning"),
      // Descriptive only. Nothing computes tax from this (D7, P9).
      taxTreatmentMeta: z.record(z.string(), z.unknown()).optional(),
      requiresJob: z.boolean().default(false),
      requiresUnit: z.boolean().default(false),
      requiresApproval: z.boolean().default(true),
      countsTowardOvertime: z.boolean().default(false),
      activeFrom: DATE,
      activeUntil: DATE.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      if (input.activeUntil && input.activeUntil <= input.activeFrom) throw badRequest("activeUntil must be after activeFrom");
      try {
        const codeRef = await comp.createBookEarningCode({
          financialEntityId: input.financialEntityId, code: input.code, name: input.name, description: input.description ?? null,
          calculationType: input.calculationType, rateSource: input.rateSource, kind: input.kind, taxTreatmentMetaJson: input.taxTreatmentMeta ?? null,
          requiresJob: input.requiresJob, requiresUnit: input.requiresUnit, requiresApproval: input.requiresApproval, countsTowardOvertime: input.countsTowardOvertime,
          activeFrom: input.activeFrom, activeUntil: input.activeUntil ?? null, createdByUserId: ctx.user.id,
        });
        return { codeRef, code: input.code, financialEntityId: input.financialEntityId };
      } catch (e) {
        if (isDuplicate(e)) throw conflict(`This book already has an earning code ${input.code}`);
        throw e;
      }
    }),

  /**
   * Retire a book's own code from a date. Versions that already use it keep it (the rule row stores the
   * code's id and text); only new proposals on or after the date stop resolving it. A shared seed is not a
   * book's to retire — a book that does not want it simply never uses it, or overrides it.
   */
  earningCodeRetire: moneyScoped(roleProcedure("payrollCompensation.earningCodeRetire"))
    .input(z.object({ codeRef: z.string().min(3).max(64), activeUntil: DATE }))
    .mutation(async ({ ctx, input }) => {
      const code = await comp.loadEarningCodeByRef(input.codeRef);
      if (!code) throw notFound(`Earning code ${input.codeRef} not found`);
      if (code.financialEntityId === null) throw forbidden("A shared seed code is not retired by a book; create this book's own code instead");
      if (!ownsEntity(ctx.money, code.financialEntityId)) throw notFound(`Earning code ${input.codeRef} not found`);
      if (code.retiredAt) throw precondition("This earning code is already retired");
      if (input.activeUntil <= code.activeFrom!) throw badRequest("A code cannot be retired before it became active");
      await comp.retireBookEarningCode({ id: code.id, retiredByUserId: ctx.user.id, activeUntil: input.activeUntil });
      return { codeRef: input.codeRef, activeUntil: input.activeUntil, historicalVersionsUnchanged: true };
    }),

  /* ---------------- Classification (D9) ---------------- */

  /** What the agreement path would snapshot for this profile, and why. Reads only. */
  profileClassification: moneyScoped(roleProcedure("payrollCompensation.profileClassification"))
    .input(z.object({ employeePayrollProfileId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      await assertProfileInScope(await dbOrThrow(), input.employeePayrollProfileId, ctx.money);
      const profile = (await comp.loadProfile(input.employeePayrollProfileId))!;
      const c = await classifyProfile(profile);
      if (!c.ok) return { classified: false as const, reason: c.reason };
      const elig = agreementEligibility(c.classification);
      return { classified: true as const, classification: c.classification, source: c.source, workerRef: c.workerRef, agreementEligible: elig.allowed, reason: elig.reason ?? null };
    }),

  /* ---------------- Agreements ---------------- */

  agreementsList: moneyScoped(roleProcedure("payrollCompensation.agreementsList")).query(async ({ ctx }) => comp.listAgreements(ctx.money.entityIds)),

  /** One agreement, every version and every version's rules. Superseded and rejected versions stay readable. */
  agreementGet: moneyScoped(roleProcedure("payrollCompensation.agreementGet"))
    .input(z.object({ agreementRef: z.string().min(3).max(64) }))
    .query(async ({ ctx, input }) => {
      const agreement = await agreementInScope(input.agreementRef, ctx.money);
      const versions = await comp.listVersions(agreement.id);
      return { agreement, versions: await Promise.all(versions.map(async v => ({ ...v, rules: await comp.listRules(v.id) }))) };
    }),

  /**
   * Open an agreement for a payroll profile in one of the caller's books. The profile's book and the
   * agreement's book must be the same book; the classification is established now and snapshotted on both
   * the profile and the agreement; an owner-driver is refused; agreements of one profile do not overlap.
   */
  agreementCreate: moneyScoped(roleProcedure("payrollCompensation.agreementCreate"))
    .input(z.object({
      employeePayrollProfileId: z.number().int(),
      financialEntityId: z.number().int(),
      title: z.string().min(1).max(160),
      startsOn: DATE,
      endsOn: DATE.optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const p = await assertProfileInScope(await dbOrThrow(), input.employeePayrollProfileId, ctx.money);
      if (p.financialEntityId !== input.financialEntityId) throw badRequest("The payroll profile is paid by a different financial entity than the agreement names");
      if (input.endsOn && input.endsOn <= input.startsOn) throw badRequest("endsOn must be after startsOn");
      const profile = (await comp.loadProfile(input.employeePayrollProfileId))!;
      if (profile.payrollStatus === "terminated") throw precondition("This payroll profile is terminated");
      const c = await classifyProfile(profile);
      if (!c.ok) throw precondition(c.reason);
      const elig = agreementEligibility(c.classification);
      if (!elig.allowed) throw badRequest(elig.reason!);
      const overlapping = await comp.overlappingAgreements({ employeePayrollProfileId: profile.id, startsOn: input.startsOn, endsOn: input.endsOn ?? null });
      if (overlapping.length) throw conflict(`This profile already has an agreement in that window (${overlapping.map(o => o.agreementRef).join(", ")}); a change of pay is a new version, not a second agreement`);
      await comp.recordProfileClassification({ employeePayrollProfileId: profile.id, classification: c.classification, source: c.source, workerRef: c.workerRef });
      const agreementRef = await comp.createAgreement({
        financialEntityId: input.financialEntityId, employeePayrollProfileId: profile.id, title: input.title, status: "draft",
        startsOn: input.startsOn, endsOn: input.endsOn ?? null, workerClassification: c.classification, classificationSource: c.source, createdByUserId: ctx.user.id,
      });
      return { agreementRef, status: "draft" as const, workerClassification: c.classification, classificationSource: c.source };
    }),

  /* ---------------- Versions ---------------- */

  /**
   * Propose a version: its rules are validated, every earning code resolved for the agreement's book on the
   * version's start date (book override first, then the shared seed), and the canonical rule set hashed and
   * frozen. An approved version is never edited — a raise is a new version with a later effectiveFrom. A
   * version that could only be approved by overlapping an approved window is refused now rather than later.
   */
  versionPropose: moneyScoped(roleProcedure("payrollCompensation.versionPropose"))
    .input(z.object({
      agreementRef: z.string().min(3).max(64),
      effectiveFrom: DATE,
      effectiveUntil: DATE.optional(),
      basis: z.enum(COMPENSATION_BASES),
      currency: CURRENCY.default("CAD"),
      rules: z.array(RULE).min(1).max(40),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const agreement = await agreementInScope(input.agreementRef, ctx.money);
      if (agreement.status === "ended") throw precondition("This agreement has ended");
      if (input.effectiveFrom < agreement.startsOn!) throw badRequest(`A version cannot start before the agreement (${agreement.startsOn})`);
      if (agreement.endsOn) {
        if (input.effectiveFrom >= agreement.endsOn) throw badRequest(`A version cannot start after the agreement ends (${agreement.endsOn})`);
        if (!input.effectiveUntil || input.effectiveUntil > agreement.endsOn) throw badRequest(`A version of an agreement that ends ${agreement.endsOn} must end by then`);
      }
      if (input.effectiveUntil && input.effectiveUntil <= input.effectiveFrom) throw badRequest("effectiveUntil must be after effectiveFrom (the window is [from, until))");

      const rules = [];
      for (const r of input.rules) {
        const code = await comp.resolveEarningCode(r.earningCode, agreement.financialEntityId, input.effectiveFrom);
        if (!code) throw badRequest(`Earning code ${r.earningCode} is not active for this book on ${input.effectiveFrom}`);
        if (code.calculationType !== r.calculation) throw badRequest(`Earning code ${r.earningCode} is ${code.calculationType}; the rule says ${r.calculation}`);
        rules.push({ ...r, earningCodeId: code.id, requiresJob: r.requiresJob ?? code.requiresJob, requiresUnit: r.requiresUnit ?? code.requiresUnit });
      }
      const errors = validateRules(input.basis, rules);
      if (errors.length) throw badRequest(errors.join("; "));

      const approved = (await comp.listVersions(agreement.id)).filter(v => v.status === "approved");
      const plan = supersessionPlan(approved.map(v => ({ versionRef: v.versionRef, status: v.status, effectiveFrom: v.effectiveFrom!, effectiveUntil: v.effectiveUntil })), { versionRef: "(candidate)", effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil ?? null });
      if (!plan.ok) throw badRequest(plan.reason);

      const r = await comp.proposeVersion({
        agreement: { id: agreement.id, financialEntityId: agreement.financialEntityId },
        effectiveFrom: input.effectiveFrom, effectiveUntil: input.effectiveUntil ?? null, basis: input.basis, currency: input.currency,
        rules, proposedByUserId: ctx.user.id, notes: input.notes ?? null,
      });
      if (!r) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      return { versionRef: r.versionRef, version: r.version, status: "proposed" as const, rulesHash: r.rulesHash };
    }),

  /**
   * Approve a proposed version (D4). Refused before the ledger is touched when the approver proposed it or
   * is the person it pays; then the commercial approval ladder decides (controller tier, proposer barred,
   * revoked roles do not count); on satisfaction the version is approved and the version in force at its
   * start is closed there and superseded — in one transaction with the ledger signature.
   */
  versionApprove: moneyScoped(roleProcedure("payrollCompensation.versionApprove"))
    .input(z.object({ versionRef: z.string().min(3).max(64), note: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const v = await versionInScope(input.versionRef, ctx.money);
      if (v.status !== "proposed") throw precondition(`This version is ${v.status}; only a proposed version can be approved`);
      if (v.proposedByUserId === ctx.user.id) throw forbidden("You proposed this version; the person who proposes a compensation change may not approve it");
      const agreement = await comp.loadAgreementById(v.agreementId);
      if (!agreement || agreement.financialEntityId !== v.financialEntityId) throw notFound(`Compensation version ${input.versionRef} not found`);
      const profile = await comp.loadProfile(agreement.employeePayrollProfileId);
      if (profile?.userId != null && profile.userId === ctx.user.id) throw forbidden("This version sets your own compensation; it must be approved by someone else");
      const r = await comp.approveVersionThroughLedger({ versionRef: v.versionRef, actorUserId: ctx.user.id, note: input.note });
      switch (r.outcome) {
        case "approved": return { versionRef: v.versionRef, status: "approved" as const, approvalRef: r.approvalRef, superseded: r.superseded };
        case "awaiting": return { versionRef: v.versionRef, status: "proposed" as const, approvalRef: r.approvalRef, awaiting: r.awaiting };
        case "overlap": throw badRequest(r.reason);
        case "blocked": throw forbidden(r.reason);
        case "not_proposed": throw precondition("This version is no longer proposed");
      }
    }),

  versionReject: moneyScoped(roleProcedure("payrollCompensation.versionReject"))
    .input(z.object({ versionRef: z.string().min(3).max(64), reason: z.string().min(5).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const v = await versionInScope(input.versionRef, ctx.money);
      if (v.status !== "proposed") throw precondition(`This version is ${v.status}; only a proposed version can be rejected`);
      if (v.proposedByUserId === ctx.user.id) throw forbidden("You proposed this version; withdrawing it is not a rejection");
      const r = await comp.rejectVersionThroughLedger({ versionRef: v.versionRef, actorUserId: ctx.user.id, reason: input.reason });
      if (r.outcome === "rejected") return { versionRef: v.versionRef, status: "rejected" as const, approvalRef: r.approvalRef };
      if (r.outcome === "blocked") throw forbidden(r.reason);
      throw precondition("This version is no longer proposed");
    }),

  /**
   * The approved version in force for a work date — [effectiveFrom, effectiveUntil), inclusive start and
   * exclusive end — with its rules and hash. Proposed and rejected versions never resolve; two matches are an
   * integrity error, reported, never resolved by picking one.
   */
  versionInForce: moneyScoped(roleProcedure("payrollCompensation.versionInForce"))
    .input(z.object({ agreementRef: z.string().min(3).max(64), workDate: DATE }))
    .query(async ({ ctx, input }) => {
      const agreement = await agreementInScope(input.agreementRef, ctx.money);
      const versions = await comp.listVersions(agreement.id);
      const r = versionInForce(versions.map(v => ({ versionRef: v.versionRef, status: v.status, effectiveFrom: v.effectiveFrom!, effectiveUntil: v.effectiveUntil })), input.workDate);
      if (r.kind === "none") return { kind: "none" as const, reason: r.reason };
      if (r.kind === "integrity_error") return { kind: "integrity_error" as const, reason: r.reason, versionRefs: r.versions.map(x => x.versionRef) };
      const v = versions.find(x => x.versionRef === r.version.versionRef)!;
      if (!windowContains({ effectiveFrom: v.effectiveFrom!, effectiveUntil: v.effectiveUntil }, input.workDate)) throw precondition("Resolver and stored window disagree");
      return {
        kind: "version" as const,
        agreementRef: agreement.agreementRef,
        versionRef: v.versionRef,
        version: v.version,
        status: v.status,
        effectiveFrom: v.effectiveFrom,
        effectiveUntil: v.effectiveUntil,
        basis: v.basis,
        currency: v.currency,
        rulesHash: v.rulesHash,
        rules: await comp.listRules(v.id),
      };
    }),
});
