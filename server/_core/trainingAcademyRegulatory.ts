import { stableHash, type CredentialBoundary } from "./trainingAcademy";

export type SourceTier = "authority" | "industry_association" | "vendor" | "unknown";
export type CertificateTransportMode = "road" | "rail" | "vessel" | "air" | "workplace" | "company";

export type AcademyRegulatoryProfileSeed = {
  profileRef: string;
  qualificationCode: string;
  mode: CertificateTransportMode;
  profileVersion: number;
  credentialBoundary: Extract<CredentialBoundary, "employer_certificate" | "company_certificate">;
  validityMonths: number | null;
  retentionMonthsAfterExpiry: number | null;
  requiresEmployeeSignature: boolean;
  requiresEmployerSignature: boolean;
  requiresReasonableGroundsAttestation: boolean;
  sourceSnapshotRef: string;
  effectiveAt: string;
  notes: string;
};

/**
 * Versioned issuance rules.  These are deliberately narrow.  If a qualification
 * is not here, an employer_certificate cannot be issued until a reviewed profile
 * is added rather than guessing an expiry/signature rule.
 */
export const ACADEMY_REGULATORY_PROFILES: AcademyRegulatoryProfileSeed[] = [
  {
    profileRef: "REG-TDG-ROAD-V1",
    qualificationCode: "TDG_ROAD",
    mode: "road",
    profileVersion: 1,
    credentialBoundary: "employer_certificate",
    validityMonths: 36,
    retentionMonthsAfterExpiry: 24,
    requiresEmployeeSignature: true,
    requiresEmployerSignature: true,
    requiresReasonableGroundsAttestation: true,
    sourceSnapshotRef: "SRC-TDG-ROAD-2026",
    effectiveAt: "2026-09-11T00:00:00.000Z",
    notes: "TDG road certificate: 36-month validity; keep record/certificate until two years after expiry; employee and employer-representative signatures required.",
  },
  {
    profileRef: "REG-WHMIS-EMPLOYER-V1",
    qualificationCode: "WHMIS_EMPLOYER",
    mode: "workplace",
    profileVersion: 1,
    credentialBoundary: "employer_certificate",
    validityMonths: null,
    retentionMonthsAfterExpiry: null,
    requiresEmployeeSignature: false,
    requiresEmployerSignature: false,
    requiresReasonableGroundsAttestation: false,
    sourceSnapshotRef: "SRC-WHMIS-AB-2026",
    effectiveAt: "2026-09-11T00:00:00.000Z",
    notes: "No universal statutory fixed WHMIS certificate expiry is manufactured by LeaseOS. Employer review/assignment rules remain separate requirements.",
  },
];

export const TDG_REASONABLE_GROUNDS_ATTESTATION =
  "I have reasonable grounds to believe this employee is adequately trained for the dangerous-goods duties and scope stated on this certificate and will perform duties to which the training relates.";

export function regulatoryProfileHash(profile: AcademyRegulatoryProfileSeed): string {
  return stableHash(profile);
}

/** Add calendar months while clamping to the last valid day of the target month. */
export function addCalendarMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const ss = date.getUTCSeconds();
  const ms = date.getUTCMilliseconds();
  const targetFirst = new Date(Date.UTC(y, m + months, 1, hh, mm, ss, ms));
  const lastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  targetFirst.setUTCDate(Math.min(d, lastDay));
  return targetFirst;
}

export function certificateTerms(args: {
  issuedAt: Date;
  credentialBoundary: Extract<CredentialBoundary, "employer_certificate" | "company_certificate">;
  profile?: AcademyRegulatoryProfileSeed | null;
  callerSuppliedExpiry?: Date | null;
  companyValidityMonths?: number | null;
}) {
  const blockers: string[] = [];
  if (args.credentialBoundary === "employer_certificate") {
    if (args.callerSuppliedExpiry) blockers.push("Caller-supplied expiry is not permitted for an employer/regulated certificate; LeaseOS computes certificate terms from the versioned regulatory profile");
    if (!args.profile) blockers.push("No versioned regulatory issuance profile exists for this employer certificate");
    if (args.profile && args.profile.credentialBoundary !== "employer_certificate") blockers.push("Regulatory profile boundary does not match the course credential boundary");
    const expiresAt = args.profile?.validityMonths == null ? null : addCalendarMonths(args.issuedAt, args.profile.validityMonths);
    const retentionUntil = expiresAt && args.profile?.retentionMonthsAfterExpiry != null
      ? addCalendarMonths(expiresAt, args.profile.retentionMonthsAfterExpiry)
      : null;
    return { permitted: blockers.length === 0, blockers, expiresAt, retentionUntil };
  }

  if (args.callerSuppliedExpiry) blockers.push("Company certificates accept a configured validity interval, not a caller-supplied absolute expiry date");
  if (args.companyValidityMonths != null && (!Number.isInteger(args.companyValidityMonths) || args.companyValidityMonths < 1 || args.companyValidityMonths > 120)) {
    blockers.push("Company certificate validity interval must be an integer from 1 to 120 months");
  }
  const expiresAt = args.companyValidityMonths ? addCalendarMonths(args.issuedAt, args.companyValidityMonths) : null;
  return { permitted: blockers.length === 0, blockers, expiresAt, retentionUntil: null as Date | null };
}

export function sourceTierCanGovernCertificate(args: { tier: SourceTier | null; credentialBoundary: CredentialBoundary }) {
  if (args.credentialBoundary === "external_track_only" || args.credentialBoundary === "knowledge_only") return true;
  if (args.tier === "vendor") return false;
  if (args.tier === "unknown" || !args.tier) return false;
  return true;
}

export function signatureRequirements(profile: AcademyRegulatoryProfileSeed | null) {
  return {
    employee: !!profile?.requiresEmployeeSignature,
    employer: !!profile?.requiresEmployerSignature,
    attestation: !!profile?.requiresReasonableGroundsAttestation,
  };
}

export function certificateFinalizationDecision(args: {
  requiresEmployeeSignature: boolean;
  requiresEmployerSignature: boolean;
  employeeSignaturePresent: boolean;
  employerSignaturePresent: boolean;
  attestationRequired: boolean;
  attestationPresent: boolean;
}) {
  const blockers: string[] = [];
  if (args.requiresEmployeeSignature && !args.employeeSignaturePresent) blockers.push("Employee signature is required before this certificate becomes active");
  if (args.requiresEmployerSignature && !args.employerSignaturePresent) blockers.push("Employer representative signature is required before this certificate becomes active");
  if (args.attestationRequired && !args.attestationPresent) blockers.push("Employer reasonable-grounds attestation is required before this certificate becomes active");
  return { permitted: blockers.length === 0, blockers };
}

export function certificateRetentionDeletionDecision(args: { retentionUntil: Date | null; now?: Date }) {
  const now = args.now ?? new Date();
  if (args.retentionUntil && args.retentionUntil > now) {
    return { permitted: false, blockers: [`Certificate/record must be retained until ${args.retentionUntil.toISOString()}`] };
  }
  return { permitted: true, blockers: [] as string[] };
}

export function foreignTdgRoadCertificateDecision(args: {
  issuingJurisdiction: string;
  vehicleLicenceJurisdiction: string;
  trainingStandard: string;
  documentValidInIssuingJurisdiction: boolean;
  expiresAt: Date | null;
  now?: Date;
}) {
  const blockers: string[] = [];
  const now = args.now ?? new Date();
  if (args.issuingJurisdiction !== "US") blockers.push("This recognition path is only for the TDG 6.4 United States road-driver pathway");
  if (args.vehicleLicenceJurisdiction !== "US") blockers.push("TDG 6.4 road recognition requires the road vehicle driver to be licensed in the United States");
  const normalized = args.trainingStandard.replace(/\s+/g, "").toLowerCase();
  if (!(normalized.includes("49cfr172.700") && normalized.includes("172.704"))) blockers.push("Foreign road certificate must indicate training in accordance with 49 CFR 172.700 to 172.704");
  if (!args.documentValidInIssuingJurisdiction) blockers.push("Foreign certificate is not confirmed valid in the issuing jurisdiction");
  if (!args.expiresAt) blockers.push("Foreign certificate validity/expiry is unknown");
  else if (args.expiresAt <= now) blockers.push("Foreign certificate is expired");
  return { permitted: blockers.length === 0, blockers };
}
