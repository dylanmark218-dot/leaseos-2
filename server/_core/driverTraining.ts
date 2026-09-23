/**
 * LeaseOS commercial-driver training + qualification engine.
 *
 * Regulatory boundary:
 * - LeaseOS may deliver supplemental knowledge, quizzes, coaching and employer
 *   competency sign-offs.
 * - LeaseOS training does NOT create an Alberta operator licence, Q endorsement,
 *   S endorsement, or Class 1 Learning Pathway designation.
 * - Government credentials must be recorded separately and verified before a
 *   dispatch gate may rely on them.
 */

export type AlbertaCommercialLicenceClass = "1" | "2" | "3";
export type CredentialVerification = "verified" | "pending" | "rejected" | "unknown";
export type DispatchQualificationStatus = "qualified_for_dispatch" | "needs_review" | "blocked";

export type TrainingProgramDefinition = {
  code: string;
  title: string;
  jurisdiction: "CA-AB" | "CA" | "CONFIGURABLE";
  licenceClass: AlbertaCommercialLicenceClass | "ALL";
  kind: "government_pathway" | "government_endorsement" | "regulated_employer_training" | "leaseos_supplemental";
  recognition: "government_required" | "government_credential" | "regulated_employer_certificate" | "employer_competency";
  officialProviderRequired: boolean;
  durationLabel: string;
  summary: string;
  modules: Array<{
    code: string;
    title: string;
    objectives: string[];
    practical?: boolean;
  }>;
  source: {
    authority: string;
    url: string;
    effectiveNote: string;
    verifiedOn: string;
  };
};

const ALBERTA_SOURCE_VERIFIED = "2026-09-11";

/**
 * Source-backed program map plus LeaseOS supplemental competency tracks.
 * The supplemental module lists are carrier training content, not a claim that
 * Alberta uses these exact module names.
 */
export const ALBERTA_DRIVER_TRAINING_PROGRAMS: TrainingProgramDefinition[] = [
  {
    code: "AB-Q-AIR-BRAKE",
    title: "Alberta Air Brake (Q) Endorsement",
    jurisdiction: "CA-AB",
    licenceClass: "ALL",
    kind: "government_endorsement",
    recognition: "government_credential",
    officialProviderRequired: true,
    durationLabel: "Minimum 6.5 h classroom + practical training/assessment; Class 1 pathway describes an 8 h air-brake course when Q is not already held",
    summary: "Required before operating an air-brake-equipped vehicle. Class 1 applicants must complete the air-brake endorsement first.",
    modules: [
      { code: "Q-01", title: "Compressed-air brake fundamentals", objectives: ["Explain compressor, reservoirs, valves and foundation brakes", "Trace service, parking and emergency brake functions"] },
      { code: "Q-02", title: "Pressure control and warning systems", objectives: ["Recognize normal pressure build-up", "Explain governor cut-in/cut-out, low-air warning and protection valves"] },
      { code: "Q-03", title: "Brake application and stopping", objectives: ["Explain brake lag and stopping distance", "Identify conditions that increase fade, heat and stopping distance"] },
      { code: "Q-04", title: "Combination vehicle air systems", objectives: ["Identify tractor protection and trailer supply/service circuits", "Recognize hose/coupler and air-loss hazards"] },
      { code: "Q-05", title: "Air-brake pre-trip inspection", practical: true, objectives: ["Perform the required air-brake pre-trip sequence", "Identify leaks, warning-system failures and unsafe conditions"] },
      { code: "Q-06", title: "Practical assessment preparation", practical: true, objectives: ["Demonstrate the inspection in a consistent sequence", "Explain each safety-critical observation rather than memorizing clicks"] },
    ],
    source: {
      authority: "Alberta Transportation and Economic Corridors",
      url: "https://www.alberta.ca/air-brake-program",
      effectiveNote: "Current Air Brake Program; Q endorsement has no renewal requirement, but the driver licence itself must remain valid.",
      verifiedOn: ALBERTA_SOURCE_VERIFIED,
    },
  },
  {
    code: "AB-C1-LP",
    title: "Alberta Class 1 Learning Pathway",
    jurisdiction: "CA-AB",
    licenceClass: "1",
    kind: "government_pathway",
    recognition: "government_required",
    officialProviderRequired: true,
    durationLabel: "Entry 40 h + Core 67 h (60 h for contracts signed on/before 2026-08-31) + 8 h air brake course if Q not held + Competence Building 10–18 h (17–25 h before 2026-09-01) for provincial restriction removal",
    summary: "Mandatory pathway for new Alberta Class 1 drivers. Entry + Core leads to eligibility for a provincially restricted Class 1 after testing; Competence Building removes the provincial restriction.",
    modules: [
      { code: "C1-ENTRY", title: "Tier 1 · Entry Program", objectives: ["Complete the 40-hour foundational program", "Prepare for the Class 1 knowledge test"] },
      { code: "C1-CORE", title: "Tier 2 · Core Learning", practical: true, objectives: ["Complete 67 hours (60 under pre-2026-09-01 contracts) of in-yard and in-cab competence building", "Prepare for the Class 1 road test"] },
      { code: "C1-Q", title: "Air Brake Q prerequisite", practical: true, objectives: ["Hold or obtain Q before Class 1 licensing", "Demonstrate air-brake inspection competence"] },
      { code: "C1-COMP", title: "Tier 3 · Competence Building", practical: true, objectives: ["Complete individualized on-road development", "Remove the provincial restriction after successful completion"] },
      { code: "C1-ADV", title: "Tier 4 · Advanced industry training", practical: true, objectives: ["Build terrain, equipment and cargo-specific competence", "Maintain a career-long skills record"] },
    ],
    source: {
      authority: "Alberta Transportation and Economic Corridors",
      url: "https://www.alberta.ca/class-1-learning-pathway",
      effectiveNote: "Replaced Alberta Class 1 MELT for new trainees effective April 1, 2025. Training hours rebalanced effective September 1, 2026 (7 h moved from Competence Building to Core Learning; totals unchanged).",
      verifiedOn: ALBERTA_SOURCE_VERIFIED,
    },
  },
  {
    code: "LEASEOS-C1-PRO",
    title: "LeaseOS Class 1 Professional Driver Competency",
    jurisdiction: "CA-AB",
    licenceClass: "1",
    kind: "leaseos_supplemental",
    recognition: "employer_competency",
    officialProviderRequired: false,
    durationLabel: "Carrier configurable; recurrent and equipment-specific",
    summary: "Supplemental employer training for Class 1 work. It complements, but never replaces, government licensing or Class 1 Learning Pathway requirements.",
    modules: [
      { code: "L1-01", title: "Professional driver responsibilities", objectives: ["Apply carrier safety policy", "Recognize when work must stop for a compliance or safety gap"] },
      { code: "L1-02", title: "Tractor-trailer inspection", practical: true, objectives: ["Complete pre-trip/post-trip inspection", "Recognize safety-critical defects and escalation paths"] },
      { code: "L1-03", title: "Coupling and uncoupling", practical: true, objectives: ["Verify fifth wheel, kingpin, jaws, lines and landing gear", "Use tug-test and visual verification"] },
      { code: "L1-04", title: "Backing and low-speed manoeuvres", practical: true, objectives: ["Use GOAL and spotter protocols", "Control blind-side and offset backing risk"] },
      { code: "L1-05", title: "Speed, space and grades", practical: true, objectives: ["Select safe speed and following distance", "Use appropriate downhill speed-control strategy and avoid brake overheating"] },
      { code: "L1-06", title: "Weights, dimensions and securement", objectives: ["Read axle/GVW information", "Trigger permit and cargo-securement checks instead of guessing legal limits"] },
      { code: "L1-07", title: "Hours of service and fatigue", objectives: ["Record duty status accurately", "Recognize fatigue and dispatch conflicts"] },
      { code: "L1-08", title: "TDG and emergency response", objectives: ["Recognize when TDG training/documentation is required", "Follow spill, collision and emergency escalation procedures"] },
      { code: "L1-09", title: "Winter, mountain and remote-road operations", practical: true, objectives: ["Plan for traction, visibility and stopping distance", "Use company radio/check-in and remote-work controls"] },
      { code: "L1-10", title: "Oilfield and lease-road operations", practical: true, objectives: ["Apply lease/haul-road radio protocols", "Manage soft shoulders, narrow roads, turnarounds and site hazards"] },
    ],
    source: {
      authority: "LeaseOS carrier competency framework",
      url: "internal://leaseos/training/class1",
      effectiveNote: "Supplemental employer competency only; not an Alberta licensing credential.",
      verifiedOn: ALBERTA_SOURCE_VERIFIED,
    },
  },
  {
    code: "LEASEOS-C2-BUS",
    title: "LeaseOS Class 2 Bus Driver Competency",
    jurisdiction: "CA-AB",
    licenceClass: "2",
    kind: "leaseos_supplemental",
    recognition: "employer_competency",
    officialProviderRequired: false,
    durationLabel: "Carrier configurable; practical sign-off required",
    summary: "Supplemental Class 2 bus competency. Alberta eliminated Class 2 MELT in 2023; licensing still requires the applicable knowledge, vision, medical and road-test requirements.",
    modules: [
      { code: "L2-01", title: "Bus systems and pre-trip", practical: true, objectives: ["Inspect passenger, emergency and vehicle systems", "Identify defects affecting safe passenger service"] },
      { code: "L2-02", title: "Passenger loading and unloading", practical: true, objectives: ["Control curbside and passenger movement hazards", "Confirm doors, clearances and safe departure"] },
      { code: "L2-03", title: "Mirrors, turns and swept path", practical: true, objectives: ["Set and scan mirrors", "Manage tail swing, off-tracking and vulnerable road users"] },
      { code: "L2-04", title: "Passenger management and accessibility", objectives: ["Apply safe passenger conduct procedures", "Use accessibility equipment and securement according to employer procedure"] },
      { code: "L2-05", title: "Emergency and evacuation", practical: true, objectives: ["Locate emergency equipment and exits", "Carry out evacuation and incident communication drills"] },
      { code: "L2-06", title: "School bus endorsement awareness", objectives: ["Recognize when an S endorsement is required", "Keep school-bus training separate from ordinary Class 2 qualification"] },
      { code: "L2-07", title: "Air-brake integration", practical: true, objectives: ["Require verified Q before air-brake bus dispatch", "Perform company air-system inspection checks"] },
    ],
    source: {
      authority: "LeaseOS carrier competency framework + Alberta commercial licensing references",
      url: "https://www.alberta.ca/upgrade-commercial-licence",
      effectiveNote: "Employer competency layer; not a replacement for Class 2 licensing or S/Q endorsements.",
      verifiedOn: ALBERTA_SOURCE_VERIFIED,
    },
  },
  {
    code: "LEASEOS-C3-TRUCK",
    title: "LeaseOS Class 3 Truck Driver Competency",
    jurisdiction: "CA-AB",
    licenceClass: "3",
    kind: "leaseos_supplemental",
    recognition: "employer_competency",
    officialProviderRequired: false,
    durationLabel: "Carrier configurable; vehicle-type practical sign-off required",
    summary: "Supplemental training for straight trucks with three or more axles, including vocational units such as dump, vacuum and hydrovac trucks.",
    modules: [
      { code: "L3-01", title: "Three-or-more-axle vehicle inspection", practical: true, objectives: ["Complete a commercial pre-trip", "Identify steering, suspension, tire, wheel and brake defects"] },
      { code: "L3-02", title: "Air brakes and Q verification", practical: true, objectives: ["Require Q for an air-brake-equipped unit", "Perform company air-system checks without substituting for the official endorsement"] },
      { code: "L3-03", title: "Weight, axle loading and stability", objectives: ["Recognize load-shift and high-centre-of-gravity risk", "Use measured weights and configured legal checks rather than assumptions"] },
      { code: "L3-04", title: "Backing, sites and spotters", practical: true, objectives: ["Use GOAL and spotters", "Control congested-site and blind-area hazards"] },
      { code: "L3-05", title: "Vocational equipment / PTO", practical: true, objectives: ["Follow equipment-specific PTO/interlock procedure", "Separate driving authorization from equipment-operation authorization"] },
      { code: "L3-06", title: "Gravel, forestry and lease roads", practical: true, objectives: ["Use radio and right-of-way protocols", "Adapt speed to surface, grade, dust and visibility"] },
      { code: "L3-07", title: "Loads, securement and dangerous goods", objectives: ["Trigger securement/TDG checks when applicable", "Verify documents before movement"] },
      { code: "L3-08", title: "Emergency response and defect escalation", objectives: ["Stop work for safety-critical defects", "Create traceable incident, defect and maintenance records"] },
    ],
    source: {
      authority: "LeaseOS carrier competency framework + Alberta commercial licensing references",
      url: "https://www.alberta.ca/upgrade-commercial-licence",
      effectiveNote: "Employer competency layer; not a replacement for Class 3 licensing or Q endorsement.",
      verifiedOn: ALBERTA_SOURCE_VERIFIED,
    },
  },
];

export type VerifiedDriverCredential = {
  code: "LICENCE" | "Q" | "S" | "C1LP_ENTRY" | "C1LP_CORE" | "C1LP_COMP" | string;
  verification: CredentialVerification;
  expiresAt?: string | null;
};

export type DriverQualificationProfile = {
  operatorId?: number;
  licenceClass?: "1" | "2" | "3" | "4" | "5" | null;
  licenceVerification: CredentialVerification;
  licenceExpiresAt?: string | null;
  /** True when the Class 1 licence is restricted to operation within Alberta. */
  class1ProvincialRestriction?: boolean;
  credentials: VerifiedDriverCredential[];
  completedCompetencies?: Array<{
    code: string;
    verification: CredentialVerification;
    expiresAt?: string | null;
  }>;
};

export type MovementQualificationRequirement = {
  requiredLicenceClass: AlbertaCommercialLicenceClass;
  airBrakes: boolean;
  schoolBus?: boolean;
  dangerousGoods?: boolean;
  /** Use only when a trained TDG certificate holder will be physically present. */
  tdgDirectSupervision?: boolean;
  tdgSupervisorCertificateVerified?: boolean;
  /** e.g. CA-AB, CA-SK. Used only to enforce a known Alberta C1 provincial restriction. */
  destinationJurisdiction?: string | null;
  requiredEmployerCompetencies?: string[];
};

export type QualificationDecision = {
  status: DispatchQualificationStatus;
  blockers: string[];
  reviewItems: string[];
  satisfied: string[];
  disclaimer: string;
};

function isExpired(date: string | null | undefined, now: Date): boolean {
  if (!date) return false;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() < now.getTime();
}

function licenceCovers(actual: DriverQualificationProfile["licenceClass"], required: AlbertaCommercialLicenceClass): boolean {
  if (!actual) return false;
  if (required === "1") return actual === "1";
  if (required === "2") return actual === "1" || actual === "2";
  return actual === "1" || actual === "2" || actual === "3";
}

function findCredential(profile: DriverQualificationProfile, code: string) {
  return profile.credentials.find(c => c.code === code);
}

/**
 * Fail-closed dispatch qualification gate.
 * "qualified_for_dispatch" means the configured credential checks passed. It
 * is not a legal opinion and does not replace carrier/regulator obligations.
 */
export function evaluateDriverQualification(
  profile: DriverQualificationProfile,
  requirement: MovementQualificationRequirement,
  now = new Date(),
): QualificationDecision {
  const blockers: string[] = [];
  const reviewItems: string[] = [];
  const satisfied: string[] = [];

  if (profile.licenceVerification === "rejected") {
    blockers.push("Driver licence verification was rejected");
  } else if (profile.licenceVerification !== "verified") {
    reviewItems.push("Driver licence is not verified");
  } else if (!licenceCovers(profile.licenceClass, requirement.requiredLicenceClass)) {
    blockers.push(`Verified Class ${profile.licenceClass ?? "unknown"} does not cover required Class ${requirement.requiredLicenceClass}`);
  } else {
    satisfied.push(`Verified Class ${profile.licenceClass} covers required Class ${requirement.requiredLicenceClass}`);
  }

  if (isExpired(profile.licenceExpiresAt, now)) {
    blockers.push("Driver licence is expired");
  }

  if (
    requirement.requiredLicenceClass === "1" &&
    profile.class1ProvincialRestriction &&
    requirement.destinationJurisdiction &&
    requirement.destinationJurisdiction !== "CA-AB"
  ) {
    blockers.push("Class 1 licence is provincially restricted to Alberta for this movement");
  } else if (requirement.requiredLicenceClass === "1" && profile.class1ProvincialRestriction) {
    satisfied.push("Class 1 provincial restriction is compatible with an Alberta-only movement");
  }

  if (requirement.airBrakes) {
    const q = findCredential(profile, "Q");
    if (!q) {
      blockers.push("Air-brake-equipped vehicle requires a verified Q endorsement");
    } else if (q.verification === "rejected") {
      blockers.push("Q endorsement verification was rejected");
    } else if (q.verification !== "verified") {
      reviewItems.push("Q endorsement exists but is not verified");
    } else {
      satisfied.push("Verified Q air-brake endorsement");
    }
  }

  if (requirement.schoolBus) {
    const s = findCredential(profile, "S");
    if (!s) blockers.push("School bus movement requires an S endorsement unless a configured exemption applies");
    else if (s.verification !== "verified") reviewItems.push("S endorsement is not verified");
    else satisfied.push("Verified S school-bus endorsement");
  }

  if (requirement.dangerousGoods) {
    const tdg = findCredential(profile, "TDG");
    if (!tdg) {
      if (requirement.tdgDirectSupervision && requirement.tdgSupervisorCertificateVerified) {
        reviewItems.push("TDG direct-supervision mode requires a trained certificate holder to be physically present; remote app/camera supervision is not sufficient");
      } else {
        blockers.push("Dangerous-goods movement requires a verified/current TDG training certificate unless a valid direct-supervision pathway is explicitly configured");
      }
    } else if (tdg.verification === "rejected") {
      blockers.push("TDG training certificate verification was rejected");
    } else if (tdg.verification !== "verified") {
      reviewItems.push("TDG training certificate exists but is not verified");
    } else if (isExpired(tdg.expiresAt, now)) {
      blockers.push("TDG training certificate is expired");
    } else {
      satisfied.push("Verified/current TDG road training certificate");
    }
  }

  for (const code of requirement.requiredEmployerCompetencies ?? []) {
    const competency = profile.completedCompetencies?.find(c => c.code === code);
    if (!competency) {
      blockers.push(`Required employer competency ${code} is missing`);
      continue;
    }
    if (competency.verification !== "verified") {
      reviewItems.push(`Employer competency ${code} is not verified`);
      continue;
    }
    if (isExpired(competency.expiresAt, now)) {
      blockers.push(`Employer competency ${code} is expired`);
      continue;
    }
    satisfied.push(`Employer competency ${code} verified`);
  }

  return {
    status: blockers.length ? "blocked" : reviewItems.length ? "needs_review" : "qualified_for_dispatch",
    blockers,
    reviewItems,
    satisfied,
    disclaimer: "LeaseOS evaluates configured dispatch prerequisites; it does not issue licences/endorsements or make a final legal determination.",
  };
}
