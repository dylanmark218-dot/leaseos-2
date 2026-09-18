/**
 * P8.5 — the vault's procedures.
 *
 * The read path goes through `serveRestricted`, which logs before it fetches. Nothing here writes
 * the two steps as two statements, because the order is the guarantee and a guarantee that depends
 * on the order somebody typed two `await`s is not one.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { incidentMatters, incidentReports, investigationProposals, restrictedAccessEvents, restrictedAccessGrants } from "../drizzle/schema";
import {
  TIER_OF_MATTER, createsInvestigation, evaluateRestrictedAccess, isRestricted, matterTrackingNumber,
  proposeInternalInvestigation, serveRestricted, trackingNumberLeaksCategory, validatePurpose,
  type SensitivityTier,
} from "./_core/restrictedVault";

const MATTER_TYPE = z.enum([
  "INSURANCE_CLAIM", "WCB_CLAIM", "REGULATORY_REPORT", "POLICE_FILE",
  "CLIENT_NOTICE", "THIRD_PARTY_CLAIM", "INTERNAL_INVESTIGATION", "LITIGATION",
]);

/** How long a break-glass grant lasts by default. Short on purpose; the spec calls for org config. */
const DEFAULT_GRANT_MINUTES = 60;

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

const orgOf = async (userId: number) => {
  const db = await dbOrThrow();
  const acting = await resolveActingScope(db, userId);
  return acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId;
};

/** The 0132 rule, reusable across the vault's tables: NULL is the historical single tenant's. */
const scopeWhere = (col: never, orgRef: string | null) =>
  orgRef == null ? isNull(col) : eq(col, orgRef);

export const restrictedVaultRouter = router({
  /**
   * Spawn a derived matter from the incident root. The facts stay on the incident; this registers
   * that an obligation exists and what kind — §4.1's single root, linked matters.
   */
  matterOpen: roleProcedure("restrictedVault.matterOpen")
    .input(z.object({
      incidentReportId: z.number().int().positive(),
      matterType: MATTER_TYPE,
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const incident = (await db.select({ id: incidentReports.id }).from(incidentReports).where(eq(incidentReports.id, input.incidentReportId)).limit(1))[0];
      if (!incident) throw new TRPCError({ code: "NOT_FOUND", message: `Incident ${input.incidentReportId} not found` });

      const [{ n }] = await db.select({ n: sql<number>`COUNT(*)` }).from(incidentMatters).where(scopeWhere(incidentMatters.orgRef as never, orgRef));
      const trackingNumber = matterTrackingNumber(Number(n) + 1);
      // Belt and braces: the generator is category-neutral, and this refuses to store one that is
      // not, so a later change to the format cannot quietly start leaking the category.
      if (trackingNumberLeaksCategory(trackingNumber)) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Refusing to store a tracking number that encodes its category" });
      }
      const tier: SensitivityTier = TIER_OF_MATTER[input.matterType];
      const ins = await db.insert(incidentMatters).values({
        orgRef, incidentReportId: input.incidentReportId, matterType: input.matterType,
        sensitivityTier: tier, trackingNumber, status: "OPEN", openedAt: new Date(),
        createdByUserId: ctx.user.id,
      });
      return {
        matterId: Number(ins[0]?.insertId ?? 0), trackingNumber, sensitivityTier: tier,
        restricted: isRestricted(tier),
        note: isRestricted(tier)
          ? "Opened in the restricted sector. It will not appear in the ordinary matter list, and opening it needs a stated purpose."
          : "Opened. It references the incident's facts rather than copying them.",
      };
    }),

  /**
   * The fan-out for an incident. Restricted matters are **excluded here**, not redacted: a list
   * that shows a row saying "restricted" still tells the reader an investigation exists, which is
   * the one fact the sector is for. They are reachable only through `restrictedRead`.
   */
  mattersForIncident: roleProcedure("restrictedVault.mattersForIncident")
    .input(z.object({ incidentReportId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const rows = await db.select().from(incidentMatters).where(and(
        scopeWhere(incidentMatters.orgRef as never, orgRef),
        eq(incidentMatters.incidentReportId, input.incidentReportId),
        inArray(incidentMatters.sensitivityTier, ["INTERNAL", "CONFIDENTIAL"]),
      )).orderBy(desc(incidentMatters.id));
      return {
        matters: rows,
        note: "Outward-facing matters only. Restricted records are not listed here at all — a row saying \"restricted\" would still say one exists.",
      };
    }),

  /** §5.3 — raise a proposal from a stated rule. Returns null when no rule fires; it does not guess. */
  investigationPropose: roleProcedure("restrictedVault.investigationPropose")
    .input(z.object({ incidentReportId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const incident = (await db.select().from(incidentReports).where(eq(incidentReports.id, input.incidentReportId)).limit(1))[0];
      if (!incident) throw new TRPCError({ code: "NOT_FOUND", message: `Incident ${input.incidentReportId} not found` });
      const trigger = proposeInternalInvestigation(incident as never);
      if (!trigger) return { proposalId: null, proposed: false as const, note: "No rule fires on this incident, so nothing is proposed. The absence of a proposal is not a finding that nothing happened." };
      const existing = (await db.select({ id: investigationProposals.id }).from(investigationProposals).where(and(
        scopeWhere(investigationProposals.orgRef as never, orgRef),
        eq(investigationProposals.incidentReportId, input.incidentReportId),
      )).limit(1))[0];
      if (existing) return { proposalId: existing.id, proposed: false as const, note: "A proposal already exists for this incident; a second one would not add a fact." };
      const ins = await db.insert(investigationProposals).values({
        orgRef, incidentReportId: input.incidentReportId,
        triggerRule: trigger.rule, triggerPolicy: trigger.policy, disposition: "PENDING",
      });
      return {
        proposalId: Number(ins[0]?.insertId ?? 0), proposed: true as const,
        triggerRule: trigger.rule, because: trigger.because,
        note: "Proposed, not required. Administration decides, and declining is a decision the system records rather than resists.",
      };
    }),

  /**
   * §5.2 — decide it. `OPENED` creates the matter; every other disposition creates **nothing** and
   * records only that a proposal was raised and deliberately declined.
   */
  investigationDecide: roleProcedure("restrictedVault.investigationDecide")
    .input(z.object({
      proposalId: z.number().int().positive(),
      disposition: z.enum(["OPENED", "HANDLED_INTERNALLY", "NOT_WARRANTED", "DEFERRED"]),
      /** Optional by owner decision: a company handling a matter in-house owes no essay. */
      reason: z.string().max(500).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const p = (await db.select().from(investigationProposals).where(eq(investigationProposals.id, input.proposalId)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      if (p.disposition !== "PENDING") throw new TRPCError({ code: "BAD_REQUEST", message: `This proposal was already decided (${p.disposition})` });

      let matterId: number | null = null;
      if (createsInvestigation(input.disposition)) {
        const [{ n }] = await db.select({ n: sql<number>`COUNT(*)` }).from(incidentMatters).where(scopeWhere(incidentMatters.orgRef as never, orgRef));
        const ins = await db.insert(incidentMatters).values({
          orgRef, incidentReportId: p.incidentReportId, matterType: "INTERNAL_INVESTIGATION",
          sensitivityTier: TIER_OF_MATTER.INTERNAL_INVESTIGATION,
          trackingNumber: matterTrackingNumber(Number(n) + 1), status: "OPEN",
          openedAt: new Date(), createdByUserId: ctx.user.id,
        });
        matterId = Number(ins[0]?.insertId ?? 0);
      }
      await db.update(investigationProposals).set({
        disposition: input.disposition, decidedByUserId: ctx.user.id,
        decidedAt: new Date(), decisionReason: input.reason ?? null, matterId,
      }).where(eq(investigationProposals.id, input.proposalId));

      return {
        proposalId: input.proposalId, disposition: input.disposition, matterId,
        note: matterId
          ? "Opened in the restricted sector."
          : "Recorded as declined. No investigation exists, and nothing about the matter's substance was stored — only that a proposal was raised and that you decided against it.",
      };
    }),

  /** §6.1 — the prompt. A purpose that would not explain the access a year later is refused. */
  breakGlass: roleProcedure("restrictedVault.breakGlass")
    .input(z.object({
      recordType: z.string().min(2).max(40),
      recordId: z.number().int().positive(),
      purpose: z.string().min(1).max(500),
      minutes: z.number().int().min(5).max(480).default(DEFAULT_GRANT_MINUTES),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const v = validatePurpose(input.purpose);
      if (!v.ok) throw new TRPCError({ code: "BAD_REQUEST", message: v.reason });
      const expiresAt = new Date(Date.now() + input.minutes * 60_000);
      const ins = await db.insert(restrictedAccessGrants).values({
        orgRef, userId: ctx.user.id, recordType: input.recordType, recordId: input.recordId,
        purpose: input.purpose.trim(), expiresAt,
      });
      const grantId = Number(ins[0]?.insertId ?? 0);
      await db.insert(restrictedAccessEvents).values({
        orgRef, grantId, userId: ctx.user.id, recordType: input.recordType, recordId: input.recordId,
        action: "GRANT_CREATED", purpose: input.purpose.trim(),
      });
      return {
        grantId, expiresAt,
        note: `This grant opens this one record until ${expiresAt.toISOString()}. Every read under it is logged with the purpose you gave.`,
      };
    }),

  /** The gated read. Logs before it fetches; a refusal is logged too. */
  restrictedRead: roleProcedure("restrictedVault.restrictedRead")
    .input(z.object({ matterId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const matter = (await db.select().from(incidentMatters).where(eq(incidentMatters.id, input.matterId)).limit(1))[0];
      if (!matter) throw new TRPCError({ code: "NOT_FOUND", message: "Record not found" });
      if (!isRestricted(matter.sensitivityTier)) {
        return { served: true as const, content: matter, note: "Not a restricted record; read through the ordinary path." };
      }
      const grants = await db.select().from(restrictedAccessGrants).where(and(
        eq(restrictedAccessGrants.userId, ctx.user.id),
        eq(restrictedAccessGrants.recordType, "incidentMatter"),
        eq(restrictedAccessGrants.recordId, input.matterId),
      ));
      const decision = evaluateRestrictedAccess({
        // The role check the procedure already made: reaching here means the permission is held.
        holdsRestrictedPermission: true,
        userId: ctx.user.id, recordType: "incidentMatter", recordId: input.matterId,
        grants: grants.map(g => ({ id: g.id, userId: g.userId, recordType: g.recordType, recordId: g.recordId, expiresAt: g.expiresAt, revokedAt: g.revokedAt })),
        now: new Date(),
      });
      const purpose = decision.allowed ? grants.find(g => g.id === decision.grantId)?.purpose ?? null : null;
      const result = await serveRestricted({
        decision,
        logAccess: async () => {
          await db.insert(restrictedAccessEvents).values({
            orgRef, grantId: decision.allowed ? decision.grantId : null, userId: ctx.user.id,
            recordType: "incidentMatter", recordId: input.matterId, action: "READ", purpose,
          });
        },
        logDenial: async (code, reason) => {
          await db.insert(restrictedAccessEvents).values({
            orgRef, grantId: null, userId: ctx.user.id, recordType: "incidentMatter",
            recordId: input.matterId, action: "DENIED", decisionCode: code, decisionReason: reason,
          });
        },
        fetchContent: async () => matter,
      });
      return result;
    }),

  /** Revocation takes effect immediately — the next read re-evaluates, it does not trust a session. */
  grantRevoke: roleProcedure("restrictedVault.grantRevoke")
    .input(z.object({ grantId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const g = (await db.select().from(restrictedAccessGrants).where(eq(restrictedAccessGrants.id, input.grantId)).limit(1))[0];
      if (!g) throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found" });
      await db.update(restrictedAccessGrants).set({ revokedAt: new Date(), revokedByUserId: ctx.user.id }).where(eq(restrictedAccessGrants.id, input.grantId));
      await db.insert(restrictedAccessEvents).values({
        orgRef, grantId: input.grantId, userId: ctx.user.id,
        recordType: g.recordType, recordId: g.recordId, action: "GRANT_REVOKED",
      });
      return { grantId: input.grantId, note: "Revoked. The next read re-evaluates rather than trusting an open session." };
    }),

  /** Who opened what, when and why — including the attempts that were refused. */
  accessHistory: roleProcedure("restrictedVault.accessHistory")
    .input(z.object({ recordType: z.string().max(40).optional(), recordId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = await orgOf(ctx.user.id);
      const rows = await db.select().from(restrictedAccessEvents).where(and(
        scopeWhere(restrictedAccessEvents.orgRef as never, orgRef),
        input.recordType ? eq(restrictedAccessEvents.recordType, input.recordType) : undefined,
        input.recordId ? eq(restrictedAccessEvents.recordId, input.recordId) : undefined,
      )).orderBy(desc(restrictedAccessEvents.occurredAt)).limit(input.limit);
      return { events: rows };
    }),
});
