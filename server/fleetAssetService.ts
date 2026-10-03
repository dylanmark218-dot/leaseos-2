/**
 * Fleet & Equipment Portfolio — asset identity, lifecycle, components, the list and the detail.
 *
 * Asset core checkpoint (docs/fleet/FLEET_ASSET_CORE_CHECKPOINT.md), on the foundation slice (0200).
 * Every function takes a unit the router has already scoped; writes append a `fleetPortfolioEvents`
 * row in the same transaction; nothing is deleted. The readiness composer stays the one authority on
 * dispatch: `unitSideReadiness` reuses its loaders and the same classification to explain the unit's
 * side of the question without a driver, and says what it did not evaluate.
 */
import { and, desc, eq, inArray, isNull, like, or as sqlOr, sql } from "drizzle-orm";
import {
  complianceDocuments, coreRecordOwnership, dispatchPostings, dispatchRoles, inspections, maintenanceDefects, operators,
  unitComponents, units, workOrders,
} from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { classifyBlocker, mergeFindings, type ComplianceFinding } from "./_core/complianceFinding";
import type { DispatchBlocker } from "./_core/dispatchReadiness";
import { assessCoverage } from "./_core/insuranceRisk";
import { complianceDocumentValidity } from "./_core/complianceDocumentValidity";
import { componentAttachment, componentBlockers, lifecycleBlocker, lifecycleTransition, unitSideVerdict, UNIT_SIDE_NOT_EVALUATED, type ComponentState } from "./_core/fleetAssets";
import { operationalState, type OperationalState, type StateReason } from "./_core/fleetPortfolio";
import { assetClassOf, vehicleTypeFor, type AssetClass, type AssetIdentityInput, type ComponentRelationship, type LifecycleStatus } from "../shared/fleetAssetTypes";
import { ownershipScopeWhere, type TenantScope } from "./db";
import { componentStatesFor } from "./fleetComponents";
import { activeHolds, appendEvent, fleetRef, meterSequencesFor, orgRefOf, portfolioFacts } from "./fleetPortfolioService";
import { credentialState, credentialsFor, holdBlocker, policiesCovering } from "./readinessComposer";

export type UnitRow = typeof units.$inferSelect;

export async function unitRow(db: DbOrTx, unitId: number): Promise<UnitRow | null> {
  return (await db.select().from(units).where(eq(units.id, unitId)).limit(1))[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

const IDENTITY_FIELDS = [
  "assetType", "assetSubtype", "companyAssetNumber", "vin", "serialNumber", "plate", "plateJurisdiction", "make", "model", "modelYear",
  "manufacturer", "ownershipType", "acquiredAt", "homeTerminal", "assignedBranchRef", "assignedDivision", "defaultOperatorId", "regulatoryClass", "notes",
] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];

export function identityOf(u: UnitRow) {
  return {
    unitId: u.id, unitNumber: u.unitNumber, assetClass: u.assetClass, assetType: u.assetType, assetSubtype: u.assetSubtype, vehicleType: u.vehicleType,
    vin: u.vin, serialNumber: u.serialNumber, plate: u.plate, plateJurisdiction: u.plateJurisdiction, make: u.make, model: u.model, modelYear: u.modelYear,
    manufacturer: u.manufacturer, ownershipType: u.ownershipType, acquiredAt: u.acquiredAt, homeTerminal: u.homeTerminal, assignedBranchRef: u.assignedBranchRef,
    assignedDivision: u.assignedDivision, defaultOperatorId: u.defaultOperatorId, regulatoryClass: u.regulatoryClass, companyAssetNumber: u.companyAssetNumber, notes: u.notes,
    company: u.company, qrTag: u.qrTag, createdAt: u.createdAt,
  };
}
export const lifecycleOf = (u: UnitRow) => ({ status: u.lifecycleStatus, changedAt: u.lifecycleChangedAt, changedByUserId: u.lifecycleChangedByUserId, reason: u.lifecycleReason, retiredAt: u.retiredAt });

/** Create a unit with its identity, its ownership row, and the first event — together or not at all. */
export async function createAsset(db: DbOrTx, a: { unitNumber: string; identity: AssetIdentityInput; scope: TenantScope; byUserId: number; byRole: string }): Promise<number> {
  const assetClass = assetClassOf(a.identity.assetType);
  if (!assetClass) throw new Error(`Unknown asset type ${a.identity.assetType}`);
  const orgRef = orgRefOf(a.scope.tenantId);
  const write = async (tx: DbOrTx) => {
    const { assetType, ...rest } = a.identity;
    const res = await tx.insert(units).values({
      unitNumber: a.unitNumber, vehicleType: vehicleTypeFor(assetType), assetClass, assetType,
      ...stripUndefined(rest), inspectionStatus: "due", maintenanceStatus: "review", lifecycleStatus: "active",
    });
    const id = Number((res as unknown as [{ insertId: number }])[0].insertId);
    if (a.scope.tenantId !== SINGLE_TENANT_ID) await tx.insert(coreRecordOwnership).values({ orgRef: a.scope.tenantId, recordType: "unit", recordId: id, assignedByUserId: a.byUserId });
    await appendEvent(tx, { orgRef, unitId: id, subjectType: "unit", subjectRef: a.unitNumber, eventType: "asset_created", newState: "active", detail: `${assetClass} ${assetType}`, actorUserId: a.byUserId, actorRole: a.byRole });
    return id;
  };
  return "transaction" in db ? db.transaction(async tx => write(tx as unknown as DbOrTx)) : write(db);
}

const stripUndefined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Change identity fields. The event names every field that changed; a change of type re-derives the class. */
export async function updateAsset(db: DbOrTx, a: { unit: UnitRow; patch: Partial<AssetIdentityInput>; byUserId: number; byRole: string }): Promise<string[]> {
  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const f of IDENTITY_FIELDS) {
    if (!(f in a.patch) || a.patch[f] === undefined) continue;
    const next = a.patch[f] as unknown;
    const prev = (a.unit as Record<string, unknown>)[f];
    const same = next instanceof Date && prev instanceof Date ? next.getTime() === prev.getTime() : next === prev;
    if (same) continue;
    set[f] = next; changed.push(f);
  }
  if (typeof set.assetType === "string") {
    const cls = assetClassOf(set.assetType);
    if (!cls) throw new Error(`Unknown asset type ${set.assetType}`);
    set.assetClass = cls; set.vehicleType = vehicleTypeFor(set.assetType);
  }
  if (!changed.length) return [];
  const write = async (tx: DbOrTx) => {
    await tx.update(units).set(set as Partial<typeof units.$inferInsert>).where(eq(units.id, a.unit.id));
    await appendEvent(tx, { orgRef: a.unit.id ? await orgRefOfUnit(tx, a.unit.id) : null, unitId: a.unit.id, subjectType: "unit", subjectRef: a.unit.unitNumber, eventType: "asset_edited", detail: changed.join(", "), actorUserId: a.byUserId, actorRole: a.byRole });
  };
  if ("transaction" in db) await db.transaction(async tx => write(tx as unknown as DbOrTx)); else await write(db);
  return changed;
}

export async function orgRefOfUnit(db: DbOrTx, unitId: number): Promise<string | null> {
  const o = (await db.select({ orgRef: coreRecordOwnership.orgRef }).from(coreRecordOwnership).where(and(eq(coreRecordOwnership.recordType, "unit"), eq(coreRecordOwnership.recordId, unitId))).limit(1))[0];
  return o?.orgRef ?? null;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * One recorded transition, conditional on the status the caller saw: two people changing it at once
 * cannot both succeed, and the loser learns the unit moved under them.
 */
export async function setLifecycle(db: DbOrTx, a: { unit: UnitRow; to: LifecycleStatus; reason: string; roles: readonly string[]; byUserId: number; byRole: string }): Promise<{ ok: true } | { ok: false; code: "refused" | "conflict"; reason: string }> {
  const decision = lifecycleTransition({ from: a.unit.lifecycleStatus, to: a.to, roles: a.roles });
  if (!decision.allowed) return { ok: false, code: "refused", reason: decision.reason };
  const at = new Date();
  let moved = false;
  const write = async (tx: DbOrTx) => {
    const res = await tx.update(units).set({
      lifecycleStatus: a.to, lifecycleChangedAt: at, lifecycleChangedByUserId: a.byUserId, lifecycleReason: a.reason,
      retiredAt: decision.terminal ? at : null,
    }).where(and(eq(units.id, a.unit.id), eq(units.lifecycleStatus, a.unit.lifecycleStatus)));
    moved = (res as unknown as [{ affectedRows: number }])[0]?.affectedRows === 1;
    if (!moved) return;
    await appendEvent(tx, { orgRef: await orgRefOfUnit(tx, a.unit.id), unitId: a.unit.id, subjectType: "lifecycle", subjectRef: a.unit.unitNumber, eventType: "lifecycle_changed", previousState: a.unit.lifecycleStatus, newState: a.to, detail: a.reason, actorUserId: a.byUserId, actorRole: a.byRole, at });
  };
  if ("transaction" in db) await db.transaction(async tx => write(tx as unknown as DbOrTx)); else await write(db);
  return moved ? { ok: true } : { ok: false, code: "conflict", reason: `Unit ${a.unit.unitNumber} is no longer ${a.unit.lifecycleStatus}: someone changed it a moment ago` };
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

export async function activeRelationsIn(db: DbOrTx, orgRef: string | null) {
  return db.select({ parentUnitId: unitComponents.parentUnitId, childUnitId: unitComponents.childUnitId }).from(unitComponents)
    .where(and(isNull(unitComponents.removedAt), orgRef == null ? isNull(unitComponents.orgRef) : eq(unitComponents.orgRef, orgRef)));
}

export async function attachComponent(db: DbOrTx, a: { parent: UnitRow; child: UnitRow; relationship: ComponentRelationship; removable: boolean; installedAt: Date; workOrderId: number | null; orgRef: string | null; byUserId: number; byRole: string }): Promise<{ ok: true; componentRef: string } | { ok: false; reason: string }> {
  const decision = componentAttachment({
    parent: { id: a.parent.id, assetClass: a.parent.assetClass as AssetClass | null, lifecycleStatus: a.parent.lifecycleStatus },
    child: { id: a.child.id, assetClass: a.child.assetClass as AssetClass | null, lifecycleStatus: a.child.lifecycleStatus },
    relationship: a.relationship, active: await activeRelationsIn(db, a.orgRef),
  });
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  const componentRef = fleetRef("CMP");
  const write = async (tx: DbOrTx) => {
    // Lock the child's row, so two attachments of one component racing are serialized here; then the
    // double-attachment check again, under that lock — both racers passed the read above.
    await tx.execute(sql`SELECT id FROM units WHERE id = ${a.child.id} FOR UPDATE`);
    const dup = await tx.select({ id: unitComponents.id }).from(unitComponents).where(and(eq(unitComponents.childUnitId, a.child.id), isNull(unitComponents.removedAt))).limit(1);
    if (dup.length) throw new ComponentConflict("The component was attached elsewhere a moment ago");
    await tx.insert(unitComponents).values({ componentRef, orgRef: a.orgRef, parentUnitId: a.parent.id, childUnitId: a.child.id, relationship: a.relationship, removable: a.removable, installedAt: a.installedAt, installedByUserId: a.byUserId, installWorkOrderId: a.workOrderId });
    const detail = `${a.child.unitNumber} ${a.relationship} on ${a.parent.unitNumber}`;
    await appendEvent(tx, { orgRef: a.orgRef, unitId: a.parent.id, subjectType: "component", subjectRef: componentRef, eventType: "component_attached", newState: "attached", detail, actorUserId: a.byUserId, actorRole: a.byRole, at: a.installedAt });
    await appendEvent(tx, { orgRef: a.orgRef, unitId: a.child.id, subjectType: "component", subjectRef: componentRef, eventType: "component_attached", newState: "attached", detail, actorUserId: a.byUserId, actorRole: a.byRole, at: a.installedAt });
  };
  try {
    if ("transaction" in db) await db.transaction(async tx => write(tx as unknown as DbOrTx)); else await write(db);
  } catch (e) {
    if (e instanceof ComponentConflict) return { ok: false, reason: e.message };
    throw e;
  }
  return { ok: true, componentRef };
}
export class ComponentConflict extends Error {}

/** Detach once: conditional on `removedAt IS NULL`; the relation stays as history. */
export async function detachComponent(db: DbOrTx, a: { relation: typeof unitComponents.$inferSelect; reason: string; workOrderId: number | null; byUserId: number; byRole: string }): Promise<boolean> {
  const at = new Date();
  let removed = false;
  const write = async (tx: DbOrTx) => {
    const res = await tx.update(unitComponents).set({ removedAt: at, removedByUserId: a.byUserId, removeWorkOrderId: a.workOrderId, removalReason: a.reason })
      .where(and(eq(unitComponents.id, a.relation.id), isNull(unitComponents.removedAt)));
    removed = (res as unknown as [{ affectedRows: number }])[0]?.affectedRows === 1;
    if (!removed) return;
    for (const unitId of [a.relation.parentUnitId, a.relation.childUnitId]) {
      await appendEvent(tx, { orgRef: a.relation.orgRef, unitId, subjectType: "component", subjectRef: a.relation.componentRef, eventType: "component_detached", previousState: "attached", newState: "detached", detail: a.reason, actorUserId: a.byUserId, actorRole: a.byRole, at });
    }
  };
  if ("transaction" in db) await db.transaction(async tx => write(tx as unknown as DbOrTx)); else await write(db);
  return removed;
}

/** Every relation a unit takes part in, either side, newest first; with history when asked. */
export async function componentsOf(db: DbOrTx, unitId: number, includeHistory: boolean) {
  const where = includeHistory
    ? sqlOr(eq(unitComponents.parentUnitId, unitId), eq(unitComponents.childUnitId, unitId))
    : and(sqlOr(eq(unitComponents.parentUnitId, unitId), eq(unitComponents.childUnitId, unitId)), isNull(unitComponents.removedAt));
  const rows = await db.select().from(unitComponents).where(where).orderBy(desc(unitComponents.installedAt), desc(unitComponents.id));
  const otherIds = Array.from(new Set(rows.map(r => (r.parentUnitId === unitId ? r.childUnitId : r.parentUnitId))));
  const others = otherIds.length ? await db.select({ id: units.id, unitNumber: units.unitNumber }).from(units).where(inArray(units.id, otherIds)) : [];
  const name = new Map(others.map(o => [o.id, o.unitNumber]));
  const states = await componentStatesFor(db, unitId);
  const st = new Map(states.map(s => [s.componentRef, s]));
  return rows.map(r => {
    const direction = r.parentUnitId === unitId ? ("attached" as const) : ("attached_to" as const);
    const otherUnitId = direction === "attached" ? r.childUnitId : r.parentUnitId;
    const s = st.get(r.componentRef);
    return { componentRef: r.componentRef, direction, otherUnitId, otherUnitNumber: name.get(otherUnitId) ?? `#${otherUnitId}`, relationship: r.relationship, removable: r.removable, installedAt: r.installedAt, installedByUserId: r.installedByUserId, installWorkOrderId: r.installWorkOrderId, removedAt: r.removedAt, removedByUserId: r.removedByUserId, removalReason: r.removalReason, criticalDefectOpen: s?.criticalDefectOpen ?? false, safetyHold: s?.safetyHold ?? false };
  });
}

/* ------------------------------------------------------------------ */
/* Assignment: who has the unit now                                    */
/* ------------------------------------------------------------------ */

const LIVE_POSTING = ["staffed", "partially_staffed", "dispatched", "in_progress"] as const;

/** The live slot a unit or trailer is bound into, with its operator and job. The slot model is the one source. */
export async function currentAssignment(db: DbOrTx, unitId: number) {
  const r = (await db.select({ roleId: dispatchRoles.id, operatorId: dispatchRoles.assignedOperatorId, jobId: dispatchPostings.jobId, planningState: dispatchPostings.planningState })
    .from(dispatchRoles).innerJoin(dispatchPostings, eq(dispatchPostings.id, dispatchRoles.postingId))
    .where(and(eq(dispatchRoles.status, "assigned"), sqlOr(eq(dispatchRoles.assignedUnitId, unitId), eq(dispatchRoles.assignedTrailerId, unitId)), inArray(dispatchPostings.planningState, [...LIVE_POSTING])))
    .orderBy(desc(dispatchRoles.id)).limit(1))[0];
  if (!r) return null;
  const op = r.operatorId ? (await db.select({ name: operators.name }).from(operators).where(eq(operators.id, r.operatorId)).limit(1))[0] : null;
  return { roleId: r.roleId, operatorId: r.operatorId, operatorName: op?.name ?? null, jobId: r.jobId, planningState: r.planningState };
}

/** The units and trailers bound to an operator's live slots — what a driver may read as their own. */
export async function unitsAssignedTo(db: DbOrTx, operatorId: number) {
  const rows = await db.select({ unitId: dispatchRoles.assignedUnitId, trailerId: dispatchRoles.assignedTrailerId, jobId: dispatchPostings.jobId })
    .from(dispatchRoles).innerJoin(dispatchPostings, eq(dispatchPostings.id, dispatchRoles.postingId))
    .where(and(eq(dispatchRoles.status, "assigned"), eq(dispatchRoles.assignedOperatorId, operatorId), inArray(dispatchPostings.planningState, [...LIVE_POSTING])));
  const out: { unitId: number; role: "unit" | "trailer"; jobId: number }[] = [];
  for (const r of rows) {
    if (r.unitId != null) out.push({ unitId: r.unitId, role: "unit", jobId: r.jobId });
    if (r.trailerId != null) out.push({ unitId: r.trailerId, role: "trailer", jobId: r.jobId });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

export const LIST_CAP = 100;

export type ListFilters = { lifecycle?: LifecycleStatus | null; assetClass?: AssetClass | null; assetType?: string | null; branchRef?: string | null; q?: string | null; status?: OperationalState["status"] | null };

/**
 * Units the scope may see, with the derived state of each. Each row's state is a full read of its
 * sources; the cap keeps that honest. Filtering by operational state happens after derivation —
 * there is no stored state to index.
 */
export async function listAssets(db: DbOrTx, scope: TenantScope, f: ListFilters) {
  const conds = [ownershipScopeWhere("unit", units.id, scope)];
  if (f.lifecycle) conds.push(eq(units.lifecycleStatus, f.lifecycle));
  else conds.push(inArray(units.lifecycleStatus, ["active", "seasonal_storage"]));
  if (f.assetClass) conds.push(eq(units.assetClass, f.assetClass));
  if (f.assetType) conds.push(eq(units.assetType, f.assetType));
  if (f.branchRef) conds.push(eq(units.assignedBranchRef, f.branchRef));
  if (f.q && f.q.trim()) {
    const term = `%${f.q.trim()}%`;
    conds.push(sqlOr(like(units.unitNumber, term), like(units.plate, term), like(units.vin, term), like(units.serialNumber, term), like(units.companyAssetNumber, term))!);
  }
  const where = and(...conds);
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(units).where(where);
  const rows = await db.select().from(units).where(where).orderBy(units.unitNumber).limit(LIST_CAP);
  const states = await Promise.all(rows.map(async u => {
    const [state, holds, assignment] = await Promise.all([operationalState(await portfolioFacts(db, u.id)), activeHolds(db, u.id), currentAssignment(db, u.id)]);
    return { u, state, holds, assignment };
  }));
  const units_ = states
    .filter(x => !f.status || x.state.status === f.status)
    .map(({ u, state, holds, assignment }) => ({
      unitId: u.id, unitNumber: u.unitNumber, assetClass: u.assetClass, assetType: u.assetType, make: u.make, model: u.model, modelYear: u.modelYear, plate: u.plate,
      lifecycleStatus: u.lifecycleStatus, status: state.status, activeHolds: holds.length,
      openCriticalDefects: state.reasons.filter(r => r.code === "critical_defect").length,
      assignedOperatorId: assignment?.operatorId ?? null, assignedOperatorName: assignment?.operatorName ?? null,
    }));
  return { units: units_, total: Number(total), cap: LIST_CAP };
}

/* ------------------------------------------------------------------ */
/* The detail                                                          */
/* ------------------------------------------------------------------ */

export async function assetDetail(db: DbOrTx, u: UnitRow, now = new Date()) {
  const ownerTypes: ("unit" | "trailer" | "equipment")[] = ["unit", "trailer", "equipment"];
  const [facts, holds, components, meters, docs, pols, defects, wos, insp, assignment] = await Promise.all([
    portfolioFacts(db, u.id),
    activeHolds(db, u.id),
    componentsOf(db, u.id, true),
    meterSequencesFor(db, u.id),
    db.select().from(complianceDocuments).where(and(inArray(complianceDocuments.ownerType, ownerTypes), eq(complianceDocuments.ownerId, u.id))).orderBy(desc(complianceDocuments.capturedAt)),
    policiesCovering(u.assetClass === "trailer" ? "trailer" : "unit", u.id, now),
    db.select().from(maintenanceDefects).where(and(eq(maintenanceDefects.unitId, u.id), sqlOr(inArray(maintenanceDefects.status, ["open", "in_progress"]), eq(maintenanceDefects.severity, "critical")))).orderBy(desc(maintenanceDefects.reportedAt)).limit(50),
    db.select({ id: workOrders.id, workOrderNumber: workOrders.workOrderNumber, status: workOrders.status, priority: workOrders.priority, openedAt: workOrders.openedAt, completedAt: workOrders.completedAt }).from(workOrders).where(eq(workOrders.unitId, u.id)).orderBy(desc(workOrders.openedAt)).limit(25),
    db.select({ id: inspections.id, type: inspections.type, status: inspections.status, observedAt: inspections.observedAt, authenticatedOperatorId: inspections.authenticatedOperatorId }).from(inspections).where(eq(inspections.unitId, u.id)).orderBy(desc(inspections.observedAt)).limit(25),
    currentAssignment(db, u.id),
  ]);
  const state = operationalState(facts);
  /*
   * Validity is the one engine's answer per document TYPE (SPINE item 2): the newest verified version is
   * what is in force. Each row is labelled by its place in that answer — the in-force row carries the
   * type's state; every other row is history (superseded, unverified, rejected), never a second answer.
   */
  const validityById = new Map<number, string>();
  const rowsByType = new Map<string, typeof docs>();
  for (const d of docs) rowsByType.set(d.docType, [...(rowsByType.get(d.docType) ?? []), d]);
  for (const [docType, rows] of Array.from(rowsByType.entries())) {
    const v = complianceDocumentValidity(rows.map(d => ({ id: d.id, docType: d.docType, title: d.title, issuedAt: d.issuedAt, expiresAt: d.expiresAt, verificationStatus: d.verificationStatus, capturedAt: d.capturedAt })), docType, now);
    // The engine's version ordinal is the row's rank by capturedAt (complianceDocumentValidity.ts: "capturedAt becomes the version ordinal").
    const ordered = [...rows].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id - b.id);
    ordered.forEach((d, i) => {
      const version = i + 1;
      validityById.set(d.id, v.version === version ? v.state : d.verificationStatus === "verified" ? "superseded" : d.verificationStatus);
    });
  }
  const insurance = assessCoverage({ coverageType: "commercial_auto", policies: pols, now });
  return {
    identity: identityOf(u), lifecycle: lifecycleOf(u), state, holds, components,
    meters: meters.sequences.map(s => ({ meterType: s.meterType, trust: s.trust, current: s.current ? { value: s.current.value, recordedAt: s.current.recordedAt, source: s.current.source } : null })),
    documents: docs.map(d => ({ id: d.id, docType: d.docType, title: d.title, identifier: d.identifier, issuedAt: d.issuedAt, expiresAt: d.expiresAt, verificationStatus: d.verificationStatus, verifiedByUserId: d.verifiedByUserId, evidenceRecordId: d.evidenceRecordId, validity: validityById.get(d.id) ?? "unknown" })),
    insurance: { status: insurance.status, reason: insurance.reason },
    defects: defects.map(d => ({ id: d.id, title: d.title, severity: d.severity, status: d.status, reportedAt: d.reportedAt, resolvedAt: d.resolvedAt })),
    workOrders: wos, inspections: insp, assignment,
  };
}

/* ------------------------------------------------------------------ */
/* Unit-side readiness                                                 */
/* ------------------------------------------------------------------ */

const SEVERITY: Record<StateReason["status"], DispatchBlocker["severity"]> = { out_of_service: "blocking", maintenance_hold: "blocking", indeterminate: "unknown", warning: "review" };

/**
 * "Why can't this unit leave?" with no driver, job or route. The portfolio's reasons (the composer's own
 * reads of holds, defects, releases, orders, roadside events and faults), the lifecycle, the components,
 * the required documents and insurance — through the composer's loaders and the one classification. It
 * reports what it did not evaluate, and its `clear` is never a dispatch verdict.
 */
export async function unitSideReadiness(db: DbOrTx, u: UnitRow, now = new Date()) {
  const subject = u.assetClass === "trailer" ? ("trailer" as const) : ("unit" as const);
  const who = subject === "unit" ? ("truck" as const) : ("trailer" as const);
  const [facts, components, creds, pols] = await Promise.all([portfolioFacts(db, u.id), componentStatesFor(db, u.id), credentialsFor(subject, u.id), policiesCovering(subject, u.id, now)]);
  const state = operationalState(facts);
  const blockers: DispatchBlocker[] = [];
  for (const r of state.reasons) {
    if (r.code.startsWith("hold_")) {
      const h = facts.holds.find(x => x.holdRef === r.source.ref);
      if (h) blockers.push(holdBlocker(subject, u.unitNumber, h));
      continue;
    }
    blockers.push({ code: r.code, label: r.label, severity: SEVERITY[r.status], subject: who, overridable: r.status === "warning", overrideAuthority: r.status === "warning" ? "manager" : undefined });
  }
  const life = lifecycleBlocker(subject, u.unitNumber, u.lifecycleStatus);
  if (life) blockers.push(life);
  blockers.push(...componentBlockers(u.unitNumber, components));
  const inspection = credentialState(creds, ["cvip_certificate", "annual_inspection"], subject === "unit" ? "Annual inspection" : "Trailer inspection", now);
  const registration = credentialState(creds, ["vehicle_registration"], "Registration", now);
  for (const [c, key] of [[inspection, "inspection"], [registration, "registration"]] as const) {
    if (!c.present) blockers.push({ code: `${subject === "unit" ? "truck" : "trailer"}_${key}_missing`, label: `${c.label}: not on record`, severity: "blocking", subject: who, overridable: false });
    else if (c.expiresAt && c.expiresAt.getTime() <= now.getTime()) blockers.push({ code: `${subject === "unit" ? "truck" : "trailer"}_${key}_expired`, label: `${c.label}: expired ${c.expiresAt.toISOString().slice(0, 10)}`, severity: "blocking", subject: who, overridable: false });
  }
  const auto = assessCoverage({ coverageType: "commercial_auto", policies: pols, now });
  if (auto.status === "coverage_expired") blockers.push({ code: "insurance_coverage_expired", label: auto.reason, severity: "blocking", subject: who, overridable: false });
  else if (auto.status === "coverage_unknown") blockers.push({ code: "insurance_coverage_unknown", label: auto.reason, severity: "blocking", subject: who, overridable: false });
  else if (auto.status === "document_missing" || auto.status === "document_expired") blockers.push({ code: "insurance_proof_missing", label: auto.reason, severity: "review", subject: who, overridable: true, overrideAuthority: "dispatcher" });
  else if (auto.status === "coverage_reported") blockers.push({ code: "insurance_coverage_unverified", label: auto.reason, severity: "review", subject: who, overridable: true, overrideAuthority: "manager" });
  const findings: ComplianceFinding[] = mergeFindings(blockers.map(b => classifyBlocker(b, now)));
  return { scope: "unit_side" as const, verdict: unitSideVerdict(findings), findings, state, notEvaluated: UNIT_SIDE_NOT_EVALUATED, evaluatedAt: now };
}
