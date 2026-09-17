/**
 * P3.1 — the manifest as a chain of custody (0129/0130).
 *
 * Procedures: bind the parties to canonical records (snapshotting what they
 * were called at the time), record custody events in order (departure seals),
 * attach evidence through the registry with a named relationship, amend a
 * sealed manifest with a reason and a second person, close against the load
 * class's evidence profile, and read the whole chain back. Tenancy is checked
 * the way every other router checks it: through the acting scope and
 * recordBelongsToOrganization.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { router, roleProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { recordBelongsToOrganization } from "./_core/coreRecordOwnership";
import { evidenceRecords, facilities, manifestAmendments, manifestCustodyEvents, manifestEvidenceLinks, manifestEvidenceProfiles, manifestPartySnapshots, manifests, operators, units } from "../drizzle/schema";
import { CUSTODY_EVENT_TYPES, EVIDENCE_RELATIONSHIPS, TICKET_RELATIONSHIPS, amendmentAllowed, closeDecision, manifestHash, nextCustodyEvent, type EvidenceRelationship, type ManifestState } from "./_core/manifestCustody";

async function dbOrThrow() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
type Db = Awaited<ReturnType<typeof dbOrThrow>>;

/** The manifest, owned by the caller's organization or not found — never someone else's. */
async function ownedManifest(db: Db, userId: number, manifestNumber: string) {
  const orgRef = (await resolveActingScope(db, userId)).tenantId;
  const m = (await db.select().from(manifests).where(eq(manifests.manifestNumber, manifestNumber)).limit(1))[0];
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Manifest not found" });
  // A legacy manifest with no owner is claimed by the first organization to bind it; a manifest owned elsewhere is invisible.
  if (m.orgRef && m.orgRef !== orgRef) throw new TRPCError({ code: "NOT_FOUND", message: "Manifest not found" });
  return { m, orgRef };
}

const stateOf = (m: typeof manifests.$inferSelect): ManifestState => ({
  manifestNumber: m.manifestNumber, jobId: m.jobId, tripId: m.tripId, loadId: m.loadId, operatorId: m.operatorId, unitId: m.unitId, trailerUnitId: m.trailerUnitId,
  originFacilityId: m.originFacilityId, destinationFacilityId: m.destinationFacilityId, material: m.material, unNumber: m.unNumber, loadClass: m.loadClass,
  driver: m.driver, trailer: m.trailer, route: m.route, facility: m.facility,
});

async function chainOf(db: Db, manifestId: number) {
  return db.select().from(manifestCustodyEvents).where(eq(manifestCustodyEvents.manifestId, manifestId)).orderBy(asc(manifestCustodyEvents.sequence));
}

const PARTY = z.object({
  operatorId: z.number().int().positive().nullable().optional(),
  unitId: z.number().int().positive().nullable().optional(),
  trailerUnitId: z.number().int().positive().nullable().optional(),
  originFacilityId: z.number().int().positive().nullable().optional(),
  destinationFacilityId: z.number().int().positive().nullable().optional(),
  tripId: z.number().int().positive().nullable().optional(),
  loadId: z.number().int().positive().nullable().optional(),
  loadClass: z.string().min(1).max(64).nullable().optional(),
});

/** Resolve the canonical rows the caller named, refusing any another organization owns, and return the snapshots to write. */
async function resolveParties(db: Db, orgRef: string, p: z.infer<typeof PARTY>) {
  const snapshots: { role: typeof manifestPartySnapshots.$inferInsert["role"]; canonicalEntityId: number; capturedName: string; capturedIdentifier: string | null }[] = [];
  if (p.operatorId) {
    if (!(await recordBelongsToOrganization(db, orgRef, "operator", p.operatorId))) throw new TRPCError({ code: "FORBIDDEN", message: "Operator is not owned by this organization" });
    const o = (await db.select({ name: operators.name, licenceNumber: operators.licenseNumber }).from(operators).where(eq(operators.id, p.operatorId)).limit(1))[0];
    if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Operator not found" });
    snapshots.push({ role: "operator", canonicalEntityId: p.operatorId, capturedName: o.name, capturedIdentifier: o.licenceNumber ?? null });
  }
  for (const [key, role] of [["unitId", "unit"], ["trailerUnitId", "trailer"]] as const) {
    const id = p[key];
    if (!id) continue;
    if (!(await recordBelongsToOrganization(db, orgRef, "unit", id))) throw new TRPCError({ code: "FORBIDDEN", message: `${role === "unit" ? "Unit" : "Trailer"} is not owned by this organization` });
    const u = (await db.select({ unitNumber: units.unitNumber }).from(units).where(eq(units.id, id)).limit(1))[0];
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: `${role} not found` });
    snapshots.push({ role, canonicalEntityId: id, capturedName: u.unitNumber, capturedIdentifier: null });
  }
  for (const [key, role] of [["originFacilityId", "origin_facility"], ["destinationFacilityId", "destination_facility"]] as const) {
    const id = p[key];
    if (!id) continue;
    const f = (await db.select({ name: facilities.name }).from(facilities).where(eq(facilities.id, id)).limit(1))[0];
    if (!f) throw new TRPCError({ code: "NOT_FOUND", message: `${role.replace("_", " ")} not found` });
    snapshots.push({ role, canonicalEntityId: id, capturedName: f.name, capturedIdentifier: null });
  }
  if (p.loadId && !(await recordBelongsToOrganization(db, orgRef, "load", p.loadId))) throw new TRPCError({ code: "FORBIDDEN", message: "Load is not owned by this organization" });
  return snapshots;
}

export const manifestCustodyRouter = router({
  /** Bind canonical records to a draft manifest; snapshot what they are called today. Sealed manifests go through `amend`. */
  bind: roleProcedure("manifestCustody.bind")
    .input(z.object({ manifestNumber: z.string().min(1).max(80) }).merge(PARTY).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { m, orgRef } = await ownedManifest(db, ctx.user.id, input.manifestNumber);
      if (m.sealedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Manifest is sealed; changes to its parties require an amendment" });
      const { manifestNumber: _n, ...parties } = input;
      const snapshots = await resolveParties(db, orgRef, parties);
      const patch: Partial<typeof manifests.$inferInsert> = { orgRef };
      for (const k of ["operatorId", "unitId", "trailerUnitId", "originFacilityId", "destinationFacilityId", "tripId", "loadId", "loadClass"] as const) if (parties[k] !== undefined) (patch as Record<string, unknown>)[k] = parties[k];
      await db.transaction(async (tx) => {
        await tx.update(manifests).set(patch).where(eq(manifests.id, m.id));
        for (const s of snapshots) await tx.insert(manifestPartySnapshots).values({ manifestId: m.id, ...s, source: "bound_from_record" });
      });
      const after = (await db.select().from(manifests).where(eq(manifests.id, m.id)).limit(1))[0]!;
      return { manifestNumber: m.manifestNumber, snapshots: snapshots.map(s => ({ role: s.role, capturedName: s.capturedName })), hash: manifestHash(stateOf(after)) };
    }),

  /** Record the next custody event. Departure from origin seals the manifest. */
  custodyRecord: roleProcedure("manifestCustody.custodyRecord")
    .input(z.object({
      manifestNumber: z.string().min(1).max(80), eventType: z.enum(CUSTODY_EVENT_TYPES), occurredAt: z.coerce.date(),
      facilityId: z.number().int().positive().nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional(), notes: z.string().max(500).nullable().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { m } = await ownedManifest(db, ctx.user.id, input.manifestNumber);
      const chain = await chainOf(db, m.id);
      const decision = nextCustodyEvent(chain.map(e => ({ eventType: e.eventType, occurredAt: e.occurredAt })), { eventType: input.eventType, occurredAt: input.occurredAt, facilityId: input.facilityId ?? null });
      if (!decision.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${decision.code}: ${decision.message}` });
      if (input.eventType === "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Closure is recorded by `close`, which checks the evidence profile" });
      await db.transaction(async (tx) => {
        await tx.insert(manifestCustodyEvents).values({ manifestId: m.id, sequence: decision.sequence, eventType: input.eventType, actorUserId: ctx.user.id, facilityId: input.facilityId ?? null, occurredAt: input.occurredAt, evidenceRecordId: input.evidenceRecordId ?? null, notes: input.notes ?? null });
        if (decision.seals) await tx.update(manifests).set({ sealedAt: input.occurredAt, status: "sealed", currentHash: manifestHash(stateOf(m)) }).where(eq(manifests.id, m.id));
      });
      return { manifestNumber: m.manifestNumber, sequence: decision.sequence, sealed: decision.seals || !!m.sealedAt };
    }),

  /** Attach evidence through the registry. A physical ticket belongs to one manifest; a second link of it anywhere is refused and named. */
  evidenceAttach: roleProcedure("manifestCustody.evidenceAttach")
    .input(z.object({ manifestNumber: z.string().min(1).max(80), evidenceRecordId: z.number().int().positive(), relationship: z.enum(EVIDENCE_RELATIONSHIPS) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { m } = await ownedManifest(db, ctx.user.id, input.manifestNumber);
      if (m.closedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A closed manifest takes no more evidence; amend it through review" });
      const ev = (await db.select({ id: evidenceRecords.id }).from(evidenceRecords).where(eq(evidenceRecords.id, input.evidenceRecordId)).limit(1))[0];
      if (!ev) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence record not found" });
      if (TICKET_RELATIONSHIPS.includes(input.relationship)) {
        const elsewhere = (await db.select({ manifestId: manifestEvidenceLinks.manifestId }).from(manifestEvidenceLinks)
          .where(and(eq(manifestEvidenceLinks.evidenceRecordId, input.evidenceRecordId), eq(manifestEvidenceLinks.relationship, input.relationship))).limit(1))[0];
        if (elsewhere && elsewhere.manifestId !== m.id) {
          const other = (await db.select({ manifestNumber: manifests.manifestNumber }).from(manifests).where(eq(manifests.id, elsewhere.manifestId)).limit(1))[0];
          throw new TRPCError({ code: "CONFLICT", message: `DUPLICATE_TICKET: this ${input.relationship.replace("_", " ")} is already attached to manifest ${other?.manifestNumber ?? elsewhere.manifestId}` });
        }
        if (elsewhere) throw new TRPCError({ code: "CONFLICT", message: `DUPLICATE_TICKET: this ${input.relationship.replace("_", " ")} is already attached to this manifest` });
      }
      await db.insert(manifestEvidenceLinks).values({ manifestId: m.id, evidenceRecordId: input.evidenceRecordId, relationship: input.relationship, attachedByUserId: ctx.user.id });
      return { manifestNumber: m.manifestNumber, attached: input.relationship };
    }),

  /** Amend a sealed manifest: a reason, a second person, the hash of what it replaced, and the change applied in the same transaction. */
  amend: roleProcedure("manifestCustody.amend")
    .input(z.object({
      manifestNumber: z.string().min(1).max(80),
      reasonCode: z.enum(["party_correction", "quantity_correction", "facility_change", "evidence_added", "other"]),
      reasonText: z.string().max(500), requestedByUserId: z.number().int().positive(),
      changes: PARTY.extend({ material: z.string().max(220).nullable().optional(), unNumber: z.string().max(40).nullable().optional() }),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { m, orgRef } = await ownedManifest(db, ctx.user.id, input.manifestNumber);
      const changedKeys = Object.entries(input.changes).filter(([k, v]) => v !== undefined && (m as Record<string, unknown>)[k] !== v).map(([k]) => k);
      const allowed = amendmentAllowed({ sealedAt: m.sealedAt, closedAt: m.closedAt, reasonText: input.reasonText, requestedByUserId: input.requestedByUserId, approvedByUserId: ctx.user.id, changedKeys });
      if (!allowed.ok) throw new TRPCError({ code: allowed.code === "AMENDMENT_SAME_PERSON" ? "FORBIDDEN" : "PRECONDITION_FAILED", message: `${allowed.code}: ${allowed.message}` });
      const { material, unNumber, ...parties } = input.changes;
      const snapshots = await resolveParties(db, orgRef, parties);
      const previousHash = manifestHash(stateOf(m));
      const patch: Record<string, unknown> = {};
      for (const k of changedKeys) patch[k] = (input.changes as Record<string, unknown>)[k];
      const replacement = stateOf({ ...m, ...patch } as typeof m);
      const replacementHash = manifestHash(replacement);
      const amendmentNo = m.amendmentCount + 1;
      await db.transaction(async (tx) => {
        await tx.insert(manifestAmendments).values({ manifestId: m.id, amendmentNo, reasonCode: input.reasonCode, reasonText: input.reasonText, requestedByUserId: input.requestedByUserId, approvedByUserId: ctx.user.id, previousHash, replacementHash, changesJson: JSON.stringify(changedKeys.map(k => ({ key: k, from: (m as Record<string, unknown>)[k] ?? null, to: patch[k] ?? null }))) });
        // amendmentCount moves in the same statement as the change: that is what the 0130 guard checks.
        await tx.update(manifests).set({ ...patch, amendmentCount: amendmentNo, currentHash: replacementHash }).where(eq(manifests.id, m.id));
        for (const s of snapshots) await tx.insert(manifestPartySnapshots).values({ manifestId: m.id, ...s, source: "amendment" });
      });
      return { manifestNumber: m.manifestNumber, amendmentNo, previousHash, replacementHash, changed: changedKeys };
    }),

  /** Close against the load class's evidence profile. REVIEW when nobody has decided what closing requires; BLOCKED naming what is missing. */
  close: roleProcedure("manifestCustody.close")
    .input(z.object({ manifestNumber: z.string().min(1).max(80), occurredAt: z.coerce.date() }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { m, orgRef } = await ownedManifest(db, ctx.user.id, input.manifestNumber);
      if (m.closedAt) return { verdict: "PASS" as const, alreadyClosed: true, closedAt: m.closedAt };
      const chain = await chainOf(db, m.id);
      const attached = (await db.select({ relationship: manifestEvidenceLinks.relationship }).from(manifestEvidenceLinks).where(eq(manifestEvidenceLinks.manifestId, m.id))).map(r => r.relationship as EvidenceRelationship);
      const profileRow = m.loadClass ? (await db.select().from(manifestEvidenceProfiles).where(and(eq(manifestEvidenceProfiles.orgRef, orgRef), eq(manifestEvidenceProfiles.loadClass, m.loadClass))).limit(1))[0] : undefined;
      const profile = profileRow ? { required: JSON.parse(profileRow.requiredRelationshipsJson) as EvidenceRelationship[], approvedAt: profileRow.approvedAt } : null;
      const decision = closeDecision({ profile, attached, chain: chain.map(e => ({ eventType: e.eventType })) });
      if (decision.verdict !== "PASS") return { ...decision, alreadyClosed: false };
      const seq = chain.length + 1;
      await db.transaction(async (tx) => {
        await tx.insert(manifestCustodyEvents).values({ manifestId: m.id, sequence: seq, eventType: "closed", actorUserId: ctx.user.id, occurredAt: input.occurredAt });
        await tx.update(manifests).set({ closedAt: input.occurredAt, status: "complete" }).where(eq(manifests.id, m.id));
      });
      return { verdict: "PASS" as const, alreadyClosed: false, closedAt: input.occurredAt, required: decision.required };
    }),

  /** What closing requires for a load class, as configuration; approved by a second person. */
  evidenceProfileSet: roleProcedure("manifestCustody.evidenceProfileSet")
    .input(z.object({ loadClass: z.string().min(1).max(64), required: z.array(z.enum(EVIDENCE_RELATIONSHIPS)).min(1).max(8) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      await db.insert(manifestEvidenceProfiles).values({ orgRef, loadClass: input.loadClass, requiredRelationshipsJson: JSON.stringify(input.required), createdByUserId: ctx.user.id })
        .onDuplicateKeyUpdate({ set: { requiredRelationshipsJson: JSON.stringify(input.required), createdByUserId: ctx.user.id, approvedByUserId: null, approvedAt: null } });
      return { loadClass: input.loadClass, required: input.required, approved: false };
    }),
  evidenceProfileApprove: roleProcedure("manifestCustody.evidenceProfileApprove")
    .input(z.object({ loadClass: z.string().min(1).max(64) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const p = (await db.select().from(manifestEvidenceProfiles).where(and(eq(manifestEvidenceProfiles.orgRef, orgRef), eq(manifestEvidenceProfiles.loadClass, input.loadClass))).limit(1))[0];
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No evidence profile for this load class" });
      if (p.createdByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who wrote the evidence profile does not approve it — a second person does" });
      await db.update(manifestEvidenceProfiles).set({ approvedByUserId: ctx.user.id, approvedAt: new Date() }).where(eq(manifestEvidenceProfiles.id, p.id));
      return { loadClass: input.loadClass, approved: true };
    }),

  /** The whole chain: manifest, party snapshots, custody events, evidence links, amendments. */
  chain: roleProcedure("manifestCustody.chain")
    .input(z.object({ manifestNumber: z.string().min(1).max(80) }).strict())
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { m } = await ownedManifest(db, ctx.user.id, input.manifestNumber);
      const [snapshots, events, links, amendments] = await Promise.all([
        db.select().from(manifestPartySnapshots).where(eq(manifestPartySnapshots.manifestId, m.id)).orderBy(asc(manifestPartySnapshots.id)),
        chainOf(db, m.id),
        db.select().from(manifestEvidenceLinks).where(eq(manifestEvidenceLinks.manifestId, m.id)),
        db.select().from(manifestAmendments).where(eq(manifestAmendments.manifestId, m.id)).orderBy(asc(manifestAmendments.amendmentNo)),
      ]);
      return { manifest: m, currentHash: manifestHash(stateOf(m)), snapshots, events, links, amendments };
    }),
});
