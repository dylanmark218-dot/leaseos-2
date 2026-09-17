import type { AcceptanceStatus, CompatibilityOutcome, CoordinatePrecision, WasteCode } from "../../shared/facilities";

export type FacilityAssessmentInput = {
  loadWasteCode?: WasteCode; capabilityWasteCode?: WasteCode; acceptanceStatus: AcceptanceStatus;
  coordinatePrecision: CoordinatePrecision; coordinateSourceUrl?: string; evidenceIds: number[];
  evidenceVerifiedAt?: Date; assessedAt: Date; accountRequired: boolean; accountApproved: boolean;
  facilityOpen: boolean; routeReviewPassed: boolean; conflictingEvidence?: boolean;
};
export type FacilityAssessmentResult = { outcome: CompatibilityOutcome; reasonCodes: string[]; blocking: boolean; evidenceIds: number[]; engineVersion: "facility-compatibility/1" };

export function assessFacilityCompatibility(input: FacilityAssessmentInput): FacilityAssessmentResult {
  const reasons: string[] = [];
  let outcome: CompatibilityOutcome = "compatible_verified";
  if (input.acceptanceStatus === "not_accepted" || (input.loadWasteCode && input.capabilityWasteCode && input.loadWasteCode !== input.capabilityWasteCode)) {
    outcome = "incompatible"; reasons.push("waste_stream_not_accepted");
  } else if (!input.loadWasteCode || !input.capabilityWasteCode || input.conflictingEvidence || input.evidenceIds.length === 0 ||
    !["verified_entrance", "verified_site"].includes(input.coordinatePrecision) || !input.coordinateSourceUrl) {
    outcome = "insufficient_information";
    if (!input.loadWasteCode) reasons.push("load_classification_missing");
    if (!input.capabilityWasteCode) reasons.push("facility_capability_missing");
    if (input.conflictingEvidence) reasons.push("evidence_conflict");
    if (input.evidenceIds.length === 0) reasons.push("acceptance_evidence_missing");
    if (!["verified_entrance", "verified_site"].includes(input.coordinatePrecision)) reasons.push("coordinate_not_verified");
    if (!input.coordinateSourceUrl) reasons.push("coordinate_source_missing");
  } else {
    const ageDays = input.evidenceVerifiedAt ? (input.assessedAt.getTime() - input.evidenceVerifiedAt.getTime()) / 86_400_000 : Infinity;
    if (input.acceptanceStatus !== "verified") reasons.push("facility_confirmation_required");
    if (ageDays > 365) reasons.push("acceptance_evidence_stale");
    if (input.accountRequired && !input.accountApproved) reasons.push("account_approval_required");
    if (!input.facilityOpen) reasons.push("facility_status_not_open");
    if (!input.routeReviewPassed) reasons.push("route_review_required");
    if (reasons.length) outcome = "facility_confirmation_required";
  }
  return { outcome, reasonCodes: reasons, blocking: outcome !== "compatible_verified", evidenceIds: [...input.evidenceIds], engineVersion: "facility-compatibility/1" };
}
