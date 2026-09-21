/**
 * v23.28 — what this paperwork needs, who reads it, and which values may not be guessed.
 *
 * A driver holding a disposal ticket at a facility gate has about ninety seconds to notice the
 * receiving signature block is empty, and that is the only ninety seconds in which it can be
 * fixed. Three days later it is a discrepancy the AER wants reported inside twenty-one days and
 * nobody can remember who was on the gate. So this file answers, for one kind of paperwork: who
 * reads it, what has to be on it, which of those values must never be filled in by guessing, and
 * whether paper has to physically travel.
 *
 * It lives in `shared/` for the reason `printability` gives: the check has to run where the camera
 * is, and the lease is where there is no signal.
 *
 * ## What this file deliberately does NOT decide
 *
 * Three questions look like they belong here and each already has an owner. Answering them again
 * would be a second answer, and two answers to one question is how they stop agreeing.
 *
 *   may this go on paper          `printability.assessPrintability`. This file produces the
 *                                 `PrintField[]` it consumes and takes its verdict.
 *   how long must it be kept      `_core/retentionPolicy.computeEffectiveRetention`. That engine
 *                                 already refuses to claim statutory backing it cannot evidence.
 *                                 This file carries only the CANDIDATE statutory figure and its
 *                                 citation; `_core/paperworkRetention` hands it over.
 *   what did the scan read        `_core/documentExtraction`. OCR output is a proposal there and
 *                                 stays one here.
 *
 * ## Every rule here is UNVERIFIED and says so
 *
 * The same discipline the HOS registry and the seeded channel banks are under. Every rule carries
 * a citation and a `verification` of `unverified`, because LeaseOS has not read the instrument —
 * it has read a planning report that read the instrument, and `readFrom` on each citation says
 * exactly that. An unverified rule is shown to a worker as guidance with its clause attached so
 * they can check it, and it is never the basis of a compliance verdict. Verifying is a recorded
 * act by a person, one clause at a time, and there is deliberately no seed that arrives verified:
 * the failure mode of a confident regulatory seed is a company that stops checking.
 *
 * That buys the honest version of helpfulness. "Alberta hazardous waste needs the generator's PIN
 * before consignment - Waste Control Regulation, per the 2026-09-21 planning report, UNVERIFIED"
 * sends somebody to the regulation. "Add the PIN" sounds like LeaseOS knows.
 *
 * ## Guidance is not a gate
 *
 * Nothing here blocks anything. It advises, names what is missing, and cites. The requirement
 * engine, the dispatch gate and the compliance registry are where blocking lives, they read
 * verified rules, and they would be wrong to read these.
 */

import type { DocumentClass, FieldState, PrintField } from "./printability";

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a rule comes from.
 *
 * `readFrom` is the field that keeps this honest. LeaseOS did not read SOR/2001-286; it read a
 * report dated 2026-09-21 that cites SOR/2001-286, and a reader deciding whether to trust a rule
 * needs to know which of those two things happened.
 */
export type Citation = {
  /** The instrument, as an auditor would name it. */
  source: string;
  /** Section, clause or page, where the report gave one. */
  locator: string | null;
  /** What LeaseOS actually read. Never a claim to have read the instrument. */
  readFrom: string;
};

export const GUIDANCE_SOURCE =
  "Planning report \"Built-In Document Scanning and Printing for LeaseOS/FieldRoute\", 2026-09-21";

const cite = (source: string, locator: string | null): Citation => ({ source, locator, readFrom: GUIDANCE_SOURCE });

/**
 * Seeded unverified, always.
 *
 * `verified` exists as a value because a person verifying a clause is the act this type waits for.
 * Nothing in this file constructs one, and `assertAllSeededUnverified` below is the guard.
 */
export type GuidanceVerification = "unverified" | "verified";

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * One document vocabulary, extended - not a second one.
 *
 * The first eight are exactly `_core/documentExtraction.DocumentType`, which is what
 * `classifyDocument` produces from OCR. `shared/` cannot import from `server/_core/` (the
 * dependency runs the other way), so the union is restated here and a compile-time assertion in
 * `server/documentScanner.test.ts` fails the build if the two ever drift.
 *
 * The four after them are regulated documents the classifier does not yet distinguish: "manifest"
 * currently scores towards `disposal_ticket`, and teaching the keyword table to split them would
 * change how existing tickets classify. So those four are chosen by a person on the capture
 * screen, and a document nobody chose stays whatever the classifier said it was. When the
 * classifier learns them it learns these names — there is no second table to keep in step.
 */
export type PaperworkKind =
  // Mirrors DocumentType exactly.
  | "expense_receipt" | "fuel_receipt" | "disposal_ticket" | "load_ticket"
  | "scale_ticket" | "invoice" | "safety_document" | "unknown"
  // Operator-selected, because the classifier cannot yet produce them.
  | "tdg_shipping_document" | "hazardous_waste_manifest" | "bill_of_lading" | "inspection_report";

export const OPERATOR_SELECTED_KINDS: readonly PaperworkKind[] = [
  "tdg_shipping_document", "hazardous_waste_manifest", "bill_of_lading", "inspection_report",
] as const;

export const ALL_PAPERWORK_KINDS: readonly PaperworkKind[] = [
  "expense_receipt", "fuel_receipt", "disposal_ticket", "load_ticket", "scale_ticket",
  "invoice", "safety_document", "unknown",
  "tdg_shipping_document", "hazardous_waste_manifest", "bill_of_lading", "inspection_report",
] as const;

/* ------------------------------------------------------------------ */
/* The shape of a rule                                                 */
/* ------------------------------------------------------------------ */

/**
 * A field this document needs.
 *
 * `required` and `precisionSensitive` are `_core/aiProposal.FormFieldDef`'s own words, deliberately.
 * `precisionSensitive` there means "an approximation is materially different from a measurement",
 * which is exactly the property that decides whether an OCR read may stand unconfirmed. Inventing
 * a second word for it — `neverGuess`, say — would be two vocabularies for one question, and the
 * two would drift the first time somebody edited one of them.
 */
export type PaperworkField = {
  key: string;
  label: string;
  required: boolean;
  precisionSensitive: boolean;
  /** Why it is required, in the terms of whoever requires it. */
  why: string;
  citation: Citation;
};

export type PaperRule = {
  /** Whether a paper copy must physically travel with the load. null is UNKNOWN. */
  paperRequired: boolean | null;
  /** Where the paper must be, in the regulation's own terms. */
  where: string | null;
  citation: Citation;
};

/**
 * A statutory retention figure this system has NOT verified.
 *
 * Carried as a candidate and handed to `computeEffectiveRetention`, which applies company policy
 * and declines to assert statutory compliance while the source is unverified. The number is here
 * so it can be verified one day; it is emphatically not an answer.
 */
export type StatutoryRetentionCandidate = {
  months: number | null;
  /** Each party that must hold a copy, named separately: they are separate duties. */
  whoMustRetain: readonly string[];
  citation: Citation;
};

export type PaperworkGuidance = {
  kind: PaperworkKind;
  title: string;
  /** Who reads the paper, which is what decides how strict printability must be. */
  documentClass: DocumentClass;
  summary: string;
  fields: readonly PaperworkField[];
  paper: PaperRule | null;
  statutoryRetention: StatutoryRetentionCandidate;
  /** What to do, in the order a worker does it. */
  steps: readonly string[];
  /** Traps worth naming out loud. */
  cautions: readonly string[];
  verification: GuidanceVerification;
};

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

const THERMAL_CAUTION =
  "If this arrived as a thermal printout, the paper is not the record. Thermal images can start fading within " +
  "six months (NARA Bulletin 96-03) and far faster on a dashboard - the scan in LeaseOS is the copy that has to " +
  "last the retention period.";

const TDG = "Transportation of Dangerous Goods Regulations (SOR/2001-286)";
const AER_058 = "AER Directive 058 (June 4, 2026 edition) and Manual 034 (March 2026)";
const AB_WASTE = "Alberta Environmental Protection and Enhancement Act / Waste Control Regulation";
const ITC_REG = "Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)";
const CRA_RECORDS = "CRA record retention (IC05-1R1 for electronic records; Guide RC4022)";
const OPERATIONAL = "Operational record - no external instrument cited";

/** CRA's six years, as a candidate figure only. */
const CRA_SIX_YEARS: StatutoryRetentionCandidate = {
  months: 72,
  whoMustRetain: ["the registrant claiming the input tax credit"],
  citation: cite(CRA_RECORDS, "6 years"),
};

const NO_STATUTE = (why: string): StatutoryRetentionCandidate => ({
  months: null, whoMustRetain: [], citation: cite(OPERATIONAL, why),
});

const GUIDANCE: PaperworkGuidance[] = [
  {
    kind: "tdg_shipping_document",
    title: "TDG shipping document",
    documentClass: "regulatory",
    summary: "Travels with dangerous goods and describes what is in the load.",
    fields: [
      { key: "un_number", label: "UN number", required: true, precisionSensitive: true, why: "Identifies the dangerous good.", citation: cite(TDG, "Part 3") },
      { key: "shipping_name", label: "Shipping name", required: true, precisionSensitive: true, why: "The regulated name of the good, not the trade name.", citation: cite(TDG, "Part 3") },
      { key: "class", label: "Class", required: true, precisionSensitive: true, why: "Determines placarding and segregation.", citation: cite(TDG, "Part 3") },
      { key: "packing_group", label: "Packing group", required: true, precisionSensitive: true, why: "Determines packaging requirements.", citation: cite(TDG, "Part 3") },
      { key: "quantity", label: "Quantity", required: true, precisionSensitive: true, why: "Drives threshold quantities and ERAP.", citation: cite(TDG, "Part 3") },
      { key: "consignor", label: "Consignor", required: true, precisionSensitive: false, why: "One of the three parties that must retain a copy.", citation: cite(TDG, "Part 3") },
      { key: "emergency_number", label: "24-hour emergency number", required: true, precisionSensitive: true, why: "The number somebody calls from the ditch.", citation: cite(TDG, "Part 3") },
    ],
    paper: {
      paperRequired: true,
      where: "If the driver is in the power unit: in a pocket mounted on the driver's door, or within the driver's reach. " +
        "If the driver is out of the power unit: in the door pocket, on the driver's seat, or somewhere clearly visible to anyone entering by the driver's door.",
      citation: cite(TDG, "s. 3.7"),
    },
    statutoryRetention: { months: 24, whoMustRetain: ["the consignor", "the carrier", "the importer"], citation: cite(TDG, "at least 2 years") },
    steps: [
      "Check the paper copy is in the cab before the wheels turn - as of the September 2026 report, an electronic-only shipping document needs an individual Transport Canada equivalency certificate.",
      "Scan the paper copy into LeaseOS so the retained record survives the trip.",
      "Confirm every extracted field against the page. Nothing on a shipping document is auto-filed.",
      "If a required field is unreadable, leave it blank rather than accepting the scanner's guess - printability will refuse the print and say which field, which is the outcome you want.",
    ],
    cautions: [
      "The June 2026 amendments (SOR/2026-112 and SOR/2026-127) changed the CONTENT rules, not the paper requirement. Do not read them as authorizing a paperless cab.",
      "An equivalency certificate carries a connectivity condition - the document must be updatable at loading and unloading sites - which sits badly with low-coverage lease work.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "hazardous_waste_manifest",
    title: "Hazardous waste manifest",
    documentClass: "regulatory",
    summary: "Tracks a hazardous waste shipment from generator through carrier to receiver.",
    fields: [
      { key: "generator_pin", label: "Generator PIN", required: true, precisionSensitive: true, why: "Alberta requires the generator's PIN before consignment.", citation: cite(AB_WASTE, null) },
      { key: "carrier_pin", label: "Carrier PIN", required: true, precisionSensitive: true, why: "Alberta requires the carrier's PIN before consignment.", citation: cite(AB_WASTE, null) },
      { key: "receiver_pin", label: "Receiver PIN", required: true, precisionSensitive: true, why: "Alberta requires the receiver's PIN before consignment.", citation: cite(AB_WASTE, null) },
      { key: "waste_description", label: "Waste description", required: true, precisionSensitive: true, why: "Identifies what is being moved.", citation: cite(AB_WASTE, null) },
      { key: "quantity", label: "Quantity", required: true, precisionSensitive: true, why: "Reconciled against what the receiving facility accepts.", citation: cite(AB_WASTE, null) },
      { key: "receiving_signature", label: "Receiving facility signature", required: true, precisionSensitive: true, why: "The handover nobody can reconstruct later.", citation: cite(AB_WASTE, null) },
    ],
    paper: {
      paperRequired: true,
      where: "A six-sheet NCR form travelling with the load; each party keeps its sheet.",
      citation: cite("Alberta hazardous waste manifest / BC hazardous waste manifest", "6-sheet NCR form"),
    },
    statutoryRetention: { months: 24, whoMustRetain: ["the generator", "the carrier", "the receiving facility"], citation: cite(AER_058, "minimum 2 years") },
    steps: [
      "Check all three PINs are filled in before the load is consigned - a missing PIN is a problem at the gate, not at month end.",
      "Get the receiving facility's signature on the gate, and scan the signed sheet before you pull away.",
      "Scan your own sheet as well, so the retained copy does not depend on the NCR surviving the season.",
      "If the quantity accepted differs from the quantity consigned, record the discrepancy the same day.",
    ],
    cautions: [
      "In BC a TDG shipping document or a bill of lading cannot substitute for the hazardous waste manifest - they are different documents and BC wants the manifest.",
      "Hazardous recyclables over 205 L or kg take a recycle docket rather than a manifest.",
      "Interprovincial and international movements fall under the federal Cross-border Movement of Hazardous Waste and Hazardous Recyclable Material Regulations (SOR/2021-25), where the \"Movement Document\" is the analogue of the provincial manifest.",
      "An unresolved discrepancy must reach the AER within 21 days. The clock starts at the gate, not when somebody notices.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "disposal_ticket",
    title: "Disposal / facility ticket",
    documentClass: "regulatory",
    summary: "What a receiving facility says it took, and the evidence a load actually ended somewhere legal.",
    fields: [
      { key: "facility", label: "Receiving facility", required: true, precisionSensitive: true, why: "Which facility accepted the load.", citation: cite(AER_058, null) },
      { key: "ticket_number", label: "Ticket number", required: true, precisionSensitive: true, why: "The facility's own reference, and how a dispute is settled.", citation: cite(AER_058, null) },
      { key: "waste_code", label: "Waste code", required: true, precisionSensitive: true, why: "New waste codes are accepted in Petrinex from May 2026 production data.", citation: cite(AER_058, null) },
      { key: "volume", label: "Volume accepted", required: true, precisionSensitive: true, why: "Reconciled against what was consigned, and it is what gets billed.", citation: cite(AER_058, null) },
      { key: "accepted_at", label: "Date and time accepted", required: true, precisionSensitive: true, why: "Places the load in a day, a shift and a billing period.", citation: cite(AER_058, null) },
    ],
    paper: { paperRequired: null, where: null, citation: cite(AER_058, "form, manifest, truck ticket or bill of lading") },
    statutoryRetention: { months: 24, whoMustRetain: ["the generator", "the carrier", "the receiving facility"], citation: cite(AER_058, "minimum 2 years") },
    steps: [
      "Scan the ticket at the gate while the facility staff are still standing there.",
      "Check the volume on the ticket against the volume you hauled before you leave.",
      "Confirm the ticket number and the waste code by reading them off the page - these two settle disputes and neither auto-files.",
      "If the facility issues no ticket, record that fact rather than leaving the load unevidenced.",
    ],
    cautions: [
      "Directive 058 was overhauled effective June 4, 2026, with the detailed guidance moved into Manual 034 - requirements differ for DOW and non-DOW streams and by facility type.",
      "An unresolved discrepancy must be reported to the AER within 21 days.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "invoice",
    title: "Sales invoice (GST/HST)",
    documentClass: "commercial",
    summary: "What a customer is charged, and what lets them claim the input tax credit.",
    fields: [
      { key: "supplier_name", label: "Supplier or intermediary name", required: true, precisionSensitive: false, why: "Required at every amount.", citation: cite(ITC_REG, "s. 3") },
      { key: "invoice_date", label: "Invoice date", required: true, precisionSensitive: true, why: "Required at every amount.", citation: cite(ITC_REG, "s. 3") },
      { key: "total", label: "Total amount", required: true, precisionSensitive: true, why: "Required at every amount, and it decides which tier applies.", citation: cite(ITC_REG, "s. 3") },
    ],
    paper: {
      paperRequired: false,
      where: "Electronic invoices and receipts are acceptable provided the required fields are present and the records stay readable for the retention period.",
      citation: cite(CRA_RECORDS, null),
    },
    statutoryRetention: CRA_SIX_YEARS,
    steps: [
      "Check which tier the total puts this invoice in - the extra fields are not decoration, they are what makes the credit claimable.",
      "If you are registered for GST/HST, show the tax separately on every invoice you issue.",
      "Keep the record readable for the retention period. A scanned copy counts; an unreadable one does not.",
    ],
    cautions: [
      "The thresholds are $100 and $500. They were raised from $30 and $150 effective April 20, 2021 and plenty of secondary sources still print the old numbers.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "expense_receipt",
    title: "Expense receipt",
    documentClass: "commercial",
    summary: "Supports a deduction or an input tax credit.",
    fields: [
      { key: "vendor_name", label: "Vendor name", required: true, precisionSensitive: false, why: "Required at every amount.", citation: cite(ITC_REG, "s. 3") },
      { key: "transaction_date", label: "Date", required: true, precisionSensitive: true, why: "Required at every amount, and places it in a period.", citation: cite(ITC_REG, "s. 3") },
      { key: "total", label: "Total amount", required: true, precisionSensitive: true, why: "Required at every amount, and decides which tier applies.", citation: cite(ITC_REG, "s. 3") },
    ],
    paper: { paperRequired: false, where: "An electronic copy is acceptable if it stays readable for the retention period.", citation: cite(CRA_RECORDS, null) },
    statutoryRetention: CRA_SIX_YEARS,
    steps: [
      "Scan it the day you get it. A fuel receipt in a jacket pocket is a receipt you will not have in March.",
      "Check the total and the date against the page - both are precision-sensitive and neither auto-files.",
      "If the amount puts it over $100, check that the supplier's GST/HST registration number is legible on the paper.",
    ],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "fuel_receipt",
    title: "Fuel receipt",
    documentClass: "commercial",
    summary: "Supports the fuel ledger, the input tax credit, and the IFTA return.",
    fields: [
      { key: "vendor_name", label: "Vendor or cardlock", required: true, precisionSensitive: false, why: "Identifies where the fuel was bought.", citation: cite(ITC_REG, "s. 3") },
      { key: "transaction_date", label: "Date", required: true, precisionSensitive: true, why: "Places the fill in an IFTA quarter and a period.", citation: cite(ITC_REG, "s. 3") },
      { key: "quantity", label: "Litres", required: true, precisionSensitive: true, why: "Drives the IFTA return and the fuel ledger.", citation: cite("IFTA", null) },
      { key: "jurisdiction", label: "Jurisdiction", required: true, precisionSensitive: true, why: "IFTA apportions by where the fuel was bought.", citation: cite("IFTA", null) },
      { key: "total", label: "Total amount", required: true, precisionSensitive: true, why: "Precision-sensitive; it becomes money.", citation: cite(ITC_REG, "s. 3") },
    ],
    paper: { paperRequired: false, where: "An electronic copy is acceptable if it stays readable for the retention period.", citation: cite(CRA_RECORDS, null) },
    statutoryRetention: CRA_SIX_YEARS,
    steps: [
      "Scan at the pump, not at the end of the day.",
      "Check the litres and the jurisdiction - an IFTA return built on a misread litre count is wrong in every quarter it touches.",
      "Confirm the unit number so the fill lands on the right truck.",
    ],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "scale_ticket",
    title: "Scale / weigh ticket",
    documentClass: "regulatory",
    summary: "A certified weight, used to reconcile a load and to settle what is billed.",
    fields: [
      { key: "gross", label: "Gross weight", required: true, precisionSensitive: true, why: "Half of the net calculation.", citation: cite(OPERATIONAL, null) },
      { key: "tare", label: "Tare weight", required: true, precisionSensitive: true, why: "The other half.", citation: cite(OPERATIONAL, null) },
      { key: "net", label: "Net weight", required: true, precisionSensitive: true, why: "What gets billed and what reconciles against the manifest.", citation: cite(OPERATIONAL, null) },
      { key: "weighed_at", label: "Date and time weighed", required: true, precisionSensitive: true, why: "Ties the weight to a specific load.", citation: cite(OPERATIONAL, null) },
    ],
    paper: { paperRequired: null, where: null, citation: cite(OPERATIONAL, null) },
    statutoryRetention: CRA_SIX_YEARS,
    steps: [
      "Scan both the inbound and the outbound ticket - one weight is not a net.",
      "Check gross, tare and net all read off the page. A transposed digit in a weight is a transposed digit in an invoice.",
    ],
    cautions: [
      "Weights are kilograms on most Western Canadian scales. A kilogram read as a pound is a 2.2x billing error that looks entirely plausible.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "bill_of_lading",
    title: "Bill of lading",
    documentClass: "commercial",
    summary: "The contract of carriage and the description of what was picked up.",
    fields: [
      { key: "shipper", label: "Shipper", required: true, precisionSensitive: false, why: "Who tendered the load.", citation: cite(OPERATIONAL, "provincial carriage rules") },
      { key: "consignee", label: "Consignee", required: true, precisionSensitive: false, why: "Who is entitled to receive it.", citation: cite(OPERATIONAL, "provincial carriage rules") },
      { key: "description", label: "Description of goods", required: true, precisionSensitive: true, why: "What the carrier accepted.", citation: cite(OPERATIONAL, "provincial carriage rules") },
      { key: "pickup_signature", label: "Pickup signature", required: true, precisionSensitive: true, why: "Evidence the carrier took custody.", citation: cite(OPERATIONAL, "provincial carriage rules") },
    ],
    paper: { paperRequired: null, where: null, citation: cite(OPERATIONAL, null) },
    statutoryRetention: CRA_SIX_YEARS,
    steps: [
      "Scan the signed copy, not the blank one.",
      "Check the description matches what is actually on the deck.",
    ],
    cautions: [
      "A bill of lading is not a hazardous waste manifest and does not substitute for one in BC.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "load_ticket",
    title: "Field / load ticket",
    documentClass: "commercial",
    summary: "What was done on the lease, and what the customer signs for.",
    fields: [
      { key: "lease", label: "Lease or LSD", required: true, precisionSensitive: true, why: "Where the work happened.", citation: cite(OPERATIONAL, null) },
      { key: "customer_signature", label: "Customer signature", required: true, precisionSensitive: true, why: "What turns work into a billable ticket.", citation: cite(OPERATIONAL, null) },
      { key: "service_date", label: "Service date", required: true, precisionSensitive: true, why: "Places it in a billing period.", citation: cite(OPERATIONAL, null) },
    ],
    paper: { paperRequired: null, where: null, citation: cite(OPERATIONAL, null) },
    statutoryRetention: CRA_SIX_YEARS,
    steps: [
      "Get the signature before you leave the lease.",
      "Check the LSD reads exactly as it is on the page - a transposed legal subdivision bills the wrong well.",
    ],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "inspection_report",
    title: "Inspection report",
    documentClass: "regulatory",
    summary: "A pre-trip, post-trip or roadside inspection record.",
    fields: [
      { key: "unit", label: "Unit", required: true, precisionSensitive: true, why: "Which vehicle was inspected.", citation: cite(OPERATIONAL, null) },
      { key: "inspected_at", label: "Date and time", required: true, precisionSensitive: true, why: "An inspection is only current for so long.", citation: cite(OPERATIONAL, null) },
      { key: "defects", label: "Defects found", required: true, precisionSensitive: true, why: "What the shop has to act on.", citation: cite(OPERATIONAL, null) },
      { key: "inspector", label: "Inspector", required: true, precisionSensitive: true, why: "Who stands behind the result.", citation: cite(OPERATIONAL, null) },
    ],
    paper: { paperRequired: null, where: null, citation: cite(OPERATIONAL, null) },
    statutoryRetention: NO_STATUTE("no verified inspection-retention rule is loaded"),
    steps: [
      "Scan the report the same shift.",
      "A defect on the page becomes a defect record in LeaseOS only when a person makes it one - scanning it does not raise it.",
    ],
    cautions: [
      "A roadside inspection document is a proposal requiring confirmation. An out-of-service marking whose scope the page does not state writes no order and needs confirming with the inspector.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "safety_document",
    title: "Safety document",
    documentClass: "informational",
    summary: "A tailgate, hazard assessment or safety meeting record.",
    fields: [
      { key: "attendees", label: "Attendees", required: true, precisionSensitive: true, why: "Who was actually there.", citation: cite(OPERATIONAL, null) },
      { key: "held_at", label: "Date and time", required: true, precisionSensitive: true, why: "A tailgate is about the work in front of it.", citation: cite(OPERATIONAL, null) },
    ],
    paper: { paperRequired: null, where: null, citation: cite(OPERATIONAL, null) },
    statutoryRetention: NO_STATUTE("no verified safety-record retention rule is loaded"),
    steps: ["Scan the signed sheet, so the attendee signatures survive with it."],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "unknown",
    title: "Unclassified document",
    /*
     * The strictest class, on purpose. Nobody has established what this document is, so nobody has
     * established who reads it — and treating an unread document as informational would let the
     * loosest printing rules apply to the one document we know least about. Unknown counts against
     * you, not for you.
     */
    documentClass: "regulatory",
    summary: "Nobody has established what this is.",
    fields: [],
    paper: null,
    statutoryRetention: NO_STATUTE("no rule applies until the document is classified"),
    steps: [
      "Tell LeaseOS what this document is. Until somebody does, no guidance applies to it and no retention period is known.",
      "The scan is kept either way - an unclassified document is filed, not discarded.",
    ],
    cautions: [
      "An unclassified document is not a document with no requirements. It is a document whose requirements nobody has looked up.",
    ],
    verification: "unverified",
  },
];

const BY_KIND: Record<string, PaperworkGuidance> = {};
for (const g of GUIDANCE) BY_KIND[g.kind] = g;

export const PAPERWORK_GUIDANCE: Readonly<Record<string, PaperworkGuidance>> = BY_KIND;

/* ------------------------------------------------------------------ */
/* Rules that depend on the document in front of you                   */
/* ------------------------------------------------------------------ */

/**
 * What LeaseOS knows about this particular document.
 *
 * Every field is optional and absent means UNKNOWN. That matters most for `totalCents` on an
 * invoice: the CRA's documentation requirements are tiered by amount, so an unknown total means an
 * unknown tier, and the honest answer is to require every tier's fields and say why. Defaulting to
 * the cheapest tier would quietly tell somebody a $900 invoice needs three fields.
 */
export type GuidanceContext = {
  /** Integer cents, as money is held everywhere else in this system. */
  totalCents?: number | null;
  jurisdiction?: "AB" | "BC" | "SK" | "MB" | "other" | null;
};

/** The CRA documentation tiers, raised from $30/$150 effective April 20, 2021. */
export const ITC_TIER_CENTS = { middle: 100_00, upper: 500_00 } as const;

export type ItcTier = "under_100" | "from_100_to_499" | "500_and_over" | "unknown";

export function itcTierFor(totalCents: number | null | undefined): ItcTier {
  if (typeof totalCents !== "number" || !Number.isFinite(totalCents) || totalCents < 0) return "unknown";
  if (totalCents < ITC_TIER_CENTS.middle) return "under_100";
  if (totalCents < ITC_TIER_CENTS.upper) return "from_100_to_499";
  return "500_and_over";
}

const ITC_MIDDLE: PaperworkField[] = [
  {
    key: "supplier_gst_number", label: "Supplier's GST/HST registration number", required: true, precisionSensitive: true,
    why: "Required at $100 and over, in the format 123456789RT0001.", citation: cite(ITC_REG, "s. 3"),
  },
  {
    key: "payment_terms", label: "Payment terms", required: true, precisionSensitive: false,
    why: "Required at $100 and over where terms apply.", citation: cite(ITC_REG, "s. 3"),
  },
];

const ITC_UPPER: PaperworkField[] = [
  {
    key: "recipient_name", label: "Recipient's name", required: true, precisionSensitive: false,
    why: "Required at $500 and over.", citation: cite(ITC_REG, "s. 3"),
  },
  {
    key: "supply_description", label: "Description of the supply", required: true, precisionSensitive: true,
    why: "Required at $500 and over, and must be sufficient to identify what was supplied.", citation: cite(ITC_REG, "s. 3"),
  },
  {
    key: "tax_by_rate", label: "Tax or rate, shown per applicable rate", required: true, precisionSensitive: true,
    why: "Required at $500 and over.", citation: cite(ITC_REG, "s. 3"),
  },
];

/** Documents whose required fields move with the amount. */
const ITC_DOCUMENTS: readonly PaperworkKind[] = ["invoice", "expense_receipt", "fuel_receipt"] as const;

/**
 * Guidance for one document, with the rules that depend on its amount and its province folded in.
 *
 * Returns a fresh object every call; the registry is never mutated. An unrecognized kind resolves
 * to `unknown` rather than throwing, because a device sending a kind this build does not know is a
 * version-skew problem and the right answer is the strictest guidance, not a crash.
 */
export function guidanceFor(kind: PaperworkKind | string, ctx: GuidanceContext = {}): PaperworkGuidance {
  const base = PAPERWORK_GUIDANCE[kind] ?? PAPERWORK_GUIDANCE["unknown"]!;
  const fields = base.fields.slice();
  const steps = base.steps.slice();
  const cautions = base.cautions.slice();

  if (ITC_DOCUMENTS.indexOf(base.kind) >= 0) {
    const tier = itcTierFor(ctx.totalCents);
    if (tier === "unknown") {
      // Requiring all of them is the fail-closed move: the reader can see which set they land in
      // the moment they read the total off the page, and until then nothing is waved through.
      fields.push(...ITC_MIDDLE, ...ITC_UPPER);
      cautions.push(
        "The total on this document is not established, so which CRA documentation tier applies is UNKNOWN. " +
        "Every tier's fields are required until somebody reads the total: under $100 needs supplier name, date and " +
        "total; $100 to $499.99 adds the supplier's GST/HST number and payment terms; $500 and over adds the " +
        "recipient's name, a description of the supply, and the tax shown per applicable rate.",
      );
    } else if (tier === "from_100_to_499") {
      fields.push(...ITC_MIDDLE);
      steps.push("This document is in the $100 to $499.99 tier: check the supplier's GST/HST registration number is legible.");
    } else if (tier === "500_and_over") {
      fields.push(...ITC_MIDDLE, ...ITC_UPPER);
      steps.push("This document is $500 or more: it needs the recipient's name, a description of the supply, and the tax shown per applicable rate as well as the supplier's registration number.");
    }
  }

  const j = ctx.jurisdiction ?? null;
  if (j === "BC" && (base.kind === "hazardous_waste_manifest" || base.kind === "bill_of_lading" || base.kind === "tdg_shipping_document")) {
    cautions.push("In BC the hazardous waste manifest is its own six-sheet paper form. A TDG shipping document or a bill of lading does not stand in for it.");
  }
  if (j === "SK" && (base.kind === "disposal_ticket" || base.kind === "hazardous_waste_manifest")) {
    cautions.push("In Saskatchewan, oilfield waste reverts to Ministry of Environment jurisdiction under the Hazardous Waste Regulation once it leaves the site for transport or disposal.");
  }
  if (j === null && (base.kind === "hazardous_waste_manifest" || base.kind === "disposal_ticket")) {
    cautions.push("The province this document belongs to is not established, so the provincial rules above may be incomplete. Alberta, BC and Saskatchewan each want something different.");
  }

  return { ...base, fields, steps, cautions };
}

/* ------------------------------------------------------------------ */
/* Observations, and the bridge to printability                        */
/* ------------------------------------------------------------------ */

/**
 * How a value on this document got here.
 *
 * These are `_core/aiProposal.FieldStatus`'s own four values, restated because `shared/` sits
 * below `server/_core/` and cannot import upward. A compile-time assertion in
 * `server/documentScanner.test.ts` fails the build if the two ever drift.
 */
export type ObservedFieldStatus = "proposed" | "confirmed" | "rejected" | "corrected";

export type FieldObservation = { key: string; status: ObservedFieldStatus };

/**
 * What one observation means for printing.
 *
 *   confirmed / corrected  a person stands behind the value. `corrected` is a human assertion that
 *                          replaced a machine one, which is the strongest provenance there is.
 *   proposed               OCR read it and nobody has confirmed it. Provisional, always — this is
 *                          the single most important line in this file, because a provisional
 *                          value on a regulatory document stops the print.
 *   rejected               a person looked and said the read was wrong, and supplied nothing. The
 *                          question matters and is unanswered: UNKNOWN, not absent. Absent would
 *                          read as "nothing expected here".
 *   (no observation)       absent.
 */
export function fieldStateFor(status: ObservedFieldStatus | null | undefined): FieldState {
  if (status === "confirmed" || status === "corrected") return "confirmed";
  if (status === "proposed") return "provisional";
  if (status === "rejected") return "unknown";
  return "absent";
}

/**
 * The field manifest `printability.assessPrintability` consumes.
 *
 * This is the whole integration. This file says what a document needs and what is known about each
 * value; `assessPrintability` decides whether that may go on paper. There is deliberately no
 * second "is this document complete" verdict here — that question has an owner, and answering it
 * twice is how the two answers stop agreeing.
 *
 * An observation whose key is not a field of this document is ignored rather than passed through:
 * a caller cannot widen the manifest, and a stray key would otherwise become a field nobody
 * declared and printability would dutifully judge it.
 */
export function toPrintFields(
  kind: PaperworkKind | string,
  observations: readonly FieldObservation[],
  ctx: GuidanceContext = {},
): PrintField[] {
  const g = guidanceFor(kind, ctx);
  const latest: Record<string, ObservedFieldStatus> = {};
  for (const o of observations) latest[o.key] = o.status;

  return g.fields.map(f => ({
    key: f.key,
    label: f.label,
    required: f.required,
    state: fieldStateFor(latest[f.key]),
  }));
}

/**
 * The guard that keeps the seed honest.
 *
 * Returns the kinds whose guidance claims to be verified. It must always be empty in this build:
 * verification is a recorded act by a person against a clause, and no seed may arrive already
 * carrying the answer. A test asserts the emptiness, so flipping a literal fails the gate.
 */
export function kindsClaimingVerified(): PaperworkKind[] {
  return ALL_PAPERWORK_KINDS.filter(k => (PAPERWORK_GUIDANCE[k]?.verification ?? "unverified") === "verified");
}
