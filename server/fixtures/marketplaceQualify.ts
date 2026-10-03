/**
 * Test fixtures for a bidding organization's CANONICAL records — the rows the marketplace readiness
 * evaluator reads through the registries' own engines. Nothing here is marketplace state: these are
 * financial entities, carrier compliance documents, insurance policies, owned units, worker
 * memberships and Academy qualifications, written exactly as their own surfaces write them.
 *
 * Qualifications follow the production model (D-05) with no test exemption: each is an
 * `academyQualifications` grant — the Academy's verified `current` record, the shape the qualification
 * read adapter's own suite writes — and each worker is an active member of the organization, which the
 * adapter requires before it reads anyone. Nothing here writes `workerQualifications`; that store has no
 * production writer.
 */
import type mysql from "mysql2/promise";

const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
let assetId = 1_700_000_000 + Math.floor(Math.random() * 40_000_000);
const nextAssetId = () => assetId++;
let userSeq = 421_000_000 + Math.floor(Math.random() * 50_000);
export const nextUserId = () => userSeq++;

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

export type QualifyOptions = {
  /** Qualification codes each worker holds: a current, verified Academy grant expiring in a year. */
  workerCodes?: string[];
  workers?: number;
  /** Units owned, of this vehicle type, inspection current and maintenance clear. */
  units?: number;
  unitClass?: string;
  /** General-liability limit in dollars on a verified, active policy of the organization's financial entity. */
  liabilityLimit?: number | null;
  coverageVerified?: boolean;
  /** Carrier-level compliance documents, verified, expiring in a year. */
  carrierDocTypes?: string[];
  contractorProfile?: boolean;
};

export type Qualified = { financialEntityId: number; policyRef: string | null; unitIds: number[]; userIds: number[]; qualificationRefs: string[] };

/** An active membership of `orgRef` — what puts a person in the organization's scope. */
export async function addMembership(pool: mysql.Pool, orgRef: string, userId: number): Promise<void> {
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
}

/**
 * An Academy qualification grant, in the shape the Academy writes and the adapter's own suite uses.
 * Defaults to a current, verified academy certificate valid from 100 days ago to a year out.
 */
export async function grantAcademyQualification(
  pool: mysql.Pool, userId: number, code: string,
  o: { status?: "current" | "pending" | "expired" | "rejected" | "revoked"; validFrom?: Date | null; expiresAt?: Date | null; createdAt?: Date; sourceKind?: string; complianceDocumentId?: number | null; verified?: boolean } = {},
): Promise<string> {
  const ref = `AQ-${rnd()}${rnd()}`;
  const verified = o.verified ?? true;
  await pool.execute(
    `INSERT INTO academyQualifications (qualificationRef, userId, qualificationCode, sourceKind, status, complianceDocumentId, validFrom, expiresAt, verifiedByUserId, verifiedAt, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [ref, userId, code, o.sourceKind ?? "academy_certificate", o.status ?? "current", o.complianceDocumentId ?? null,
      o.validFrom === undefined ? days(-100) : o.validFrom, o.expiresAt === undefined ? days(365) : o.expiresAt,
      verified ? 1 : null, verified ? days(-100) : null, o.createdAt ?? days(-100)],
  );
  return ref;
}

/** Gives an organization what a compliant contractor has on record. Every piece is optional so a test can leave one out. */
export async function qualifyOrganization(pool: mysql.Pool, orgRef: string, o: QualifyOptions = {}): Promise<Qualified> {
  const workers = o.workers ?? 4;
  const unitCount = o.units ?? 4;
  if (o.contractorProfile ?? true) {
    await pool.execute("INSERT IGNORE INTO contractorBusinessProfiles (orgRef, operatingMode, legalName, status, createdByUserId) VALUES (?,?,?,?,1)", [orgRef, "CONTRACTOR_COMPANY", `${orgRef} Ltd.`, "active"]);
  }
  const [fe] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO financialEntities (orgRef, entityRef, legalName, taxpayerType, jurisdiction, status) VALUES (?,?,?,?,?,'active')",
    [orgRef, `FE-${rnd()}`, `${orgRef} Ltd.`, "corporation", "CA-AB"],
  );
  const financialEntityId = fe.insertId;
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'financial_entity', ?, 1)", [orgRef, financialEntityId]);

  for (const docType of o.carrierDocTypes ?? []) {
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, issuedAt, expiresAt, verificationStatus, verifiedByUserId, verifiedAt) VALUES ('carrier', ?, ?, ?, NOW(), ?, ?, 'verified', 1, NOW())",
      [financialEntityId, docType, `${docType} for ${orgRef}`, days(-30), days(365)],
    );
  }

  let policyRef: string | null = null;
  if (o.liabilityLimit !== null && (o.liabilityLimit ?? 5_000_000) > 0) {
    const [ins] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO insuranceProviders (providerRef, name, role) VALUES (?, ?, 'insurer')", [`INS-${rnd()}`, "Fixture Mutual"]);
    policyRef = `POL-${rnd()}`;
    const [pol] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO insurancePolicies (policyRef, financialEntityId, policyType, insurerId, policyNumber, effectiveAt, expiresAt, status, coverageVerificationStatus, coverageVerifiedAt, coverageVerifiedByUserId) VALUES (?,?,?,?,?,?,?,'active',?,NOW(),1)",
      [policyRef, financialEntityId, "general_liability", ins.insertId, `GL-${rnd()}`, days(-60), days(300), (o.coverageVerified ?? true) ? "coverage_verified" : "coverage_reported"],
    );
    await pool.execute("INSERT INTO insurancePolicyCoverages (insurancePolicyId, coverageType, limitAmount, limitAmountCents, limitBasis) VALUES (?, 'general_liability', ?, ?, 'per_occurrence')", [pol.insertId, o.liabilityLimit ?? 5_000_000, Math.round((o.liabilityLimit ?? 5_000_000) * 100)]);
    await pool.execute("INSERT INTO insuranceCoveredEntities (insurancePolicyId, entityType, entityId, coveredFrom) VALUES (?, 'company', ?, ?)", [pol.insertId, financialEntityId, days(-60)]);
    // The certificate of insurance, on the carrier subject, verified: without it the insurance engine
    // calls the cover "document missing" and the marketplace fails closed on it.
    await pool.execute(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, issuedAt, expiresAt, verificationStatus, verifiedByUserId, verifiedAt) VALUES ('carrier', ?, 'insurance_proof', ?, NOW(), ?, ?, ?, 1, NOW())",
      [financialEntityId, `Certificate of insurance ${policyRef}`, days(-60), days(300), (o.coverageVerified ?? true) ? "verified" : "needs_review"],
    );
  }

  const unitIds: number[] = [];
  for (let i = 0; i < unitCount; i++) {
    const id = nextAssetId();
    await pool.execute("INSERT INTO units (id, unitNumber, vehicleType, company, inspectionStatus, maintenanceStatus) VALUES (?, ?, ?, ?, 'current', 'clear')", [id, `U-${rnd()}`, o.unitClass ?? "TRI_DRIVE_VAC", orgRef]);
    await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?, 'unit', ?, 1)", [orgRef, id]);
    unitIds.push(id);
  }

  const userIds: number[] = [];
  const qualificationRefs: string[] = [];
  for (let i = 0; i < workers; i++) {
    const userId = nextUserId();
    await pool.execute("INSERT INTO organizationWorkers (workerRef, orgRef, userId, workerType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'EMPLOYEE_DRIVER','active','2020-01-01',1)", [`WRK-${rnd()}`, orgRef, userId]);
    await addMembership(pool, orgRef, userId);
    for (const code of o.workerCodes ?? []) qualificationRefs.push(await grantAcademyQualification(pool, userId, code));
    userIds.push(userId);
  }
  return { financialEntityId, policyRef, unitIds, userIds, qualificationRefs };
}
