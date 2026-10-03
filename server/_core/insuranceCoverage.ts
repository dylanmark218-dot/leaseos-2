/**
 * The insurance engine's view of a financial entity's policies — lifted out of insuranceRouter at
 * 0236 so the marketplace reads a bidder's cover through the same loader the insurance surface
 * uses, rather than a second one that could drift. Its proof read is main's canonical one (SPINE item 2).
 */
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { complianceDocuments, insuranceCoveredEntities, insurancePolicies, insurancePolicyCoverages } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import { INSURANCE_PROOF_DOC_TYPES, proofFromDocuments, type PolicyRecord } from "./insuranceRisk";

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
  // SPINE item 2: every proof row the owner holds, judged canonically (proofFromDocuments) — never the
  // first or newest `insurance_proof` row in whatever state, and `insurance_card`, which dispatch
  // accepts, counts too. For the whole company the owner is the carrier subject (see above).
  const proofOwner = entity ?? { type: "carrier", id: financialEntityId };
  const proof = proofFromDocuments(await db.select().from(complianceDocuments).where(and(
    eq(complianceDocuments.ownerType, proofOwner.type as never), eq(complianceDocuments.ownerId, proofOwner.id),
    inArray(complianceDocuments.docType, [...INSURANCE_PROOF_DOC_TYPES]),
  )), now);
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
    out.push({
      policyRef: p.policyRef, policyType: p.policyType, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt, status: p.status,
      coverageVerificationStatus: p.coverageVerificationStatus,
      coverages: coverages.map(c => ({ coverageType: c.coverageType, limitAmount: c.limitAmount, additionalInsuredEndorsement: c.additionalInsuredEndorsement })),
      document: proof,
    });
  }
  return out;
}
