/**
 * LeaseOS AI Secretary compliance helpers.
 *
 * Safety boundary:
 * - These helpers organize verified facts and configured rules.
 * - They do not classify an unknown product, invent a UN number, or make a final
 *   placarding / manifest / emergency-response determination from free text.
 * - Unknown, conflicting, expired, or unverified inputs fail closed or route to
 *   human review.
 */

export type KnowledgeCategory =
  | "tdg"
  | "whmis"
  | "erg"
  | "placards"
  | "waste_manifest"
  | "cargo_securement"
  | "company_policy";

export type ComplianceKnowledgeItemDefinition = {
  code: string;
  category: KnowledgeCategory;
  title: string;
  jurisdiction: string;
  summary: string;
  learningPoints: string[];
  source: {
    authority: string;
    url: string;
    regulatoryVersion: string;
    verifiedOn: string;
  };
};

const VERIFIED_ON = "2026-09-11";

export const COMPLIANCE_KNOWLEDGE_CATALOG: ComplianceKnowledgeItemDefinition[] = [
  {
    code: "TDG-P6-TRAINING",
    category: "tdg",
    title: "TDG training certificate and adequate training",
    jurisdiction: "CA",
    summary: "A person who handles, offers for transport, or transports dangerous goods must be adequately trained and hold a valid training certificate, or perform the work under direct physical supervision of a trained certificate holder.",
    learningPoints: [
      "Match training to the employee's actual duties and dangerous goods handled or transported.",
      "For road transport, a TDG training certificate expires 36 months after issue.",
      "Keep the training record or statement of experience and a copy of the certificate until two years after the certificate expires.",
      "Direct supervision is a physical-accompaniment concept; remote camera or app monitoring is not a substitute.",
    ],
    source: {
      authority: "Transport Canada",
      url: "https://tc.canada.ca/en/dangerous-goods/part-6",
      regulatoryVersion: "TDG Regulations Part 6",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "TDG-P3-DOCUMENTATION",
    category: "tdg",
    title: "TDG shipping-document knowledge",
    jurisdiction: "CA",
    summary: "LeaseOS should validate required fields from a verified load profile and keep shipping-document workflow separate from product classification.",
    learningPoints: [
      "The consignor prepares/provides the shipping document before the carrier takes possession, unless a valid exemption applies.",
      "The carrier must have the shipping document before taking possession of dangerous goods.",
      "Core data includes the verified dangerous-goods description such as UN number, shipping name, class, quantity and required contact information.",
      "LeaseOS should flag missing or conflicting fields instead of silently repairing a dangerous-goods description.",
    ],
    source: {
      authority: "Transport Canada",
      url: "https://tc.canada.ca/en/dangerous-goods/publications/shipping-document",
      regulatoryVersion: "TDG Regulations Part 3",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "TDG-P4-MARKS",
    category: "placards",
    title: "TDG labels, placards and dangerous-goods marks",
    jurisdiction: "CA",
    summary: "Labels, placards, UN numbers and other dangerous-goods marks identify the verified hazard in transport. LeaseOS may recommend a checklist only after classification inputs are verified.",
    learningPoints: [
      "Generally, labels apply to small means of containment and placards to large means of containment; the exact Part 4 rule still controls.",
      "Marks must be visible, legible, durable, weather resistant and not misleading.",
      "Carrier responsibilities include keeping required marks displayed and changing/removing them when the regulatory requirement changes.",
      "WHMIS workplace labels do not replace TDG transport marks.",
    ],
    source: {
      authority: "Transport Canada",
      url: "https://tc.canada.ca/en/dangerous-goods/safety-awareness-materials-faq/industry/dangerous-goods-marks",
      regulatoryVersion: "TDG Regulations Part 4",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "ERG-2024",
    category: "erg",
    title: "Emergency Response Guidebook 2024",
    jurisdiction: "CA",
    summary: "ERG 2024 is an initial-response reference. LeaseOS should teach drivers how the colour-coded sections work and provide a fast verified lookup path, while making clear that the ERG does not replace emergency-response training or judgment.",
    learningPoints: [
      "White pages explain use, placards, rail/road identification and initial response concepts.",
      "Yellow pages index by UN/NA identification number; blue pages index by material name.",
      "Orange guides provide hazard and initial emergency-response information.",
      "Green pages provide initial isolation/protective-action information for certain materials.",
      "Use the current ERG source and preserve its guide number / material lookup as evidence when LeaseOS assists.",
    ],
    source: {
      authority: "Transport Canada CANUTEC",
      url: "https://tc.canada.ca/en/dangerous-goods/canutec/emergency-response-guidebook",
      regulatoryVersion: "ERG 2024",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "WHMIS-AB-WORKER",
    category: "whmis",
    title: "WHMIS worker education and workplace-specific training",
    jurisdiction: "CA-AB",
    summary: "WHMIS combines general hazard education with site- and job-specific training on the products and procedures workers actually encounter.",
    learningPoints: [
      "Understand supplier and workplace labels, pictograms, signal words and precautionary information.",
      "Read the 16-section SDS and know where the current SDS is available.",
      "Apply company procedures for storage, handling, use, disposal, spills, fugitive emissions and emergencies.",
      "Workers should be able to explain the product hazard, how to protect themselves, what to do in an emergency and where to get more information.",
      "WHMIS and TDG can both apply to the same material, but they are different systems with different labels/documents and purposes.",
    ],
    source: {
      authority: "Alberta OHS / CCOHS",
      url: "https://search-ohs-laws.alberta.ca/legislation/occupational-health-and-safety-code/part-29-workplace-hazardous-materials-information-system-whmis/",
      regulatoryVersion: "Alberta OHS Code Part 29 / current WHMIS framework",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "AB-HAZ-WASTE-MANIFEST",
    category: "waste_manifest",
    title: "Alberta hazardous-waste manifest decision path",
    jurisdiction: "CA-AB",
    summary: "Hazardous-waste, hazardous-recyclable and dangerous-goods document workflows overlap but are not interchangeable.",
    learningPoints: [
      "Hazardous waste shipments use the Alberta hazardous waste manifest; hazardous recyclables use a recycle docket.",
      "The generator, carrier and receiver include their Alberta PINs where required.",
      "Dangerous goods that are not hazardous waste should not be put on a hazardous-waste manifest merely because TDG applies.",
      "Dangerous oilfield waste should not use an Alberta hazardous-waste manifest for an in-province movement; route that workflow to the applicable AER/oilfield requirements unless it is being exported from Alberta.",
      "Where TDG also applies, the dangerous-goods requirements still have to be satisfied.",
    ],
    source: {
      authority: "Government of Alberta",
      url: "https://www.alberta.ca/hazardous-waste-transportation",
      regulatoryVersion: "EPEA / Waste Control Regulation transportation guidance",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "NSC10-GENERAL",
    category: "cargo_securement",
    title: "NSC Standard 10 general cargo securement",
    jurisdiction: "CA-AB",
    summary: "Cargo must be immobilized or secured with suitable structures, blocking, bracing or tiedowns. General aggregate working-load-limit rules do not replace commodity-specific sections.",
    learningPoints: [
      "Use only suitable securement equipment in serviceable condition and verify manufacturer working-load-limit markings.",
      "For the general rule, aggregate working load limit must be at least 50% of the article or group weight.",
      "Inspect cargo and securement before movement and re-check/adjust during the trip as required.",
      "Select the commodity-specific rule when applicable, including logs, dressed lumber, metal coils, paper rolls, concrete pipe, intermodal containers, vehicles/equipment, crushed vehicles, roll-on/roll-off containers and boulders.",
    ],
    source: {
      authority: "CCMTA / Alberta Transportation and Economic Corridors",
      url: "https://www.ccmta.ca/en/national-safety-code",
      regulatoryVersion: "NSC Standard 10, revised June 2013",
      verifiedOn: VERIFIED_ON,
    },
  },
  {
    code: "LEASEOS-COMPANY-TRAINING",
    category: "company_policy",
    title: "Company-specific competency framework",
    jurisdiction: "CONFIGURABLE",
    summary: "Carrier-specific policies can be assigned by role, unit, customer, site, route, hazard, or work type and can be made dispatch prerequisites without pretending they are government credentials.",
    learningPoints: [
      "Orientation, fit-for-duty, PPE, stop-work authority and incident reporting.",
      "Journey management, remote-work check-ins, lease-road / forestry-road radio procedure and winter/mountain driving.",
      "Customer/site orientations, emergency response plans, muster points and evacuation requirements.",
      "Equipment-specific sign-offs for hydrovac, vacuum truck, tanker, dump, Super-B, winch tractor, PTO, pumps and loading/unloading systems.",
      "Role-specific modules such as ground disturbance, H2S/site gas hazards, confined space, fall protection, first aid, spill response, spotter/backing and load/unload procedures when applicable.",
    ],
    source: {
      authority: "LeaseOS configurable carrier policy",
      url: "internal://leaseos/knowledge/company-training",
      regulatoryVersion: "Company-controlled",
      verifiedOn: VERIFIED_ON,
    },
  },
];

export const TDG_CLASS_KNOWLEDGE = [
  { classCode: "1", name: "Explosives", examples: "Explosive substances/articles; divisions and compatibility groups control details." },
  { classCode: "2.1", name: "Flammable gases", examples: "Gases presenting a flammability hazard." },
  { classCode: "2.2", name: "Non-flammable, non-toxic gases", examples: "Compressed/liquefied gases not in 2.1 or 2.3." },
  { classCode: "2.3", name: "Toxic gases", examples: "Gases presenting acute toxicity by inhalation." },
  { classCode: "3", name: "Flammable liquids", examples: "Liquids meeting the applicable flammability criteria." },
  { classCode: "4.1", name: "Flammable solids", examples: "Flammable solids / related self-reactive hazards." },
  { classCode: "4.2", name: "Spontaneously combustible", examples: "Materials liable to spontaneous combustion." },
  { classCode: "4.3", name: "Dangerous when wet", examples: "Materials that emit flammable gases on contact with water." },
  { classCode: "5.1", name: "Oxidizing substances", examples: "Oxidizers." },
  { classCode: "5.2", name: "Organic peroxides", examples: "Organic peroxide hazards." },
  { classCode: "6.1", name: "Toxic substances", examples: "Acute toxic substances." },
  { classCode: "6.2", name: "Infectious substances", examples: "Infectious biological materials." },
  { classCode: "7", name: "Radioactive materials", examples: "Radioactive material subject to Class 7 transport rules." },
  { classCode: "8", name: "Corrosives", examples: "Corrosive substances." },
  { classCode: "9", name: "Miscellaneous dangerous goods", examples: "Regulated hazards not assigned to Classes 1–8." },
] as const;

export type AssistantDecisionStatus = "blocked" | "needs_review" | "ready_for_human_confirmation";

export type DangerousGoodsAssistInput = {
  jurisdiction?: string | null;
  classificationStatus: "verified" | "needs_verification" | "blocked";
  unNumber?: string | null;
  properShippingName?: string | null;
  dgClass?: string | null;
  packingGroup?: string | null;
  quantity?: string | null;
  containerCategory?: "small" | "large" | "unknown";
  tdgShippingDocumentPresent?: boolean;
  tdgExemptionVerified?: boolean;
  marksConfirmed?: boolean;
  driverTdgCertificateStatus?: "verified" | "pending" | "missing" | "expired" | "rejected";
  tdgDirectSupervision?: boolean;
  supervisorTdgCertificateVerified?: boolean;
  isHazardousWaste?: boolean;
  isHazardousRecyclable?: boolean;
  isDangerousOilfieldWaste?: boolean;
  exportFromAlberta?: boolean;
  hazardousWasteManifestPresent?: boolean;
  recycleDocketPresent?: boolean;
  whmisWorkplaceExposure?: boolean;
  whmisTrainingStatus?: "current" | "due" | "missing" | "unknown";
  ergGuideNumber?: string | null;
  ergLookupVerified?: boolean;
};

export type DangerousGoodsAssistDecision = {
  status: AssistantDecisionStatus;
  blockers: string[];
  reviewItems: string[];
  confirmed: string[];
  documentChecklist: string[];
  markChecklist: string[];
  emergencyChecklist: string[];
  wasteWorkflow: "not_applicable" | "hazardous_waste_manifest" | "recycle_docket" | "oilfield_waste_workflow" | "needs_classification";
  placardKnowledge?: { classCode: string; name: string; note: string };
  disclaimer: string;
};

function normalizedClass(value?: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d(?:\.\d)?)/);
  return match?.[1];
}

export function evaluateDangerousGoodsAssist(input: DangerousGoodsAssistInput): DangerousGoodsAssistDecision {
  const blockers: string[] = [];
  const reviewItems: string[] = [];
  const confirmed: string[] = [];
  const documentChecklist: string[] = [];
  const markChecklist: string[] = [];
  const emergencyChecklist: string[] = [];
  let wasteWorkflow: DangerousGoodsAssistDecision["wasteWorkflow"] = "not_applicable";

  if (input.classificationStatus === "blocked") {
    blockers.push("Load classification is blocked; do not generate transport marks or a dangerous-goods description.");
  } else if (input.classificationStatus !== "verified") {
    blockers.push("Dangerous-goods classification is not verified. LeaseOS must not guess a UN number, class, packing group or placard.");
  } else {
    confirmed.push("Dangerous-goods classification marked verified.");
  }

  if (input.classificationStatus === "verified") {
    if (!input.unNumber) blockers.push("Verified load is missing its UN number.");
    if (!input.properShippingName) blockers.push("Verified load is missing its proper shipping name.");
    if (!input.dgClass) blockers.push("Verified load is missing its dangerous-goods class.");
  }

  if (input.tdgExemptionVerified) {
    confirmed.push("A specific TDG exemption/special-case pathway is recorded as verified; retain the supporting rule/evidence with the job.");
    documentChecklist.push("Keep the verified exemption/special-case reference with the dispatch record.");
  } else if (!input.tdgShippingDocumentPresent) {
    blockers.push("TDG shipping document is not confirmed and no verified exemption is recorded.");
  } else {
    confirmed.push("TDG shipping document is present.");
    documentChecklist.push("Cross-check consignor identity/date and the verified dangerous-goods description before movement.");
    documentChecklist.push("Confirm the required 24-hour contact and any ERAP information that applies to this shipment.");
    documentChecklist.push("Keep the document in the required road-transport location and retain the required record copy.");
  }

  const driverStatus = input.driverTdgCertificateStatus ?? "missing";
  if (driverStatus === "verified") {
    confirmed.push("Driver TDG training certificate is verified/current.");
  } else if (input.tdgDirectSupervision && input.supervisorTdgCertificateVerified) {
    reviewItems.push("Direct-supervision mode selected: verify the trained certificate holder is physically present for the TDG activities; remote monitoring is not enough.");
  } else if (driverStatus === "pending") {
    reviewItems.push("Driver TDG training certificate is pending verification.");
  } else if (driverStatus === "expired") {
    blockers.push("Driver TDG training certificate is expired for this road movement.");
  } else if (driverStatus === "rejected") {
    blockers.push("Driver TDG training certificate verification was rejected.");
  } else {
    blockers.push("No verified driver TDG training certificate is recorded and verified direct supervision is not configured.");
  }

  if (input.marksConfirmed === true) {
    confirmed.push("Required dangerous-goods marks are recorded as checked by a qualified person.");
  } else if (input.marksConfirmed === false) {
    blockers.push("Required dangerous-goods marks are not confirmed.");
  } else {
    reviewItems.push("Dangerous-goods labels/placards/UN-number display still require a Part 4 check using the verified classification, quantity and means of containment.");
  }

  if (input.containerCategory === "small") {
    markChecklist.push("Small means of containment: verify the applicable label/UN-number requirements under TDG Part 4.");
  } else if (input.containerCategory === "large") {
    markChecklist.push("Large means of containment: verify the applicable placard/UN-number requirements under TDG Part 4.");
  } else {
    markChecklist.push("Record the means-of-containment category/capacity before LeaseOS presents a mark checklist.");
    reviewItems.push("Means-of-containment category is unknown.");
  }
  markChecklist.push("Do not use a WHMIS workplace label as a substitute for a TDG transport mark.");
  markChecklist.push("Confirm marks are visible, legible, durable, weather resistant and not misleading.");

  if (input.isDangerousOilfieldWaste && !input.exportFromAlberta) {
    wasteWorkflow = "oilfield_waste_workflow";
    blockers.push("In-province dangerous oilfield waste should not be put on an Alberta hazardous-waste manifest; route to the configured AER/oilfield-waste workflow.");
  } else if (input.isHazardousWaste) {
    wasteWorkflow = "hazardous_waste_manifest";
    if (!input.hazardousWasteManifestPresent) blockers.push("Alberta hazardous-waste manifest is required by the configured hazardous-waste workflow and is not confirmed.");
    else confirmed.push("Hazardous-waste manifest is present.");
    documentChecklist.push("Verify generator, carrier and receiver identifiers/PINs and waste description fields before departure.");
  } else if (input.isHazardousRecyclable) {
    wasteWorkflow = "recycle_docket";
    if (!input.recycleDocketPresent) blockers.push("Hazardous-recyclable recycle docket is not confirmed.");
    else confirmed.push("Recycle docket is present.");
  } else if (input.classificationStatus !== "verified") {
    wasteWorkflow = "needs_classification";
  }

  if (input.whmisWorkplaceExposure) {
    if (input.whmisTrainingStatus === "current") confirmed.push("WHMIS workplace training is current for the configured assignment.");
    else if (input.whmisTrainingStatus === "due") reviewItems.push("WHMIS refresher/site-specific review is due under the configured company program.");
    else blockers.push("WHMIS workplace training is not confirmed for work with or near the hazardous product.");
  }

  if (input.ergLookupVerified && input.ergGuideNumber) {
    confirmed.push(`ERG 2024 lookup recorded as Guide ${input.ergGuideNumber}.`);
    emergencyChecklist.push(`Open ERG 2024 Guide ${input.ergGuideNumber} from the verified UN/name lookup and follow the initial-response information appropriate to the incident.`);
  } else if (input.unNumber) {
    reviewItems.push("ERG 2024 guide lookup has not been verified for the recorded UN number.");
    emergencyChecklist.push(`Use the current ERG 2024 yellow index for ${input.unNumber} (or blue index by verified shipping name) and record the resulting guide number.`);
  } else {
    emergencyChecklist.push("Do not choose an ERG guide from an unverified material description; first obtain the verified UN number or proper shipping name from an authoritative source.");
  }
  emergencyChecklist.push("Keep CANUTEC/company emergency contacts accessible; the ERG supports the initial phase and does not replace emergency-response training or the company ERP.");

  const cls = normalizedClass(input.dgClass);
  const classKnowledge = cls ? TDG_CLASS_KNOWLEDGE.find(item => item.classCode === cls) : undefined;

  return {
    status: blockers.length ? "blocked" : reviewItems.length ? "needs_review" : "ready_for_human_confirmation",
    blockers,
    reviewItems,
    confirmed,
    documentChecklist,
    markChecklist,
    emergencyChecklist,
    wasteWorkflow,
    placardKnowledge: classKnowledge
      ? {
          classCode: classKnowledge.classCode,
          name: classKnowledge.name,
          note: `${classKnowledge.examples} This is hazard-family knowledge only; final label/placard selection still requires the applicable TDG Part 4 rule check.`,
        }
      : undefined,
    disclaimer: "LeaseOS AI Secretary organizes verified facts and configured compliance checks. It must not independently classify dangerous goods or make the final legal placarding, manifest, exemption, ERAP or emergency-response determination.",
  };
}

export type TiedownInput = {
  id: string;
  workingLoadLimitKg?: number | null;
  attachedEndSections?: 0 | 1 | 2;
  markedByManufacturer: boolean;
  damagedOrDefective?: boolean;
};

export type CargoSecurementInput = {
  cargoWeightKg?: number | null;
  cargoImmobilizedOrContained: boolean;
  generalRuleApplicable: boolean;
  commoditySpecificRuleRequired?: boolean;
  commoditySpecificRuleConfirmed?: boolean;
  preTripInspectionComplete?: boolean;
  tiedowns: TiedownInput[];
};

export type CargoSecurementDecision = {
  status: AssistantDecisionStatus;
  aggregateWorkingLoadLimitKg: number;
  minimumGeneralRuleKg?: number;
  blockers: string[];
  reviewItems: string[];
  confirmed: string[];
  disclaimer: string;
};

/**
 * General NSC Standard 10 aggregate-WLL helper.
 * Each attached end section contributes one-half of that tiedown's WLL.
 * Commodity-specific rules can require more and therefore remain a separate gate.
 */
export function evaluateGeneralCargoSecurement(input: CargoSecurementInput): CargoSecurementDecision {
  const blockers: string[] = [];
  const reviewItems: string[] = [];
  const confirmed: string[] = [];

  if (!input.cargoImmobilizedOrContained) {
    blockers.push("Cargo is not confirmed immobilized/contained by suitable structure, blocking, bracing, tiedowns or an approved combination.");
  } else {
    confirmed.push("Cargo immobilization/containment method is recorded.");
  }

  if (input.preTripInspectionComplete) confirmed.push("Pre-trip cargo/securement inspection is recorded.");
  else blockers.push("Pre-trip cargo/securement inspection is not complete.");

  let aggregate = 0;
  for (const tiedown of input.tiedowns) {
    if (!tiedown.markedByManufacturer) {
      blockers.push(`Tiedown ${tiedown.id} does not have a confirmed manufacturer working-load-limit marking.`);
      continue;
    }
    if (tiedown.damagedOrDefective) {
      blockers.push(`Tiedown ${tiedown.id} is damaged/defective and cannot be credited toward securement.`);
      continue;
    }
    if (!tiedown.workingLoadLimitKg || tiedown.workingLoadLimitKg <= 0) {
      blockers.push(`Tiedown ${tiedown.id} has no verified working load limit.`);
      continue;
    }
    const ends = tiedown.attachedEndSections ?? 2;
    aggregate += tiedown.workingLoadLimitKg * (ends / 2);
  }

  let minimumGeneralRuleKg: number | undefined;
  if (input.generalRuleApplicable) {
    if (!input.cargoWeightKg || input.cargoWeightKg <= 0) {
      blockers.push("Cargo weight is missing, so the general 50% aggregate-WLL check cannot be completed.");
    } else {
      minimumGeneralRuleKg = input.cargoWeightKg * 0.5;
      if (aggregate + 1e-9 < minimumGeneralRuleKg) {
        blockers.push(`Aggregate WLL ${aggregate.toFixed(0)} kg is below the general-rule minimum ${minimumGeneralRuleKg.toFixed(0)} kg.`);
      } else {
        confirmed.push(`Aggregate WLL ${aggregate.toFixed(0)} kg meets the general 50% cargo-weight threshold (${minimumGeneralRuleKg.toFixed(0)} kg).`);
      }
    }
  } else {
    reviewItems.push("General aggregate-WLL rule is not selected; verify the applicable securement method/commodity rule.");
  }

  if (input.commoditySpecificRuleRequired) {
    if (!input.commoditySpecificRuleConfirmed) blockers.push("A commodity-specific NSC Standard 10 rule applies but its securement method has not been confirmed.");
    else confirmed.push("Applicable commodity-specific securement rule is recorded as confirmed.");
  }

  return {
    status: blockers.length ? "blocked" : reviewItems.length ? "needs_review" : "ready_for_human_confirmation",
    aggregateWorkingLoadLimitKg: Math.round(aggregate * 100) / 100,
    minimumGeneralRuleKg,
    blockers,
    reviewItems,
    confirmed,
    disclaimer: "This helper evaluates the configured general aggregate-WLL inputs only. It does not replace NSC Standard 10 commodity-specific requirements, provincial rules, permits, equipment instructions or a driver's inspection judgment.",
  };
}
