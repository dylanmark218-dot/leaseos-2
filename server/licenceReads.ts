/**
 * SPINE item 2 — a person's driver-licence standing, read once and judged canonically.
 *
 * Open-shift eligibility and shift readiness both need "is this person's licence in force?". The
 * answer is `driverLicenceVerdict` (complianceDocumentValidity): structured `driver_licence`
 * documents first, the legacy `operators.licenseExpiresAt` only as an unverified claim. This reads
 * what that verdict needs — the person's own operator record, through `operators.userId` in the
 * caller's organization, its licence documents and its legacy date — and returns the verdict
 * without judging anything itself. The open-work files reach the licence only through here, the
 * same way they reach a qualification only through `qualificationReads.effectiveQualifications`.
 */
import { and, eq, inArray } from "drizzle-orm";
import { complianceDocuments, operators } from "../drizzle/schema";
import { DRIVER_LICENCE_DOC_TYPES, driverLicenceVerdict } from "./_core/complianceDocumentValidity";
import type { DbOrTx } from "./_core/dbTypes";
import type { OperatorResolution } from "./_core/operatorIdentity";
import type { LicenceStanding } from "./_core/openShifts";

/**
 * The canonical verdict at `at`, narrowed to what the open-shift rule and shift readiness read.
 * The narrowing is a table, not a judgement: every verdict state maps to exactly one standing.
 */
export async function driverLicenceStanding(d: DbOrTx, operator: OperatorResolution, at: Date): Promise<LicenceStanding> {
  if (operator.kind === "none") return { kind: "none" };
  if (operator.kind === "ambiguous") return { kind: "ambiguous" };
  const [legacy, rows] = await Promise.all([
    d.select({ licenseExpiresAt: operators.licenseExpiresAt }).from(operators).where(eq(operators.id, operator.operatorId)).limit(1),
    d.select().from(complianceDocuments).where(and(
      eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, operator.operatorId),
      inArray(complianceDocuments.docType, [...DRIVER_LICENCE_DOC_TYPES]),
    )),
  ]);
  return standingOf(driverLicenceVerdict(rows, legacy[0]?.licenseExpiresAt ?? null, at));
}

export function standingOf(v: ReturnType<typeof driverLicenceVerdict>): LicenceStanding {
  switch (v.state) {
    case "in_force":
    case "expiring":
      return { kind: "in_force" };
    case "expired":
      return { kind: "lapsed", expiresAt: v.expiresAt };
    case "none":
      return { kind: "none" };
    case "unverified":
      return v.claimLapsed ? { kind: "lapsed", expiresAt: v.claimedExpiresAt } : { kind: "not_established", reason: v.reason };
    case "incomplete":
    case "rejected":
    case "not_yet_effective":
      return { kind: "not_established", reason: v.reason };
  }
}
