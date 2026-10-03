/**
 * Safety & Compliance Program Builder — the LeaseOS library.
 *
 * Modules, jurisdiction/operations packs, the policy template registry and the
 * regulatory reference seeds. This is the catalog a company assembles a safety
 * management system FROM; it is not a company's program.
 *
 * Three deliberate limits:
 *  - templates seed as `skeleton` (headings, no body). The first Alberta
 *    Commercial/Oilfield content pack is loaded into these keys one category at
 *    a time, and each template's body is reviewed by a person before it is
 *    anything but a skeleton;
 *  - regulatory references seed as `unverified`. A person verifies each one
 *    against the current instrument and records who and when; nothing here
 *    turns a citation into a regulatory determination;
 *  - a template's `regulatoryBasis` is `not_inferred_from_template` until every
 *    reference it cites is verified. The seeder never sets the other value.
 */

export type SafetyModuleKey =
  | "company_foundation" | "ohs" | "nsc_trucking" | "oilfield_industrial" | "ground_disturbance"
  | "whmis_chemicals_tdg" | "emergency_management" | "incident_management" | "workplace_conduct"
  | "working_alone_remote" | "environmental" | "training_competency" | "contractor_management"
  | "vendor_prequalification";

export type PackKey =
  | "core" | "ab_ohs" | "ab_nsc" | "federal_carrier" | "sk_ohs" | "bc_ohs"
  | "oilfield" | "hydrovac" | "ground_disturbance" | "client" | "company";

export type DocumentKind = "policy" | "procedure" | "safe_work_practice" | "plan" | "program" | "form" | "statement";

export type SafetyModule = {
  moduleKey: SafetyModuleKey;
  ordinal: number;
  title: string;
  description: string;
  /** Policy code prefix: HSE-POL-001. */
  codePrefix: string;
  /** Operations-profile flags that make the module apply; empty = always. */
  appliesWhen: readonly string[];
};

export const SAFETY_PROGRAM_MODULES: readonly SafetyModule[] = [
  { moduleKey: "company_foundation", ordinal: 1, title: "Company foundation", codePrefix: "HSE", appliesWhen: [], description: "Mission, safety philosophy, management commitment, the top-level policies, responsibilities, conduct, enforcement and document control." },
  { moduleKey: "ohs", ordinal: 2, title: "Occupational health and safety", codePrefix: "OHS", appliesWhen: [], description: "Hazard assessment, safe work practices and procedures, orientation, competency, PPE, hazard-specific practices, inspections, corrective actions and worker participation." },
  { moduleKey: "nsc_trucking", ordinal: 3, title: "Commercial trucking / National Safety Code", codePrefix: "NSC", appliesWhen: ["nscCarrier"], description: "Driver qualification, hours of service, vehicle operation, journey management, load securement, dangerous goods on the road, inspections, maintenance and carrier profile monitoring." },
  { moduleKey: "oilfield_industrial", ordinal: 4, title: "Oilfield and industrial operations", codePrefix: "OIL", appliesWhen: ["oilfield", "hydrovac"], description: "Site entry, permits, SIMOPS, line of fire, H2S, hot work, confined space, pressure, lifting, hydrovac and vacuum-truck procedures, fluid and waste handling." },
  { moduleKey: "ground_disturbance", ordinal: 5, title: "Ground disturbance", codePrefix: "GD", appliesWhen: ["groundDisturbance", "hydrovac"], description: "Locates, permits, crossing agreements, exposure zones, mechanical excavation limits, trenching, shoring, damage response and closeout." },
  { moduleKey: "whmis_chemicals_tdg", ordinal: 6, title: "WHMIS, chemicals and TDG", codePrefix: "WHM", appliesWhen: [], description: "WHMIS program, SDS and labels, chemical storage and spills, and the transportation of dangerous goods program with employer-issued training certificates." },
  { moduleKey: "emergency_management", ordinal: 7, title: "Emergency management", codePrefix: "ERP", appliesWhen: [], description: "The emergency response plan, scenario procedures, notifications, drills and post-emergency review." },
  { moduleKey: "incident_management", ordinal: 8, title: "Incident management", codePrefix: "INC", appliesWhen: [], description: "Reporting, investigation, root cause, corrective actions with owners and due dates, verification, lessons learned and regulatory reporting." },
  { moduleKey: "workplace_conduct", ordinal: 9, title: "Workplace conduct", codePrefix: "CON", appliesWhen: [], description: "Respectful workplace, violence and harassment prevention, complaints and investigations, impairment, social media and client-site behaviour." },
  { moduleKey: "working_alone_remote", ordinal: 10, title: "Working alone / remote operations", codePrefix: "LW", appliesWhen: ["workingAlone"], description: "Lone-worker hazard assessment, check-in schedules, escalation, monitoring consent, communications without cell service and man-down procedures." },
  { moduleKey: "environmental", ordinal: 11, title: "Environmental program", codePrefix: "ENV", appliesWhen: [], description: "Spill prevention and response, waste segregation and manifests, disposal verification, fuel storage, containment, wildlife and watercourse protection, reclamation." },
  { moduleKey: "training_competency", ordinal: 12, title: "Training and competency", codePrefix: "TRN", appliesWhen: [], description: "Required certificates and company training by position; the training matrix is computed from these requirements against the Driver Wallet." },
  { moduleKey: "contractor_management", ordinal: 13, title: "Contractor / subcontractor management", codePrefix: "CTR", appliesWhen: [], description: "Qualification, insurance, WCB, COR/SECOR, training verification, orientation, monitoring, non-compliance and performance review." },
  { moduleKey: "vendor_prequalification", ordinal: 14, title: "Vendor prequalification package", codePrefix: "VEN", appliesWhen: [], description: "The company profile, declarations and references that, with the program's own records, compile into a vendor compliance package." },
];

export type SafetyPack = {
  packKey: PackKey;
  kind: "core" | "jurisdiction" | "operations" | "overlay";
  title: string;
  jurisdiction: string;
  description: string;
  /** Operations-profile flags under which the pack is recommended; empty = always (core) or by choice (overlay). */
  recommendedWhen: readonly string[];
};

export const SAFETY_PACKS: readonly SafetyPack[] = [
  { packKey: "core", kind: "core", title: "LeaseOS Core", jurisdiction: "*", recommendedWhen: [], description: "Jurisdiction-neutral policies, practices and procedures every program carries." },
  { packKey: "ab_ohs", kind: "jurisdiction", title: "Alberta OHS Pack", jurisdiction: "CA-AB", recommendedWhen: ["jurisdiction:CA-AB"], description: "Alberta OHS Act, Regulation and Code overlays: health and safety program, committee or representative, hazard assessment, violence and harassment, working alone, ground disturbance, emergency preparedness." },
  { packKey: "ab_nsc", kind: "jurisdiction", title: "Alberta NSC / Transportation Pack", jurisdiction: "CA-AB", recommendedWhen: ["nscCarrier", "jurisdiction:CA-AB"], description: "The carrier safety and maintenance programs an Alberta National Safety Code carrier must have written and implemented — separate from the OHS program, which does not satisfy them." },
  { packKey: "federal_carrier", kind: "jurisdiction", title: "Federal Carrier Pack", jurisdiction: "CA", recommendedWhen: ["federalCarrier"], description: "Federal hours of service, ELD, trip inspection and cargo securement overlays for extra-provincial carriers." },
  { packKey: "sk_ohs", kind: "jurisdiction", title: "Saskatchewan Pack", jurisdiction: "CA-SK", recommendedWhen: ["jurisdiction:CA-SK"], description: "Saskatchewan overlay. Added to a company's manual as an overlay, never by rewriting it." },
  { packKey: "bc_ohs", kind: "jurisdiction", title: "British Columbia Pack", jurisdiction: "CA-BC", recommendedWhen: ["jurisdiction:CA-BC"], description: "British Columbia overlay. Added as an overlay, never by rewriting the company manual." },
  { packKey: "oilfield", kind: "operations", title: "Oilfield Pack", jurisdiction: "*", recommendedWhen: ["oilfield"], description: "Lease and site entry, permits, SIMOPS, H2S, hot work, confined space, lifting and fluid handling." },
  { packKey: "hydrovac", kind: "operations", title: "Hydrovac / Vacuum Truck Pack", jurisdiction: "*", recommendedWhen: ["hydrovac"], description: "Hydrovac and vacuum-truck procedures, tank cleaning, pressure washing, fluid and waste transfer." },
  { packKey: "ground_disturbance", kind: "operations", title: "Ground Disturbance Pack", jurisdiction: "*", recommendedWhen: ["groundDisturbance", "hydrovac"], description: "Locates, permits, exposure zones, excavation limits and damage response." },
  { packKey: "client", kind: "overlay", title: "Client Pack", jurisdiction: "*", recommendedWhen: [], description: "Client-specific overlays (site rules, orientations, contractual safety requirements) recorded per client and layered on the company's policies." },
  { packKey: "company", kind: "overlay", title: "Company Pack", jurisdiction: "*", recommendedWhen: [], description: "The company's own templates and additions." },
];

export type PolicyTemplateSeed = {
  templateKey: string;
  moduleKey: SafetyModuleKey;
  packKey: PackKey;
  documentKind: DocumentKind;
  title: string;
  acknowledgementRequired: boolean;
  reviewIntervalMonths: number;
  defaultOwnerRole: string;
  regulatoryReferenceKeys: readonly string[];
  /** Section headings of the skeleton. */
  sections: readonly string[];
};

const SECTIONS: Record<DocumentKind, readonly string[]> = {
  policy: ["Purpose", "Scope", "Policy statement", "Responsibilities", "Requirements", "Non-compliance", "Records", "References", "Revision history"],
  statement: ["Statement", "Commitment", "Signature and date"],
  procedure: ["Purpose", "Scope", "Definitions", "Responsibilities", "Required equipment and PPE", "Hazards and controls", "Procedure", "Emergency provisions", "Training and competency", "Records", "References", "Revision history"],
  safe_work_practice: ["Purpose", "Scope", "Hazards", "Controls", "Practice", "PPE", "Training", "References", "Revision history"],
  plan: ["Purpose", "Scope", "Roles and contacts", "Activation", "Response actions", "Communication", "Recovery and review", "Drills", "Records", "References", "Revision history"],
  program: ["Purpose", "Scope", "Program elements", "Responsibilities", "Implementation", "Evaluation and review", "Records", "References", "Revision history"],
  form: ["Header and identification", "Fields", "Sign-off", "Retention"],
};

export function slugify(title: string): string {
  return title.toLowerCase().replace(/&/g, "and").replace(/\//g, " ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

type Spec = { title: string; kind?: DocumentKind; pack?: PackKey; ack?: boolean; review?: number; owner?: string; refs?: readonly string[] };

function entries(moduleKey: SafetyModuleKey, defaults: { pack: PackKey; kind: DocumentKind; owner: string; refs?: readonly string[] }, specs: readonly (string | Spec)[]): PolicyTemplateSeed[] {
  return specs.map(raw => {
    const s: Spec = typeof raw === "string" ? { title: raw } : raw;
    const kind = s.kind ?? defaults.kind;
    return {
      templateKey: `${moduleKey}.${slugify(s.title)}`,
      moduleKey,
      packKey: s.pack ?? defaults.pack,
      documentKind: kind,
      title: s.title,
      acknowledgementRequired: s.ack ?? kind !== "form",
      reviewIntervalMonths: s.review ?? 12,
      defaultOwnerRole: s.owner ?? defaults.owner,
      regulatoryReferenceKeys: [...(defaults.refs ?? []), ...(s.refs ?? [])],
      sections: SECTIONS[kind],
    };
  });
}

const P = (title: string, over: Omit<Spec, "title"> = {}): Spec => ({ title, kind: "policy", ...over });
const PR = (title: string, over: Omit<Spec, "title"> = {}): Spec => ({ title, kind: "procedure", ...over });
const PG = (title: string, over: Omit<Spec, "title"> = {}): Spec => ({ title, kind: "program", ...over });
const PL = (title: string, over: Omit<Spec, "title"> = {}): Spec => ({ title, kind: "plan", ...over });
const F = (title: string, over: Omit<Spec, "title"> = {}): Spec => ({ title, kind: "form", ...over });
const ST = (title: string, over: Omit<Spec, "title"> = {}): Spec => ({ title, kind: "statement", ...over });

export const POLICY_TEMPLATE_SEEDS: readonly PolicyTemplateSeed[] = [
  ...entries("company_foundation", { pack: "core", kind: "policy", owner: "management" }, [
    ST("Company mission statement"), ST("Safety philosophy and safety motto"), ST("Management commitment statement"),
    P("Health and Safety Policy", { refs: ["ab.ohs_act.health_safety_program"] }), P("Environmental Policy"), P("Quality Policy"),
    P("Transportation Safety Policy", { pack: "ab_nsc", refs: ["ab.nsc.commercial_vehicle_safety_regulation"] }),
    P("Maintenance Policy", { pack: "ab_nsc", refs: ["ab.nsc.commercial_vehicle_safety_regulation"] }),
    P("Stop-Work Authority"), P("Worker rights and responsibilities", { refs: ["ab.ohs_act"] }), P("Supervisor responsibilities", { refs: ["ab.ohs_act"] }),
    P("Management responsibilities", { refs: ["ab.ohs_act"] }), P("Contractor responsibilities"), P("Code of conduct", { owner: "hr" }), P("Ethics and integrity policy", { owner: "hr" }),
    P("Regulatory-compliance commitment"), P("Client and site-rule compliance"), P("Policy enforcement and disciplinary process", { owner: "hr" }),
    P("Document-control and revision policy"),
  ]),
  ...entries("ohs", { pack: "core", kind: "safe_work_practice", owner: "safety" }, [
    P("Hazard assessment policy", { refs: ["ab.ohs_code.part2_hazard_assessment"] }), PR("Formal hazard assessment", { refs: ["ab.ohs_code.part2_hazard_assessment"] }),
    F("Field Level Hazard Assessment (FLHA)", { refs: ["ab.ohs_code.part2_hazard_assessment"] }), F("Job Hazard Analysis (JHA)"), F("Job Safety Analysis (JSA)"),
    PG("Safe-work-practice system"), PG("Safe-job-procedure system"), PR("Worker orientation", { refs: ["ab.ohs_act"] }), PR("Young and new worker orientation"),
    PR("Competency assessment"), P("Training and competency policy"), P("Refresher-training policy"), P("PPE policy", { refs: ["ab.ohs_code.part18_ppe"] }),
    PG("Respiratory protection", { refs: ["ab.ohs_code.part18_ppe"] }), PG("Hearing conservation"), "Eye and face protection", "Hand protection",
    PG("Fall protection", { refs: ["ab.ohs_code.part9_fall_protection"] }), "Working at heights", PR("Working alone", { pack: "ab_ohs", refs: ["ab.ohs_code.part28_working_alone"] }),
    PG("Fatigue management"), P("Fitness for duty"), P("Alcohol, drug and impairment policy", { owner: "hr" }), "Heat stress", "Cold stress", "Ergonomics and manual handling",
    "Housekeeping", "Slips, trips and falls", PR("Hazardous energy control (lockout/tagout)", { refs: ["ab.ohs_code.part15_hazardous_energy"] }), "Machine guarding", "Electrical safety", "Fire prevention",
    PG("Workplace inspection program"), PG("Corrective-action system"), PR("Safety meetings and toolbox talks"), P("Right to refuse dangerous work", { refs: ["ab.ohs_act"] }),
    PR("Safety observations and near-miss reporting"),
    PG("Health and safety program (20 or more workers)", { pack: "ab_ohs", refs: ["ab.ohs_act.health_safety_program"] }),
    PR("Health and safety committee or representative", { pack: "ab_ohs", refs: ["ab.ohs_act.committee_representative"] }),
  ]),
  ...entries("nsc_trucking", { pack: "core", kind: "policy", owner: "safety", refs: ["ca.nsc.standard_15_facility_audit"] }, [
    P("Driver qualification policy", { pack: "ab_nsc", refs: ["ab.nsc.carrier_safety_program"] }), PR("Driver abstract review", { pack: "ab_nsc" }), PR("Licence verification", { pack: "ab_nsc" }),
    P("Hours-of-service policy", { refs: ["ca.nsc.hours_of_service"] }), P("ELD and logbook policy", { pack: "federal_carrier", refs: ["ca.nsc.hours_of_service", "ca.eld_mandate"] }), P("Sleeper-berth policy", { refs: ["ca.nsc.hours_of_service"] }),
    PG("Fatigue management (drivers)"), P("Dispatch responsibility"), P("Driver responsibility"), P("No coercion to violate hours of service", { refs: ["ca.nsc.hours_of_service"] }),
    P("Speed policy", { refs: ["ab.nsc.carrier_safety_program"] }), P("Seat-belt policy", { refs: ["ab.nsc.carrier_safety_program"] }), P("Distracted-driving and mobile-device policy"), P("Defensive-driving requirements", { refs: ["ab.nsc.carrier_safety_program"] }),
    PR("Backing policy"), PR("Journey management"), P("Winter-driving policy"), PR("Adverse-weather shutdown"), PR("Mountain-driving procedures"), PR("Remote and backroad travel"),
    PR("Radio-controlled roads"), PR("Load securement", { refs: ["ca.nsc.standard_10_cargo_securement"] }), P("Weight and axle compliance"), P("Dangerous-goods transportation (road)", { refs: ["ca.tdg.act", "ca.tdg.regulations"] }),
    F("Shipping documents", { refs: ["ca.tdg.regulations"] }), PR("Placarding", { refs: ["ca.tdg.regulations"] }), PR("Fueling procedures", { refs: ["ab.nsc.carrier_safety_program"] }),
    PR("Pre-trip inspection", { refs: ["ca.nsc.standard_13_trip_inspection"] }), PR("Post-trip inspection", { refs: ["ca.nsc.standard_13_trip_inspection"] }), PR("Defect reporting", { refs: ["ca.nsc.standard_13_trip_inspection"] }),
    PR("Out-of-service equipment procedure"), PR("CVIP inspection tracking", { pack: "ab_nsc", refs: ["ab.nsc.commercial_vehicle_safety_regulation"] }), PG("Preventive maintenance", { pack: "ab_nsc", refs: ["ab.nsc.commercial_vehicle_safety_regulation"] }),
    PR("Repair authorization"), PR("Tire and wheel inspection"), PR("Trailer coupling and uncoupling"), PR("Cargo and equipment securement", { refs: ["ca.nsc.standard_10_cargo_securement"] }),
    PR("Collision reporting"), PR("Roadside-inspection response"), PR("Carrier-profile monitoring", { pack: "ab_nsc", refs: ["ab.nsc.carrier_safety_program"] }), P("Driver disciplinary and progressive-correction system", { owner: "hr", refs: ["ab.nsc.carrier_safety_program"] }),
  ]),
  ...entries("oilfield_industrial", { pack: "oilfield", kind: "procedure", owner: "safety" }, [
    PR("General oilfield orientation"), PR("Lease and site-entry procedures"), P("Prime-contractor responsibilities", { refs: ["ab.ohs_act"] }), F("Permit-to-work"), PR("SIMOPS (simultaneous operations)"),
    P("Line-of-fire policy"), P("Pinch and crush-point policy"), PR("H2S procedure"), PR("Gas detection"), PL("H2S emergency response"), PR("Ignition-source control"), PR("Flammable and combustible atmosphere"),
    PR("Grounding and bonding"), PR("Hot work"), PR("Confined space", { refs: ["ab.ohs_code.part5_confined_spaces"] }), PR("Tank entry", { refs: ["ab.ohs_code.part5_confined_spaces"] }), PR("Pressure hazards"), PR("Stored-energy hazards"),
    PR("High-pressure lines"), PR("Rig movement"), PR("Spotter and signaller procedures"), PR("Heavy-equipment interaction"), PR("Mobile-equipment exclusion zones"), PR("Crane and lifting procedures", { refs: ["ab.ohs_code.part21_rigging"] }),
    PR("Rigging", { refs: ["ab.ohs_code.part21_rigging"] }), PR("Suspended loads"), PR("Hydrovac procedures", { pack: "hydrovac" }), PR("Vacuum-truck procedures", { pack: "hydrovac" }), PR("Tank cleaning", { pack: "hydrovac" }),
    PR("Pressure washing", { pack: "hydrovac" }), PR("Fluid transfer", { pack: "hydrovac" }), PR("Chemical transfer", { pack: "hydrovac" }), PR("Loading and unloading", { pack: "hydrovac" }), PR("Produced-water handling", { pack: "hydrovac" }),
    PR("Sewage and septic handling", { pack: "hydrovac" }), PR("Waste and disposal-site procedures", { pack: "hydrovac" }),
  ]),
  ...entries("ground_disturbance", { pack: "ground_disturbance", kind: "procedure", owner: "safety", refs: ["ab.ohs_code.part32_excavating"] }, [
    P("Ground-disturbance policy"), F("Ground-disturbance permit"), PR("One-call and utility locate process", { refs: ["ab.utility_safety_partners"] }), PR("Owner notification"), PR("Locate validation"),
    F("Crossing agreement", { refs: ["ab.pipeline_rules_ground_disturbance"] }), PR("Pipeline right-of-way authorization", { refs: ["ab.pipeline_rules_ground_disturbance"] }), PR("Hand-exposure zone"), PR("Hydrovac exposure"),
    PR("Mechanical excavation limitations"), PR("Excavation and trenching procedure"), PR("Soil classification"), PR("Shoring and sloping"), PR("Spoil pile placement"), PR("Safe access and egress"),
    PL("Underground-facility damage response"), PR("Ground-disturbance closeout"),
  ]),
  ...entries("whmis_chemicals_tdg", { pack: "core", kind: "procedure", owner: "safety" }, [
    PG("WHMIS program", { refs: ["ca.whmis.hazardous_products_regulations", "ab.ohs_code.part29_whmis"] }), PR("SDS management", { refs: ["ab.ohs_code.part29_whmis"] }), PR("Chemical inventory"), PR("Workplace labels", { refs: ["ab.ohs_code.part29_whmis"] }),
    PR("Secondary-container labels"), PR("Chemical compatibility and storage", { refs: ["ab.ohs_code.part4_chemical_hazards"] }), PL("Spill response (chemical)"), PR("Chemical exposure", { refs: ["ab.ohs_code.part4_chemical_hazards"] }),
    P("TDG policy", { refs: ["ca.tdg.act", "ca.tdg.regulations"] }), PR("TDG classification", { refs: ["ca.tdg.regulations"] }), PR("TDG documentation", { refs: ["ca.tdg.regulations"] }), PR("Safety marks and placards", { refs: ["ca.tdg.regulations"] }),
    PR("ERAP applicability", { refs: ["ca.tdg.regulations"] }), PL("Dangerous-goods incident response", { refs: ["ca.tdg.regulations"] }), PR("TDG training and certification records", { refs: ["ca.tdg.regulations.part6_training"] }),
  ]),
  ...entries("emergency_management", { pack: "core", kind: "procedure", owner: "safety", refs: ["ab.ohs_code.part7_emergency"] }, [
    PL("Emergency Response Plan"), F("Emergency contacts"), PR("Muster procedures"), PR("Fire"), PR("Explosion"), PR("H2S release", { pack: "oilfield" }), PR("Chemical spill"), PR("Vehicle collision (emergency)"),
    PR("Rollover"), PR("Serious injury"), PR("Medical emergency"), PR("Worker missing or lost"), PR("Severe weather"), PR("Wildfire"), PR("Pipeline strike", { pack: "ground_disturbance" }), PR("Electrical contact"),
    PR("Environmental release"), PR("Emergency shutdown"), PR("Media and public communication"), PR("Regulator notification"), PR("Client notification"), PG("Emergency drill program"), PR("Post-emergency review"),
  ]),
  ...entries("incident_management", { pack: "core", kind: "procedure", owner: "safety" }, [
    PR("Injury reporting", { refs: ["ab.ohs_act"] }), PR("Near-miss reporting"), PR("Property-damage reporting"), PR("Environmental-incident reporting"), PR("Vehicle-collision reporting"), PR("Dangerous-occurrence reporting", { refs: ["ab.ohs_act"] }),
    PR("Investigation procedure"), PR("Root-cause analysis"), F("Witness statements"), PR("Photographs and video"), PG("Corrective actions"), PR("Responsible person and due dates"),
    PR("Verification of completion"), PR("Lessons learned"), PR("Safety alerts"), F("Regulatory reporting record", { refs: ["ab.ohs_act"] }),
  ]),
  ...entries("workplace_conduct", { pack: "core", kind: "policy", owner: "hr", refs: ["ab.ohs_code.part27_violence_harassment"] }, [
    P("Respectful workplace"), PL("Violence prevention plan"), PL("Harassment prevention plan"), P("Bullying"), P("Sexual harassment"), PR("Complaint procedure"), PR("Investigation procedure (conduct)"),
    P("Confidentiality"), P("Non-retaliation"), P("Employee discipline"), P("Drug, alcohol and impairment (conduct)"), P("Cannabis"), P("Prescription medication affecting fitness for duty"),
    P("Social-media conduct"), P("Client-site behaviour"),
  ]),
  ...entries("working_alone_remote", { pack: "core", kind: "procedure", owner: "safety", refs: ["ab.ohs_code.part28_working_alone"] }, [
    F("Lone-worker hazard assessment"), PR("Check-in schedule"), PR("Missed check-in escalation"), F("GPS monitoring consent", { refs: ["ca.pipeda"] }), PR("Satellite communication"),
    PR("No-cell-service procedures"), PR("Emergency beacon"), F("Remote-road journey plan"), PR("Fatigue and weather reassessment"), PR("Man-down procedure"),
  ]),
  ...entries("environmental", { pack: "core", kind: "procedure", owner: "safety", refs: ["ab.epea"] }, [
    ST("Environmental commitment"), PR("Spill prevention"), PL("Spill response (environmental)"), PR("Waste segregation"), F("Waste manifests"), PR("Disposal facility verification"), PR("Produced water"),
    PR("Contaminated soil"), PR("Sewage and septic"), PR("Fuel storage"), PR("Secondary containment"), P("Idling"), PR("Wildlife and environmental protection"), PR("Watercourse protection"),
    PR("Site reclamation"), PR("Environmental incident reporting"),
  ]),
  ...entries("training_competency", { pack: "core", kind: "program", owner: "safety" }, [
    PG("WHMIS training", { refs: ["ca.whmis.hazardous_products_regulations"] }), PG("TDG training", { refs: ["ca.tdg.regulations.part6_training"] }), PG("H2S training", { pack: "oilfield" }), PG("First Aid / CPR", { refs: ["ab.ohs_code.part11_first_aid"] }),
    PG("Ground disturbance training", { pack: "ground_disturbance" }), PG("Confined space training", { pack: "oilfield" }), PG("Fall protection training"), PG("CSTS / CSO or client-required orientation", { pack: "oilfield" }),
    PG("Defensive driving training"), PG("Hours of service training", { refs: ["ca.nsc.hours_of_service"] }), PG("Load securement training", { refs: ["ca.nsc.standard_10_cargo_securement"] }), PG("Fatigue management training"),
    PG("Equipment-specific competency"), PG("Hydrovac competency", { pack: "hydrovac" }), PG("Vacuum-truck competency", { pack: "hydrovac" }), PG("Hoisting and rigging training", { pack: "oilfield" }),
    PG("Fire extinguisher training"), PG("Respiratory protection training"), PG("Forklift and mobile equipment training"), PG("Company orientation"), PG("Client orientation"),
  ]),
  ...entries("contractor_management", { pack: "core", kind: "procedure", owner: "safety" }, [
    PR("Contractor qualification"), P("Insurance requirements"), PR("WCB clearance"), PR("COR / SECOR verification", { refs: ["ab.partnerships_cor"] }), PR("Safety statistics"), PR("Training verification"),
    PR("Equipment documentation"), PR("Contractor orientation"), PR("Subcontractor monitoring"), PR("Non-compliance"), PR("Contractor corrective actions"), PR("Contractor performance review"),
  ]),
  ...entries("vendor_prequalification", { pack: "core", kind: "form", owner: "management" }, [
    F("Company profile"), F("Signed declarations"), F("References"), PR("Vendor compliance package assembly", { ack: false }),
  ]),
];

export type RegulatoryReferenceSeed = {
  referenceKey: string;
  jurisdiction: string;
  authority: string;
  instrument: string;
  provision: string | null;
  title: string;
  url: string | null;
  summary: string;
};

/**
 * Every seed is UNVERIFIED. Part and section numbers are the ones the template
 * authors worked from; a person verifies each against the instrument as
 * consolidated today and records the verification. A template cites a
 * reference by key, so verification propagates without rewriting templates.
 */
export const REGULATORY_REFERENCE_SEEDS: readonly RegulatoryReferenceSeed[] = [
  { referenceKey: "ab.ohs_act", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Act", provision: null, title: "Alberta OHS Act — general duties, rights and obligations", url: "https://kings-printer.alberta.ca/", summary: "Employer, supervisor, worker, contractor and prime-contractor obligations; the right to refuse dangerous work; reporting of injuries and incidents." },
  { referenceKey: "ab.ohs_act.health_safety_program", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Act", provision: "Health and safety program", title: "Health and safety program required for employers with 20 or more regularly employed workers", url: null, summary: "Employers with 20 or more regularly employed workers must establish a health and safety program with prescribed elements." },
  { referenceKey: "ab.ohs_act.committee_representative", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Act", provision: "Joint work site health and safety committee / health and safety representative", title: "Committee or representative requirements by workforce size", url: null, summary: "Thresholds at which a joint committee or a representative is required and their functions." },
  { referenceKey: "ab.ohs_code.part2_hazard_assessment", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 2 — Hazard Assessment, Elimination and Control", title: "Hazard assessment, elimination and control", url: null, summary: "Formal and site-specific hazard assessment, worker participation, controls in the hierarchy, review when conditions change." },
  { referenceKey: "ab.ohs_code.part4_chemical_hazards", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 4 — Chemical Hazards, Biological Hazards and Harmful Substances", title: "Chemical and harmful-substance exposure", url: null, summary: "Exposure limits, controls, storage and handling of harmful substances." },
  { referenceKey: "ab.ohs_code.part5_confined_spaces", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 5 — Confined Spaces", title: "Confined space entry", url: null, summary: "Hazard assessment, entry permits, atmospheric testing, tending, rescue." },
  { referenceKey: "ab.ohs_code.part7_emergency", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 7 — Emergency Preparedness and Response", title: "Emergency response plan", url: null, summary: "Written emergency response plan contents, rescue and evacuation, training and equipment." },
  { referenceKey: "ab.ohs_code.part9_fall_protection", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 9 — Fall Protection", title: "Fall protection", url: null, summary: "Fall protection plan, systems, anchors, inspection and training." },
  { referenceKey: "ab.ohs_code.part11_first_aid", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 11 — First Aid", title: "First aid services, supplies and records", url: null, summary: "First aiders, kits and records by workforce size, hazard class and distance to hospital." },
  { referenceKey: "ab.ohs_code.part15_hazardous_energy", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 15 — Managing the Control of Hazardous Energy", title: "Hazardous energy control", url: null, summary: "Isolation, lockout, verification, group procedures and returning to service." },
  { referenceKey: "ab.ohs_code.part18_ppe", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 18 — Personal Protective Equipment", title: "Personal protective equipment", url: null, summary: "Employer and worker duties, respiratory, eye, foot, head and limb protection." },
  { referenceKey: "ab.ohs_code.part21_rigging", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 21 — Rigging", title: "Rigging", url: null, summary: "Rigging design, inspection, rejection criteria and use." },
  { referenceKey: "ab.ohs_code.part27_violence_harassment", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 27 — Violence and Harassment", title: "Violence and harassment prevention plan", url: null, summary: "Every employer must develop and implement a violence and harassment prevention plan with policy and procedures." },
  { referenceKey: "ab.ohs_code.part28_working_alone", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 28 — Working Alone", title: "Working alone", url: null, summary: "Hazard assessment and an effective communication or check-in method appropriate to the hazard." },
  { referenceKey: "ab.ohs_code.part29_whmis", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 29 — Workplace Hazardous Materials Information System (WHMIS)", title: "WHMIS in the workplace", url: null, summary: "Labels, SDS availability and worker education on hazardous products." },
  { referenceKey: "ab.ohs_code.part32_excavating", jurisdiction: "CA-AB", authority: "Alberta", instrument: "Occupational Health and Safety Code", provision: "Part 32 — Excavating and Tunnelling", title: "Ground disturbance, excavating and trenching", url: null, summary: "Locating buried facilities before disturbing ground, exposing facilities, pipeline rights-of-way, mechanical excavation near buried pipelines, soil, shoring and sloping." },
  { referenceKey: "ab.pipeline_rules_ground_disturbance", jurisdiction: "CA-AB", authority: "Alberta Energy Regulator", instrument: "Pipeline Act and Pipeline Rules", provision: "Ground disturbance near a pipeline", title: "Ground disturbance within the controlled area of a pipeline", url: null, summary: "Licensee consent, crossing agreements and supervision requirements for ground disturbance near a pipeline." },
  { referenceKey: "ab.utility_safety_partners", jurisdiction: "CA-AB", authority: "Utility Safety Partners (Alberta One-Call)", instrument: "Locate request process", provision: null, title: "Locate requests before ground disturbance", url: "https://utilitysafety.ca/", summary: "The one-call locate request process. Not legislation: the legal duty to locate is in the OHS Code and the Pipeline Rules." },
  { referenceKey: "ab.nsc.commercial_vehicle_safety_regulation", jurisdiction: "CA-AB", authority: "Alberta Transportation", instrument: "Commercial Vehicle Safety Regulation (Traffic Safety Act)", provision: null, title: "Carrier safety fitness, written safety and maintenance programs, CVIP", url: null, summary: "An NSC carrier must have written and implemented safety and maintenance programs. Alberta states an OHS program alone does not satisfy this." },
  { referenceKey: "ab.nsc.carrier_safety_program", jurisdiction: "CA-AB", authority: "Alberta Transportation", instrument: "Carrier safety program guidance (Safety Fitness Certificate)", provision: null, title: "Subjects a carrier safety program should address", url: null, summary: "Safe vehicle operation, speed, seat belts, drugs and alcohol, defensive driving, load security, fueling, driver records, qualifications, training, conduct, discipline, evaluations and safety equipment." },
  { referenceKey: "ca.nsc.standard_15_facility_audit", jurisdiction: "CA", authority: "CCMTA", instrument: "National Safety Code Standard 15", provision: "Facility Audit", title: "NSC facility audit elements", url: null, summary: "The audit a carrier's safety program is measured against." },
  { referenceKey: "ca.nsc.hours_of_service", jurisdiction: "CA", authority: "Transport Canada / CCMTA", instrument: "Commercial Vehicle Drivers Hours of Service Regulations (SOR/2005-313); NSC Standard 9", provision: null, title: "Hours of service", url: null, summary: "Federal hours-of-service limits; provincial adoption for intra-provincial carriers is verified per jurisdiction." },
  { referenceKey: "ca.eld_mandate", jurisdiction: "CA", authority: "Transport Canada", instrument: "Commercial Vehicle Drivers Hours of Service Regulations — electronic logging devices", provision: null, title: "ELD requirement for federally regulated carriers", url: null, summary: "Certified ELD use, records and exemptions." },
  { referenceKey: "ca.nsc.standard_10_cargo_securement", jurisdiction: "CA", authority: "CCMTA", instrument: "National Safety Code Standard 10", provision: "Cargo Securement", title: "Cargo securement", url: null, summary: "General and commodity-specific securement requirements." },
  { referenceKey: "ca.nsc.standard_13_trip_inspection", jurisdiction: "CA", authority: "CCMTA", instrument: "National Safety Code Standard 13", provision: "Trip Inspections", title: "Daily trip inspection", url: null, summary: "Pre-trip inspection, schedules, defect reporting and records." },
  { referenceKey: "ca.tdg.act", jurisdiction: "CA", authority: "Transport Canada", instrument: "Transportation of Dangerous Goods Act, 1992", provision: null, title: "TDG Act", url: null, summary: "Handling, offering for transport and transporting dangerous goods." },
  { referenceKey: "ca.tdg.regulations", jurisdiction: "CA", authority: "Transport Canada", instrument: "Transportation of Dangerous Goods Regulations", provision: null, title: "TDG Regulations — classification, documentation, safety marks, ERAP, reporting", url: null, summary: "Parts on classification, documentation, safety marks, ERAP and incident reporting." },
  { referenceKey: "ca.tdg.regulations.part6_training", jurisdiction: "CA", authority: "Transport Canada", instrument: "Transportation of Dangerous Goods Regulations", provision: "Part 6 — Training", title: "Adequate training and the employer-issued certificate", url: null, summary: "A person performing a regulated function must be adequately trained and hold an employer-issued training certificate; the certificate is employer-specific." },
  { referenceKey: "ca.whmis.hazardous_products_regulations", jurisdiction: "CA", authority: "Health Canada", instrument: "Hazardous Products Act and Hazardous Products Regulations (WHMIS)", provision: null, title: "WHMIS supplier requirements; worker education elements", url: null, summary: "Labels, SDS information, safe storage, use and handling, and emergency procedures as training subjects." },
  { referenceKey: "ca.pipeda", jurisdiction: "CA", authority: "Office of the Privacy Commissioner of Canada", instrument: "Personal Information Protection and Electronic Documents Act; Alberta PIPA", provision: null, title: "Notice and consent for workplace monitoring", url: null, summary: "Workers must be told what is collected about them and why; see monitoringNotices (0160)." },
  { referenceKey: "ab.epea", jurisdiction: "CA-AB", authority: "Alberta Environment and Protected Areas", instrument: "Environmental Protection and Enhancement Act", provision: null, title: "Release reporting, waste and reclamation duties", url: null, summary: "Duty to report releases, waste management and conservation and reclamation." },
  { referenceKey: "ab.partnerships_cor", jurisdiction: "CA-AB", authority: "Alberta OHS — Partnerships in Injury Reduction", instrument: "Certificate of Recognition (COR / SECOR) program", provision: null, title: "COR audit standard", url: null, summary: "Evidence that an employer's health and safety management system has been audited against provincial standards: documentation, interviews and observation." },
];

export function moduleByKey(key: string): SafetyModule | undefined {
  return SAFETY_PROGRAM_MODULES.find(m => m.moduleKey === key);
}
export function packByKey(key: string): SafetyPack | undefined {
  return SAFETY_PACKS.find(p => p.packKey === key);
}
