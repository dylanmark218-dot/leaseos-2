/**
 * The qualification read adapter (C1b-3; owner decision D-05). READ ONLY.
 *
 * D-05: `academyQualifications` is the authority for qualifications and competency;
 * `complianceDocuments` is the authority for the documents they rest on; legacy stores stay readable
 * through adapters; `workerQualifications` may not remain an independent source of truth. Four readers
 * (shift readiness, crews, open shifts, the calendar) each read `workerQualifications` directly. They
 * now read this, and nothing else.
 *
 * **Precedence, per person and qualification code** (deterministic; nothing is merged silently):
 *
 *   1. `academyQualifications` rows for the code — the canonical answer, decided by the same engine as
 *      everything else (`documentValidity`). When there are any, they decide, even when a legacy row
 *      would read better: canonical never loses to a more permissive legacy record.
 *   2. Where the governing Academy row rests on an external credential (`complianceDocumentId`), that
 *      document is read as its evidence through `complianceDocumentValidity`. A credential that is not
 *      in force does not support the qualification: it is not held, and the result says why.
 *   3. `workerQualifications` for the code, only when no Academy row exists: marked
 *      `source = LEGACY_WORKER_QUALIFICATION`, `legacyFallback: true`. A legacy row that says `verified`
 *      without a recorded verifier has no provenance for that claim and reads UNKNOWN, not held.
 *
 * Where canonical and legacy disagree, the canonical result is returned with a `discrepancies` entry
 * naming the legacy holding. No record is rewritten, and no legacy row is deleted.
 *
 * **Tenancy.** The organization is the caller's acting scope, from the server. A person outside it is
 * not read at all (every requested code reads UNKNOWN). Academy rows carry no organization column;
 * they are reached only through a person already established in scope. Legacy rows are read only for
 * the acting organization's `tenantId`, or with no `tenantId` for the single-tenant fallback — never
 * across organizations.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { academyQualifications, complianceDocuments, workerQualifications } from "../drizzle/schema";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { asClaimVerification, complianceDocumentValidity } from "./_core/complianceDocumentValidity";
import type { DbOrTx } from "./_core/dbTypes";
import type { DocumentType } from "./_core/documentExtraction";
import { validityOf, type DocumentVersion, type Validity, type ValidityState } from "./_core/documentValidity";
import { heldFromValidity, qualificationValidity, type NotHeldCode, type QualificationHolding } from "./_core/qualificationValidity";
import { userInScope } from "./db";

export type QualificationSource = "ACADEMY_QUALIFICATION" | "LEGACY_WORKER_QUALIFICATION";

export type QualificationDiscrepancy = {
  kind: "LEGACY_DISAGREES" | "EVIDENCE_NOT_IN_FORCE" | "ACADEMY_STATUS_EXPIRED";
  detail: string;
  ref?: string;
};

/** One person's standing on one qualification code, with where it came from. */
export type EffectiveQualification = {
  userId: number;
  code: string;
  /** The acting organization the read was made for (server scope, never input). */
  orgRef: string;
  /** Null when nothing is on record (or the person is outside the organization). */
  source: QualificationSource | null;
  sourceRef: string | null;
  legacyFallback: boolean;
  /** The engine's verdict: in_force | expiring | expired | unverified | rejected | none. */
  state: ValidityState;
  /** The operational reading every reader used before: held only when verified, in date and with an establishable end. */
  held: boolean;
  notHeld: NotHeldCode | null;
  reason: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  /** The source's own verification word: Academy `status` or legacy `verificationState`. */
  verification: string | null;
  verifiedByUserId: number | null;
  /** Who stands behind it: the Academy source kind, or the legacy record. */
  issuer: string | null;
  certificateNumber: string | null;
  academyQualificationRef: string | null;
  evidence: { complianceDocumentId: number; docType: string | null; state: ValidityState } | null;
  discrepancies: QualificationDiscrepancy[];
};

type AcademyRow = typeof academyQualifications.$inferSelect;
type LegacyRow = typeof workerQualifications.$inferSelect;
type DocRow = typeof complianceDocuments.$inferSelect;

const ACADEMY_STATE: Readonly<Record<AcademyRow["status"], DocumentVersion["state"]>> = {
  current: "verified", expired: "verified", pending: "uploaded", rejected: "rejected", revoked: "rejected",
};

/** The Academy's verdict for one code, through the engine. Pure. */
export function academyVerdict(rows: readonly AcademyRow[], at: Date): { validity: Validity; chosen: AcademyRow | null } {
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const versions: DocumentVersion[] = ordered.map((r, i) => ({
    documentRef: r.qualificationRef, version: i + 1, type: r.qualificationCode as DocumentType, subjectRef: r.qualificationCode,
    state: ACADEMY_STATE[r.status], effectiveFrom: r.validFrom, expiresAt: r.expiresAt,
    verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, supersededByVersion: null, uploadedAt: r.createdAt,
  }));
  let validity = validityOf(versions, at);
  const chosen = validity.version ? ordered[validity.version - 1] ?? null : null;
  // The Academy said expired. Its dates cannot overrule that into "in force".
  if (chosen?.status === "expired" && (validity.state === "in_force" || validity.state === "expiring")) {
    validity = { ...validity, state: "expired", reason: `The Academy records ${chosen.qualificationCode} as expired` };
  }
  return { validity, chosen };
}

/**
 * The legacy verdict for one code. A holding marked verified with no recorded verifier is not evidence
 * of verification: it is presented to the engine as extracted, and the verdict says UNKNOWN.
 */
export function legacyVerdict(rows: readonly LegacyRow[], code: string, at: Date): { held: ReturnType<typeof heldFromValidity>; validity: Validity; chosen: LegacyRow | null; insufficient: boolean } {
  const forCode = rows.filter((r) => r.code === code);
  const holdings: QualificationHolding[] = forCode.map((r) => ({
    holdingRef: r.holdingRef, code: r.code,
    verificationState: r.supersededByHoldingRef ? "superseded"
      : r.verificationState === "verified" && (r.verifiedByUserId == null || r.verifiedAt == null) ? "extracted" : r.verificationState,
    issuedAt: r.issuedAt, expiresAt: r.expiresAt, recordedAt: r.recordedAt,
  }));
  const validity = qualificationValidity(holdings, code, at);
  const ordered = [...forCode].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const chosen = validity.version ? ordered[validity.version - 1] ?? null : ordered[ordered.length - 1] ?? null;
  const insufficient = !!chosen && chosen.verificationState === "verified" && (chosen.verifiedByUserId == null || chosen.verifiedAt == null);
  const held = insufficient
    ? { held: false, code: "unknown" as const, reason: `${code} is a legacy holding marked verified with no recorded verifier — its provenance is insufficient to establish it` }
    : heldFromValidity(validity, code, chosen?.verificationState === "extracted" ? "extracted" : "unverified");
  return { held, validity, chosen, insufficient };
}

const NOT_IN_FORCE_CODE: Partial<Record<ValidityState, NotHeldCode>> = { expired: "expired", rejected: "rejected", unverified: "unverified", none: "unknown" };

/**
 * Everyone's standing on the requested codes (or on every code on record when `codes` is omitted),
 * for one person, in the caller's organization, at `at`.
 */
export async function effectiveQualifications(
  d: DbOrTx, args: { tenantId: string; userId: number; at: Date; codes?: readonly string[] },
): Promise<EffectiveQualification[]> {
  const blank = (code: string, reason: string): EffectiveQualification => ({
    userId: args.userId, code, orgRef: args.tenantId, source: null, sourceRef: null, legacyFallback: false,
    state: "none", held: false, notHeld: "unknown", reason, issuedAt: null, expiresAt: null, verification: null,
    verifiedByUserId: null, issuer: null, certificateNumber: null, academyQualificationRef: null, evidence: null, discrepancies: [],
  });

  // Fail closed: a person outside the acting organization is not read from any store.
  if (!(await userInScope(args.userId, { tenantId: args.tenantId }))) {
    return (args.codes ?? []).map((c) => blank(c, `No ${c} on record for this person in this organization — unknown is not satisfied`));
  }

  const codeFilter = args.codes?.length ? args.codes : null;
  const academy = await d.select().from(academyQualifications).where(and(
    eq(academyQualifications.userId, args.userId),
    codeFilter ? inArray(academyQualifications.qualificationCode, [...codeFilter]) : undefined,
  ));
  const legacy = await d.select().from(workerQualifications).where(and(
    eq(workerQualifications.userId, args.userId),
    codeFilter ? inArray(workerQualifications.code, [...codeFilter]) : undefined,
    args.tenantId === SINGLE_TENANT_ID
      ? or(eq(workerQualifications.tenantId, SINGLE_TENANT_ID), isNull(workerQualifications.tenantId))
      : eq(workerQualifications.tenantId, args.tenantId),
  )).limit(500);
  const docIds = Array.from(new Set(academy.map((a) => a.complianceDocumentId).filter((x): x is number => x != null)));
  const docs = docIds.length ? await d.select().from(complianceDocuments).where(inArray(complianceDocuments.id, docIds)) : [];
  const docById = new Map<number, DocRow>(docs.map((x) => [x.id, x]));

  const codes = codeFilter ?? Array.from(new Set([...academy.map((a) => a.qualificationCode), ...legacy.map((l) => l.code)])).sort();
  return codes.map((code) => {
    const academyRows = academy.filter((a) => a.qualificationCode === code);
    const legacyRead = legacy.some((l) => l.code === code) ? legacyVerdict(legacy, code, args.at) : null;

    if (academyRows.length) {
      const { validity, chosen } = academyVerdict(academyRows, args.at);
      let held = heldFromValidity(validity, code, chosen?.status === "pending" ? "pending" : "unverified");
      const discrepancies: QualificationDiscrepancy[] = [];
      if (chosen?.status === "expired" && validity.reason.startsWith("The Academy records")) {
        discrepancies.push({ kind: "ACADEMY_STATUS_EXPIRED", detail: `status is expired while its dates read ${chosen.expiresAt ? "later" : "open-ended"}`, ref: chosen.qualificationRef });
      }
      let evidence: EffectiveQualification["evidence"] = null;
      if (chosen?.complianceDocumentId != null) {
        const doc = docById.get(chosen.complianceDocumentId);
        const ev = doc
          ? complianceDocumentValidity([{ docType: doc.docType, expiresAt: doc.expiresAt, verificationStatus: asClaimVerification(doc.verificationStatus) }], doc.docType, args.at)
          : null;
        evidence = { complianceDocumentId: chosen.complianceDocumentId, docType: doc?.docType ?? null, state: ev?.state ?? "none" };
        const docInForce = ev && (ev.state === "in_force" || ev.state === "expiring");
        if (chosen.sourceKind === "external_credential" && !docInForce) {
          held = { held: false, code: NOT_IN_FORCE_CODE[ev?.state ?? "none"] ?? "unknown", reason: `${code} rests on external credential ${chosen.complianceDocumentId}, which is ${ev?.state ?? "not on record"}` };
          discrepancies.push({ kind: "EVIDENCE_NOT_IN_FORCE", detail: `evidence document is ${ev?.state ?? "missing"}`, ref: String(chosen.complianceDocumentId) });
        }
      }
      if (legacyRead?.chosen && (legacyRead.held.held !== held.held ||
          (legacyRead.chosen.expiresAt?.getTime() ?? null) !== (chosen?.expiresAt?.getTime() ?? null))) {
        discrepancies.push({
          kind: "LEGACY_DISAGREES", ref: legacyRead.chosen.holdingRef,
          detail: `legacy holding reads ${legacyRead.held.held ? "held" : legacyRead.held.code}${legacyRead.chosen.expiresAt ? ` until ${legacyRead.chosen.expiresAt.toISOString().slice(0, 10)}` : ""}; the Academy record governs`,
        });
      }
      return {
        userId: args.userId, code, orgRef: args.tenantId, source: "ACADEMY_QUALIFICATION", sourceRef: chosen?.qualificationRef ?? null,
        legacyFallback: false, state: validity.state, held: held.held, notHeld: held.code, reason: held.reason,
        issuedAt: chosen?.validFrom ?? null, expiresAt: chosen?.expiresAt ?? null, verification: chosen?.status ?? null,
        verifiedByUserId: chosen?.verifiedByUserId ?? null, issuer: chosen ? `academy:${chosen.sourceKind}` : null,
        certificateNumber: null, academyQualificationRef: chosen?.qualificationRef ?? null, evidence, discrepancies,
      };
    }

    if (legacyRead) {
      const c = legacyRead.chosen;
      return {
        userId: args.userId, code, orgRef: args.tenantId, source: "LEGACY_WORKER_QUALIFICATION", sourceRef: c?.holdingRef ?? null,
        legacyFallback: true, state: legacyRead.insufficient ? "unverified" : legacyRead.validity.state,
        held: legacyRead.held.held, notHeld: legacyRead.held.code, reason: legacyRead.held.reason,
        issuedAt: c?.issuedAt ?? null, expiresAt: c?.expiresAt ?? null, verification: c?.verificationState ?? null,
        verifiedByUserId: c?.verifiedByUserId ?? null, issuer: c ? `legacy:recordedBy:${c.recordedByUserId}` : null,
        certificateNumber: c?.certificateNumber ?? null, academyQualificationRef: null, evidence: null, discrepancies: [],
      };
    }

    return blank(code, `No ${code} on record — unknown is not satisfied`);
  });
}
