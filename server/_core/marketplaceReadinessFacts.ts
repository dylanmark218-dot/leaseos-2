/**
 * Reads the facts the marketplace readiness evaluator consumes — from the canonical registries,
 * never from a marketplace copy of them (0192, P10.3).
 *
 *   organization            organizations
 *   contractor profile      contractorBusinessProfiles
 *   carrier identity        financialEntities owned by the organization (the subject carrierProfileReviews
 *                           and insurancePolicies are keyed by)
 *   carrier credentials     complianceDocuments, ownerType `carrier`, ownerId = financial entity
 *   insurance               the insurance engine's PolicyRecords, via the loader the insurance surface uses
 *   equipment               units the organization owns (coreRecordOwnership) with their inspection and
 *                           maintenance flags
 *   workers                 organizationWorkers (active) and owned operators, resolved to users; holdings
 *                           from workerQualifications (recorded) and academyQualifications (issued)
 *   enforcement             outOfServiceOrders, scope `carrier`, active, in the organization's tenant
 *
 * Nothing here decides anything. Private credential fields never leave this module: a holding is
 * reduced to code, state and expiry before it reaches the evaluator, and the evaluator reduces it
 * to a count before it reaches anyone.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  academyQualifications, complianceDocuments, contractorBusinessProfiles, coreRecordOwnership, financialEntities, marketplaceInvitations,
  operators, organizationWorkers, organizations, outOfServiceOrders, units, workerQualifications, type MarketplacePostingRow,
} from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import { policiesForFinancialEntity } from "./insuranceCoverage";
import { biddingWindow } from "./marketplace";
import { normalizeTenderRequirements, type MarketplaceReadinessFacts, type ReadinessStage, type WorkerFact } from "./marketplaceReadiness";
import type { QualificationHolding } from "./qualificationValidity";

/** An Academy-issued qualification presented in the holdings engine's shape. `current` is the Academy's verified. */
function academyHolding(q: typeof academyQualifications.$inferSelect): QualificationHolding {
  const verificationState: QualificationHolding["verificationState"] =
    q.status === "current" || q.status === "expired" ? "verified" : q.status === "pending" ? "unverified" : "rejected";
  return { holdingRef: q.qualificationRef, code: q.qualificationCode, verificationState, issuedAt: q.validFrom, expiresAt: q.expiresAt, recordedAt: q.verifiedAt ?? q.validFrom ?? q.createdAt };
}

export async function gatherReadinessFacts(
  db: DbOrTx,
  args: { posting: MarketplacePostingRow; bidderOrgRef: string; unitsOffered: number | null; stage: ReadinessStage },
  now: Date,
): Promise<MarketplaceReadinessFacts> {
  const { posting, bidderOrgRef } = args;
  const [org] = await db.select({ status: organizations.status }).from(organizations).where(eq(organizations.orgRef, bidderOrgRef)).limit(1);
  const [profile] = await db.select({ status: contractorBusinessProfiles.status }).from(contractorBusinessProfiles).where(eq(contractorBusinessProfiles.orgRef, bidderOrgRef)).limit(1);
  const [inv] = await db.select({ status: marketplaceInvitations.status }).from(marketplaceInvitations).where(and(eq(marketplaceInvitations.postingId, posting.id), eq(marketplaceInvitations.invitedOrgRef, bidderOrgRef))).limit(1);

  const entities = await db.select({ id: financialEntities.id }).from(financialEntities).where(and(eq(financialEntities.orgRef, bidderOrgRef), eq(financialEntities.status, "active")));
  const financialEntityIds = entities.map(e => e.id);
  const carrierDocuments = financialEntityIds.length
    ? (await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, "carrier"), inArray(complianceDocuments.ownerId, financialEntityIds))))
        .map(d => ({ id: d.id, docType: d.docType, title: d.title, issuedAt: d.issuedAt, expiresAt: d.expiresAt, verificationStatus: d.verificationStatus, capturedAt: d.capturedAt }))
    : [];
  const policies = [];
  for (const id of financialEntityIds) policies.push(...(await policiesForFinancialEntity(db, id, null, now)));

  const ownedUnits = await db.select({ recordId: coreRecordOwnership.recordId }).from(coreRecordOwnership).where(and(eq(coreRecordOwnership.orgRef, bidderOrgRef), eq(coreRecordOwnership.recordType, "unit")));
  const unitRows = ownedUnits.length ? await db.select({ id: units.id, vehicleType: units.vehicleType, inspectionStatus: units.inspectionStatus, maintenanceStatus: units.maintenanceStatus }).from(units).where(inArray(units.id, ownedUnits.map(u => u.recordId))) : [];

  // Workers: the organization's listed workers, plus operators it owns; each resolved to a user.
  const listed = await db.select({ userId: organizationWorkers.userId, operatorId: organizationWorkers.operatorId }).from(organizationWorkers).where(and(eq(organizationWorkers.orgRef, bidderOrgRef), eq(organizationWorkers.status, "active")));
  const ownedOps = await db.select({ recordId: coreRecordOwnership.recordId }).from(coreRecordOwnership).where(and(eq(coreRecordOwnership.orgRef, bidderOrgRef), eq(coreRecordOwnership.recordType, "operator")));
  const operatorIds = Array.from(new Set([...listed.flatMap(w => (w.operatorId ? [w.operatorId] : [])), ...ownedOps.map(o => o.recordId)]));
  const operatorRows = operatorIds.length ? await db.select({ id: operators.id, userId: operators.userId }).from(operators).where(inArray(operators.id, operatorIds)) : [];
  const userIds = new Set<number>();
  let unlinkedWorkers = 0;
  for (const w of listed) {
    const viaOperator = w.operatorId ? operatorRows.find(o => o.id === w.operatorId)?.userId ?? null : null;
    const userId = w.userId ?? viaOperator;
    if (userId) userIds.add(userId); else unlinkedWorkers++;
  }
  for (const o of operatorRows) { if (o.userId) userIds.add(o.userId); else if (!listed.some(w => w.operatorId === o.id)) unlinkedWorkers++; }
  const ids = Array.from(userIds);
  const recorded = ids.length ? await db.select().from(workerQualifications).where(inArray(workerQualifications.userId, ids)) : [];
  const issued = ids.length ? await db.select().from(academyQualifications).where(inArray(academyQualifications.userId, ids)) : [];
  const workers: WorkerFact[] = ids.map(userId => ({
    userId,
    holdings: [
      ...recorded.filter(r => r.userId === userId).map(r => ({ holdingRef: r.holdingRef, code: r.code, verificationState: r.verificationState, issuedAt: r.issuedAt, expiresAt: r.expiresAt, recordedAt: r.recordedAt })),
      ...issued.filter(q => q.userId === userId).map(academyHolding),
    ],
  }));

  const oos = await db.select({ id: outOfServiceOrders.id }).from(outOfServiceOrders).where(and(eq(outOfServiceOrders.scope, "carrier"), eq(outOfServiceOrders.status, "active"), eq(outOfServiceOrders.tenantId, bidderOrgRef)));

  return {
    stage: args.stage,
    bidderOrgRef,
    clientOrgRef: posting.clientOrgRef,
    organizationStatus: org?.status ?? "missing",
    contractorProfileStatus: profile?.status ?? "none",
    distribution: posting.distribution,
    invited: inv?.status === "sent",
    window: biddingWindow({ state: posting.state, biddingClosesAt: posting.biddingClosesAt }, now),
    unitsRequired: posting.unitsRequired,
    unitsOffered: args.unitsOffered,
    requirements: normalizeTenderRequirements(JSON.parse(posting.requirementsJson)),
    financialEntityIds,
    carrierDocuments,
    policies,
    units: unitRows.map(u => ({ unitId: u.id, vehicleType: u.vehicleType, inspectionStatus: u.inspectionStatus, maintenanceStatus: u.maintenanceStatus })),
    workers,
    unlinkedWorkers,
    activeCarrierOutOfServiceOrders: oos.length,
  };
}
