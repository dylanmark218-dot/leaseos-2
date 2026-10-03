/**
 * Records service.
 *
 * Everything authorization depends on is loaded here, from the database. The
 * request supplies identifiers; it never supplies the facts used to decide
 * whether it is allowed. A client that can name the owner of the record it is
 * asking about can name itself.
 */

import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import type { Permission } from "./_core/recordsAuthorization";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { getDb, jobScopeSubquery, type TenantScope } from "./db";
import { placeHold, releaseHold } from "./fleetPortfolioService";
import { defectEvent } from "./defectLifecycleService";
import type { DbOrTx } from "./_core/dbTypes";
import {
  evidenceAccessEvents,
  evidenceRecords,
  evidenceRelationships,
  evidenceSeals,
  evidenceVersions,
  incidentReports,
  legalHoldRecords,
  legalHolds,
  maintenanceDefects,
  nearMissReports,
  operators,
  organizationMemberships,
  recordRetentionState,
  syncPackageItems,
  syncPackages,
  unitHolds,
  workOrderReleases,
  workOrders,
  attestArtifacts,
  attestDocumentRevisions,
  attestMarks,
} from "../drizzle/schema";
import { ALL_FOLDERED_TYPES, READ_CATEGORY_BY_RECORD_TYPE, TYPE_FOLDER_TYPES, integrityState, signedSubjectCategory, type FolderKey, type IntegrityState, type SigningLink } from "./recordFiles";

export type OperatorIdentity = {
  operatorId: number | null;
  employeeNumber: string | null;
};

/** The caller's operator identity, derived from the session user. */
export async function resolveOperatorForUser(
  userId: number
): Promise<OperatorIdentity> {
  const db = await getDb();
  if (!db) return { operatorId: null, employeeNumber: null };
  const rows = await db
    .select({ id: operators.id })
    .from(operators)
    .where(eq(operators.userId, userId))
    .limit(1);
  return { operatorId: rows[0]?.id ?? null, employeeNumber: null };
}

export type EvidenceSubject = {
  id: number;
  trackingNumber: string | null;
  sealState: "draft" | "sealed" | "amended" | "superseded";
  currentVersion: number;
  legalHold: boolean;
  recordType: string;
  capturedBy: number | null;
  /** Derived from relationships, not from the request. */
  ownerOperatorId: number | null;
};

/**
 * Load an evidence record together with the ownership fact used to authorize
 * access to it. Ownership comes from the `operator` relationship row, which the
 * seal covers — a client cannot assert it.
 */
export async function loadEvidenceSubject(
  evidenceId: number
): Promise<EvidenceSubject | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(evidenceRecords)
    .where(eq(evidenceRecords.id, evidenceId))
    .limit(1);
  const rec = rows[0];
  if (!rec) return null;

  const rels = await db
    .select({
      entityType: evidenceRelationships.entityType,
      entityId: evidenceRelationships.entityId,
    })
    .from(evidenceRelationships)
    .where(eq(evidenceRelationships.evidenceRecordId, evidenceId));

  const ownerRel = rels.find(r => r.entityType === "operator");

  return {
    id: rec.id,
    trackingNumber: rec.trackingNumber ?? null,
    sealState: rec.sealState,
    currentVersion: rec.currentVersion,
    legalHold: rec.legalHold,
    recordType: rec.recordType,
    capturedBy: rec.capturedBy ?? null,
    ownerOperatorId: ownerRel?.entityId ?? null,
  };
}

/**
 * The hashes actually stored for the record's current version.
 *
 * The send package declares what the office should independently reproduce, so
 * the declaration has to come from the seal rows. Placeholders would make the
 * receipt check compare a constant against itself and pass regardless.
 */
export async function loadCurrentSealHashes(
  evidenceId: number,
  version: number
): Promise<{ contentHash: string; manifestHash: string } | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({
      contentHash: evidenceSeals.contentHash,
      manifestHash: evidenceSeals.manifestHash,
    })
    .from(evidenceSeals)
    .where(
      and(
        eq(evidenceSeals.evidenceRecordId, evidenceId),
        eq(evidenceSeals.version, version)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listEvidenceForOperator(operatorId: number) {
  const db = await getDb();
  if (!db) return [];
  const rels = await db
    .select({ recordId: evidenceRelationships.evidenceRecordId })
    .from(evidenceRelationships)
    .where(
      and(
        eq(evidenceRelationships.entityType, "operator"),
        eq(evidenceRelationships.entityId, operatorId)
      )
    );
  if (rels.length === 0) return [];

  const ids = new Set(rels.map(r => r.recordId));
  const all = await db
    .select()
    .from(evidenceRecords)
    .orderBy(desc(evidenceRecords.capturedAt))
    .limit(500);
  return all.filter(r => ids.has(r.id));
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function persistSeal(args: {
  evidenceId: number;
  /** The normalized record type, written on the first seal only; an amendment keeps the record's type. */
  recordType?: string;
  version: number;
  contentHash: string;
  manifestHash: string;
  canonicalManifest: string;
  sealedAt: Date;
  sealedByUserId: number;
  sealedByEmployeeNumber?: string | null;
  deviceId?: string | null;
  devicePlatform?: string | null;
  storageKey?: string | null;
  mimeType?: string | null;
  amendmentReason?: string | null;
  supersedesVersion?: number | null;
  deviceRetainUntil: Date | null;
  officeRetainUntil: Date | null;
  effectiveRetentionMonths: number | null;
  retentionBasis: string;
}) {
  const db = await getDb();
  if (!db) return undefined;

  await db.insert(evidenceVersions).values({
    evidenceRecordId: args.evidenceId,
    version: args.version,
    supersedesVersion: args.supersedesVersion ?? null,
    storageKey: args.storageKey ?? null,
    mimeType: args.mimeType ?? null,
    contentHash: args.contentHash,
    manifestHash: args.manifestHash,
    amendmentReason: args.amendmentReason ?? null,
    amendedByUserId: args.version > 1 ? args.sealedByUserId : null,
  });

  await db.insert(evidenceSeals).values({
    evidenceRecordId: args.evidenceId,
    version: args.version,
    canonicalManifest: args.canonicalManifest,
    contentHash: args.contentHash,
    manifestHash: args.manifestHash,
    sealedAt: args.sealedAt,
    sealedByUserId: args.sealedByUserId,
    sealedByEmployeeNumber: args.sealedByEmployeeNumber ?? null,
    deviceId: args.deviceId ?? null,
    devicePlatform: args.devicePlatform ?? null,
  });

  await db
    .update(evidenceRecords)
    .set({
      sealState: args.version > 1 ? "amended" : "sealed",
      currentVersion: args.version,
      ...(args.recordType ? { recordType: args.recordType } : {}),
    })
    .where(eq(evidenceRecords.id, args.evidenceId));

  // Retention is computed at seal time so both clocks start from the sealed
  // moment rather than from whenever the office happens to look at it.
  const existing = await db
    .select({ id: recordRetentionState.id })
    .from(recordRetentionState)
    .where(eq(recordRetentionState.evidenceRecordId, args.evidenceId))
    .limit(1);

  const values = {
    evidenceRecordId: args.evidenceId,
    effectiveRetentionMonths: args.effectiveRetentionMonths,
    retentionBasis: args.retentionBasis,
    officeRetainUntil: args.officeRetainUntil,
    deviceRetainUntil: args.deviceRetainUntil,
  };
  if (existing[0]) {
    await db
      .update(recordRetentionState)
      .set(values)
      .where(eq(recordRetentionState.id, existing[0].id));
  } else {
    await db.insert(recordRetentionState).values(values);
  }

  return args.version;
}

export async function addEvidenceRelationships(
  evidenceId: number,
  rels: Array<{
    entityType: string;
    entityId?: number | null;
    entityRef?: string | null;
    role?: string | null;
  }>
) {
  const db = await getDb();
  if (!db || rels.length === 0) return;
  await db.insert(evidenceRelationships).values(
    rels.map(r => ({
      evidenceRecordId: evidenceId,
      entityType: r.entityType as never,
      entityId: r.entityId ?? null,
      entityRef: r.entityRef ?? null,
      role: r.role ?? null,
    }))
  );
}

export async function loadRetentionState(evidenceId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(recordRetentionState)
    .where(eq(recordRetentionState.evidenceRecordId, evidenceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The office has the record, and it is the record that was sealed. Called from
 * `sync.receivePackage` only for an item the server verified from the bytes it
 * stored — never on the device's word, and never for a mismatch, which stays
 * in syncReceipts/syncPackageItems as the audit of what arrived.
 *
 * Received and integrity-verified are separate columns because they are
 * separate facts; this path sets both, at the moment verification succeeds.
 * Neither is acceptance: that is a person's decision (`recordOfficeAcceptance`).
 *
 * First write wins. A device that re-sends after a lost acknowledgement does
 * not move the dates. One statement, so two receipts racing for the same
 * record cannot both insert. Seal-time retention (`persistSeal`) writes only
 * the retention fields, so receipt before or after the seal leaves both intact.
 */
export async function recordOfficeReceipt(args: { evidenceId: number; at: Date }) {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(recordRetentionState)
    .values({ evidenceRecordId: args.evidenceId, officeReceivedAt: args.at, officeIntegrityVerifiedAt: args.at })
    .onDuplicateKeyUpdate({
      set: {
        officeReceivedAt: sql`COALESCE(${recordRetentionState.officeReceivedAt}, ${args.at})`,
        officeIntegrityVerifiedAt: sql`COALESCE(${recordRetentionState.officeIntegrityVerifiedAt}, ${args.at})`,
      },
    });
}

/**
 * The office accepted the record — a business decision, made by a person
 * holding `evidence.verify`, through the existing verification act. Recorded in
 * B20's `officeReviewedAt` / `officeReviewedByUserId`, which existed for this
 * and which nothing wrote.
 *
 * Acceptance does not imply receipt or integrity, and does not stand in for
 * them: device release requires all three, so accepting a record whose bytes
 * never verified releases nothing. First acceptance wins.
 */
export async function recordOfficeAcceptance(args: { evidenceId: number; userId: number; at: Date }) {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(recordRetentionState)
    .values({ evidenceRecordId: args.evidenceId, officeReviewedAt: args.at, officeReviewedByUserId: args.userId })
    .onDuplicateKeyUpdate({
      set: {
        officeReviewedAt: sql`COALESCE(${recordRetentionState.officeReviewedAt}, ${args.at})`,
        officeReviewedByUserId: sql`COALESCE(${recordRetentionState.officeReviewedByUserId}, ${args.userId})`,
      },
    });
}

export async function markDeviceCopyDeleted(args: {
  evidenceId: number;
  userId: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(recordRetentionState)
    .set({
      deviceCopyDeletedAt: new Date(),
      deviceCopyDeletedByUserId: args.userId,
    })
    .where(eq(recordRetentionState.evidenceRecordId, args.evidenceId));
}

export async function hasActiveLegalHold(evidenceId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: legalHoldRecords.id })
    .from(legalHoldRecords)
    .innerJoin(legalHolds, eq(legalHolds.id, legalHoldRecords.legalHoldId))
    .where(
      and(
        eq(legalHoldRecords.evidenceRecordId, evidenceId),
        eq(legalHolds.status, "active")
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Idempotent package creation. An offline client retries; retrying must not
 * create a second package for the same attempt.
 */
export async function createSyncPackage(args: {
  packageRef: string;
  deviceId: string;
  operatorId: number | null;
  items: Array<{
    evidenceRecordId: number;
    declaredContentHash: string;
    declaredManifestHash: string;
  }>;
  queuedAt: Date;
}) {
  const db = await getDb();
  if (!db) return { created: false, packageRef: args.packageRef, itemCount: 0 };

  const existing = await db
    .select({ id: syncPackages.id, itemCount: syncPackages.itemCount })
    .from(syncPackages)
    .where(eq(syncPackages.packageRef, args.packageRef))
    .limit(1);
  if (existing[0]) {
    return {
      created: false,
      packageRef: args.packageRef,
      itemCount: existing[0].itemCount,
    };
  }

  const inserted = await db.insert(syncPackages).values({
    packageRef: args.packageRef,
    deviceId: args.deviceId,
    operatorId: args.operatorId,
    state: "queued",
    itemCount: args.items.length,
    queuedAt: args.queuedAt,
  });
  const packageId = inserted[0]?.insertId;

  if (packageId && args.items.length > 0) {
    await db.insert(syncPackageItems).values(
      args.items.map(i => ({
        syncPackageId: Number(packageId),
        evidenceRecordId: i.evidenceRecordId,
        declaredContentHash: i.declaredContentHash,
        declaredManifestHash: i.declaredManifestHash,
      }))
    );
  }

  return {
    created: true,
    packageRef: args.packageRef,
    itemCount: args.items.length,
  };
}

export async function recordEvidenceAccess(args: {
  evidenceRecordId: number;
  actorUserId: number;
  actorRole: string;
  action: "viewed" | "downloaded" | "exported" | "shared" | "printed" | "seal_verified";
  context?: string | null;
  scope?: string | null;
}) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(evidenceAccessEvents).values({
      evidenceRecordId: args.evidenceRecordId,
      actorUserId: args.actorUserId,
      actorRole: args.actorRole,
      action: args.action,
      context: args.context ?? null,
      scope: args.scope ?? null,
      occurredAt: new Date(),
    });
  } catch {
    // Access logging is best effort; the authorization decision row is the
    // record that must exist, and it is written separately.
  }
}

/* ------------------------------------------------------------------ */
/* Safety                                                              */
/* ------------------------------------------------------------------ */

export async function insertIncident(values: typeof incidentReports.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(incidentReports).values(values);
  return r[0]?.insertId;
}

export async function loadIncident(incidentNumber: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(incidentReports)
    .where(eq(incidentReports.incidentNumber, incidentNumber))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * CP1.5 — the role a hold records when an incident's escalation plan places it. The capturer is the
 * person who placed it (and so may never release it); the authority is the plan, not their role.
 */
export const INCIDENT_HOLD_ROLE = "incident_escalation";

/**
 * CP1.5 — an incident and, when its escalation plan holds the unit, that hold: one transaction, so
 * there is never an incident that says the unit is held with no hold, or a hold with no incident.
 *
 * The hold is the portfolio's own `unitHolds` row — there is no second incident-hold representation.
 * Type `safety`, so it is out of service and never overridable at dispatch (the portfolio design's
 * `incident_unit_held`, NEVER_OVERRIDABLE); source `incident`, so `fleet.holdRelease` refuses it and
 * only this incident's safety review lifts it. `incidentReports.unitHeld` remains the incident's own
 * record of what its plan decided; readiness reads the hold, never the flag.
 *
 * The caller has already proved the unit and the job are its organization's (`records.incident.capture`,
 * `records.nearMiss.report`); `orgRef` is that organization, so the hold and the incident agree.
 */
export async function insertIncidentHoldingUnit(values: typeof incidentReports.$inferInsert, placer: { orgRef: string | null; byUserId: number }): Promise<{ id: number; holdRef: string | null } | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return db.transaction(async tx => {
    const r = await tx.insert(incidentReports).values(values);
    const id = Number(r[0]?.insertId ?? 0);
    if (!values.unitHeld || values.unitId == null) return { id, holdRef: null };
    const holdRef = await placeHold(tx as unknown as DbOrTx, {
      unitId: values.unitId, orgRef: placer.orgRef, holdType: "safety", effect: "out_of_service",
      reason: `Incident ${values.incidentNumber} (${String(values.incidentType).replace(/_/g, " ")}): unit held pending safety review`,
      sourceKind: "incident", sourceRef: values.incidentNumber, byUserId: placer.byUserId, byRole: INCIDENT_HOLD_ROLE,
    });
    return { id, holdRef };
  });
}

/** The holds this incident placed that still stand. */
export async function activeIncidentHolds(incidentNumber: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(unitHolds).where(and(eq(unitHolds.sourceKind, "incident"), eq(unitHolds.sourceRef, incidentNumber), eq(unitHolds.status, "active")));
}

/**
 * The safety review, and — in the same transaction — the release of the holds the incident placed
 * (design B.4: an incident's hold is lifted when its safety review is recorded). The router has
 * already decided the reviewer may release them; the release is conditional on `status = 'active'`,
 * so a concurrent review releases each hold once.
 */
export async function markIncidentReviewed(args: {
  incidentNumber: string;
  userId: number;
  /** The holds to release, and the role the reviewer releases them in. Empty when there are none. */
  releasing?: { holds: (typeof unitHolds.$inferSelect)[]; byRole: string };
}): Promise<{ releasedHoldRefs: string[] }> {
  const db = await getDb();
  if (!db) return { releasedHoldRefs: [] };
  return db.transaction(async tx => {
    await tx
      .update(incidentReports)
      .set({
        safetyReviewedAt: new Date(),
        safetyReviewedByUserId: args.userId,
        status: "under_review",
        escalationState: "under_review",
      })
      .where(eq(incidentReports.incidentNumber, args.incidentNumber));
    const releasedHoldRefs: string[] = [];
    for (const hold of args.releasing?.holds ?? []) {
      const ok = await releaseHold(tx as unknown as DbOrTx, { hold, byUserId: args.userId, byRole: args.releasing!.byRole, reason: `Safety review of incident ${args.incidentNumber}` });
      if (ok) releasedHoldRefs.push(hold.holdRef);
    }
    return { releasedHoldRefs };
  });
}

export async function insertNearMiss(values: typeof nearMissReports.$inferInsert) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.insert(nearMissReports).values(values);
  return r[0]?.insertId;
}

export async function linkNearMissToIncident(args: {
  nearMissNumber: string;
  incidentId: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(nearMissReports)
    .set({
      escalatedToIncidentId: args.incidentId,
      escalatedAt: new Date(),
      status: "escalated",
    })
    .where(eq(nearMissReports.nearMissNumber, args.nearMissNumber));
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

export type WorkOrderSubject = {
  id: number;
  workOrderNumber: string;
  unitId: number;
  status:
    | "draft" | "open" | "in_progress" | "waiting_parts"
    | "ready_for_service" | "closed" | "cancelled";
  defectSeverity: "advisory" | "inspection_required" | "critical";
};

/**
 * Work order plus the defect severity that decides how much evidence a release
 * needs. Severity is read from the defect, never accepted from the caller —
 * otherwise a critical release could be downgraded to advisory in the request.
 */
export async function loadWorkOrderSubject(
  workOrderId: number
): Promise<WorkOrderSubject | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(workOrders)
    .where(eq(workOrders.id, workOrderId))
    .limit(1);
  const wo = rows[0];
  if (!wo) return null;

  let severity: WorkOrderSubject["defectSeverity"] = "advisory";
  if (wo.defectId) {
    const d = await db
      .select({ severity: maintenanceDefects.severity })
      .from(maintenanceDefects)
      .where(eq(maintenanceDefects.id, wo.defectId))
      .limit(1);
    if (d[0]) severity = d[0].severity;
  }

  return {
    id: wo.id,
    workOrderNumber: wo.workOrderNumber,
    unitId: wo.unitId,
    status: wo.status,
    defectSeverity: severity,
  };
}

export async function appendWorkOrderRelease(
  values: typeof workOrderReleases.$inferInsert
) {
  const db = await getDb();
  if (!db) return undefined;
  // Append only. A prior release is never mutated or deleted — the history of
  // what was signed, and by whom, is the point.
  const r = await db.insert(workOrderReleases).values(values);
  return r[0]?.insertId;
}

/* ------------------------------------------------------------------ */
/* Defect resolution                                                   */
/* ------------------------------------------------------------------ */

export type DefectForResolution = {
  id: number;
  unitId: number;
  severity: "advisory" | "inspection_required" | "critical";
  status: "open" | "in_progress" | "resolved";
  title: string;
};

export async function loadDefect(defectId: number): Promise<DefectForResolution | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ id: maintenanceDefects.id, unitId: maintenanceDefects.unitId, severity: maintenanceDefects.severity, status: maintenanceDefects.status, title: maintenanceDefects.title })
    .from(maintenanceDefects)
    .where(eq(maintenanceDefects.id, defectId))
    .limit(1);
  return rows[0] ?? null;
}

/** One release row, for validating the evidence a resolution cites. */
export async function loadRelease(releaseId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(workOrderReleases).where(eq(workOrderReleases.id, releaseId)).limit(1);
  return rows[0] ?? null;
}

/** Every release recorded against a unit, newest first. */
export async function releasesForUnit(unitId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(workOrderReleases).where(eq(workOrderReleases.unitId, unitId)).orderBy(desc(workOrderReleases.releasedAt));
}

/**
 * Move one named defect to `resolved`.
 *
 * Scoped to a single id on purpose. The failure this replaces cleared every critical defect on a
 * unit at once, from a release that named none of them, so "resolve this defect" is the whole
 * operation and there is deliberately no bulk form of it.
 *
 * The `status <> 'resolved'` predicate makes the transition idempotent at the database rather than
 * in a read-then-write race: two callers resolving at once produce one change and one refusal.
 */
export async function resolveMaintenanceDefect(args: {
  defectId: number;
  resolvedByUserId: number;
  resolvedByReleaseId: number | null;
  note: string;
  at: Date;
  /** 0221 — who resolved it, and the role they acted in, for the defect's history. */
  actorRole?: string;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  // 0221 — the resolution and its `resolved` event, together.
  return db.transaction(async tx => {
    const before = (await tx.select({ unitId: maintenanceDefects.unitId, status: maintenanceDefects.status }).from(maintenanceDefects).where(eq(maintenanceDefects.id, args.defectId)).limit(1))[0];
    const r = await tx
      .update(maintenanceDefects)
      .set({
        status: "resolved",
        resolvedAt: args.at,
        resolvedByUserId: args.resolvedByUserId,
        resolvedByReleaseId: args.resolvedByReleaseId,
        resolutionNote: args.note.slice(0, 400),
      })
      .where(and(eq(maintenanceDefects.id, args.defectId), ne(maintenanceDefects.status, "resolved")));
    const changed = (r[0]?.affectedRows ?? 0) > 0;
    if (changed && before) {
      await defectEvent(tx as unknown as DbOrTx, {
        defectId: args.defectId, unitId: before.unitId, eventType: "resolved", fromValue: before.status, toValue: "resolved",
        releaseId: args.resolvedByReleaseId, reason: args.note, actor: { userId: args.resolvedByUserId, role: args.actorRole ?? "unknown" }, at: args.at,
      });
    }
    return changed;
  });
}

export async function latestRelease(unitId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(workOrderReleases)
    .where(eq(workOrderReleases.unitId, unitId))
    .orderBy(desc(workOrderReleases.releasedAt))
    .limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Legal hold                                                          */
/* ------------------------------------------------------------------ */

export async function placeLegalHold(args: {
  holdNumber: string;
  reason: string;
  matterRef?: string | null;
  incidentNumber?: string | null;
  placedByUserId: number;
  placedByRole: string;
  evidenceRecordIds: number[];
}) {
  const db = await getDb();
  if (!db) return undefined;
  const now = new Date();
  const inserted = await db.insert(legalHolds).values({
    holdNumber: args.holdNumber,
    reason: args.reason,
    matterRef: args.matterRef ?? null,
    incidentNumber: args.incidentNumber ?? null,
    placedByUserId: args.placedByUserId,
    placedByRole: args.placedByRole,
    placedAt: now,
  });
  const holdId = Number(inserted[0]?.insertId);

  if (holdId && args.evidenceRecordIds.length > 0) {
    await db.insert(legalHoldRecords).values(
      args.evidenceRecordIds.map(id => ({
        legalHoldId: holdId,
        evidenceRecordId: id,
        addedByUserId: args.placedByUserId,
      }))
    );
    for (const id of args.evidenceRecordIds) {
      await db
        .update(evidenceRecords)
        .set({ legalHold: true })
        .where(eq(evidenceRecords.id, id));
    }
  }
  return holdId;
}

export async function releaseLegalHold(args: {
  holdNumber: string;
  releasedByUserId: number;
  releasedByRole: string;
  reason: string;
  authority: string;
}) {
  const db = await getDb();
  if (!db) return { ok: false as const, reason: "No database" };

  const rows = await db
    .select()
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.holdNumber, args.holdNumber),
        eq(legalHolds.status, "active")
      )
    )
    .limit(1);
  const hold = rows[0];
  if (!hold) return { ok: false as const, reason: "No active hold with that number" };

  await db
    .update(legalHolds)
    .set({
      status: "released",
      releasedAt: new Date(),
      releasedByUserId: args.releasedByUserId,
      releasedByRole: args.releasedByRole,
      releaseReason: args.reason,
      releaseAuthority: args.authority,
    })
    .where(eq(legalHolds.id, hold.id));

  // The records are not deleted. Retention eligibility simply resumes.
  const held = await db
    .select({ evidenceRecordId: legalHoldRecords.evidenceRecordId })
    .from(legalHoldRecords)
    .where(eq(legalHoldRecords.legalHoldId, hold.id));

  for (const h of held) {
    const stillHeld = await hasActiveLegalHold(h.evidenceRecordId);
    if (!stillHeld) {
      await db
        .update(evidenceRecords)
        .set({ legalHold: false })
        .where(eq(evidenceRecords.id, h.evidenceRecordId));
    }
  }

  return { ok: true as const, releasedRecords: held.length };
}

/* ------------------------------------------------------------------ */
/* Roadside                                                            */
/* ------------------------------------------------------------------ */

export async function loadRoadsideCandidates(operatorId: number) {
  const db = await getDb();
  if (!db) return [];
  const rels = await db
    .select({ recordId: evidenceRelationships.evidenceRecordId })
    .from(evidenceRelationships)
    .where(
      and(
        eq(evidenceRelationships.entityType, "operator"),
        eq(evidenceRelationships.entityId, operatorId)
      )
    );
  const ids = new Set(rels.map(r => r.recordId));
  if (ids.size === 0) return [];

  const full = await db
    .select({
      id: evidenceRecords.id,
      trackingNumber: evidenceRecords.trackingNumber,
      category: evidenceRecords.category,
      recordType: evidenceRecords.recordType,
      capturedAt: evidenceRecords.capturedAt,
    })
    .from(evidenceRecords)
    .orderBy(desc(evidenceRecords.capturedAt))
    .limit(500);

  return full.filter(r => ids.has(r.id));
}

/* ------------------------------------------------------------------ */
/* Records & File Manager                                              */
/* ------------------------------------------------------------------ */

/**
 * The tenant half of `evidenceInScope`, as one query rather than a loop: a
 * record is in scope through its job; failing a job, through the user who
 * captured it; failing both, only in the historical single tenant.
 *
 * Category and ownership are decided afterwards, per record, by the router —
 * this narrows to what the caller's organization holds and nothing more.
 */
function fileScopeWhere(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, scope: TenantScope) {
  const activeMembers = (orgRef?: string) =>
    db.select({ userId: organizationMemberships.userId }).from(organizationMemberships).where(
      orgRef
        ? and(eq(organizationMemberships.orgRef, orgRef), eq(organizationMemberships.status, "active"))
        : eq(organizationMemberships.status, "active")
    );
  const byJob = inArray(evidenceRecords.jobId, jobScopeSubquery(db, scope));
  if (scope.tenantId === SINGLE_TENANT_ID) {
    return or(
      byJob,
      and(
        isNull(evidenceRecords.jobId),
        or(isNull(evidenceRecords.capturedBy), notInArray(evidenceRecords.capturedBy, activeMembers()))
      )
    );
  }
  return or(
    byJob,
    and(isNull(evidenceRecords.jobId), inArray(evidenceRecords.capturedBy, activeMembers(scope.tenantId)))
  );
}

export type FileCandidate = {
  id: number;
  jobId: number | null;
  title: string;
  category: string;
  recordType: string;
  trackingNumber: string | null;
  mimeType: string | null;
  hasContent: boolean;
  capturedAt: Date;
  /** Server receipt time: the File Manager's order (with id), and the cursor's position. */
  createdAt: Date;
  capturedBy: number | null;
  status: "needs_review" | "verified" | "unverified";
  sealState: "draft" | "sealed" | "amended" | "superseded";
  currentVersion: number;
  legalHold: boolean;
  notes: string | null;
  relationships: Array<{ entityType: string; entityId: number | null; entityRef: string | null; role: string | null }>;
  syncState: "pending" | "received" | "verified" | "mismatch" | null;
  sealVerification: "pending" | "verified" | "hash_mismatch" | "manifest_mismatch" | "content_unavailable" | null;
  officeReviewedAt: Date | null;
  deviceCopyDeletedAt: Date | null;
  officeRetainUntil: Date | null;
};

/** Who is asking, as the File Manager needs it: decided by the router from the session, never the request. */
export type FileReach = {
  userId: number;
  operatorId: number | null;
  /** The evidence permissions authorize() allowed this caller, in the acting organization. */
  held: ReadonlySet<Permission>;
};

export type FileQueryFilters = {
  folder: FolderKey;
  /** Whitespace-separated terms, every one of which must match somewhere. */
  terms: readonly string[];
  /** An effective record type (signing linkage first, then the type column). */
  recordType: string | null;
  /** Lifecycle is decided by the projection over three tables; the query only narrows drafts from the rest. */
  lifecycle: string | null;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const TRUE = sql`1 = 1`;
const FALSE = sql`1 = 0`;

/**
 * The signing linkage as subqueries: which evidence ids Sign & Attest's own
 * tables say are stroke documents, rendered marks, audit receipts and signed
 * documents. NULLs are excluded so NOT IN means what it says.
 */
function signingSets(db: Db) {
  const strokes = db.select({ id: attestMarks.strokeEvidenceRecordId }).from(attestMarks).where(isNotNull(attestMarks.strokeEvidenceRecordId));
  const renders = db.select({ id: attestMarks.renderedEvidenceRecordId }).from(attestMarks).where(isNotNull(attestMarks.renderedEvidenceRecordId));
  const receipts = db.select({ id: attestArtifacts.evidenceRecordId }).from(attestArtifacts)
    .where(and(isNotNull(attestArtifacts.evidenceRecordId), eq(attestArtifacts.kind, "audit_receipt")));
  const signedDocs = db.select({ id: attestArtifacts.evidenceRecordId }).from(attestArtifacts)
    .where(and(isNotNull(attestArtifacts.evidenceRecordId), inArray(attestArtifacts.kind, ["finalized_pdf", "page_render"])));
  const artifacts = db.select({ id: attestArtifacts.evidenceRecordId }).from(attestArtifacts).where(isNotNull(attestArtifacts.evidenceRecordId));
  /** Any signing linkage at all. */
  const linked = or(
    inArray(evidenceRecords.id, strokes), inArray(evidenceRecords.id, renders), inArray(evidenceRecords.id, artifacts),
  )!;
  return { strokes, renders, receipts, signedDocs, artifacts, linked };
}

/**
 * `fileVisibility`, in SQL — so a page is cut from rows the caller may see,
 * not from a broad set trimmed afterwards. The projection re-checks every row
 * it returns; the two are the same rule written twice, and the tests hold them
 * together.
 *
 *   excluded  stroke data (by linkage, or by type when unlinked): never shown
 *   category  rendered mark / receipt → legal; signed document → the category
 *             of what was signed; anything else → its type's category
 *   owner     evidence.read_own and (captured it, or is its operator)
 */
export function fileVisibilityWhere(db: Db, reach: FileReach): SQL {
  const sets = signingSets(db);
  const heldTypes = Object.entries(READ_CATEGORY_BY_RECORD_TYPE)
    .filter(([, c]) => c !== null && reach.held.has(c))
    .map(([t]) => t);
  const legal = reach.held.has("evidence.read_legal") ? TRUE : FALSE;
  const typeHeld = heldTypes.length ? inArray(evidenceRecords.recordType, heldTypes) : FALSE;

  // A signed document is visible when what it signs is: a held evidence type that is not itself signing
  // material, a field ticket for job-operational readers, a commercial document for commercial readers.
  const subject = alias(evidenceRecords, "signedSubject");
  const signedVisible = db.select({ id: attestArtifacts.evidenceRecordId }).from(attestArtifacts)
    .innerJoin(attestDocumentRevisions, eq(attestDocumentRevisions.id, attestArtifacts.revisionId))
    .leftJoin(subject, eq(subject.id, attestDocumentRevisions.subjectId))
    .where(and(
      isNotNull(attestArtifacts.evidenceRecordId),
      inArray(attestArtifacts.kind, ["finalized_pdf", "page_render"]),
      or(
        reach.held.has("evidence.read_job_operational") ? eq(attestDocumentRevisions.subjectType, "field_ticket_revision") : FALSE,
        reach.held.has("evidence.read_commercial") ? eq(attestDocumentRevisions.subjectType, "commercial_document") : FALSE,
        heldTypes.length
          ? and(
              eq(attestDocumentRevisions.subjectType, "evidence_record"),
              inArray(subject.recordType, heldTypes),
              notInArray(subject.id, db.select({ id: attestMarks.strokeEvidenceRecordId }).from(attestMarks).where(isNotNull(attestMarks.strokeEvidenceRecordId))),
              notInArray(subject.id, db.select({ id: attestMarks.renderedEvidenceRecordId }).from(attestMarks).where(isNotNull(attestMarks.renderedEvidenceRecordId))),
              notInArray(subject.id, db.select({ id: attestArtifacts.evidenceRecordId }).from(attestArtifacts).where(isNotNull(attestArtifacts.evidenceRecordId))),
            )
          : FALSE,
      ),
    ));

  const excluded = or(
    inArray(evidenceRecords.id, sets.strokes),
    and(sql`NOT (${sets.linked})`, eq(evidenceRecords.recordType, "signature_strokes")),
  )!;
  const categoryVisible = or(
    and(inArray(evidenceRecords.id, sets.renders), legal),
    and(notInArray(evidenceRecords.id, sets.renders), inArray(evidenceRecords.id, sets.receipts), legal),
    and(notInArray(evidenceRecords.id, sets.renders), notInArray(evidenceRecords.id, sets.receipts),
      inArray(evidenceRecords.id, sets.signedDocs), inArray(evidenceRecords.id, signedVisible)),
    and(notInArray(evidenceRecords.id, sets.renders), notInArray(evidenceRecords.id, sets.receipts),
      notInArray(evidenceRecords.id, sets.signedDocs), typeHeld),
  )!;
  const ownerVisible = reach.held.has("evidence.read_own")
    ? or(
        eq(evidenceRecords.capturedBy, reach.userId),
        reach.operatorId != null
          ? sql`EXISTS (SELECT 1 FROM ${evidenceRelationships} WHERE ${evidenceRelationships.evidenceRecordId} = ${evidenceRecords.id} AND ${evidenceRelationships.entityType} = 'operator' AND ${evidenceRelationships.entityId} = ${reach.operatorId})`
          : FALSE,
      )!
    : FALSE;
  return and(sql`NOT (${excluded})`, or(categoryVisible, ownerVisible))!;
}

/** `%`, `_` and the escape character are literal in a search term. `!`, not `\`: no SQL-mode dependence. */
const likeTerm = (t: string) => `%${t.toLowerCase().replace(/[!%_]/g, c => `!${c}`)}%`;

/**
 * The File Manager's filters, in SQL. Each is the projection's rule or a
 * superset of it (search and signing types, which the projection re-checks
 * exactly), never a subset — so nothing that matches is missed by the query.
 */
export function fileFilterWhere(db: Db, f: FileQueryFilters): SQL {
  const sets = signingSets(db);
  const parts: SQL[] = [];
  const notLinked = sql`NOT (${sets.linked})`;

  // Folder: type folders file by effective type, and every signing type is filed under "other".
  switch (f.folder) {
    case "all": break;
    case "needs_filing":
      parts.push(and(isNull(evidenceRecords.jobId),
        sql`NOT EXISTS (SELECT 1 FROM ${evidenceRelationships} WHERE ${evidenceRelationships.evidenceRecordId} = ${evidenceRecords.id} AND ${evidenceRelationships.entityType} <> 'operator')`)!);
      break;
    case "needs_review": parts.push(eq(evidenceRecords.status, "needs_review")); break;
    case "drafts": parts.push(eq(evidenceRecords.sealState, "draft")); break;
    case "legal_hold":
      parts.push(or(eq(evidenceRecords.legalHold, true), inArray(evidenceRecords.id,
        db.select({ id: legalHoldRecords.evidenceRecordId }).from(legalHoldRecords)
          .innerJoin(legalHolds, eq(legalHolds.id, legalHoldRecords.legalHoldId)).where(eq(legalHolds.status, "active"))))!);
      break;
    case "other":
      parts.push(or(sets.linked, notInArray(evidenceRecords.recordType, [...ALL_FOLDERED_TYPES]))!);
      break;
    default: {
      const types = TYPE_FOLDER_TYPES[f.folder] ?? [];
      parts.push(types.length ? and(notLinked, inArray(evidenceRecords.recordType, [...types]))! : FALSE);
    }
  }

  // Effective type: a signing type is matched by its linkage (or by the column when unlinked); any other
  // type only on an unlinked row, because a linked row's effective type is its signing role.
  if (f.recordType) {
    const byLinkage: Record<string, ReturnType<typeof signingSets>[keyof ReturnType<typeof signingSets>]> = {
      signature_strokes: sets.strokes, signature_render: sets.renders, attest_receipt: sets.receipts, signed_artifact: sets.signedDocs,
    };
    const set = byLinkage[f.recordType];
    parts.push(set
      ? or(inArray(evidenceRecords.id, set as never), and(notLinked, eq(evidenceRecords.recordType, f.recordType)))!
      : and(notLinked, eq(evidenceRecords.recordType, f.recordType))!);
  }

  // Lifecycle: only the seal state is a column; the rest is decided by the projection.
  if (f.lifecycle === "draft") parts.push(eq(evidenceRecords.sealState, "draft"));
  else if (f.lifecycle) parts.push(ne(evidenceRecords.sealState, "draft"));

  // Search: every term must match one of the fields the projection searches. Signing rows pass the query
  // on any term, because their searchable type is the signing role rather than the column.
  for (const term of f.terms) {
    const like = likeTerm(term);
    parts.push(or(
      sql`LOWER(${evidenceRecords.title}) LIKE ${like} ESCAPE '!'`,
      sql`LOWER(COALESCE(${evidenceRecords.trackingNumber}, '')) LIKE ${like} ESCAPE '!'`,
      sql`LOWER(REPLACE(${evidenceRecords.recordType}, '_', ' ')) LIKE ${like} ESCAPE '!'`,
      sql`LOWER(${evidenceRecords.category}) LIKE ${like} ESCAPE '!'`,
      sql`LOWER(COALESCE(${evidenceRecords.notes}, '')) LIKE ${like} ESCAPE '!'`,
      sql`EXISTS (SELECT 1 FROM ${evidenceRelationships} WHERE ${evidenceRelationships.evidenceRecordId} = ${evidenceRecords.id} AND LOWER(CONCAT(COALESCE(${evidenceRelationships.entityRef}, ''), ' ', COALESCE(${evidenceRelationships.entityId}, ''))) LIKE ${like} ESCAPE '!')`,
      sets.linked,
    )!);
  }
  return parts.length ? and(...parts)! : TRUE;
}

/** Strictly after a cursor position in createdAt DESC, id DESC. */
function afterPosition(pos: { createdAt: Date; id: number }): SQL {
  return or(
    lt(evidenceRecords.createdAt, pos.createdAt),
    and(eq(evidenceRecords.createdAt, pos.createdAt), lt(evidenceRecords.id, pos.id)),
  )!;
}

/**
 * One batch of the File Manager's sequence: the caller's organization, what
 * they may see and what they filtered for, in createdAt DESC, id DESC, strictly
 * after `after`. Everything that decides access is in the WHERE clause.
 */
export async function scanFileCandidates(args: {
  scope: TenantScope;
  reach: FileReach;
  filters: FileQueryFilters;
  after: { createdAt: Date; id: number } | null;
  limit: number;
}): Promise<FileCandidate[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(evidenceRecords)
    .where(and(
      fileScopeWhere(db, args.scope),
      fileVisibilityWhere(db, args.reach),
      fileFilterWhere(db, args.filters),
      ...(args.after ? [afterPosition(args.after)] : []),
    ))
    .orderBy(desc(evidenceRecords.createdAt), desc(evidenceRecords.id))
    .limit(args.limit);
  return enrichFileCandidates(db, rows);
}

/**
 * Folder counts over everything the caller may see — the same scope and
 * visibility as the pages, so a count never includes a row the caller cannot
 * open. One aggregate query.
 */
export async function countFileFolders(scope: TenantScope, reach: FileReach): Promise<Record<FolderKey, number>> {
  const db = await getDb();
  const keys: FolderKey[] = ["all", "field_tickets", "loads_disposal", "photos", "safety", "maintenance", "billing", "personnel", "other", "needs_filing", "needs_review", "drafts", "legal_hold"];
  const out = Object.fromEntries(keys.map(k => [k, 0])) as Record<FolderKey, number>;
  if (!db) return out;
  const selection = Object.fromEntries(keys.map(k => [k,
    k === "all" ? sql<number>`COUNT(*)` : sql<number>`SUM(CASE WHEN ${fileFilterWhere(db, { folder: k, terms: [], recordType: null, lifecycle: null })} THEN 1 ELSE 0 END)`,
  ])) as Record<FolderKey, SQL<number>>;
  const row = (await db.select(selection).from(evidenceRecords).where(and(fileScopeWhere(db, scope), fileVisibilityWhere(db, reach))))[0];
  for (const k of keys) out[k] = Number(row?.[k] ?? 0);
  return out;
}

async function enrichFileCandidates(db: Db, rows: (typeof evidenceRecords.$inferSelect)[]): Promise<FileCandidate[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);

  const [rels, items, seals, retention, held] = await Promise.all([
    db.select().from(evidenceRelationships).where(inArray(evidenceRelationships.evidenceRecordId, ids)),
    db.select({ evidenceRecordId: syncPackageItems.evidenceRecordId, state: syncPackageItems.state, id: syncPackageItems.id })
      .from(syncPackageItems).where(inArray(syncPackageItems.evidenceRecordId, ids)),
    db.select({ evidenceRecordId: evidenceSeals.evidenceRecordId, version: evidenceSeals.version, verificationResult: evidenceSeals.verificationResult })
      .from(evidenceSeals).where(inArray(evidenceSeals.evidenceRecordId, ids)),
    db.select().from(recordRetentionState).where(inArray(recordRetentionState.evidenceRecordId, ids)),
    db.select({ evidenceRecordId: legalHoldRecords.evidenceRecordId })
      .from(legalHoldRecords)
      .innerJoin(legalHolds, eq(legalHolds.id, legalHoldRecords.legalHoldId))
      .where(and(inArray(legalHoldRecords.evidenceRecordId, ids), eq(legalHolds.status, "active"))),
  ]);

  const heldIds = new Set(held.map(h => h.evidenceRecordId));
  return rows.map(r => {
    // The latest send attempt speaks for the record; an earlier failed one does not.
    const latestItem = items.filter(i => i.evidenceRecordId === r.id).sort((a, b) => b.id - a.id)[0];
    const seal = seals.find(s => s.evidenceRecordId === r.id && s.version === r.currentVersion);
    const ret = retention.find(x => x.evidenceRecordId === r.id);
    return {
      id: r.id,
      jobId: r.jobId ?? null,
      title: r.title,
      category: r.category,
      recordType: r.recordType,
      trackingNumber: r.trackingNumber ?? null,
      mimeType: r.mimeType ?? null,
      hasContent: Boolean(r.storageKey),
      capturedAt: r.capturedAt,
      createdAt: r.createdAt,
      capturedBy: r.capturedBy ?? null,
      status: r.status,
      sealState: r.sealState,
      currentVersion: r.currentVersion,
      legalHold: r.legalHold || heldIds.has(r.id),
      notes: r.notes ?? null,
      relationships: rels
        .filter(x => x.evidenceRecordId === r.id)
        .map(x => ({ entityType: x.entityType, entityId: x.entityId ?? null, entityRef: x.entityRef ?? null, role: x.role ?? null })),
      syncState: latestItem?.state ?? null,
      sealVerification: seal?.verificationResult ?? null,
      officeReviewedAt: ret?.officeReviewedAt ?? null,
      deviceCopyDeletedAt: ret?.deviceCopyDeletedAt ?? null,
      officeRetainUntil: ret?.officeRetainUntil ?? null,
    };
  });
}

/** Everything the inspector shows about one record. Authorization is the caller's job. */
export async function loadFileDetail(evidenceId: number) {
  const db = await getDb();
  if (!db) return null;
  const rec = (await db.select().from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId)).limit(1))[0];
  if (!rec) return null;
  const [relationships, versions, seals, retention, holds, items, access] = await Promise.all([
    db.select().from(evidenceRelationships).where(eq(evidenceRelationships.evidenceRecordId, evidenceId)),
    db.select().from(evidenceVersions).where(eq(evidenceVersions.evidenceRecordId, evidenceId)).orderBy(desc(evidenceVersions.version)),
    db.select().from(evidenceSeals).where(eq(evidenceSeals.evidenceRecordId, evidenceId)).orderBy(desc(evidenceSeals.version)),
    db.select().from(recordRetentionState).where(eq(recordRetentionState.evidenceRecordId, evidenceId)).limit(1),
    db.select({
      holdNumber: legalHolds.holdNumber, matterRef: legalHolds.matterRef, status: legalHolds.status,
      placedAt: legalHolds.placedAt, releasedAt: legalHolds.releasedAt, addedAt: legalHoldRecords.addedAt,
    }).from(legalHoldRecords)
      .innerJoin(legalHolds, eq(legalHolds.id, legalHoldRecords.legalHoldId))
      .where(eq(legalHoldRecords.evidenceRecordId, evidenceId)),
    db.select({ id: syncPackageItems.id, state: syncPackageItems.state })
      .from(syncPackageItems).where(eq(syncPackageItems.evidenceRecordId, evidenceId)).orderBy(desc(syncPackageItems.id)).limit(1),
    db.select().from(evidenceAccessEvents).where(eq(evidenceAccessEvents.evidenceRecordId, evidenceId))
      .orderBy(desc(evidenceAccessEvents.occurredAt)).limit(50),
  ]);
  return { rec, relationships, versions, seals, retention: retention[0] ?? null, holds, latestSync: items[0] ?? null, access };
}

/** The storage key for one version: the version row when it names one, else the record's own. */
export async function storageKeyForVersion(evidenceId: number, version: number | null) {
  const db = await getDb();
  if (!db) return null;
  const rec = (await db.select({ storageKey: evidenceRecords.storageKey, mimeType: evidenceRecords.mimeType, currentVersion: evidenceRecords.currentVersion })
    .from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId)).limit(1))[0];
  if (!rec) return null;
  const wanted = version ?? rec.currentVersion;
  const v = (await db.select({ storageKey: evidenceVersions.storageKey, mimeType: evidenceVersions.mimeType })
    .from(evidenceVersions)
    .where(and(eq(evidenceVersions.evidenceRecordId, evidenceId), eq(evidenceVersions.version, wanted))).limit(1))[0];
  if (v?.storageKey) return { storageKey: v.storageKey, mimeType: v.mimeType ?? rec.mimeType ?? null, version: wanted };
  // An older version with no stored object of its own has nothing to hand out; the record's
  // key belongs to the current version, and serving it as an older one would be a lie.
  if (version != null && version !== rec.currentVersion) return { storageKey: null, mimeType: null, version: wanted };
  return { storageKey: rec.storageKey ?? null, mimeType: rec.mimeType ?? null, version: wanted };
}

/**
 * What Sign & Attest's own tables say each of these records is. Read from
 * attestMarks (stroke and rendered-mark records) and attestArtifacts (finalized
 * documents, page renders, audit receipts), never from the type column or the
 * request — so a stroke document sealed as `other` is still found to be strokes.
 *
 * A signed document carries the category of what was signed (its revision's
 * subject), resolved here so the projection can inherit it; a subject this
 * cannot resolve leaves the signed document owner-only.
 *
 * When one record is linked more than one way, the most restrictive role wins.
 */
export async function signingLinksFor(evidenceIds: readonly number[]): Promise<Map<number, SigningLink>> {
  const out = new Map<number, SigningLink>();
  const ids = Array.from(new Set(evidenceIds));
  const db = await getDb();
  if (!db || ids.length === 0) return out;

  const RANK: Record<SigningLink["role"], number> = { strokes: 4, rendered_mark: 3, receipt: 2, signed_document: 1 };
  const put = (id: number, link: SigningLink) => {
    const prev = out.get(id);
    if (!prev || RANK[link.role] > RANK[prev.role]) out.set(id, link);
  };

  const [strokes, renders, artifacts] = await Promise.all([
    db.select({ id: attestMarks.strokeEvidenceRecordId }).from(attestMarks).where(inArray(attestMarks.strokeEvidenceRecordId, ids)),
    db.select({ id: attestMarks.renderedEvidenceRecordId }).from(attestMarks).where(inArray(attestMarks.renderedEvidenceRecordId, ids)),
    db.select({
      id: attestArtifacts.evidenceRecordId, kind: attestArtifacts.kind,
      subjectType: attestDocumentRevisions.subjectType, subjectId: attestDocumentRevisions.subjectId,
    }).from(attestArtifacts)
      .innerJoin(attestDocumentRevisions, eq(attestDocumentRevisions.id, attestArtifacts.revisionId))
      .where(inArray(attestArtifacts.evidenceRecordId, ids)),
  ]);
  for (const r of strokes) if (r.id != null) put(r.id, { role: "strokes", inheritedCategory: null });
  for (const r of renders) if (r.id != null) put(r.id, { role: "rendered_mark", inheritedCategory: null });

  // The subjects of signed documents that are themselves evidence records: their type, and whether they are signing material.
  const subjectIds = Array.from(new Set(artifacts.filter(a => a.subjectType === "evidence_record" && a.subjectId != null).map(a => a.subjectId!)));
  const subjectTypes = new Map<number, string>();
  const subjectSigning = new Set<number>();
  if (subjectIds.length) {
    const [rows, markedStrokes, markedRenders, artifacted] = await Promise.all([
      db.select({ id: evidenceRecords.id, recordType: evidenceRecords.recordType }).from(evidenceRecords).where(inArray(evidenceRecords.id, subjectIds)),
      db.select({ id: attestMarks.strokeEvidenceRecordId }).from(attestMarks).where(inArray(attestMarks.strokeEvidenceRecordId, subjectIds)),
      db.select({ id: attestMarks.renderedEvidenceRecordId }).from(attestMarks).where(inArray(attestMarks.renderedEvidenceRecordId, subjectIds)),
      db.select({ id: attestArtifacts.evidenceRecordId }).from(attestArtifacts).where(inArray(attestArtifacts.evidenceRecordId, subjectIds)),
    ]);
    for (const r of rows) subjectTypes.set(r.id, r.recordType);
    for (const r of [...markedStrokes, ...markedRenders, ...artifacted]) if (r.id != null) subjectSigning.add(r.id);
  }

  for (const a of artifacts) {
    if (a.id == null) continue;
    if (a.kind === "audit_receipt") { put(a.id, { role: "receipt", inheritedCategory: null }); continue; }
    // finalized_pdf and page_render are both the signed document, in whole or by page.
    const subjectRecordType = a.subjectType === "evidence_record" && a.subjectId != null ? subjectTypes.get(a.subjectId) ?? null : null;
    put(a.id, {
      role: "signed_document",
      inheritedCategory: signedSubjectCategory({
        subjectType: a.subjectType,
        subjectRecordType,
        subjectIsSigningMaterial: a.subjectId != null && subjectSigning.has(a.subjectId),
      }),
    });
  }
  return out;
}

/**
 * The office's integrity state for one record, from what the server itself
 * recorded: the latest send's verdict, the current seal's server check, and the
 * office receipt. Never from the request. See `integrityState` for the rule.
 */
export async function loadIntegrityState(evidenceId: number): Promise<IntegrityState> {
  const db = await getDb();
  if (!db) return "unknown";
  const rec = (await db.select({ currentVersion: evidenceRecords.currentVersion }).from(evidenceRecords).where(eq(evidenceRecords.id, evidenceId)).limit(1))[0];
  if (!rec) return "unknown";
  const [latestItem, seal, retention] = await Promise.all([
    db.select({ state: syncPackageItems.state }).from(syncPackageItems)
      .where(eq(syncPackageItems.evidenceRecordId, evidenceId)).orderBy(desc(syncPackageItems.id)).limit(1),
    db.select({ verificationResult: evidenceSeals.verificationResult }).from(evidenceSeals)
      .where(and(eq(evidenceSeals.evidenceRecordId, evidenceId), eq(evidenceSeals.version, rec.currentVersion))).limit(1),
    db.select({ officeIntegrityVerifiedAt: recordRetentionState.officeIntegrityVerifiedAt }).from(recordRetentionState)
      .where(eq(recordRetentionState.evidenceRecordId, evidenceId)).limit(1),
  ]);
  return integrityState({
    syncState: latestItem[0]?.state ?? null,
    sealVerification: seal[0]?.verificationResult ?? null,
    officeIntegrityVerifiedAt: retention[0]?.officeIntegrityVerifiedAt ?? null,
  });
}
