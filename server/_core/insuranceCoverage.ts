/**
 * The insurance engine's view of a financial entity's policies — lifted out of insuranceRouter at
 * 0192 so the marketplace reads a bidder's cover through the same loader the insurance surface
 * uses, rather than a second one that could drift. Body unchanged from the router's `policiesFor`.
 */
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { complianceDocuments, insuranceCoveredEntities, insurancePolicies, insurancePolicyCoverages } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import type { PolicyRecord } from "./insuranceRisk";

/**
 * Every policy covering an entity (or the whole company), as the engine sees it.
 *
 * The proof document: for an entity, the entity's own `insurance_proof`; for the whole company
 * (`entity` null), the CARRIER's — `complianceDocuments` with ownerType `carrier` and ownerId the
 * financial entity, the same subject `carrierProfileReviews` is keyed by. The router's original
 * whole-company read carried no document, which made the engine call every company-level cover
 * "document missing"; a company's certificate of insurance lives on the carrier subject.
 */
export async function policiesForFinancialEntity(db: DbOrTx, financialEntityId: number, entity: { type: string; id: number } | null, now: Date): Promise<PolicyRecord[]> {
  const rows = await db.select().from(insurancePolicies).where(eq(insurancePolicies.financialEntityId, financialEntityId));
  const out: PolicyRecord[] = [];
  for (const p of rows) {
    if (entity) {
      const covered = await db.select({ id: insuranceCoveredEntities.id }).from(insuranceCoveredEntities).where(and(
        eq(insuranceCoveredEntities.insurancePolicyId, p.id),
        or(and(eq(insuranceCoveredEntities.entityType, entity.type as never), eq(insuranceCoveredEntities.entityId, entity.id)), eq(insuranceCoveredEntities.entityType, "company")),
        or(isNull(insuranceCoveredEntities.coveredUntil), gte(insuranceCoveredEntities.coveredUntil, now)),
      )).limit(1);
      if (!covered[0]) continue;
    }
    const coverages = await db.select().from(insurancePolicyCoverages).where(eq(insurancePolicyCoverages.insurancePolicyId, p.id));
    const proofOwner = entity ?? { type: "carrier", id: financialEntityId };
    const doc = (await db.select().from(complianceDocuments)
      .where(and(eq(complianceDocuments.ownerType, proofOwner.type as never), eq(complianceDocuments.ownerId, proofOwner.id), eq(complianceDocuments.docType, "insurance_proof")))
      .orderBy(desc(complianceDocuments.capturedAt)).limit(1))[0];
    out.push({
      policyRef: p.policyRef, policyType: p.policyType, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt, status: p.status,
      coverageVerificationStatus: p.coverageVerificationStatus,
      coverages: coverages.map(c => ({ coverageType: c.coverageType, limitAmount: c.limitAmount, additionalInsuredEndorsement: c.additionalInsuredEndorsement })),
      document: doc ? { expiresAt: doc.expiresAt, verificationStatus: doc.verificationStatus } : null,
    });
  }
  return out;
}
