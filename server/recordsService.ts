/**
 * Records service.
 *
 * Everything authorization depends on is loaded here, from the database. The
 * request supplies identifiers; it never supplies the facts used to decide
 * whether it is allowed. A client that can name the owner of the record it is
 * asking about can name itself.
 */

import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "./db";
import { placeHold, releaseHold } from "./fleetPortfolioService";
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
  recordRetentionState,
  syncPackageItems,
  syncPackages,
  unitHolds,
  workOrderReleases,
  workOrders,
} from "../drizzle/schema";

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
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const r = await db
    .update(maintenanceDefects)
    .set({
      status: "resolved",
      resolvedAt: args.at,
      resolvedByUserId: args.resolvedByUserId,
      resolvedByReleaseId: args.resolvedByReleaseId,
      resolutionNote: args.note.slice(0, 400),
    })
    .where(and(eq(maintenanceDefects.id, args.defectId), ne(maintenanceDefects.status, "resolved")));
  return (r[0]?.affectedRows ?? 0) > 0;
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
