/**
 * Disposal-facility directory (0139) — re-based from feature/facility-map-v7.
 *
 * The v7 invariants, kept: a map pin is not disposal authorization; a service
 * area is not an entrance; unknown, approximate, expired or conflicting evidence
 * fails closed; coordinates carry precision and provenance. Added on this
 * lineage: every evidence row names the licence it was taken under, and content
 * is cached only where the licence permits (the AER's does not — link out and
 * keep the WM approval number); operators are organizations linked by a person;
 * the seed runs here, as leads, never as verified facilities.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import seed from "../data/western-canada-facilities.json";
import brief from "../data/canada-disposal-facilities-brief-2026-09-17.json";
import { approximateFromLegalLocation } from "./_core/legalLocation";
import { facilities, facilityAliases, facilityCallAheads, facilityCapabilities, facilityEvidence, facilityOperatingHours, facilitySourceLicences, facilityWaitReports, loadFacilityAssessments, loads, wasteStreamVocabulary } from "../drizzle/schema";
import { acceptanceStatusSchema, coordinatePrecisionSchema, wasteCodeSchema, type CommercialAccess, type CoordinatePrecision, type FacilityLifecycle, type FacilityMapFeature } from "../shared/facilities";
type BriefRow = { facilityKey: string; name: string; operatorKey: string; parentCompany: string | null; province: string; municipality: string | null; facilityType: string; facilityTypes: string[]; legalLocation: string | null; physicalAddress: string | null; phone: string | null; dispatchPhone: string | null; afterHoursPhone: string | null; salesContact: string | null; email: string | null; websiteUrl: string | null; licenceKey: string; sourceAuthority: string; commercialAccess: CommercialAccess; lifecycle: FacilityLifecycle; historicalOperators: string[]; normAccepted: boolean | null; sourAccepted: boolean | null; twentyFourHourCallout: boolean | null; notes: string | null; latitude?: number; longitude?: number; coordinatePrecision?: CoordinatePrecision; coordinateSourceUrl?: string; regulatorRef?: string };
import { assessFacilityCompatibility } from "./_core/facilityCompatibility";
import { toCsv, toGeoJson } from "./_core/facilityExport";
import { buildFacilityLinks } from "./_core/facilityNavigation";
import { validateFacilitySeed, type FacilitySeedRow } from "./_core/facilitySeed";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const jsonArray = <T,>(v: unknown): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : Array.isArray(v) ? (v as T[]) : []);
const routableOf = (f: { disposition: string; coordinatePrecision: string }) => f.disposition === "verified_facility" && (f.coordinatePrecision === "verified_entrance" || f.coordinatePrecision === "verified_site");
const featureOf = (f: typeof facilities.$inferSelect): FacilityMapFeature | null => f.latitude === null || f.longitude === null || !f.facilityKey ? null : {
  facilityKey: f.facilityKey, name: f.name, facilityType: f.facilityType ?? undefined, latitude: f.latitude, longitude: f.longitude,
  coordinatePrecision: f.coordinatePrecision, routable: routableOf(f), verificationState: routableOf(f) ? "verified" : f.disposition === "approximate_facility" ? "review_required" : "unknown",
};
async function facilityByKey(db: Awaited<ReturnType<typeof dbOrThrow>>, facilityKey: string) {
  const f = (await db.select().from(facilities).where(eq(facilities.facilityKey, facilityKey)).limit(1))[0];
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: `No facility ${facilityKey}` });
  return f;
}

export const facilityDirectoryRouter = router({
  licences: router({
    list: roleProcedure("facilityDirectory.licencesList").query(async () => (await dbOrThrow()).select().from(facilitySourceLicences)),
  }),
  vocabulary: router({
    list: roleProcedure("facilityDirectory.vocabularyList").query(async () => (await dbOrThrow()).select().from(wasteStreamVocabulary)),
    verify: roleProcedure("facilityDirectory.vocabularyVerify")
      .input(z.object({ internalCode: wasteCodeSchema, aerWasteCode: z.string().max(120).nullable(), albertaWcrClass: z.string().max(60).nullable().optional(), status: z.enum(["verified", "not_applicable"]), note: z.string().min(10).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const db = await dbOrThrow();
        await db.update(wasteStreamVocabulary).set({ aerWasteCode: input.aerWasteCode, albertaWcrClass: input.albertaWcrClass ?? null, verificationStatus: input.status, verifiedByUserId: ctx.user.id, verifiedAt: new Date(), verificationNote: input.note }).where(eq(wasteStreamVocabulary.internalCode, input.internalCode));
        return { internalCode: input.internalCode, status: input.status };
      }),
  }),

  /** The 23 v7 leads, imported as leads: community-level coordinates, never routable, one evidence row each under the operator's own site. Idempotent by facilityKey. */
  seedLeads: roleProcedure("facilityDirectory.seedLeads").mutation(async ({ ctx }) => {
    const db = await dbOrThrow();
    const rows = seed as FacilitySeedRow[];
    const { errors } = validateFacilitySeed(rows);
    if (errors.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Seed invalid: ${errors.slice(0, 3).join("; ")}` });
    let inserted = 0, existing = 0;
    for (const r of rows) {
      const key = String(r.facilityKey);
      const found = (await db.select({ id: facilities.id }).from(facilities).where(eq(facilities.facilityKey, key)).limit(1))[0];
      if (found) { existing++; continue; }
      const precision = coordinatePrecisionSchema.parse(r.coordinatePrecision ?? "unknown");
      if (precision === "verified_entrance" || precision === "verified_site") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Seed row ${key} claims verified coordinates; the seed carries leads only` });
      const ins = await db.insert(facilities).values({
        facilityKey: key, name: String(r.name), status: "unknown", facilityType: (r.facilityType as string) ?? null, municipality: (r.municipality as string) ?? null, province: (r.province as string) ?? null,
        latitude: (r.latitude as number) ?? null, longitude: (r.longitude as number) ?? null, coordinatePrecision: precision, coordinateSourceUrl: (r.coordinateSourceUrl as string) ?? null,
        disposition: r.disposition === "verified_facility" ? "approximate_facility" : r.disposition, operatorNameFromSource: (r.operatorKey as string) ?? null, websiteUrl: (r.websiteUrl as string) ?? null, phone: (r.phone as string) ?? null,
      });
      const facilityId = ins[0].insertId;
      await db.insert(facilityEvidence).values({ facilityId, publisher: String(r.operatorKey ?? "operator"), title: `Facility lead from the operator's public website`, sourceUrl: String(r.coordinateSourceUrl ?? r.websiteUrl ?? ""), licenceKey: "company_website", claimType: "facility_exists", claimValue: `${r.name} listed near ${r.municipality ?? "?"}, ${r.province ?? "?"}; coordinates are community-level only`, cachedContent: false, retrievedAt: new Date("2026-09-17T00:00:00Z"), confidence: "low", reviewState: "lead", recordedByUserId: ctx.user.id });
      for (const alias of (r.sourceBriefNames as string[]) ?? []) if (alias !== r.name) await db.insert(facilityAliases).values({ facilityId, alias, relationship: "source_brief_name", sourceUrl: (r.coordinateSourceUrl as string) ?? null });
      inserted++;
    }
    return { inserted, existing, routable: 0, note: "Every seeded facility is a lead with community-level coordinates. Nothing here is a verified entrance; navigation stays disabled until a person verifies coordinates against reviewed evidence." };
  }),

  /**
   * The operator briefs of 2026-09-17: R360's network, SECURE's landfills and WPFs, the Alberta
   * hydrovac list's facilities, Aqua Terra, Miller, Lambton, Stablex. Legal land descriptions are
   * converted to approximate coordinates (±2 km, never routable); contacts and access land in
   * their columns; former operators become aliases; every row is a lead until reviewed.
   */
  seedBrief: roleProcedure("facilityDirectory.seedBrief").mutation(async ({ ctx }) => {
    const db = await dbOrThrow();
    const rows = brief as BriefRow[];
    let inserted = 0, existing = 0, lsdConverted = 0, ntsUnconverted = 0;
    for (const r of rows) {
      const found = (await db.select({ id: facilities.id }).from(facilities).where(eq(facilities.facilityKey, r.facilityKey)).limit(1))[0];
      if (found) { existing++; continue; }
      let latitude = r.latitude ?? null, longitude = r.longitude ?? null, precision: typeof r.coordinatePrecision | "approximate_site" = r.coordinatePrecision ?? "unknown", sourceUrl = r.coordinateSourceUrl ?? null, coordNote: string | null = null;
      if (r.legalLocation && latitude === null) {
        const c = approximateFromLegalLocation(r.legalLocation);
        if (c) { latitude = c.latitude; longitude = c.longitude; precision = "approximate_site"; sourceUrl = r.websiteUrl ?? null; coordNote = c.note; lsdConverted++; } else ntsUnconverted++;
      }
      const ins = await db.insert(facilities).values({
        facilityKey: r.facilityKey, name: r.name, status: r.lifecycle === "operating" ? "unknown" : r.lifecycle === "closed" ? "closed" : "unknown", province: r.province, municipality: r.municipality ?? null, facilityType: r.facilityType, facilityTypes: r.facilityTypes,
        legalLocation: r.legalLocation ?? null, physicalAddress: r.physicalAddress ?? null, latitude, longitude, coordinatePrecision: precision, coordinateSourceUrl: sourceUrl,
        disposition: r.lifecycle === "conflicting" ? "ambiguous" : "approximate_facility", operatorNameFromSource: r.operatorKey, parentCompany: r.parentCompany ?? null,
        phone: r.phone ?? null, dispatchPhone: r.dispatchPhone ?? null, afterHoursPhone: r.afterHoursPhone ?? null, salesContact: r.salesContact ?? null, email: r.email ?? null, websiteUrl: r.websiteUrl ?? null,
        commercialAccess: r.commercialAccess, lifecycle: r.lifecycle, normAccepted: r.normAccepted ?? null, sourAccepted: r.sourAccepted ?? null, twentyFourHourCallout: r.twentyFourHourCallout ?? null,
        regulatorRef: r.regulatorRef ?? null, regulatorRefSourceUrl: r.regulatorRef ? r.websiteUrl ?? null : null, sourceAuthority: r.sourceAuthority, gateInstructions: r.notes ?? null,
      });
      const facilityId = ins[0].insertId;
      const claim = [r.legalLocation ? `LSD ${r.legalLocation}` : null, r.physicalAddress, r.phone ? `phone ${r.phone}` : null, coordNote].filter(Boolean).join("; ");
      if (r.lifecycle === "conflicting") {
        await db.insert(facilityEvidence).values([
          { facilityId, publisher: "SECURE Waste Infrastructure", title: "Facility page: NO LONGER IN OPERATION", sourceUrl: r.websiteUrl ?? "", licenceKey: "company_website", claimType: "closure", claimValue: "SECURE's facility page states the Virden operation is no longer in operation", cachedContent: false, retrievedAt: new Date("2026-09-17T00:00:00Z"), confidence: "medium", reviewState: "conflicting", recordedByUserId: ctx.user.id, reviewNote: "conflicts with the Town of Virden's description" },
          { facilityId, publisher: "Town of Virden", title: "Municipal/industrial waste facility managed by LOCAL Industrial Partners", sourceUrl: "https://www.virden.ca/", licenceKey: "company_website", claimType: "operator_identity", claimValue: "The Town describes a municipal/industrial waste facility managed by LOCAL Industrial Partners", cachedContent: false, retrievedAt: new Date("2026-09-17T00:00:00Z"), confidence: "medium", reviewState: "conflicting", recordedByUserId: ctx.user.id, reviewNote: "conflicts with SECURE's closure statement" },
        ]);
      } else {
        await db.insert(facilityEvidence).values({ facilityId, publisher: r.operatorKey, title: "Facility lead from the operator brief of 2026-09-17", sourceUrl: r.websiteUrl ?? "", licenceKey: r.licenceKey, claimType: "facility_exists", claimValue: claim, cachedContent: false, retrievedAt: new Date("2026-09-17T00:00:00Z"), confidence: r.licenceKey === "ogl_alberta" ? "medium" : "low", reviewState: "lead", recordedByUserId: ctx.user.id });
      }
      for (const h of r.historicalOperators ?? []) await db.insert(facilityAliases).values({ facilityId, alias: `${h} ${r.name.replace(/^(R360|SECURE) /, "")}`, relationship: "former_operator", sourceUrl: r.websiteUrl ?? null });
      inserted++;
    }
    return { inserted, existing, lsdConverted, ntsUnconverted, routable: 0, note: "Coordinates from legal land descriptions are the centre of the LSD, ±2 km, never an entrance. Contacts and hours are as the brief stated them; call ahead." };
  }),

  /** Map features: pins with their precision; routable only when a person verified the coordinates. */
  features: roleProcedure("facilityDirectory.features")
    .input(z.object({ province: z.string().length(2).optional(), facilityType: z.string().max(100).optional() }).optional())
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const conds = [isNotNull(facilities.facilityKey)];
      if (input?.province) conds.push(eq(facilities.province, input.province));
      if (input?.facilityType) conds.push(eq(facilities.facilityType, input.facilityType));
      const rows = await db.select().from(facilities).where(and(...conds)).limit(2000);
      return rows.map(featureOf).filter((x): x is FacilityMapFeature => x !== null);
    }),
  get: roleProcedure("facilityDirectory.get")
    .input(z.object({ facilityKey: z.string().min(1).max(100) }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const f = await facilityByKey(db, input.facilityKey);
      const [evidence, capabilities, aliases] = await Promise.all([
        db.select().from(facilityEvidence).where(eq(facilityEvidence.facilityId, f.id)),
        db.select().from(facilityCapabilities).where(eq(facilityCapabilities.facilityId, f.id)),
        db.select().from(facilityAliases).where(eq(facilityAliases.facilityId, f.id)),
      ]);
      return { facility: f, routable: routableOf(f), evidence, capabilities, aliases, links: buildFacilityLinks({ precision: f.coordinatePrecision, site: f.latitude !== null && f.longitude !== null ? { lat: f.latitude, lon: f.longitude } : undefined, phone: f.phone ?? undefined, websiteUrl: f.websiteUrl ?? undefined, accountRegistrationUrl: f.accountRegistrationUrl ?? undefined }) };
    }),

  /** Record a piece of evidence under the licence it was taken under. Caching content a licence forbids is refused by name. */
  evidenceRecord: roleProcedure("facilityDirectory.evidenceRecord")
    .input(z.object({ facilityKey: z.string().min(1).max(100), publisher: z.string().min(1).max(220), title: z.string().min(1).max(300), sourceUrl: z.string().url().max(1024), licenceKey: z.string().min(1).max(40), claimType: z.enum(["facility_exists", "entrance_coordinate", "site_coordinate", "accepts_waste_stream", "does_not_accept", "operating_hours", "regulator_approval", "operator_identity", "closure", "other"]), claimValue: z.string().max(4000).optional(), cachedContent: z.boolean().default(false), retrievedAt: z.coerce.date(), effectiveAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional(), confidence: z.enum(["low", "medium", "high"]).default("low"), regulatorRef: z.string().max(80).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const f = await facilityByKey(db, input.facilityKey);
      const lic = (await db.select().from(facilitySourceLicences).where(eq(facilitySourceLicences.licenceKey, input.licenceKey)).limit(1))[0];
      if (!lic) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown licence ${input.licenceKey}; register it first` });
      if (input.cachedContent && !lic.cachePermitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — ${lic.name} does not permit caching its content (${lic.status}); record the reference and the identifier, not the content` });
      if (input.cachedContent && lic.status === "unconfirmed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — the terms of ${lic.name} are unconfirmed; reference only until confirmed` });
      const ins = await db.insert(facilityEvidence).values({ facilityId: f.id, publisher: input.publisher, title: input.title, sourceUrl: input.sourceUrl, licenceKey: input.licenceKey, claimType: input.claimType, claimValue: input.claimValue ?? null, cachedContent: input.cachedContent, retrievedAt: input.retrievedAt, effectiveAt: input.effectiveAt ?? null, expiresAt: input.expiresAt ?? null, confidence: input.confidence, reviewState: "lead", recordedByUserId: ctx.user.id });
      if (input.claimType === "regulator_approval" && input.regulatorRef) await db.update(facilities).set({ regulatorRef: input.regulatorRef, regulatorRefSourceUrl: input.sourceUrl }).where(eq(facilities.id, f.id));
      return { evidenceId: ins[0].insertId, reviewState: "lead" as const, attribution: lic.attributionText };
    }),
  evidenceReview: roleProcedure("facilityDirectory.evidenceReview")
    .input(z.object({ evidenceId: z.number().int().positive(), reviewState: z.enum(["reviewed", "rejected", "conflicting"]), note: z.string().min(5).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const e = (await db.select().from(facilityEvidence).where(eq(facilityEvidence.id, input.evidenceId)).limit(1))[0];
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence not found" });
      if (e.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded evidence does not review it — a second person does" });
      await db.update(facilityEvidence).set({ reviewState: input.reviewState, reviewedByUserId: ctx.user.id, reviewedAt: new Date(), reviewNote: input.note }).where(eq(facilityEvidence.id, e.id));
      return { evidenceId: e.id, reviewState: input.reviewState };
    }),

  /** Coordinates become verified only from reviewed, high-confidence coordinate evidence; this is what turns navigation on. */
  coordinateVerify: roleProcedure("facilityDirectory.coordinateVerify")
    .input(z.object({ facilityKey: z.string().min(1).max(100), evidenceId: z.number().int().positive(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), precision: z.enum(["verified_entrance", "verified_site"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const f = await facilityByKey(db, input.facilityKey);
      const e = (await db.select().from(facilityEvidence).where(and(eq(facilityEvidence.id, input.evidenceId), eq(facilityEvidence.facilityId, f.id))).limit(1))[0];
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence not found on this facility" });
      if (e.claimType !== "entrance_coordinate" && e.claimType !== "site_coordinate") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — evidence ${e.id} is ${e.claimType}, not a coordinate claim` });
      if (e.reviewState !== "reviewed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — evidence ${e.id} is ${e.reviewState}; a second person must review it first` });
      if (e.confidence !== "high") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `BLOCKED — evidence ${e.id} is ${e.confidence} confidence; verified coordinates need high` });
      if (input.precision === "verified_entrance" && e.claimType !== "entrance_coordinate") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BLOCKED — an entrance needs entrance evidence; site evidence verifies the site only" });
      await db.update(facilities).set({ latitude: input.latitude, longitude: input.longitude, coordinatePrecision: input.precision, coordinateSourceUrl: e.sourceUrl, coordinateVerifiedAt: new Date(), coordinateVerifiedByUserId: ctx.user.id, disposition: "verified_facility" }).where(eq(facilities.id, f.id));
      return { facilityKey: f.facilityKey, coordinatePrecision: input.precision, routable: true };
    }),
  capabilitySet: roleProcedure("facilityDirectory.capabilitySet")
    .input(z.object({ facilityKey: z.string().min(1).max(100), wasteCode: wasteCodeSchema, acceptanceStatus: acceptanceStatusSchema, evidenceId: z.number().int().positive().optional(), conditions: z.string().max(2000).optional(), handlingMethod: z.string().max(100).optional(), expiresAt: z.coerce.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const f = await facilityByKey(db, input.facilityKey);
      let verifiedAt: Date | null = null;
      if (input.acceptanceStatus === "verified") {
        const e = input.evidenceId ? (await db.select().from(facilityEvidence).where(and(eq(facilityEvidence.id, input.evidenceId), eq(facilityEvidence.facilityId, f.id))).limit(1))[0] : undefined;
        if (!e || e.reviewState !== "reviewed" || e.claimType !== "accepts_waste_stream") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "BLOCKED — a verified acceptance needs reviewed accepts_waste_stream evidence on this facility" });
        verifiedAt = e.reviewedAt ?? new Date();
      }
      const existing = (await db.select({ id: facilityCapabilities.id }).from(facilityCapabilities).where(and(eq(facilityCapabilities.facilityId, f.id), eq(facilityCapabilities.wasteCode, input.wasteCode))).limit(1))[0];
      const values = { facilityId: f.id, wasteCode: input.wasteCode, acceptanceStatus: input.acceptanceStatus, evidenceId: input.evidenceId ?? null, conditions: input.conditions ?? null, handlingMethod: input.handlingMethod ?? null, verifiedAt, expiresAt: input.expiresAt ?? null, setByUserId: ctx.user.id };
      if (existing) await db.update(facilityCapabilities).set(values).where(eq(facilityCapabilities.id, existing.id)); else await db.insert(facilityCapabilities).values(values);
      return { facilityKey: f.facilityKey, wasteCode: input.wasteCode, acceptanceStatus: input.acceptanceStatus };
    }),

  /** Run the v7 engine for a load against a facility and write the immutable assessment. */
  assessLoad: roleProcedure("facilityDirectory.assessLoad")
    .input(z.object({ loadId: z.number().int().positive(), facilityKey: z.string().min(1).max(100), loadWasteCode: wasteCodeSchema.optional(), accountRequired: z.boolean().default(false), accountApproved: z.boolean().default(false), routeReviewPassed: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const load = (await db.select({ id: loads.id }).from(loads).where(eq(loads.id, input.loadId)).limit(1))[0];
      if (!load) throw new TRPCError({ code: "NOT_FOUND", message: `No load ${input.loadId}` });
      const f = await facilityByKey(db, input.facilityKey);
      const cap = input.loadWasteCode ? (await db.select().from(facilityCapabilities).where(and(eq(facilityCapabilities.facilityId, f.id), eq(facilityCapabilities.wasteCode, input.loadWasteCode))).limit(1))[0] : undefined;
      const evidence = await db.select().from(facilityEvidence).where(eq(facilityEvidence.facilityId, f.id));
      const reviewed = evidence.filter(e => e.reviewState === "reviewed" && (cap?.evidenceId === e.id));
      // A valid call-ahead acceptance for this load (or this waste stream) is the facility's own confirmation.
      const now = new Date();
      const callAhead = (await db.select().from(facilityCallAheads).where(and(eq(facilityCallAheads.facilityId, f.id), inArray(facilityCallAheads.outcome, ["accepted", "accepted_with_conditions"]), gte(facilityCallAheads.validUntil, now))).orderBy(desc(facilityCallAheads.calledAt)).limit(5))
        .find(c => (c.loadId !== null && c.loadId === input.loadId) || (c.loadId === null && c.wasteCode === input.loadWasteCode));
      const confirmedByCall = !!callAhead && cap?.acceptanceStatus === "confirmation_required";
      const callMeta = callAhead ? { callAheadRef: callAhead.callAheadRef, outcome: callAhead.outcome, validUntil: callAhead.validUntil?.toISOString() } : null;
      const snapshot = {
        loadWasteCode: input.loadWasteCode, capabilityWasteCode: cap?.wasteCode as never, acceptanceStatus: (confirmedByCall ? "verified" : (cap?.acceptanceStatus ?? "unknown")) as never,
        coordinatePrecision: f.coordinatePrecision, coordinateSourceUrl: f.coordinateSourceUrl ?? undefined, evidenceIds: reviewed.map(e => e.id), evidenceVerifiedAt: confirmedByCall ? callAhead!.calledAt : (cap?.verifiedAt ?? undefined),
        assessedAt: new Date(), accountRequired: input.accountRequired, accountApproved: input.accountApproved, facilityOpen: f.status === "open" && f.lifecycle !== "closed" && f.lifecycle !== "suspended" && f.lifecycle !== "conflicting" && f.commercialAccess !== "operator_private", routeReviewPassed: input.routeReviewPassed,
        conflictingEvidence: evidence.some(e => e.reviewState === "conflicting"),
      };
      const result = assessFacilityCompatibility(snapshot);
      if (callMeta?.outcome === "accepted_with_conditions" && result.outcome === "compatible_verified") result.reasonCodes.push("call_ahead_conditions");
      if (f.lifecycle === "conflicting") result.reasonCodes.push("lifecycle_conflicting"); else if (f.lifecycle === "closed" || f.lifecycle === "suspended") result.reasonCodes.push(`lifecycle_${f.lifecycle}`);
      if (f.commercialAccess === "operator_private") result.reasonCodes.push("operator_private");
      const assessmentRef = ref("FASSESS");
      await db.insert(loadFacilityAssessments).values({ assessmentRef, loadId: input.loadId, facilityId: f.id, outcome: result.outcome, blocking: result.blocking, reasonCodes: result.reasonCodes, evidenceIds: result.evidenceIds, inputSnapshot: { ...snapshot, assessedAt: snapshot.assessedAt.toISOString(), evidenceVerifiedAt: snapshot.evidenceVerifiedAt?.toISOString(), callAhead: callMeta }, engineVersion: result.engineVersion, assessedByUserId: ctx.user.id });
      return { assessmentRef, ...result, facilityKey: f.facilityKey, dispatchable: !result.blocking, callAhead: callMeta };
    }),
  assessments: roleProcedure("facilityDirectory.assessments")
    .input(z.object({ loadId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const rows = await db.select().from(loadFacilityAssessments).where(eq(loadFacilityAssessments.loadId, input.loadId)).orderBy(loadFacilityAssessments.assessedAt);
      return rows.map(r => ({ ...r, reasonCodes: jsonArray<string>(r.reasonCodes), evidenceIds: jsonArray<number>(r.evidenceIds) }));
    }),

  /**
   * The driver-facing half. Everything here is a fact somebody witnessed, with who and when;
   * the current wait is the freshest report or UNKNOWN; hours say who stated them and when.
   */
  hours: router({
    set: roleProcedure("facilityDirectory.hoursSet")
      .input(z.object({ facilityKey: z.string().min(1).max(100), source: z.enum(["facility_stated", "website", "regulator", "driver_reported"]), statedAt: z.coerce.date(), evidenceId: z.number().int().positive().optional(), days: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), opensAt: z.string().regex(/^\d{2}:\d{2}$/).optional(), closesAt: z.string().regex(/^\d{2}:\d{2}$/).optional(), closed: z.boolean().default(false), note: z.string().max(300).optional() })).min(1).max(7) }))
      .mutation(async ({ ctx, input }) => {
        const db = await dbOrThrow();
        const f = await facilityByKey(db, input.facilityKey);
        for (const d of input.days) {
          if (!d.closed && (!d.opensAt || !d.closesAt)) throw new TRPCError({ code: "BAD_REQUEST", message: `Day ${d.dayOfWeek}: an open day needs opensAt and closesAt` });
          const existing = (await db.select({ id: facilityOperatingHours.id }).from(facilityOperatingHours).where(and(eq(facilityOperatingHours.facilityId, f.id), eq(facilityOperatingHours.dayOfWeek, d.dayOfWeek))).limit(1))[0];
          const values = { facilityId: f.id, dayOfWeek: d.dayOfWeek, opensAt: d.closed ? null : d.opensAt!, closesAt: d.closed ? null : d.closesAt!, closed: d.closed, note: d.note ?? null, source: input.source, evidenceId: input.evidenceId ?? null, statedAt: input.statedAt, setByUserId: ctx.user.id };
          if (existing) await db.update(facilityOperatingHours).set(values).where(eq(facilityOperatingHours.id, existing.id)); else await db.insert(facilityOperatingHours).values(values);
        }
        return { facilityKey: f.facilityKey, daysSet: input.days.length, source: input.source };
      }),
  }),
  callAhead: router({
    record: roleProcedure("facilityDirectory.callAheadRecord")
      .input(z.object({ facilityKey: z.string().min(1).max(100), loadId: z.number().int().positive().optional(), wasteCode: wasteCodeSchema.optional(), calledAt: z.coerce.date().optional(), phoneUsed: z.string().max(60).optional(), spokeTo: z.string().max(160).optional(), outcome: z.enum(["accepted", "accepted_with_conditions", "refused", "no_answer", "call_back"]), conditions: z.string().max(500).optional(), quotedWaitMinutes: z.number().int().min(0).max(1440).optional(), validForHours: z.number().min(0.5).max(72).default(12), note: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        const db = await dbOrThrow();
        const f = await facilityByKey(db, input.facilityKey);
        const accepted = input.outcome === "accepted" || input.outcome === "accepted_with_conditions";
        if (accepted && !input.loadId && !input.wasteCode) throw new TRPCError({ code: "BAD_REQUEST", message: "An acceptance needs the load or the waste stream it was for" });
        if (input.outcome === "accepted_with_conditions" && !input.conditions) throw new TRPCError({ code: "BAD_REQUEST", message: "State the conditions the facility gave" });
        if (accepted && !input.spokeTo) throw new TRPCError({ code: "BAD_REQUEST", message: "Record who at the facility accepted the load" });
        const calledAt = input.calledAt ?? new Date();
        const validUntil = accepted ? new Date(calledAt.getTime() + input.validForHours * 3_600_000) : null;
        const callAheadRef = ref("CALL");
        await db.insert(facilityCallAheads).values({ callAheadRef, facilityId: f.id, loadId: input.loadId ?? null, wasteCode: input.wasteCode ?? null, calledByUserId: ctx.user.id, calledAt, phoneUsed: input.phoneUsed ?? f.phone ?? null, spokeTo: input.spokeTo ?? null, outcome: input.outcome, conditions: input.conditions ?? null, quotedWaitMinutes: input.quotedWaitMinutes ?? null, validUntil, note: input.note ?? null });
        if (input.quotedWaitMinutes !== undefined) await db.insert(facilityWaitReports).values({ facilityId: f.id, reportedByUserId: ctx.user.id, reportedAt: calledAt, waitMinutes: input.quotedWaitMinutes, source: "facility_stated", note: `quoted on call ${callAheadRef}` });
        return { callAheadRef, outcome: input.outcome, validUntil };
      }),
  }),
  wait: router({
    report: roleProcedure("facilityDirectory.waitReport")
      .input(z.object({ facilityKey: z.string().min(1).max(100), waitMinutes: z.number().int().min(0).max(1440), trucksInQueue: z.number().int().min(0).max(500).optional(), source: z.enum(["driver_observed", "facility_stated", "dispatcher_relayed"]).default("driver_observed"), note: z.string().max(300).optional() }))
      .mutation(async ({ ctx, input }) => {
        const db = await dbOrThrow();
        const f = await facilityByKey(db, input.facilityKey);
        await db.insert(facilityWaitReports).values({ facilityId: f.id, reportedByUserId: ctx.user.id, reportedAt: new Date(), waitMinutes: input.waitMinutes, trucksInQueue: input.trucksInQueue ?? null, source: input.source, note: input.note ?? null });
        return { facilityKey: f.facilityKey, waitMinutes: input.waitMinutes };
      }),
  }),

  /** Sites near a point by great-circle distance, with what is known about each — never a route (the spatial engine's job). */
  nearby: roleProcedure("facilityDirectory.nearby")
    .input(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), radiusKm: z.number().min(1).max(1500).default(250), wasteCode: wasteCodeSchema.optional(), limit: z.number().int().min(1).max(50).default(15) }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const rows = await db.select().from(facilities).where(and(isNotNull(facilities.facilityKey), isNotNull(facilities.latitude), isNotNull(facilities.longitude)));
      const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
      const dist = (lat: number, lon: number) => { const dLat = rad(lat - input.latitude), dLon = rad(lon - input.longitude); const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(input.latitude)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
      const ids = rows.map(r => r.id);
      const caps = ids.length && input.wasteCode ? await db.select().from(facilityCapabilities).where(and(inArray(facilityCapabilities.facilityId, ids), eq(facilityCapabilities.wasteCode, input.wasteCode))) : [];
      const out = rows.map(f => ({ facilityKey: f.facilityKey!, name: f.name, municipality: f.municipality, province: f.province, facilityType: f.facilityType, facilityTypes: jsonArray<string>(f.facilityTypes), distanceKm: Math.round(dist(f.latitude!, f.longitude!) * 10) / 10, coordinatePrecision: f.coordinatePrecision, routable: routableOf(f), phone: f.phone, dispatchPhone: f.dispatchPhone, afterHoursPhone: f.afterHoursPhone, websiteUrl: f.websiteUrl, commercialAccess: f.commercialAccess, lifecycle: f.lifecycle, normAccepted: f.normAccepted, sourAccepted: f.sourAccepted, twentyFourHourCallout: f.twentyFourHourCallout, legalLocation: f.legalLocation,
        acceptance: input.wasteCode ? (caps.find(c => c.facilityId === f.id)?.acceptanceStatus ?? "unknown") : undefined,
        distanceNote: f.coordinatePrecision === "community_only" ? "distance to the community, not the gate" : f.coordinatePrecision === "approximate_site" ? "distance to the LSD centre, ±2 km, not the gate" : undefined,
        accessNote: f.commercialAccess === "operator_private" ? "producer-owned: does not take third-party loads" : f.commercialAccess === "unknown" ? "commercial access unknown — confirm before travelling" : f.commercialAccess === "commercial_preapproval_required" ? "preapproval required" : undefined,
        lifecycleNote: f.lifecycle === "conflicting" ? "sources disagree on whether this site operates" : f.lifecycle === "closed" ? "closed" : f.lifecycle === "suspended" ? "suspended" : undefined }))
        .filter(x => x.distanceKm <= input.radiusKm).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, input.limit);
      return { origin: { latitude: input.latitude, longitude: input.longitude }, radiusKm: input.radiusKm, wasteCode: input.wasteCode ?? null, facilities: out, note: "Distances are straight-line. Routes come from the spatial engine with commercial-vehicle constraints; call ahead before travelling." };
    }),

  /** One screen for a driver: contact, hours as stated, the freshest wait or UNKNOWN, the last valid call-ahead, precision, links. */
  driverView: roleProcedure("facilityDirectory.driverView")
    .input(z.object({ facilityKey: z.string().min(1).max(100), loadId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const db = await dbOrThrow();
      const f = await facilityByKey(db, input.facilityKey);
      const now = new Date();
      const [hours, waits, calls, caps] = await Promise.all([
        db.select().from(facilityOperatingHours).where(eq(facilityOperatingHours.facilityId, f.id)),
        db.select().from(facilityWaitReports).where(and(eq(facilityWaitReports.facilityId, f.id), gte(facilityWaitReports.reportedAt, new Date(now.getTime() - 6 * 3_600_000)))).orderBy(desc(facilityWaitReports.reportedAt)).limit(5),
        db.select().from(facilityCallAheads).where(eq(facilityCallAheads.facilityId, f.id)).orderBy(desc(facilityCallAheads.calledAt)).limit(5),
        db.select().from(facilityCapabilities).where(eq(facilityCapabilities.facilityId, f.id)),
      ]);
      const today = hours.find(h => h.dayOfWeek === now.getUTCDay());
      const freshest = waits[0];
      const lastValid = calls.find(c => (c.outcome === "accepted" || c.outcome === "accepted_with_conditions") && c.validUntil && c.validUntil > now && (!input.loadId || c.loadId === null || c.loadId === input.loadId));
      return {
        facility: { facilityKey: f.facilityKey, name: f.name, operatorNameFromSource: f.operatorNameFromSource, parentCompany: f.parentCompany, municipality: f.municipality, province: f.province, facilityType: f.facilityType, facilityTypes: jsonArray<string>(f.facilityTypes), status: f.status, lifecycle: f.lifecycle, commercialAccess: f.commercialAccess, coordinatePrecision: f.coordinatePrecision, legalLocation: f.legalLocation, physicalAddress: f.physicalAddress, routable: routableOf(f), regulatorRef: f.regulatorRef, preapprovalRequired: f.preapprovalRequired, manifestRequired: f.manifestRequired, tdgRequired: f.tdgRequired, normAccepted: f.normAccepted, sourAccepted: f.sourAccepted, twentyFourHourCallout: f.twentyFourHourCallout, sourceAuthority: f.sourceAuthority },
        contact: { phone: f.phone, dispatchPhone: f.dispatchPhone, afterHoursPhone: f.afterHoursPhone, salesContact: f.salesContact, email: f.email, emergencyPhone: f.emergencyPhone, websiteUrl: f.websiteUrl, accountRegistrationUrl: f.accountRegistrationUrl, wasteApprovalFormUrl: f.wasteApprovalFormUrl, gateInstructions: f.gateInstructions, requiredDocuments: f.requiredDocuments },
        warnings: [f.lifecycle === "conflicting" ? "Sources disagree on whether this site operates — resolve before dispatch" : null, f.lifecycle === "closed" ? "Closed" : null, f.commercialAccess === "operator_private" ? "Producer-owned: does not take third-party loads" : null, f.commercialAccess === "unknown" ? "Commercial access unknown — confirm on the call" : null, f.coordinatePrecision !== "verified_entrance" && f.coordinatePrecision !== "verified_site" ? "Coordinates are not a verified entrance — no directions link" : null].filter((x): x is string => x !== null),
        links: buildFacilityLinks({ precision: f.coordinatePrecision, site: f.latitude !== null && f.longitude !== null ? { lat: f.latitude, lon: f.longitude } : undefined, phone: f.phone ?? undefined, websiteUrl: f.websiteUrl ?? undefined, accountRegistrationUrl: f.accountRegistrationUrl ?? undefined }),
        hoursToday: today ? { ...today, state: "as_stated" as const } : { state: "unknown" as const, note: "No hours on file — call ahead" },
        hoursWeek: hours,
        currentWait: freshest ? { waitMinutes: freshest.waitMinutes, trucksInQueue: freshest.trucksInQueue, reportedAt: freshest.reportedAt, ageMinutes: Math.round((now.getTime() - freshest.reportedAt.getTime()) / 60_000), source: freshest.source, state: "reported" as const } : { state: "unknown" as const, note: "No wait report in the last 6 hours — call ahead" },
        callAhead: lastValid ? { callAheadRef: lastValid.callAheadRef, outcome: lastValid.outcome, spokeTo: lastValid.spokeTo, conditions: lastValid.conditions, quotedWaitMinutes: lastValid.quotedWaitMinutes, validUntil: lastValid.validUntil, calledAt: lastValid.calledAt } : { state: "none_valid" as const, note: "No valid call-ahead acceptance — call before travelling" },
        accepts: caps.map(c => ({ wasteCode: c.wasteCode, acceptanceStatus: c.acceptanceStatus, conditions: c.conditions, expiresAt: c.expiresAt })),
        recentCalls: calls.map(c => ({ callAheadRef: c.callAheadRef, calledAt: c.calledAt, outcome: c.outcome, spokeTo: c.spokeTo })),
      };
    }),

  exportCsv: roleProcedure("facilityDirectory.exportCsv").query(async () => toCsv(await exportRows())),
  exportGeoJson: roleProcedure("facilityDirectory.exportGeoJson").query(async () => toGeoJson(await exportRows())),
});

async function exportRows(): Promise<FacilitySeedRow[]> {
  const db = await dbOrThrow();
  const rows = await db.select().from(facilities).where(isNotNull(facilities.facilityKey));
  return rows.map(f => ({ facilityKey: f.facilityKey!, name: f.name, municipality: f.municipality ?? undefined, province: f.province ?? undefined, facilityType: f.facilityType ?? undefined, latitude: f.latitude ?? undefined, longitude: f.longitude ?? undefined, coordinatePrecision: f.coordinatePrecision, coordinateSourceUrl: f.coordinateSourceUrl ?? undefined, disposition: f.disposition, sourceBriefNames: [] }));
}
