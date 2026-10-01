/**
 * v22.17 — Communications on the route: the API.
 *
 * Reading the channel registry is a read. Establishing that a channel record
 * matches the regulator's appendix, that the company holds a licence, that a
 * road actually carries a channel, or that a driver's photograph of a sign
 * becomes the governing assignment — each of those establishes an operational
 * or legal fact, so each is a second person's act under its own sensitive
 * permission.
 *
 * There is no procedure here that programs a radio, and there will not be.
 * LeaseOS is the configuration and compliance authority for communications;
 * the radio shop is the radio shop.
 */
import { TRPCError } from "@trpc/server";
import { requireCallerUnits } from "./unitScope";
import type { Tx } from "./_core/dbTypes";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { mayScopePolicyTo, resolveActingScope } from "./_core/actingScope";
import { affectedRows } from "./_core/enforcementCommit";
import { createHash } from "node:crypto";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  communicationCoverage, communicationPackageDownloads, communicationPackages, communicationPlans,
  communicationPolicies, companyRadioAuthorizations, oosReleasePolicies, radioChannels,
  radioSignObservations, roadRadioAssignments, unitRadioCapabilities,
} from "../drizzle/schema";
import {
  carriedState, dependencyHash, packageDependencies, packageStaleness,
  sealCommunicationPackage, type PackageDependencies,
} from "./_core/commPackage";
import { ALL_CHANNEL_SEEDS, CHANNEL_SEED_CAVEAT, CHANNEL_SEED_RETRIEVAL_DATE } from "./_core/radioChannelSeeds";
import {
  AUTHORITY_TIERS, ADVISORY_POLICY, communicationBlockers, communicationsFingerprintParts,
  planCommunications, transmitAuthorization,
  type CommunicationPolicy, type CoverageObservation, type GeoCondition, type PathSegment,
  type RadioChannel, type RoadRadioAssignment, type UnitRadioCapability,
} from "./_core/commRoute";
import { resolveRouteCommunicationGeography } from "./routeCommunicationGeography";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const TIER = z.enum(AUTHORITY_TIERS);

/** A stored row read back as the engine's type. The JSON columns are parsed once, here. */
function toChannel(r: typeof radioChannels.$inferSelect): RadioChannel {
  return {
    channelKey: r.channelKey, alias: r.alias, serviceClass: r.serviceClass, systemType: r.systemType,
    rxMHz: r.rxMHz, txMHz: r.txMHz, toneRxHz: r.toneRxHz, toneTxHz: r.toneTxHz,
    bandwidthKHz: r.bandwidthKHz, maxPowerW: r.maxPowerW, licenceRequired: r.licenceRequired,
    conditions: JSON.parse(r.conditionsJson) as GeoCondition[],
    sourceKey: r.sourceKey, sourceCitation: r.sourceCitation, sourceVersion: r.sourceVersion,
    verificationStatus: r.verificationStatus,
    serviceStatus: r.serviceStatus, retiredNote: r.retiredNote,
  };
}

function toAssignment(r: typeof roadRadioAssignments.$inferSelect): RoadRadioAssignment {
  return {
    assignmentRef: r.assignmentRef, segmentId: r.segmentId, channelKey: r.channelKey,
    authorityTier: r.authorityTier, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
    callDirectionLoaded: r.callDirectionLoaded, callIntervalKm: r.callIntervalKm,
    mustCallKm: r.mustCallKmJson ? (JSON.parse(r.mustCallKmJson) as number[]) : null,
    roadName: r.roadName, observedAt: r.observedAt, verificationStatus: r.verificationStatus,
    supersedesAssignmentRef: r.supersedesAssignmentRef,
  };
}

function toCapability(r: typeof unitRadioCapabilities.$inferSelect): UnitRadioCapability {
  return {
    unitId: r.unitId, vhf: r.vhf, uhf: r.uhf, cb: r.cb, satellite: r.satellite, cellular: r.cellular,
    programmingProfileRef: r.programmingProfileRef,
    programmedChannelKeys: r.programmedChannelKeysJson ? (JSON.parse(r.programmedChannelKeysJson) as string[]) : null,
    verificationStatus: r.verificationStatus,
  };
}

/**
 * Everything a plan is computed from, read once. Shared by `planForPath` and
 * `packageBuild` so the package is sealed over exactly the inputs the plan was
 * computed over, rather than a second, separately-assembled set of them.
 */
async function planInputs(d: Awaited<ReturnType<typeof db>>, segmentIds: string[], unitId: number | null) {
  const [assignRows, coverRows, channelRows, authRows] = await Promise.all([
    segmentIds.length ? d.select().from(roadRadioAssignments).where(inArray(roadRadioAssignments.segmentId, segmentIds)) : Promise.resolve([]),
    segmentIds.length ? d.select().from(communicationCoverage).where(inArray(communicationCoverage.segmentId, segmentIds)) : Promise.resolve([]),
    d.select().from(radioChannels),
    d.select().from(companyRadioAuthorizations).where(eq(companyRadioAuthorizations.authorized, true)),
  ]);
  const cap = unitId ? (await d.select().from(unitRadioCapabilities).where(eq(unitRadioCapabilities.unitId, unitId)).limit(1))[0] : undefined;
  return {
    assignments: assignRows.map(toAssignment),
    channels: channelRows.map(toChannel),
    coverage: coverRows.map(r => ({ segmentId: r.segmentId, medium: r.medium, state: r.state, sourceKey: r.sourceKey, authorityTier: r.authorityTier, observedAt: r.observedAt, verificationStatus: r.verificationStatus })) as CoverageObservation[],
    companyAuthorizations: authRows.map(a => ({ channelKey: a.channelKey, authorized: a.authorized, licenceRef: a.licenceRef, licenceExpiresAt: a.licenceExpiresAt, provinces: a.provincesJson ? (JSON.parse(a.provincesJson) as string[]) : null, approvedUnitIds: a.approvedUnitIdsJson ? (JSON.parse(a.approvedUnitIdsJson) as number[]) : null, verificationStatus: a.verificationStatus })),
    unit: cap ? toCapability(cap) : null,
  };
}

export const commsRouter = router({
  /* ---------------- the channel registry ---------------- */

  /**
   * Load the standardized banks. Additive and idempotent: a channel already
   * present is left exactly as it is, so seeding never walks over a person's
   * verification. Every inserted row is `unverified`.
   */
  channelSeed: roleProcedure("comms.channelSeed").mutation(async ({ ctx }) => {
    const d = await db();
    const present = new Set((await d.select({ channelKey: radioChannels.channelKey }).from(radioChannels)).map(r => r.channelKey));
    const inserted: string[] = [];
    for (const c of ALL_CHANNEL_SEEDS) {
      if (present.has(c.channelKey)) continue;
      await d.insert(radioChannels).values({
        channelKey: c.channelKey, alias: c.alias, serviceClass: c.serviceClass, systemType: c.systemType,
        rxMHz: c.rxMHz, txMHz: c.txMHz, bandwidthKHz: c.bandwidthKHz ?? null, maxPowerW: c.maxPowerW ?? null,
        licenceRequired: c.licenceRequired, conditionsJson: JSON.stringify(c.conditions),
        sourceKey: c.sourceKey, sourceCitation: c.sourceCitation, sourceVersion: c.sourceVersion ?? null,
        retrievedAt: CHANNEL_SEED_RETRIEVAL_DATE, verificationStatus: "unverified", recordedByUserId: ctx.user.id,
      });
      inserted.push(c.channelKey);
    }
    return { inserted: inserted.length, existing: present.size, channels: inserted, caveat: CHANNEL_SEED_CAVEAT };
  }),

  channelList: roleProcedure("comms.channelList")
    .input(z.object({ serviceClass: z.string().max(40).optional(), verifiedOnly: z.boolean().default(false) }).default({ verifiedOnly: false }))
    .query(async ({ input }) => {
      const d = await db();
      let rows = await d.select().from(radioChannels).orderBy(radioChannels.channelKey);
      if (input.serviceClass) rows = rows.filter(r => r.serviceClass === input.serviceClass);
      if (input.verifiedOnly) rows = rows.filter(r => r.verificationStatus === "verified");
      return {
        channels: rows.map(r => ({
          channelKey: r.channelKey, alias: r.alias, serviceClass: r.serviceClass, systemType: r.systemType,
          rxMHz: r.rxMHz, txMHz: r.txMHz, licenceRequired: r.licenceRequired,
          conditions: JSON.parse(r.conditionsJson) as GeoCondition[],
          verificationStatus: r.verificationStatus, serviceStatus: r.serviceStatus, retiredNote: r.retiredNote, sourceCitation: r.sourceCitation,
        })),
        verified: rows.filter(r => r.verificationStatus === "verified").length,
        unverified: rows.filter(r => r.verificationStatus === "unverified").length,
        caveat: CHANNEL_SEED_CAVEAT,
      };
    }),

  /** Verify a channel against the publication it cites. Never the person who recorded it. */
  channelVerify: roleProcedure("comms.channelVerify")
    .input(z.object({ channelKey: z.string().min(1).max(40), sourceUrl: z.string().max(600).optional(), sourceVersion: z.string().max(80).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = (await d.select().from(radioChannels).where(eq(radioChannels.channelKey, input.channelKey)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: `No channel ${input.channelKey} in the registry` });
      if (c.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Channel is ${c.verificationStatus}` });
      if (c.recordedByUserId != null && c.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded a channel does not verify it — a second person does" });
      await d.update(radioChannels).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), sourceUrl: input.sourceUrl ?? c.sourceUrl, sourceVersion: input.sourceVersion ?? c.sourceVersion }).where(eq(radioChannels.id, c.id));
      return { channelKey: c.channelKey, verificationStatus: "verified" as const, citation: c.sourceCitation };
    }),

  /* ---------------- may this company transmit ---------------- */

  authorizationRecord: roleProcedure("comms.authorizationRecord")
    .input(z.object({
      channelKey: z.string().min(1).max(40), authorized: z.boolean(),
      licenceRef: z.string().max(120).optional(), licenceExpiresAt: z.coerce.date().optional(),
      provinces: z.array(z.string().min(2).max(3)).max(13).optional(),
      approvedUnitIds: z.array(z.number().int().positive()).max(500).optional(),
      evidenceRecordId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitIds: input.approvedUnitIds });   // CP1.5 — a licence approves only units the caller can see
      const d = await db();
      const c = (await d.select().from(radioChannels).where(eq(radioChannels.channelKey, input.channelKey)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: `No channel ${input.channelKey} in the registry — record the channel before authorizing it` });
      const authorizationRef = ref("RADAUTH");
      await d.insert(companyRadioAuthorizations).values({
        authorizationRef, channelKey: input.channelKey, authorized: input.authorized,
        licenceRef: input.licenceRef ?? null, licenceExpiresAt: input.licenceExpiresAt ?? null,
        provincesJson: input.provinces ? JSON.stringify(input.provinces) : null,
        approvedUnitIdsJson: input.approvedUnitIds ? JSON.stringify(input.approvedUnitIds) : null,
        evidenceRecordId: input.evidenceRecordId ?? null, verificationStatus: "unverified", recordedByUserId: ctx.user.id,
      });
      return { authorizationRef, channelKey: input.channelKey, verificationStatus: "unverified" as const, note: "Recorded and unverified — until a second person verifies it against the licence, transmit authorization on this channel reads UNKNOWN." };
    }),

  /** Verify an authorization against the licence document. A second person, and the evidence named. */
  authorizationVerify: roleProcedure("comms.authorizationVerify")
    .input(z.object({ authorizationRef: z.string().min(1).max(64), evidenceRecordId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const a = (await d.select().from(companyRadioAuthorizations).where(eq(companyRadioAuthorizations.authorizationRef, input.authorizationRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "No such authorization" });
      if (a.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Authorization is ${a.verificationStatus}` });
      if (a.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded an authorization does not verify it — a second person does" });
      await d.update(companyRadioAuthorizations).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date(), evidenceRecordId: input.evidenceRecordId }).where(eq(companyRadioAuthorizations.id, a.id));
      return { authorizationRef: a.authorizationRef, channelKey: a.channelKey, verificationStatus: "verified" as const };
    }),

  /* ---------------- what is in the truck ---------------- */

  /**
   * The shop's record of the radio fit. The programmed channel list is the
   * shop's programming profile, not a wish: a channel absent from it cannot be
   * transmitted on however well LeaseOS knows the frequency.
   */
  unitCapabilitySet: roleProcedure("comms.unitCapabilitySet")
    .input(z.object({
      unitId: z.number().int().positive(),
      vhf: z.boolean().default(false), uhf: z.boolean().default(false), cb: z.boolean().default(false),
      satellite: z.boolean().default(false), cellular: z.boolean().default(false),
      programmingProfileRef: z.string().max(80).optional(), programmingProfileVersion: z.string().max(40).optional(),
      programmedChannelKeys: z.array(z.string().max(40)).max(500).optional(),
      programmedAt: z.coerce.date().optional(), programmedBy: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5 — readiness reads this radio fit for the unit's route
      const d = await db();
      const values = {
        unitId: input.unitId, vhf: input.vhf, uhf: input.uhf, cb: input.cb, satellite: input.satellite, cellular: input.cellular,
        programmingProfileRef: input.programmingProfileRef ?? null, programmingProfileVersion: input.programmingProfileVersion ?? null,
        programmedChannelKeysJson: input.programmedChannelKeys ? JSON.stringify(input.programmedChannelKeys) : null,
        programmedAt: input.programmedAt ?? null, programmedBy: input.programmedBy ?? null,
        configurationHash: input.programmedChannelKeys ? sha([...input.programmedChannelKeys].sort()).slice(0, 64) : null,
        verificationStatus: "unverified" as const, recordedByUserId: ctx.user.id,
      };
      const cur = (await d.select({ id: unitRadioCapabilities.id }).from(unitRadioCapabilities).where(eq(unitRadioCapabilities.unitId, input.unitId)).limit(1))[0];
      if (cur) await d.update(unitRadioCapabilities).set(values).where(eq(unitRadioCapabilities.id, cur.id));
      else await d.insert(unitRadioCapabilities).values(values);
      return { unitId: input.unitId, verificationStatus: "unverified" as const, programmedChannels: input.programmedChannelKeys?.length ?? 0, configurationHash: values.configurationHash };
    }),

  /* ---------------- the road carries a channel ---------------- */

  assignmentRecord: roleProcedure("comms.assignmentRecord")
    .input(z.object({
      segmentId: z.string().min(1).max(80), channelKey: z.string().min(1).max(40), authorityTier: TIER,
      roadName: z.string().max(220).optional(),
      callDirectionLoaded: z.enum(["increasing_km", "decreasing_km"]).optional(),
      callIntervalKm: z.number().positive().max(200).optional(),
      mustCallKm: z.array(z.number().nonnegative().max(2000)).max(200).optional(),
      effectiveFrom: z.coerce.date().optional(), effectiveTo: z.coerce.date().optional(),
      supersedesAssignmentRef: z.string().max(64).optional(),
      sourceKey: z.string().min(1).max(60), sourceCitation: z.string().max(400).optional(),
      observedAt: z.coerce.date().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.effectiveFrom && input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The window ends before it begins" });
      const c = (await d.select().from(radioChannels).where(eq(radioChannels.channelKey, input.channelKey)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: `No channel ${input.channelKey} in the registry` });
      // A posted sign is what a driver reads off the road. It is not something
      // an office types in from a map, so recording one that way is refused.
      if (input.authorityTier === "posted_sign") throw new TRPCError({ code: "FORBIDDEN", message: "A posted-sign assignment is created by confirming a field observation of the sign, not by recording one directly" });
      const assignmentRef = ref("RADASSIGN");
      await d.insert(roadRadioAssignments).values({
        assignmentRef, segmentId: input.segmentId, channelKey: input.channelKey, roadName: input.roadName ?? null,
        authorityTier: input.authorityTier, callDirectionLoaded: input.callDirectionLoaded ?? null,
        callIntervalKm: input.callIntervalKm ?? null, mustCallKmJson: input.mustCallKm ? JSON.stringify(input.mustCallKm) : null,
        effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null,
        permanent: !input.effectiveTo, supersedesAssignmentRef: input.supersedesAssignmentRef ?? null,
        sourceKey: input.sourceKey, sourceCitation: input.sourceCitation ?? null,
        observedAt: input.observedAt ?? new Date(), verificationStatus: "unverified", recordedByUserId: ctx.user.id,
      });
      return {
        assignmentRef, segmentId: input.segmentId, channelKey: input.channelKey, authorityTier: input.authorityTier,
        temporary: !!input.effectiveTo,
        note: input.effectiveTo
          ? `Temporary: in force to ${input.effectiveTo.toISOString().slice(0, 10)}, after which the previous assignment governs again — the history is kept, not overwritten.`
          : "The channel posted on the road governs over this record.",
      };
    }),

  assignmentVerify: roleProcedure("comms.assignmentVerify")
    .input(z.object({ assignmentRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const a = (await d.select().from(roadRadioAssignments).where(eq(roadRadioAssignments.assignmentRef, input.assignmentRef)).limit(1))[0];
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "No such assignment" });
      if (a.verificationStatus !== "unverified") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Assignment is ${a.verificationStatus}` });
      if (a.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded an assignment does not verify it — a second person does" });
      if (a.supersedesAssignmentRef) {
        const prior = (await d.select().from(roadRadioAssignments).where(eq(roadRadioAssignments.assignmentRef, a.supersedesAssignmentRef)).limit(1))[0];
        if (prior) await d.update(roadRadioAssignments).set({ verificationStatus: "superseded" }).where(eq(roadRadioAssignments.id, prior.id));
      }
      await d.update(roadRadioAssignments).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date() }).where(eq(roadRadioAssignments.id, a.id));
      return { assignmentRef: a.assignmentRef, verificationStatus: "verified" as const, superseded: a.supersedesAssignmentRef ?? null };
    }),

  assignmentsForSegments: roleProcedure("comms.assignmentsForSegments")
    .input(z.object({ segmentIds: z.array(z.string().min(1).max(80)).min(1).max(500) }))
    .query(async ({ input }) => {
      const d = await db();
      const rows = await d.select().from(roadRadioAssignments).where(inArray(roadRadioAssignments.segmentId, input.segmentIds));
      return { assignments: rows.map(toAssignment), segmentsWithout: input.segmentIds.filter(s => !rows.some(r => r.segmentId === s)) };
    }),

  /* ---------------- the sign on the road ---------------- */

  /**
   * A driver photographs a radio sign. This records an observation and changes
   * nothing operational: detected is not confirmed, here as everywhere else.
   */
  signObserve: roleProcedure("comms.signObserve")
    .input(z.object({
      observedChannelText: z.string().min(1).max(120),
      latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
      segmentId: z.string().max(80).optional(), roadName: z.string().max(220).optional(),
      evidenceRecordId: z.number().int().positive().optional(), photoHash: z.string().max(64).optional(),
      tripId: z.number().int().positive().optional(), note: z.string().max(400).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      // Best-effort match against the registry, offered as a candidate only.
      const normalized = input.observedChannelText.trim().toUpperCase().replace(/\s+/g, "-");
      const candidate = (await d.select({ channelKey: radioChannels.channelKey }).from(radioChannels).where(eq(radioChannels.channelKey, normalized)).limit(1))[0];
      const observationRef = ref("RADSIGN");
      await d.insert(radioSignObservations).values({
        observationRef, segmentId: input.segmentId ?? null, roadName: input.roadName ?? null,
        observedChannelText: input.observedChannelText, resolvedChannelKey: candidate?.channelKey ?? null,
        latitude: input.latitude, longitude: input.longitude,
        evidenceRecordId: input.evidenceRecordId ?? null, photoHash: input.photoHash ?? null,
        tripId: input.tripId ?? null, note: input.note ?? null, status: "pending", observedByUserId: ctx.user.id,
      });
      return {
        observationRef, status: "pending" as const, candidateChannelKey: candidate?.channelKey ?? null,
        note: candidate
          ? `Reads as ${candidate.channelKey}. Recorded for review — it governs nothing until the office confirms it.`
          : "No channel in the registry matches that text. Recorded for review as written.",
      };
    }),

  /**
   * The office decides. Confirming creates the assignment at `posted_sign` —
   * the only path to that tier, and the tier that outranks every dataset.
   */
  signDecide: roleProcedure("comms.signDecide")
    .input(z.object({
      observationRef: z.string().min(1).max(64), decision: z.enum(["confirm", "reject"]),
      channelKey: z.string().max(40).optional(), segmentId: z.string().max(80).optional(),
      callDirectionLoaded: z.enum(["increasing_km", "decreasing_km"]).optional(),
      callIntervalKm: z.number().positive().max(200).optional(),
      mustCallKm: z.array(z.number().nonnegative().max(2000)).max(200).optional(),
      decisionNote: z.string().max(400).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const o = (await d.select().from(radioSignObservations).where(eq(radioSignObservations.observationRef, input.observationRef)).limit(1))[0];
      if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "No such observation" });
      if (o.status !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Observation is already ${o.status}` });
      if (o.observedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who observed a sign does not confirm it — a second person does" });

      if (input.decision === "reject") {
        await d.update(radioSignObservations).set({ status: "rejected", decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionNote: input.decisionNote ?? null }).where(eq(radioSignObservations.id, o.id));
        return { observationRef: o.observationRef, status: "rejected" as const, assignmentRef: null };
      }

      const channelKey = input.channelKey ?? o.resolvedChannelKey;
      const segmentId = input.segmentId ?? o.segmentId;
      if (!channelKey) throw new TRPCError({ code: "BAD_REQUEST", message: "Confirming a sign names the channel it shows — the observed text matched nothing in the registry" });
      if (!segmentId) throw new TRPCError({ code: "BAD_REQUEST", message: "Confirming a sign names the road segment it governs" });
      const c = (await d.select().from(radioChannels).where(eq(radioChannels.channelKey, channelKey)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: `No channel ${channelKey} in the registry` });

      const assignmentRef = ref("RADASSIGN");
      await d.insert(roadRadioAssignments).values({
        assignmentRef, segmentId, channelKey, roadName: o.roadName,
        authorityTier: "posted_sign", callDirectionLoaded: input.callDirectionLoaded ?? null,
        callIntervalKm: input.callIntervalKm ?? null, mustCallKmJson: input.mustCallKm ? JSON.stringify(input.mustCallKm) : null,
        permanent: true, sourceKey: "field_observation",
        sourceCitation: `Posted sign photographed at ${o.latitude.toFixed(5)}, ${o.longitude.toFixed(5)} — observation ${o.observationRef}`,
        observedAt: o.observedAt, verificationStatus: "verified", recordedByUserId: o.observedByUserId,
        verifiedByUserId: ctx.user.id, verifiedAt: new Date(),
      });
      await d.update(radioSignObservations).set({ status: "confirmed", decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionNote: input.decisionNote ?? null, resolvedChannelKey: channelKey, createdAssignmentRef: assignmentRef }).where(eq(radioSignObservations.id, o.id));
      return { observationRef: o.observationRef, status: "confirmed" as const, assignmentRef, channelKey, segmentId, note: "Recorded at posted-sign authority — it now outranks any map or planning record for this segment." };
    }),

  signQueue: roleProcedure("comms.signQueue").query(async () => {
    const d = await db();
    const rows = await d.select().from(radioSignObservations).where(eq(radioSignObservations.status, "pending")).orderBy(desc(radioSignObservations.id)).limit(200);
    return { pending: rows.map(r => ({ observationRef: r.observationRef, observedChannelText: r.observedChannelText, candidateChannelKey: r.resolvedChannelKey, roadName: r.roadName, segmentId: r.segmentId, latitude: r.latitude, longitude: r.longitude, observedAt: r.observedAt })) };
  }),

  /* ---------------- coverage ---------------- */

  coverageRecord: roleProcedure("comms.coverageRecord")
    .input(z.object({
      segmentId: z.string().min(1).max(80), medium: z.enum(["cellular", "satellite", "radio"]),
      state: z.enum(["available", "intermittent", "unavailable"]), carrier: z.string().max(120).optional(),
      authorityTier: TIER, sourceKey: z.string().min(1).max(60), sourceCitation: z.string().max(400).optional(),
      tripId: z.number().int().positive().optional(), observedAt: z.coerce.date().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const coverageRef = ref("COV");
      await d.insert(communicationCoverage).values({
        coverageRef, segmentId: input.segmentId, medium: input.medium, state: input.state,
        carrier: input.carrier ?? null, authorityTier: input.authorityTier, sourceKey: input.sourceKey,
        sourceCitation: input.sourceCitation ?? null, tripId: input.tripId ?? null,
        observedAt: input.observedAt ?? new Date(), verificationStatus: "unverified", recordedByUserId: ctx.user.id,
      });
      return { coverageRef, segmentId: input.segmentId, medium: input.medium, state: input.state, note: "Coverage evidence, not a guarantee. Absence of a row is unknown, never 'no service'." };
    }),

  /* ---------------- the question a driver asks ---------------- */

  /** May this unit transmit on this channel, here, now? Four gates, each with its reason. */
  transmitCheck: roleProcedure("comms.transmitCheck")
    .input(z.object({
      channelKey: z.string().min(1).max(40), unitId: z.number().int().positive().optional(),
      latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
      province: z.string().max(3).optional(), segmentId: z.string().max(80).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .query(async ({ input }) => {
      const d = await db();
      const c = (await d.select().from(radioChannels).where(eq(radioChannels.channelKey, input.channelKey)).limit(1))[0];
      const auths = await d.select().from(companyRadioAuthorizations).where(and(eq(companyRadioAuthorizations.channelKey, input.channelKey), eq(companyRadioAuthorizations.authorized, true)));
      const live = auths.filter(a => a.verificationStatus !== "superseded").sort((a, b) => b.id - a.id)[0];
      const cap = input.unitId ? (await d.select().from(unitRadioCapabilities).where(eq(unitRadioCapabilities.unitId, input.unitId)).limit(1))[0] : undefined;
      let posted = false;
      if (input.segmentId) {
        const rows = await d.select().from(roadRadioAssignments).where(and(eq(roadRadioAssignments.segmentId, input.segmentId), eq(roadRadioAssignments.channelKey, input.channelKey)));
        posted = rows.some(r => r.authorityTier === "posted_sign" && r.verificationStatus !== "superseded");
      }
      const result = transmitAuthorization({
        channel: c ? toChannel(c) : null, channelKey: input.channelKey,
        companyAuthorization: live ? { channelKey: live.channelKey, authorized: live.authorized, licenceRef: live.licenceRef, licenceExpiresAt: live.licenceExpiresAt, provinces: live.provincesJson ? (JSON.parse(live.provincesJson) as string[]) : null, approvedUnitIds: live.approvedUnitIdsJson ? (JSON.parse(live.approvedUnitIdsJson) as number[]) : null, verificationStatus: live.verificationStatus } : null,
        unit: cap ? toCapability(cap) : null,
        position: input.latitude != null && input.longitude != null ? [input.longitude, input.latitude] : null,
        province: input.province ?? null, at: input.at, postedOnThisRoad: posted,
      });
      return { ...result, alias: c?.alias ?? null, rxMHz: c?.rxMHz ?? null, txMHz: c?.txMHz ?? null };
    }),

  /* ---------------- the plan along a route ---------------- */

  /**
   * Compute and persist the communication plan for a path. The path is the
   * router's answer; this says what the driver talks on while driving it, and
   * where that stops being true.
   */
  planForPath: roleProcedure("comms.planForPath")
    .input(z.object({
      segments: z.array(z.object({ segmentId: z.string().min(1).max(80), label: z.string().max(220).default(""), lengthKm: z.number().nonnegative().max(5000) })).min(1).max(500),
      unitId: z.number().int().positive().optional(), tripId: z.number().int().positive().optional(),
      jobId: z.number().int().positive().optional(), buildRef: z.string().max(64).optional(),
      province: z.string().max(3).optional(),
      policy: z.object({ unknownPlanBlocks: z.boolean().default(false), requireTransmitAuthorization: z.boolean().default(false), toleratedNoCommunicationKm: z.number().nonnegative().max(5000).default(5000) }).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5 — it reads the unit's radio fit, too
      const d = await db();
      const segmentIds = input.segments.map(s => s.segmentId);
      const [assignRows, coverRows, channelRows, authRows] = await Promise.all([
        d.select().from(roadRadioAssignments).where(inArray(roadRadioAssignments.segmentId, segmentIds)),
        d.select().from(communicationCoverage).where(inArray(communicationCoverage.segmentId, segmentIds)),
        d.select().from(radioChannels),
        d.select().from(companyRadioAuthorizations).where(eq(companyRadioAuthorizations.authorized, true)),
      ]);
      const cap = input.unitId ? (await d.select().from(unitRadioCapabilities).where(eq(unitRadioCapabilities.unitId, input.unitId)).limit(1))[0] : undefined;

      const path: PathSegment[] = input.segments.map(s => ({ segmentId: s.segmentId, label: s.label, lengthKm: s.lengthKm }));
      const coverage: CoverageObservation[] = coverRows.map(r => ({ segmentId: r.segmentId, medium: r.medium, state: r.state, sourceKey: r.sourceKey, authorityTier: r.authorityTier, observedAt: r.observedAt, verificationStatus: r.verificationStatus }));
      // The same resolver routeCompute and readiness use. Three paths, one set
      // of geographic facts — a plan that disagreed with the readiness it feeds
      // would be worse than no plan.
      const planGeo = input.buildRef ? await resolveRouteCommunicationGeography(d, { buildRef: input.buildRef, segmentIds }) : null;
      const plan = planCommunications({
        geographyBySegment: planGeo?.geographyBySegment,
        path, assignments: assignRows.map(toAssignment), channels: channelRows.map(toChannel), coverage,
        companyAuthorizations: authRows.map(a => ({ channelKey: a.channelKey, authorized: a.authorized, licenceRef: a.licenceRef, licenceExpiresAt: a.licenceExpiresAt, provinces: a.provincesJson ? (JSON.parse(a.provincesJson) as string[]) : null, approvedUnitIds: a.approvedUnitIdsJson ? (JSON.parse(a.approvedUnitIdsJson) as number[]) : null, verificationStatus: a.verificationStatus })),
        unit: cap ? toCapability(cap) : null, province: input.province ?? null, at: input.at,
      });

      const policy: CommunicationPolicy = input.policy ? { ...input.policy } : ADVISORY_POLICY;
      const blockers = communicationBlockers(plan, policy);
      const fingerprintHash = sha(communicationsFingerprintParts(plan));
      const planRef = ref("COMMS");
      await d.insert(communicationPlans).values({
        planRef, unitId: input.unitId ?? null, tripId: input.tripId ?? null, jobId: input.jobId ?? null,
        buildRef: input.buildRef ?? null, segmentIdsJson: JSON.stringify(segmentIds), totalKm: plan.totalKm,
        verdict: plan.verdict, unknownChannelKm: plan.unknownChannelKm, noCommunicationKm: plan.noCommunicationKm,
        zonesJson: JSON.stringify(plan.zones), coverageJson: JSON.stringify(plan.coverage),
        ladderJson: JSON.stringify(plan.ladder), mustCallJson: JSON.stringify(plan.mustCall),
        fingerprintHash, explanation: plan.explanation.slice(0, 2000), computedByUserId: ctx.user.id,
      });
      return { planRef, fingerprintHash, ...plan, blockers };
    }),

  /* ---------------- the out-of-service release policy ---------------- */

  /**
   * Propose a release policy. It decides nothing until a different person
   * approves it — which is what finally makes "separate proposer and approver"
   * an enforced rule rather than two columns that happen to exist.
   */
  oosPolicyPropose: roleProcedure("comms.oosPolicyPropose")
    .input(z.object({
      label: z.string().min(2).max(220),
      // No tenantId. It is server-owned; see resolveActingScope.
      scopeType: z.enum(["company", "branch", "terminal"]).default("company"),
      scopeRef: z.string().max(64).optional(),
      repairerMayRecordRepairVerification: z.boolean().default(false),
      releaserMustDifferFromRepairer: z.boolean().default(true),
      releaserMustDifferFromFindingAuthor: z.boolean().default(false),
      allowedFindingRoles: z.record(z.string(), z.array(z.string().max(40)).max(20)),
      rationale: z.string().max(1000).optional(),
      effectiveFrom: z.coerce.date(),
      effectiveTo: z.coerce.date().optional(),
      supersedesPolicyRef: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The window ends before it begins" });
      // The organization comes from server-owned records, never from the request.
      const acting = await resolveActingScope(d, ctx.user.id);
      const scope = mayScopePolicyTo(acting, input.scopeType, input.scopeRef ?? null);
      if (!scope.allowed) throw new TRPCError({ code: "FORBIDDEN", message: scope.reason });
      const policyRef = ref("POLOOS");
      await d.insert(oosReleasePolicies).values({
        policyRef, tenantId: acting.tenantId, version: 1, label: input.label,
        scopeType: input.scopeType, scopeRef: scope.scopeRef,
        repairerMayRecordRepairVerification: input.repairerMayRecordRepairVerification,
        releaserMustDifferFromRepairer: input.releaserMustDifferFromRepairer,
        releaserMustDifferFromFindingAuthor: input.releaserMustDifferFromFindingAuthor,
        allowedFindingRolesJson: JSON.stringify(input.allowedFindingRoles),
        rationale: input.rationale ?? null, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
        status: "proposed", supersedesPolicyRef: input.supersedesPolicyRef ?? null, proposedByUserId: ctx.user.id,
      });
      return { policyRef, status: "proposed" as const, note: "Proposed. Until a different person approves it, no out-of-service order can be released under it." };
    }),

  /**
   * Approve or reject it. Two refusals, and the second matters most: approving
   * a policy that overlaps an approved one at the same scope would manufacture
   * exactly the ambiguity the release selector refuses — and the first anyone
   * would learn of it is a truck that cannot be released.
   */
  oosPolicyApprove: roleProcedure("comms.oosPolicyApprove")
    .input(z.object({ policyRef: z.string().min(1).max(64), decision: z.enum(["approve", "reject"]), decisionNote: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const p0 = (await d.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.policyRef, input.policyRef)).limit(1))[0];
      if (!p0) throw new TRPCError({ code: "NOT_FOUND", message: "No such release policy" });
      // One scope at a time. Reading "no conflict" and writing "approved" were
      // two statements, so two approvers could each see a clear scope and both
      // approve into it — manufacturing the ambiguity the release selector then
      // refuses, discovered only when a truck could not be released.
      // Serialize approvals per scope with a locking read of every policy row in the
      // scope (oosReleasePolicies_scope index). A named GET_LOCK was used before, but it
      // was released in a `finally` inside the transaction — before the commit — so a
      // second approver could take the lock, read a snapshot that did not yet include
      // the first approval, and approve too (gate run 2026-09-17 04:25). Row locks are
      // held until commit; the second transaction's locking read then sees the first.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await d.transaction(async (tx: Tx) => {
      await tx.execute(sql`SELECT id FROM oosReleasePolicies WHERE tenantId = ${p0.tenantId ?? ""} AND scopeType = ${p0.scopeType} AND scopeRef <=> ${p0.scopeRef ?? null} FOR UPDATE`);
      {
      const p = (await tx.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.policyRef, input.policyRef)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such release policy" });
      if (p.status !== "proposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Policy is ${p.status}` });
      if (p.proposedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who proposed a release policy does not approve it — a second person does" });

      if (input.decision === "reject") {
        await tx.update(oosReleasePolicies).set({ status: "rejected", approvedByUserId: ctx.user.id, approvedAt: new Date(), decisionNote: input.decisionNote ?? null }).where(eq(oosReleasePolicies.id, p.id));
        return { policyRef: p.policyRef, status: "rejected" as const, superseded: null, note: "Recorded as reviewed and not approved." };
      }

      const siblings = await tx.select().from(oosReleasePolicies).where(and(eq(oosReleasePolicies.status, "approved"), eq(oosReleasePolicies.tenantId, p.tenantId ?? ""))).for("update");
      const overlapping = siblings.filter((s2: typeof p) =>
        s2.scopeType === p.scopeType && (s2.scopeRef ?? null) === (p.scopeRef ?? null) &&
        s2.policyRef !== p.supersedesPolicyRef &&
        (!p.effectiveTo || s2.effectiveFrom.getTime() < p.effectiveTo.getTime()) &&
        (!s2.effectiveTo || s2.effectiveTo.getTime() > p.effectiveFrom.getTime()));
      if (overlapping.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Approving this would leave ${overlapping.length + 1} approved ${p.scopeType} policies in force at once (${[...overlapping.map((o: typeof p) => o.policyRef), p.policyRef].join(", ")}). Name the one it supersedes, or change its window — otherwise every release in that scope is blocked as ambiguous.`,
        });
      }

      let superseded: string | null = null;
      if (p.supersedesPolicyRef) {
        const prior = (await tx.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.policyRef, p.supersedesPolicyRef)).limit(1))[0];
        if (prior && prior.tenantId !== p.tenantId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A policy may only supersede one in its own tenant" });
        if (prior && (prior.scopeType !== p.scopeType || (prior.scopeRef ?? null) !== (p.scopeRef ?? null))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A ${p.scopeType} policy may only supersede another ${p.scopeType} policy at the same scope` });
        if (prior && prior.status === "approved") { await tx.update(oosReleasePolicies).set({ status: "superseded" }).where(eq(oosReleasePolicies.id, prior.id)); superseded = prior.policyRef; }
      }
      const applied = await tx.update(oosReleasePolicies).set({ status: "approved", approvedByUserId: ctx.user.id, approvedAt: new Date(), decisionNote: input.decisionNote ?? null }).where(and(eq(oosReleasePolicies.id, p.id), eq(oosReleasePolicies.status, "proposed")));
      if (affectedRows(applied) !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Another decision on this policy completed first" });
      return { policyRef: p.policyRef, status: "approved" as const, superseded, note: "In force. Releases in its scope are now decided by it." };
      }
      });
    }),

  /* ---------------- the company's own policy ---------------- */

  /**
   * Propose the policy. LeaseOS has no opinion on whether an incomplete
   * communication plan should stop a truck — a city flatdeck operator and a
   * lone worker on a resource road at night need different answers, and
   * hard-coding either would be wrong for the other. So it is recorded, and
   * approved by somebody other than the person who wrote it, because it decides
   * whether a driver leaves the yard.
   */
  policyPropose: roleProcedure("comms.policyPropose")
    .input(z.object({
      label: z.string().min(2).max(220),
      scopeType: z.enum(["company", "branch"]).default("company"),
      scopeRef: z.string().max(64).optional(),
      unknownPlanBlocks: z.boolean().default(false),
      requireTransmitAuthorization: z.boolean().default(false),
      toleratedNoCommunicationKm: z.number().nonnegative().max(5000).default(0),
      loneWorkerRequiresSatellite: z.boolean().default(false),
      rationale: z.string().max(1000).optional(),
      effectiveFrom: z.coerce.date().optional(),
      effectiveTo: z.coerce.date().optional(),
      supersedesPolicyRef: z.string().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.effectiveFrom && input.effectiveTo && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The window ends before it begins" });
      const policyRef = ref("COMMPOL");
      await d.insert(communicationPolicies).values({
        policyRef, label: input.label, scopeType: input.scopeType, scopeRef: input.scopeRef ?? null,
        unknownPlanBlocks: input.unknownPlanBlocks, requireTransmitAuthorization: input.requireTransmitAuthorization,
        toleratedNoCommunicationKm: input.toleratedNoCommunicationKm, loneWorkerRequiresSatellite: input.loneWorkerRequiresSatellite,
        rationale: input.rationale ?? null, effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null,
        supersedesPolicyRef: input.supersedesPolicyRef ?? null, status: "proposed", proposedByUserId: ctx.user.id,
      });
      return { policyRef, status: "proposed" as const, note: "Proposed. Until a second person approves it, dispatch reads the advisory default and warns rather than blocks." };
    }),

  policyApprove: roleProcedure("comms.policyApprove")
    .input(z.object({ policyRef: z.string().min(1).max(64), decision: z.enum(["approve", "reject"]), decisionNote: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const p = (await d.select().from(communicationPolicies).where(eq(communicationPolicies.policyRef, input.policyRef)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such policy" });
      if (p.status !== "proposed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Policy is ${p.status}` });
      if (p.proposedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who proposed a policy does not approve it — a second person does" });
      if (input.decision === "reject") {
        await d.update(communicationPolicies).set({ status: "rejected", approvedByUserId: ctx.user.id, approvedAt: new Date(), decisionNote: input.decisionNote ?? null }).where(eq(communicationPolicies.id, p.id));
        return { policyRef: p.policyRef, status: "rejected" as const, superseded: null };
      }
      let superseded: string | null = null;
      if (p.supersedesPolicyRef) {
        const prior = (await d.select().from(communicationPolicies).where(eq(communicationPolicies.policyRef, p.supersedesPolicyRef)).limit(1))[0];
        if (prior && prior.status === "approved") { await d.update(communicationPolicies).set({ status: "superseded" }).where(eq(communicationPolicies.id, prior.id)); superseded = prior.policyRef; }
      }
      await d.update(communicationPolicies).set({ status: "approved", approvedByUserId: ctx.user.id, approvedAt: new Date(), decisionNote: input.decisionNote ?? null }).where(eq(communicationPolicies.id, p.id));
      return { policyRef: p.policyRef, status: "approved" as const, superseded, note: "In force. Dispatch now applies it to every route it is given." };
    }),

  policyCurrent: roleProcedure("comms.policyCurrent")
    .input(z.object({ at: z.coerce.date().default(() => new Date()) }).default({ at: new Date() }))
    .query(async ({ input }) => {
      const d = await db();
      const rows = await d.select().from(communicationPolicies).where(eq(communicationPolicies.status, "approved")).orderBy(desc(communicationPolicies.id));
      const live = rows.find(r => (!r.effectiveFrom || r.effectiveFrom.getTime() <= input.at.getTime()) && (!r.effectiveTo || r.effectiveTo.getTime() > input.at.getTime()));
      if (!live) return { policyRef: null, inForce: false, policy: { unknownPlanBlocks: false, requireTransmitAuthorization: false, toleratedNoCommunicationKm: null, loneWorkerRequiresSatellite: false }, note: "No approved policy is in force — dispatch warns about communications and does not block on them." };
      return {
        policyRef: live.policyRef, inForce: true, label: live.label, rationale: live.rationale,
        policy: { unknownPlanBlocks: live.unknownPlanBlocks, requireTransmitAuthorization: live.requireTransmitAuthorization, toleratedNoCommunicationKm: live.toleratedNoCommunicationKm, loneWorkerRequiresSatellite: live.loneWorkerRequiresSatellite },
        approvedAt: live.approvedAt, effectiveFrom: live.effectiveFrom, effectiveTo: live.effectiveTo,
      };
    }),

  /**
   * Record a service as retired. Same authority as verifying a channel, because
   * it is the same class of act: establishing what is true of the record. This
   * exists because Weatheradio was shut down with its frequencies still
   * published — a retired service authorizes nothing, and says why.
   */
  channelRetire: roleProcedure("comms.channelRetire")
    .input(z.object({ channelKey: z.string().min(1).max(40), note: z.string().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = (await d.select().from(radioChannels).where(eq(radioChannels.channelKey, input.channelKey)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: `No channel ${input.channelKey} in the registry` });
      if (c.serviceStatus === "retired") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That service is already recorded as retired" });
      await d.update(radioChannels).set({ serviceStatus: "retired", retiredNote: input.note, retiredAt: new Date(), retiredByUserId: ctx.user.id }).where(eq(radioChannels.id, c.id));
      return { channelKey: c.channelKey, serviceStatus: "retired" as const, note: "Retired. It will never be offered as a communication option again, and any plan naming it reports it as not authorized." };
    }),

  /* ---------------- the package a truck carries ---------------- */

  /**
   * Seal the package. Built once, hashed, never edited — a driver 60 km up a
   * resource road is acting on what they downloaded this morning, and a record
   * that changed underneath them would make the evidence trail a lie.
   */
  packageBuild: roleProcedure("comms.packageBuild")
    .input(z.object({
      label: z.string().min(2).max(220),
      segments: z.array(z.object({ segmentId: z.string().min(1).max(80), label: z.string().max(220).default(""), lengthKm: z.number().nonnegative().max(5000) })).min(1).max(500),
      unitId: z.number().int().positive().optional(), tripId: z.number().int().positive().optional(),
      jobId: z.number().int().positive().optional(), buildRef: z.string().max(64).optional(),
      routeApprovalRef: z.string().max(64).optional(), province: z.string().max(3).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5
      const d = await db();
      const segmentIds = input.segments.map(s => s.segmentId);
      const inputs = await planInputs(d, segmentIds, input.unitId ?? null);
      const buildGeo = input.buildRef ? await resolveRouteCommunicationGeography(d, { buildRef: input.buildRef, segmentIds }) : null;
      const plan = planCommunications({ path: input.segments.map(s => ({ segmentId: s.segmentId, label: s.label, lengthKm: s.lengthKm })), ...inputs, geographyBySegment: buildGeo?.geographyBySegment, province: input.province ?? null, at: input.at });
      const sealed = sealCommunicationPackage({ plan, channels: inputs.channels, assignments: inputs.assignments, coverage: inputs.coverage, routeRef: input.routeApprovalRef ?? null });
      // Sealed over the keys this package actually carries — the same basis
      // `packageStatus` recomputes on. Sealing over every assigned key while
      // checking over the carried ones made every package stale the instant a
      // second assignment existed on any of its segments.
      const carriedKeys = Array.from(new Set(sealed.content.zones.map(z => z.channelKey).filter((k): k is string => !!k)));
      // Geometry is sealed in. A survey correction that moves a node flips the
      // radio answer while every other input stays identical, so without this
      // the arithmetic would call a carried package CURRENT after its answer
      // had changed.
      const deps = packageDependencies({ segmentIds, assignments: inputs.assignments, channels: inputs.channels, coverage: inputs.coverage, channelKeys: carriedKeys, geographyHash: buildGeo?.geographyHash ?? null });

      // A stale predecessor is still a predecessor. Looking only for `current`
      // restarted the version at 1 and lost the supersession chain exactly when
      // a rebuild mattered most — which is after the world moved.
      const prior = (await d.select().from(communicationPackages).where(and(eq(communicationPackages.label, input.label), inArray(communicationPackages.status, ["current", "stale"]))).orderBy(desc(communicationPackages.version)).limit(1))[0];
      const packageRef = ref("COMMPKG");
      await d.insert(communicationPackages).values({
        packageRef, label: input.label, version: (prior?.version ?? 0) + 1,
        routeApprovalRef: input.routeApprovalRef ?? null, tripId: input.tripId ?? null, jobId: input.jobId ?? null,
        unitId: input.unitId ?? null, buildRef: input.buildRef ?? null, segmentIdsJson: JSON.stringify(segmentIds),
        contentJson: JSON.stringify(sealed.content), manifestHash: sealed.manifestHash,
        dependencyJson: JSON.stringify(deps), dependencyHash: dependencyHash(deps),
        verdict: plan.verdict, totalKm: plan.totalKm,
        zoneCount: sealed.counts.zones, channelCount: sealed.counts.channels,
        unverifiedChannelCount: sealed.counts.unverifiedChannels, retiredExcludedCount: sealed.counts.retiredExcluded,
        mustCallCount: sealed.counts.mustCall, zonesWithoutChannel: sealed.counts.zonesWithoutChannel,
        status: "current", supersedesPackageRef: prior?.packageRef ?? null, builtByUserId: ctx.user.id,
      });
      if (prior) await d.update(communicationPackages).set({ status: "superseded" }).where(eq(communicationPackages.id, prior.id));
      return {
        packageRef, label: input.label, version: (prior?.version ?? 0) + 1, manifestHash: sealed.manifestHash,
        verdict: plan.verdict, totalKm: plan.totalKm, counts: sealed.counts,
        caveats: sealed.content.caveats, supersedes: prior?.packageRef ?? null,
      };
    }),

  /** Take it onto a device. The download is recorded so dispatch knows what is in the field. */
  packageFetch: roleProcedure("comms.packageFetch")
    .input(z.object({ packageRef: z.string().max(64).optional(), label: z.string().max(220).optional(), deviceRef: z.string().max(80).optional(), tripId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (!input.packageRef && !input.label) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the package or the route it is for" });
      const p = input.packageRef
        ? (await d.select().from(communicationPackages).where(eq(communicationPackages.packageRef, input.packageRef)).limit(1))[0]
        // A stale package is still the package for that route. Refusing to hand
        // it over would leave a driver with nothing, which is worse than an out
        // of date package they have been told is out of date.
        : (await d.select().from(communicationPackages).where(and(eq(communicationPackages.label, input.label!), inArray(communicationPackages.status, ["current", "stale"]))).orderBy(desc(communicationPackages.version)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No communication package for that route — build one before departure" });
      if (p.status === "superseded") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Package ${p.packageRef} is superseded — fetch the current one instead` });
      const downloadRef = ref("COMMDL");
      await d.insert(communicationPackageDownloads).values({ downloadRef, packageRef: p.packageRef, manifestHash: p.manifestHash, deviceRef: input.deviceRef ?? null, userId: ctx.user.id, tripId: input.tripId ?? null });
      return {
        downloadRef, packageRef: p.packageRef, version: p.version, manifestHash: p.manifestHash,
        status: p.status, content: JSON.parse(p.contentJson),
        warning: p.status === "stale" ? "This package is out of date — what it was built from has changed. Rebuild before departure." : null,
      };
    }),

  /** The device confirms it stored it. Until then, handing it over is not the same as carrying it. */
  packageAcknowledge: roleProcedure("comms.packageAcknowledge")
    .input(z.object({ downloadRef: z.string().min(1).max(64), manifestHash: z.string().min(8).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const dl = (await d.select().from(communicationPackageDownloads).where(eq(communicationPackageDownloads.downloadRef, input.downloadRef)).limit(1))[0];
      if (!dl) throw new TRPCError({ code: "NOT_FOUND", message: "No such download" });
      if (dl.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "A download is acknowledged by the person who took it" });
      // The device states the hash of what it actually stored. A mismatch is a
      // corrupted or partial download, and saying "carried" of it would be false.
      if (dl.manifestHash !== input.manifestHash) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The hash the device stored does not match the package it was handed — the download is incomplete and is not acknowledged" });
      await d.update(communicationPackageDownloads).set({ acknowledgedAt: new Date() }).where(eq(communicationPackageDownloads.id, dl.id));
      return { downloadRef: dl.downloadRef, packageRef: dl.packageRef, acknowledged: true as const };
    }),

  /**
   * What exists, whether it is still true, and who is carrying what. This is
   * "tomorrow's trip affected" as a query rather than a hope.
   */
  packageStatus: roleProcedure("comms.packageStatus")
    .input(z.object({ label: z.string().max(220).optional(), packageRef: z.string().max(64).optional(), at: z.coerce.date().default(() => new Date()) }))
    .query(async ({ input }) => {
      const d = await db();
      if (!input.packageRef && !input.label) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the package or the route it is for" });
      const p = input.packageRef
        ? (await d.select().from(communicationPackages).where(eq(communicationPackages.packageRef, input.packageRef)).limit(1))[0]
        : (await d.select().from(communicationPackages).where(and(eq(communicationPackages.label, input.label!), inArray(communicationPackages.status, ["current", "stale"]))).orderBy(desc(communicationPackages.version)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No communication package for that route" });

      const segmentIds = JSON.parse(p.segmentIdsJson) as string[];
      const inputs = await planInputs(d, segmentIds, p.unitId);
      const sealedContent = JSON.parse(p.contentJson) as { zones: { channelKey: string | null }[] };
      const sealedKeys = Array.from(new Set(sealedContent.zones.map(z => z.channelKey).filter((k): k is string => !!k)));
      const statusGeo = p.buildRef ? await resolveRouteCommunicationGeography(d, { buildRef: p.buildRef, segmentIds }) : null;
      const current = packageDependencies({ segmentIds, assignments: inputs.assignments, channels: inputs.channels, coverage: inputs.coverage, channelKeys: sealedKeys, geographyHash: statusGeo?.geographyHash ?? null });
      const s = packageStaleness(JSON.parse(p.dependencyJson) as PackageDependencies, current);
      if (s.stale && p.status === "current") await d.update(communicationPackages).set({ status: "stale", staleReasonsJson: JSON.stringify(s.reasons), stalenessDetectedAt: new Date() }).where(eq(communicationPackages.id, p.id));

      const downloads = await d.select().from(communicationPackageDownloads).where(eq(communicationPackageDownloads.packageRef, p.packageRef)).orderBy(desc(communicationPackageDownloads.id)).limit(200);
      const latestByUser = new Map<number, typeof downloads[number]>();
      for (const dl of downloads) if (!latestByUser.has(dl.userId)) latestByUser.set(dl.userId, dl);

      return {
        packageRef: p.packageRef, label: p.label, version: p.version, manifestHash: p.manifestHash,
        status: s.stale ? ("stale" as const) : (p.status as "current" | "superseded" | "stale"),
        stale: s.stale, changed: s.changed,
        reasons: s.stale ? s.reasons : ["Nothing this package was built from has changed"],
        verdict: p.verdict, totalKm: p.totalKm,
        counts: { zones: p.zoneCount, channels: p.channelCount, unverifiedChannels: p.unverifiedChannelCount, retiredExcluded: p.retiredExcludedCount, mustCall: p.mustCallCount, zonesWithoutChannel: p.zonesWithoutChannel },
        carriedBy: Array.from(latestByUser.values()).map(dl => ({
          userId: dl.userId, deviceRef: dl.deviceRef, downloadedAt: dl.downloadedAt,
          acknowledged: dl.acknowledgedAt != null,
          ...carriedState({ carriedManifestHash: dl.manifestHash, currentManifestHash: p.manifestHash, currentIsStale: s.stale }),
        })),
        builtAt: p.builtAt,
      };
    }),

  planGet: roleProcedure("comms.planGet")
    .input(z.object({ planRef: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const d = await db();
      const p = (await d.select().from(communicationPlans).where(eq(communicationPlans.planRef, input.planRef)).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such communication plan" });
      return {
        planRef: p.planRef, verdict: p.verdict, totalKm: p.totalKm, unknownChannelKm: p.unknownChannelKm,
        noCommunicationKm: p.noCommunicationKm, zones: JSON.parse(p.zonesJson), coverage: JSON.parse(p.coverageJson),
        ladder: JSON.parse(p.ladderJson), mustCall: JSON.parse(p.mustCallJson), explanation: p.explanation,
        fingerprintHash: p.fingerprintHash, computedAt: p.computedAt, buildRef: p.buildRef,
      };
    }),
});
