/**
 * v22.20 — Hours of service: the API.
 *
 * Loading a profile is a controller's act. Verifying one — or a single limit
 * inside it — is a second person's, because a verified figure is what a
 * driver's legal driving time will be computed from. Until then every
 * determination reads UNKNOWN and the clocks are shown without a compliance
 * answer.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { storageKeyInput } from "./_core/storageKey";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import type { DbOrTx } from "./_core/dbTypes";
import { complianceDocuments, dutyRecords, hosAttestations, hosRuleLimits, hosRuleProfiles } from "../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { ALL_HOS_PROFILE_SEEDS, HOS_SEED_CAVEAT, HOS_SEED_RETRIEVAL_DATE } from "./_core/hosRuleSeeds";
import { divergences, promote as promoteLimit } from "./_core/knowledge/promotionLedger";
import { checkPromotionScope } from "./_core/knowledge/scopeGuard";
import {
  computeClocks, determine, selectProfile, tripFeasibility,
  type DutyEntry, type HosRuleProfile, type LimitKey,
} from "./_core/hos";

async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

/** Rows read back as the engine's types. The limits travel with their profile, never apart from it. */
export async function loadProfiles(d: DbOrTx): Promise<HosRuleProfile[]> {
  const profiles = await d.select().from(hosRuleProfiles);
  const limits = profiles.length ? await d.select().from(hosRuleLimits).where(inArray(hosRuleLimits.profileKey, profiles.map(p => p.profileKey))) : [];
  return profiles.map(p => ({
    profileKey: p.profileKey, label: p.label,
    applicability: { authorityLevel: p.authorityLevel, jurisdiction: p.jurisdiction, latitudeRule: p.latitudeRule, minimumWeightKg: p.minimumWeightKg, operationClass: p.operationClass },
    limits: limits.filter(l => l.profileKey === p.profileKey && l.verificationStatus !== "superseded").map(l => ({ limitKey: l.limitKey as LimitKey, value: l.value, sourceSection: l.sourceSection, verificationStatus: l.verificationStatus })),
    sourceAuthority: p.sourceAuthority, sourceCitation: p.sourceCitation, sourceUrl: p.sourceUrl,
    effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo,
    verificationStatus: p.verificationStatus, supersedesProfileKey: p.supersedesProfileKey,
  }));
}

export const CONTEXT = z.object({
  carrierAuthority: z.enum(["federal", "provincial", "territorial"]).nullish(),
  jurisdiction: z.string().max(8).nullish(),
  crossedBoundary: z.boolean().nullish(),
  registeredWeightKg: z.number().int().positive().max(200_000).nullish(),
  operationClass: z.string().max(40).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  at: z.coerce.date().default(() => new Date()),
});

/**
 * B23.2 — the determination for one operator at one moment, as `hos.status` computes it. Shared so
 * Scheduling Intelligence reads the same answer the HOS screen shows rather than a second one.
 */
export async function determinationFor(d: DbOrTx, input: z.infer<typeof CONTEXT> & { operatorId: number; lookbackDays?: number }) {
  const since = new Date(input.at.getTime() - (input.lookbackDays ?? 16) * 24 * 60 * 60_000);
  const rows = await d.select().from(dutyRecords).where(and(eq(dutyRecords.operatorId, input.operatorId), gte(dutyRecords.startedAt, since)));
  const entries: DutyEntry[] = rows.map(r => ({ dutyStatus: r.dutyStatus, startedAt: r.startedAt, endedAt: r.endedAt }));
  const selection = selectProfile({ ...input, at: input.at }, await loadProfiles(d));
  const profile = selection.outcome === "selected" ? selection.profile : null;
  const core = profile?.limits.find(l => l.limitKey === "core_rest_minutes" && l.verificationStatus === "verified")?.value;
  const clocks = computeClocks(entries, input.at, { shiftResetMinutes: core });
  return { dutyRecordsRead: rows.length, selection, clocks, determination: determine(clocks, profile), core };
}

export const hosRouter = router({

  /**
   * P8.3 — record a scanned paper log as a compliance record.
   *
   * This and `attestHours` answer two different questions, and the whole value is in not letting
   * them blur:
   *
   *   this one satisfies **retention and audit** — the log book page exists, it is on file, and a
   *     regulator asking for six months of records can be given them;
   *   `attestHours` answers **dispatch** — can this driver legally start this run right now.
   *
   * A scanned page is after-the-fact proof. It says what happened yesterday; it does not say what
   * is left today, and a scan arriving must not quietly clear a dispatch check. So this writes a
   * compliance document and deliberately touches nothing the readiness engine reads.
   *
   * `confidence: "low"` is not pessimism about the paperwork: the company's record may be perfect.
   * It is about what LeaseOS itself can vouch for, which is an image of a page nobody here has
   * totalled. A person verifies it through the ordinary credential path.
   */
  recordScannedLog: roleProcedure("hos.recordScannedLog")
    .input(z.object({
      operatorId: z.number().int().positive(),
      dutyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The duty date the page covers, as YYYY-MM-DD"),
      storageKey: storageKeyInput,
      /** Who put the page in front of the scanner, in their words. */
      note: z.string().min(10).max(400),
      jurisdiction: z.string().max(80).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const dutyDate = new Date(`${input.dutyDate}T00:00:00Z`);
      if (dutyDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A duty date in the future has no log page to scan" });
      }
      const ins = await db.insert(complianceDocuments).values({
        ownerType: "operator", ownerId: input.operatorId,
        docType: "hos_daily_log", requirementKey: "hos.daily_log",
        title: `Paper log — ${input.dutyDate}`,
        identifier: input.dutyDate,
        storageKey: input.storageKey,
        capturedAt: new Date(), issuedAt: dutyDate, expiresAt: null,
        jurisdiction: input.jurisdiction ?? null,
        // Recorded is not verified, as everywhere else.
        verificationStatus: "needs_review",
        source: "scanned_paper",
        // What LeaseOS can vouch for is an image of a page nobody here has totalled.
        confidence: "low",
        privateDetail: false,
      });
      return {
        documentId: Number(ins[0]?.insertId ?? 0),
        source: "scanned_paper" as const,
        verificationStatus: "needs_review" as const,
        recordedByUserId: ctx.user.id,
        note: `On file for retention and audit. It is after-the-fact proof for ${input.dutyDate} and does not answer whether this driver has hours available now — dispatch still needs an attestation or a live figure for that.`,
      };
    }),

  /**
   * P8.3 — attest a driver's hours for one duty day, when the company runs paper logs.
   *
   * This is the statement that was previously impossible to make. A carrier on paper has no live
   * figure, so dispatch could only answer `hos_unknown` and be overridden — which recorded that
   * someone clicked past it, not that anyone had checked anything.
   *
   * What it deliberately does NOT do: write `hoursAvailableMinutes`. A stated figure copied into
   * the computed field would be indistinguishable from an ELD reading the moment it left this
   * table, and every screen downstream would present a person's word as a measurement.
   */
  attestHours: roleProcedure("hos.attestHours")
    .input(z.object({
      operatorId: z.number().int().positive(),
      dutyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A duty date, as YYYY-MM-DD"),
      method: z.enum(["paper_log_reviewed", "driver_declaration"]),
      /** What was actually checked, in the attester's words. A checkbox is not an attestation. */
      statement: z.string().min(15).max(500),
      /** Optional, and stated. Omitting it is honest when the book was reviewed but not totalled. */
      hoursAvailableMinutesStated: z.number().int().min(0).max(24 * 60).nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const acting = await resolveActingScope(db, ctx.user.id);
      const dutyDate = new Date(`${input.dutyDate}T00:00:00Z`);
      if (dutyDate.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
        // Hours are a fact about a day that has begun. Attesting the future is a promise.
        throw new TRPCError({ code: "BAD_REQUEST", message: "A duty date in the future cannot be attested" });
      }
      // A correction is a second statement, not an edit: both stay on the record.
      const prior = await db.select({ id: hosAttestations.id }).from(hosAttestations).where(and(
        eq(hosAttestations.operatorId, input.operatorId),
        eq(hosAttestations.dutyDate, dutyDate),
        isNull(hosAttestations.supersededAt),
      ));
      const ins = await db.insert(hosAttestations).values({
        orgRef: acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId,
        operatorId: input.operatorId, dutyDate, method: input.method, statement: input.statement,
        hoursAvailableMinutesStated: input.hoursAvailableMinutesStated ?? null,
        attestedByUserId: ctx.user.id, attestedAt: new Date(),
      });
      const attestationId = Number(ins[0]?.insertId ?? 0);
      if (prior.length) {
        await db.update(hosAttestations)
          .set({ supersededAt: new Date(), supersededByAttestationId: attestationId })
          .where(inArray(hosAttestations.id, prior.map(r => r.id)));
      }
      return {
        attestationId, supersededCount: prior.length,
        provenance: "attested" as const,
        note: "Recorded as a statement by you, for this duty day only. It is not a computed hours figure and dispatch will show it as attested, not as clear.",
      };
    }),

  /** Load the candidate profiles. Additive and idempotent: a profile already present is left exactly as it is. */
  profileSeed: roleProcedure("hos.profileSeed").mutation(async ({ ctx }) => {
    const d = await db();
    const present = new Set((await d.select({ profileKey: hosRuleProfiles.profileKey }).from(hosRuleProfiles)).map(r => r.profileKey));
    const inserted: string[] = [];
    for (const p of ALL_HOS_PROFILE_SEEDS) {
      if (present.has(p.profileKey)) continue;
      await d.insert(hosRuleProfiles).values({
        profileKey: p.profileKey, label: p.label, authorityLevel: p.applicability.authorityLevel,
        jurisdiction: p.applicability.jurisdiction, latitudeRule: p.applicability.latitudeRule,
        minimumWeightKg: p.applicability.minimumWeightKg, operationClass: p.applicability.operationClass,
        sourceAuthority: p.sourceAuthority, sourceCitation: p.sourceCitation,
        retrievedAt: HOS_SEED_RETRIEVAL_DATE, verificationStatus: "unverified", recordedByUserId: ctx.user.id,
      });
      for (const l of p.limits) await d.insert(hosRuleLimits).values({ profileKey: p.profileKey, limitKey: l.limitKey, value: l.value, recordedByUserId: ctx.user.id, sourceSection: l.sourceSection, verificationStatus: "unverified" });
      inserted.push(p.profileKey);
    }
    return { inserted: inserted.length, existing: present.size, profiles: inserted, caveat: HOS_SEED_CAVEAT };
  }),

  profileList: roleProcedure("hos.profileList").query(async () => {
    const d = await db();
    const profiles = await loadProfiles(d);
    return {
      profiles: profiles.map(p => ({
        profileKey: p.profileKey, label: p.label, applicability: p.applicability,
        verificationStatus: p.verificationStatus, sourceCitation: p.sourceCitation,
        limitCount: p.limits.length, verifiedLimits: p.limits.filter(l => l.verificationStatus === "verified").length,
        note: p.limits.length ? null : "No figures are loaded for this profile — every determination under it is UNKNOWN",
      })),
      verified: profiles.filter(p => p.verificationStatus === "verified").length,
      unverified: profiles.filter(p => p.verificationStatus === "unverified").length,
      caveat: HOS_SEED_CAVEAT,
    };
  }),

  /** Verify one figure against its clause. A profile is verified only when every limit it carries is. */
  /**
   * 0093B — closed.
   *
   * This reached `verificationStatus: "verified"` from a section string and a
   * number: no citation anybody could follow, no instrument named, no scope
   * check against the schedule's applicability, and no ledger entry. The engine
   * measures drivers against that column, so a figure nobody could produce a
   * source for was doing real work.
   *
   * Two doors to one state, and this one asked for nothing. It now refuses and
   * names its replacement rather than being deleted, so an existing caller gets
   * an instruction instead of a missing-procedure error.
   *
   * **Breaking change.** Callers move to `hos.limitPromote`, which needs the
   * instrument, the issuing authority, a citation on a registered publisher's
   * domain, the geographic scope, a verification method and three attestations
   * — and reports `corrected` / `previousValue` exactly as this did.
   *
   * Figures already verified through this path keep working and keep
   * determining; they are identifiable by a null `currentPromotionRef` and
   * reported by `figuresWithoutCitation()`. Re-verifying them through
   * `limitPromote` is a separate piece of work, and not one to do by script.
   */
  limitVerify: roleProcedure("hos.limitVerify")
    .input(z.object({ profileKey: z.string().min(1).max(60), limitKey: z.string().min(1).max(60), sourceSection: z.string().min(1).max(120), confirmedValue: z.number().nonnegative() }))
    .mutation(async ({ input }) => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `hos.limitVerify is closed: it marked a figure verified without a citation, an instrument or a scope check. Use hos.limitPromote for ${input.profileKey}.${input.limitKey} — it records the same correction and leaves a promotion an audit can follow.`,
      });
    }),

  /**
   * 0093 — the cited path.
   *
   * `limitVerify` above takes a section string and a number, and that is all
   * it has ever taken: no citation anybody can follow, no instrument named, no
   * scope check, and no ledger entry. It still writes
   * `verificationStatus: "verified"`, which is what the engine measures
   * drivers against.
   *
   * This procedure is the door the 0090–0092 work built, and until now the
   * console was wired to the old one. It refuses without a named instrument, a
   * citation on a registered publisher's domain, a schedule scoped no wider
   * than the reading, and a plausible figure — then writes the live row and an
   * immutable promotion together, in one transaction.
   *
   * `limitVerify` is deliberately left alone. Changing what an existing
   * compliance procedure accepts is its own checkpoint; what this does is stop
   * anything new arriving through it.
   */
  limitPromote: roleProcedure("hos.limitPromote")
    .input(z.object({
      profileKey: z.string().min(1).max(60),
      limitKey: z.string().min(1).max(60),
      value: z.number().finite(),
      unit: z.enum(["minutes", "hours", "days", "kilograms"]),
      jurisdiction: z.string().min(2).max(64),
      geographicScope: z.enum(["SOUTH_OF_60_N", "NORTH_OF_60_N", "ALL"]).optional(),
      authorityType: z.enum(["law", "official_guidance", "recognized_standard", "manufacturer"]),
      instrumentTitle: z.string().min(1).max(400),
      issuingAuthority: z.string().min(1).max(200),
      sourceSection: z.string().min(1).max(200),
      citationUrl: z.string().min(1).max(1000),
      instrumentVersion: z.string().max(120).optional(),
      verificationMethod: z.enum([
        "OFFICIAL_WEB", "OFFICIAL_PDF", "OFFICIAL_PRINT", "LEGAL_COUNSEL", "REGULATOR_CONFIRMATION",
      ]),
      effectiveFrom: z.coerce.date().optional(),
      effectiveUntil: z.coerce.date().optional(),
      correctsPromotionRef: z.string().max(64).optional(),
      /** All three, separately. The server does not accept one combined flag. */
      attestInstrumentOpen: z.literal(true),
      attestPersonallyVerified: z.literal(true),
      attestBindingAuthority: z.literal(true),
    }))
    .mutation(async ({ ctx, input }) => {
      // A figure may not govern operations wider than the reading it came from.
      const scope = await checkPromotionScope({
        profileKey: input.profileKey,
        jurisdiction: input.jurisdiction,
        geographicScope: input.geographicScope,
      });
      if (!scope.ok) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${scope.reason} — ${scope.remedy}` });
      }

      // The old door reported when a verifier read a different number than was
      // seeded. That is the most interesting thing it said and it is kept:
      // a correction is evidence, and silently accepting a changed figure
      // would lose it.
      const before = (await (await db()).select({ value: hosRuleLimits.value, status: hosRuleLimits.verificationStatus, recordedByUserId: hosRuleLimits.recordedByUserId })
        .from(hosRuleLimits)
        .where(and(eq(hosRuleLimits.profileKey, input.profileKey), eq(hosRuleLimits.limitKey, input.limitKey)))
        .limit(1))[0];

      // 0124 — the same rule profileVerify carries: the person who recorded a
      // candidate does not verify it. A second person does. It bites on an
      // unverified candidate only: a figure that is already verified may be
      // re-verified or amended by the person who established it, because that is
      // a re-reading of the instrument, not an approval of one's own seed.
      if (before && before.status !== "verified" && before.recordedByUserId != null && before.recordedByUserId === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded this candidate figure does not verify it — a second person does" });
      }

      const now = new Date();
      const outcome = await promoteLimit({
        profileKey: input.profileKey,
        limitKey: input.limitKey,
        value: input.value,
        unit: input.unit,
        jurisdiction: input.jurisdiction,
        authorityType: input.authorityType,
        instrumentTitle: input.instrumentTitle,
        issuingAuthority: input.issuingAuthority,
        sourceSection: input.sourceSection,
        citationUrl: input.citationUrl,
        instrumentVersion: input.instrumentVersion,
        verificationMethod: input.verificationMethod,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil,
        correctsPromotionRef: input.correctsPromotionRef,
        // The verifier is the authenticated user, never a field in the payload.
        verifiedByUserId: ctx.user.id,
        verifiedAt: now,
      }, now);

      if (!outcome.promoted) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${outcome.code}: ${outcome.reason}` });
      }

      const divergence = await divergences();
      const corrected = before != null && before.value !== input.value;
      return {
        promotionRef: outcome.promotionRef,
        status: outcome.status,
        becameCurrent: outcome.becameCurrent,
        scope: scope.scope,
        sourceTextStored: false as const,
        divergence: divergence.length === 0 ? "NONE" : `${divergence.length} found`,
        corrected,
        previousValue: corrected ? before!.value : null,
        value: input.value,
      };
    }),

  /** Verify the profile itself, once every figure under it has been verified. */
  profileVerify: roleProcedure("hos.profileVerify")
    .input(z.object({ profileKey: z.string().min(1).max(60), sourceUrl: z.string().max(600).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const p = (await d.select().from(hosRuleProfiles).where(eq(hosRuleProfiles.profileKey, input.profileKey)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such profile" });
      if (p.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Profile is ${p.verificationStatus}` });
      if (p.recordedByUserId != null && p.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded a profile does not verify it — a second person does" });
      const limits = await d.select().from(hosRuleLimits).where(eq(hosRuleLimits.profileKey, p.profileKey));
      const outstanding = limits.filter(l => l.verificationStatus !== "verified");
      if (outstanding.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${outstanding.length} figure(s) in this profile are unverified — verify each against its clause first: ${outstanding.map(l => l.limitKey).join(", ")}` });
      if (!limits.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This profile carries no figures — there is nothing to have verified" });
      await d.update(hosRuleProfiles).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), sourceUrl: input.sourceUrl ?? p.sourceUrl }).where(eq(hosRuleProfiles.id, p.id));
      return { profileKey: p.profileKey, verificationStatus: "verified" as const, limitsVerified: limits.length };
    }),

  /** Which schedule applies? The ladder, walked, with the rung that stopped it named. */
  profileFor: roleProcedure("hos.profileFor").input(CONTEXT).query(async ({ input }) => {
    const d = await db();
    return selectProfile({ ...input, at: input.at }, await loadProfiles(d));
  }),

  /** The clocks, and what the applicable schedule makes of them. */
  status: roleProcedure("hos.status")
    .input(CONTEXT.extend({ operatorId: z.number().int().positive(), lookbackDays: z.number().int().min(1).max(30).default(16) }))
    .query(async ({ input }) => {
      const d = await db();
      const { dutyRecordsRead, selection, clocks, determination, core } = await determinationFor(d, input);
      return {
        operatorId: input.operatorId, dutyRecordsRead,
        selection, clocks, determination,
        shiftBasis: core ? `work shift taken to begin after a verified ${core} min core rest` : "work shift taken to begin after 8 h of rest — a default, because no verified core-rest figure applies",
      };
    }),

  /** Can this trip be finished legally? UNKNOWN whenever the driving limit is unverified. */
  tripFeasibility: roleProcedure("hos.tripFeasibility")
    .input(CONTEXT.extend({ operatorId: z.number().int().positive(), estimatedDriveMinutes: z.number().positive().max(10_000) }))
    .query(async ({ input }) => {
      const d = await db();
      const since = new Date(input.at.getTime() - 16 * 24 * 60 * 60_000);
      const rows = await d.select().from(dutyRecords).where(and(eq(dutyRecords.operatorId, input.operatorId), gte(dutyRecords.startedAt, since)));
      const selection = selectProfile({ ...input, at: input.at }, await loadProfiles(d));
      const profile = selection.outcome === "selected" ? selection.profile : null;
      const clocks = computeClocks(rows.map(r => ({ dutyStatus: r.dutyStatus, startedAt: r.startedAt, endedAt: r.endedAt })), input.at);
      const determination = determine(clocks, profile);
      return { operatorId: input.operatorId, selection, determination, feasibility: tripFeasibility(determination, input.estimatedDriveMinutes) };
    }),
});
