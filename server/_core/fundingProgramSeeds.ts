/**
 * Funding program seeds.
 *
 * Every program here comes from a research summary supplied to the project. The
 * percentages, caps, deadlines and eligibility rules are recorded exactly as
 * that summary stated them — and **every one is `unverified`**, because none has
 * been checked against the administering authority.
 *
 * That is not a formality. The summary itself corrected two figures from an
 * earlier draft (a training grant that had been replaced by a successor, and a
 * financing ceiling that was understated by more than half). Program terms
 * change, intakes close, funding runs out. A cap transcribed from a summary
 * and shown to a customer as "you may be eligible for $X" is a promise LeaseOS
 * cannot keep.
 *
 * So `matchProgram` will never rate an unverified program "strong", and
 * `estimateCostShare` labels every figure derived from one as coming from
 * unverified details. A test asserts the seed contains zero verified programs.
 */

import type { FundingProgram } from "./fundingIntelligence";

export const PROGRAM_SEED_DATE = new Date("2026-09-09T00:00:00Z");

const CLAIMED = "claimed by supplied summary, unverified against authority";

export const FUNDING_PROGRAM_SEEDS: readonly FundingProgram[] = [
  {
    programKey: "ab.capg",
    version: 1,
    officialName: "Canada-Alberta Productivity Grant",
    governmentLevel: "provincial",
    country: "CA",
    province: "AB",
    programType: "cost_share",
    deliveryMechanism: "application_intake",
    categoryKey: "training",
    applicantTypes: ["corporation", "sole_proprietor", "partnership"],
    industries: [],
    exclusions: [],
    parameters: {
      // Existing employee stream, as claimed.
      coveragePercent: 50,
      capPerUnit: 5000,
      capPerApplicant: 100000,
      unemployedStreamCoveragePercent: 75,
      unemployedStreamCapPerUnit: 10000,
      applyBeforeTrainingStarts: true,
      note: CLAIMED,
    },
    preApprovalRequired: true,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: false,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Government of Alberta",
  },
  {
    programKey: "ab.workforce_resilience.employer_training",
    version: 1,
    officialName: "Canada-Alberta Workforce Resilience Initiative — Employer-led Training Grant",
    governmentLevel: "provincial",
    country: "CA",
    province: "AB",
    programType: "cost_share",
    deliveryMechanism: "application_intake",
    categoryKey: "training",
    applicantTypes: ["corporation", "sole_proprietor", "partnership"],
    industries: [
      "transportation_warehousing", "agriculture", "forestry",
      "manufacturing", "mining_quarrying", "oil_gas_extraction",
    ],
    exclusions: [],
    parameters: { note: CLAIMED },
    preApprovalRequired: true,
    stackingRule: "unknown",
    // Claimed to close 2026-09-30 or on exhaustion. Temporary, so the record
    // carries a close date and an exhaustion flag instead of "grant available".
    programStatus: "unknown",
    intakeClosesAt: new Date("2026-09-30T23:59:59Z"),
    fundingExhaustionPossible: true,
    temporaryProgram: true,
    verificationStatus: "unverified",
    sourceAuthority: "Government of Alberta",
  },
  {
    programKey: "ca.csbfp",
    version: 1,
    officialName: "Canada Small Business Financing Program",
    governmentLevel: "federal",
    country: "CA",
    programType: "loan_guarantee",
    deliveryMechanism: "lender",
    categoryKey: "financing",
    applicantTypes: ["corporation", "sole_proprietor", "partnership"],
    industries: [],
    // Farming businesses are directed elsewhere. Recorded as an exclusion on
    // the program so the matcher routes them, rather than a hard-coded branch.
    exclusions: ["farming"],
    parameters: {
      maxRevenue: 10000000,
      overallMaximum: 1150000,
      termLoanMaximum: 1000000,
      lineOfCreditMaximum: 150000,
      equipmentLeaseholdSubLimit: 500000,
      note: CLAIMED,
    },
    preApprovalRequired: false,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: false,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Innovation, Science and Economic Development Canada",
  },
  {
    programKey: "ca.cala",
    version: 1,
    officialName: "Canadian Agricultural Loans Act Program",
    governmentLevel: "federal",
    country: "CA",
    programType: "loan_guarantee",
    deliveryMechanism: "lender",
    categoryKey: "agriculture",
    applicantTypes: ["farming"],
    industries: ["agriculture"],
    exclusions: [],
    parameters: { totalMaximum: 500000, note: CLAIMED },
    preApprovalRequired: false,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: false,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Agriculture and Agri-Food Canada",
  },
  {
    programKey: "ab.sustainable_cap",
    version: 1,
    officialName: "Sustainable Canadian Agricultural Partnership — Alberta programs",
    governmentLevel: "provincial",
    country: "CA",
    province: "AB",
    programType: "cost_share",
    deliveryMechanism: "application_intake",
    categoryKey: "agriculture",
    applicantTypes: ["farming"],
    industries: ["agriculture"],
    exclusions: [],
    // A program family. Individual streams open and close independently, so
    // this record is the family and streams are recorded as they are verified.
    parameters: {
      frameworkYears: "2023-2028",
      streamsClaimedOpen: ["water", "on_farm_value_added", "emerging_opportunities", "value_added"],
      streamsClaimedClosed: ["on_farm_efficiency"],
      note: CLAIMED,
    },
    preApprovalRequired: true,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: true,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Government of Alberta / Agriculture and Agri-Food Canada",
  },
  {
    programKey: "ca.sred",
    version: 1,
    officialName: "Scientific Research and Experimental Development",
    governmentLevel: "federal",
    country: "CA",
    programType: "refundable_tax_credit",
    deliveryMechanism: "tax_return",
    categoryKey: "rd_innovation",
    applicantTypes: ["corporation", "sole_proprietor", "partnership"],
    industries: [],
    exclusions: [],
    parameters: { note: CLAIMED, expandedIn2026: true },
    preApprovalRequired: false,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: false,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Canada Revenue Agency",
  },
  {
    programKey: "ab.innovation_employment_grant",
    version: 1,
    officialName: "Alberta Innovation Employment Grant",
    governmentLevel: "provincial",
    country: "CA",
    province: "AB",
    // Delivered through the corporate tax system, not an application intake.
    // The workflow is different and the record says so.
    programType: "tax_system_grant",
    deliveryMechanism: "tax_return",
    categoryKey: "rd_innovation",
    applicantTypes: ["corporation"],
    industries: [],
    exclusions: [],
    parameters: { coveragePercent: 20, note: CLAIMED },
    preApprovalRequired: false,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: false,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Government of Alberta",
  },
  {
    programKey: "ca.clean_technology_itc",
    version: 1,
    officialName: "Clean Technology Investment Tax Credit",
    governmentLevel: "federal",
    country: "CA",
    programType: "refundable_tax_credit",
    deliveryMechanism: "tax_return",
    categoryKey: "clean_technology",
    applicantTypes: ["corporation"],
    industries: [],
    exclusions: [],
    parameters: {
      regularRatePercent: 30,
      throughYear: 2033,
      // Rate depends on labour requirements. That links the credit to the
      // workforce records LeaseOS already keeps — and it is a claim to verify.
      labourRequirementsAffectRate: true,
      note: CLAIMED,
    },
    preApprovalRequired: false,
    stackingRule: "unknown",
    programStatus: "unknown",
    fundingExhaustionPossible: false,
    temporaryProgram: false,
    verificationStatus: "unverified",
    sourceAuthority: "Canada Revenue Agency",
  },
];

/**
 * Worker-facing personal tax topics. Not programs a company applies to —
 * deductions an individual may investigate with their own accountant. They are
 * surfaced in the personal organizer as "worth asking about", never as a
 * determination, and GPS or rotation data is evidence for that conversation,
 * never a residency ruling.
 */
export const WORKER_TAX_TOPICS: readonly {
  topicKey: string;
  title: string;
  evidenceLeaseOsHolds: readonly string[];
  employerCertificationMayBeRequired: boolean;
  verificationStatus: "unverified";
}[] = [
  {
    topicKey: "tradesperson_tools",
    title: "Tradesperson tool expenses",
    evidenceLeaseOsHolds: ["tool receipts", "employer certification form status"],
    employerCertificationMayBeRequired: true,
    verificationStatus: "unverified",
  },
  {
    topicKey: "northern_residents",
    title: "Northern residents deductions",
    evidenceLeaseOsHolds: ["work locations", "rotation dates", "travel records", "allowances"],
    employerCertificationMayBeRequired: false,
    verificationStatus: "unverified",
  },
  {
    topicKey: "employment_expenses",
    title: "Employment expenses",
    evidenceLeaseOsHolds: ["receipts", "mileage", "employer certification form status"],
    employerCertificationMayBeRequired: true,
    verificationStatus: "unverified",
  },
];
