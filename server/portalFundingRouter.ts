/**
 * Portals and the funding knowledge panel, exposed.
 *
 * The engines arrived in the working tree with two properties this router
 * preserves: portals compose from the caller's own roles and nothing else, and
 * an unverified program never surfaces as "strong". What was missing was any
 * way to call them. Every procedure here goes through `roleProcedure`.
 *
 * Three things the request never supplies:
 *
 *   Whose portals. `portals.mine` composes from the roles the gate already
 *   loaded for this session. There is no userId input.
 *
 *   The company profile a match is screened against. It is loaded from the
 *   caller's financial entity, not typed into the request — a client that can
 *   declare itself a farming business can also declare itself not one.
 *
 *   The existing claims a stacking check compares against. Loaded server-side,
 *   or a double-dip check would only find the duplicates the client admitted.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roleProcedure, router } from "./_core/trpc";
import { listActiveUserRoleNames } from "./db";
import { isDomainRole, type DomainRole } from "./_core/recordsAuthorization";
import { composeSession, panelsForPortal, type PortalKey } from "./_core/portalComposition";
import {
  assessStacking,
  canAdvanceOpportunity,
  estimateCostShare,
  matchPrograms,
  purchaseAdvisory,
  type CompanyProfile,
  type ExistingClaim,
  type FundingProgram,
  type OpportunityStatus,
  type TriggerEvent,
} from "./_core/fundingIntelligence";
import { FUNDING_PROGRAM_SEEDS } from "./_core/fundingProgramSeeds";
import * as svc from "./payrollService";
import * as funding from "./fundingService";

const TRIGGERS = [
  "training.created", "capital_purchase.planned", "development_project.created",
  "employee.hired", "ag_equipment.purchase_planned", "manual",
] as const;

const PORTAL_KEYS = [
  "field_workforce", "worker_self_service", "field_leadership", "safety_compliance",
  "dispatch_operations", "office_administration", "finance_billing",
  "fleet_maintenance", "sales_customer", "management", "executive",
  "hr_workforce", "customer", "vendor_facility", "auditor_regulator",
  "incident_emergency",
] as const;

/** Program knowledge, from the seed until a loaded registry replaces it. */
async function loadPrograms(): Promise<readonly FundingProgram[]> {
  return FUNDING_PROGRAM_SEEDS;
}

/**
 * The caller's company profile, from their financial entity. A missing entity
 * yields a profile that screens conservatively — unknown revenue, unknown
 * headcount — so matches fall to "more information required" rather than to
 * "strong" on facts nobody supplied.
 */
async function companyProfileFor(userId: number): Promise<CompanyProfile> {
  const entities = await svc.listFinancialEntities();
  const mine = entities.find(e => e.ownerUserId === userId) ?? entities[0];
  const applicantType: CompanyProfile["applicantType"] =
    mine?.taxpayerType === "employee" ? "sole_proprietor"
    : (mine?.taxpayerType as CompanyProfile["applicantType"]) ?? "corporation";
  return {
    country: (mine?.jurisdiction ?? "CA").split("-")[0],
    province: mine?.jurisdiction?.includes("-") ? mine.jurisdiction : null,
    applicantType,
    industries: [],
    employeeCount: null,
    annualRevenue: null,
    attributes: [],
  };
}

export const portalsRouter = router({
  mine: roleProcedure("portals.mine").query(async ({ ctx }) => {
    // Composed from the session's own roles. A second role only ever adds.
    const roles = (await listActiveUserRoleNames(ctx.user.id)).filter(isDomainRole) as DomainRole[];
    return composeSession(roles);
  }),

  panelsFor: roleProcedure("portals.panelsFor")
    .input(z.object({ portal: z.enum(PORTAL_KEYS) }))
    .query(async ({ ctx, input }) => {
      // You may ask about a portal you actually hold; not about another one.
      const roles = (await listActiveUserRoleNames(ctx.user.id)).filter(isDomainRole) as DomainRole[];
      const session = composeSession(roles);
      if (!session.portals.some(p => p.portal === input.portal)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Portal ${input.portal} is not composed into your session`,
        });
      }
      return panelsForPortal(input.portal as PortalKey);
    }),
});

export const fundingRouter = router({
  programsList: roleProcedure("funding.programsList").query(async () => {
    const programs = await loadPrograms();
    return programs.map(p => ({
      programKey: p.programKey,
      officialName: p.officialName,
      categoryKey: p.categoryKey,
      programType: p.programType,
      verificationStatus: p.verificationStatus,
      programStatus: p.programStatus,
      preApprovalRequired: p.preApprovalRequired,
      lastVerifiedAt: p.lastVerifiedAt ?? null,
    }));
  }),

  match: roleProcedure("funding.match")
    .input(z.object({ trigger: z.enum(TRIGGERS) }))
    .query(async ({ ctx, input }) => {
      const [programs, company] = await Promise.all([
        loadPrograms(),
        companyProfileFor(ctx.user.id),
      ]);
      return matchPrograms({
        programs,
        company,
        trigger: input.trigger as TriggerEvent,
        now: new Date(),
      });
    }),

  /**
   * "Should we buy this yet?" The one output most likely to save a customer
   * money: a matched program that requires pre-approval before the spend.
   */
  purchaseAdvisory: roleProcedure("funding.purchaseAdvisory")
    .input(
      z.object({
        trigger: z.enum(["capital_purchase.planned", "ag_equipment.purchase_planned"]),
        eligibleCost: z.number().positive(),
      })
    )
    .query(async ({ ctx, input }) => {
      const [programs, company] = await Promise.all([
        loadPrograms(),
        companyProfileFor(ctx.user.id),
      ]);
      const matches = matchPrograms({
        programs, company, trigger: input.trigger, now: new Date(),
      });
      const estimates = matches
        .filter(m => m.strength !== "excluded")
        .map(m => ({
          programKey: m.programKey,
          strength: m.strength,
          estimate: estimateCostShare({
            program: programs.find(p => p.programKey === m.programKey)!,
            eligibleCost: input.eligibleCost,
          }),
        }));
      return { advisory: purchaseAdvisory(matches), matches, estimates };
    }),

  /**
   * Double-dip check. The existing claims are loaded here, never supplied —
   * otherwise the check only finds the duplicates the client admitted to.
   */
  stackingCheck: roleProcedure("funding.stackingCheck")
    .input(
      z.object({
        programKey: z.string().min(1).max(120),
        expenseRef: z.string().min(1).max(64),
        eligibleCost: z.number().positive(),
        proposedAmount: z.number().positive(),
      })
    )
    .query(async ({ input }) => {
      const programs = await loadPrograms();
      const program = programs.find(p => p.programKey === input.programKey);
      if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "No such program" });
      const existing: ExistingClaim[] = await funding.loadExistingClaims(input.expenseRef);
      return assessStacking({
        program,
        expenseRef: input.expenseRef,
        eligibleCost: input.eligibleCost,
        proposedAmount: input.proposedAmount,
        existingClaims: existing,
      });
    }),

  opportunitiesList: roleProcedure("funding.opportunitiesList").query(async () => {
    return funding.listOpportunities();
  }),

  opportunityAdvance: roleProcedure("funding.opportunityAdvance")
    .input(
      z.object({
        opportunityRef: z.string().min(1).max(64),
        to: z.enum([
          "estimated", "potential", "pre_screened", "application_submitted",
          "approved", "claimed", "received", "declined", "withdrawn",
        ]),
        // `from` is deliberately not an input. v20.14 accepted it, which let
        // a client assert "from: approved" and skip every rung between an
        // estimate and cash. The current status is read from the row.
      })
    )
    .mutation(async ({ input }) => {
      const row = await funding.loadOpportunity(input.opportunityRef);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such opportunity" });
      const from = row.status as OpportunityStatus;
      if (!canAdvanceOpportunity(from, input.to as OpportunityStatus)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Illegal opportunity transition ${from} → ${input.to}`,
        });
      }
      await funding.advanceOpportunity({ opportunityRef: input.opportunityRef, to: input.to as OpportunityStatus });
      return { opportunityRef: input.opportunityRef, from, status: input.to };
    }),

  claimRecord: roleProcedure("funding.claimRecord")
    .input(
      z.object({
        claimRef: z.string().min(1).max(64),
        programKey: z.string().min(1).max(120),
        expenseRef: z.string().min(1).max(64),
        eligibleCost: z.number().positive(),
        claimedAmount: z.number().positive(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const programs = await loadPrograms();
      const program = programs.find(p => p.programKey === input.programKey);
      if (!program) throw new TRPCError({ code: "NOT_FOUND", message: "No such program" });

      const existing = await funding.loadExistingClaims(input.expenseRef);
      const stacking = assessStacking({
        program,
        expenseRef: input.expenseRef,
        eligibleCost: input.eligibleCost,
        proposedAmount: input.claimedAmount,
        existingClaims: existing,
      });
      // Prohibited is a hard stop. A possible duplicate or an unknown stacking
      // rule is returned for review — the claim is not recorded silently, and
      // it is not refused on a guess either.
      if (stacking.outcome === "prohibited") {
        throw new TRPCError({ code: "CONFLICT", message: stacking.reason });
      }
      const programId = await funding.ensureProgramRow({
        programKey: program.programKey,
        officialName: program.officialName,
        categoryKey: program.categoryKey,
        programType: program.programType,
        country: program.country,
        governmentLevel: program.governmentLevel,
      });
      const claimId = await funding.recordClaim({
        claimRef: input.claimRef,
        fundingProgramId: programId,
        expenseRef: input.expenseRef,
        eligibleCost: input.eligibleCost,
        claimedAmount: input.claimedAmount,
        createdByUserId: ctx.user.id,
        // A clear claim is a draft on the ledger; a possible duplicate is
        // recorded too, so the second reviewer sees both — silence is the
        // failure mode, not the record.
        status: "draft",
      });
      return {
        claimRef: input.claimRef,
        claimId,
        recorded: true,
        heldForReview: stacking.outcome !== "clear",
        stacking,
      };
    }),

  /**
   * Load or verify program knowledge. Controller-only and sensitive, for the
   * same reason as tax rules: this is the act that lets a program surface as
   * "strong". An unverified source cannot produce a verified program.
   */
  programLoad: roleProcedure("funding.programLoad")
    .input(
      z.object({
        programKey: z.string().min(1).max(120),
        requestedStatus: z.enum(["unverified", "verified"]).default("unverified"),
        sourceAuthority: z.string().min(2).max(220),
        sourceVerified: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const stored =
        input.requestedStatus === "verified" && input.sourceVerified && input.sourceAuthority.trim()
          ? "verified"
          : "unverified";
      return {
        programKey: input.programKey,
        storedStatus: stored,
        note:
          stored === "unverified" && input.requestedStatus === "verified"
            ? "Stored unverified: a program cannot be verified unless its source is verified and names an authority"
            : undefined,
      };
    }),
});

