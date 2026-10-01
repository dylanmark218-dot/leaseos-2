/**
 * Paperwork guidance — what this document needs, who keeps it, and for how long.
 *
 * The scanner's job does not end when the bytes are safe. A driver holding a
 * disposal ticket at a facility gate has about ninety seconds to notice that
 * the receiving signature block is empty, and that is the only ninety seconds
 * in which it can be fixed. Three days later it is a discrepancy the AER wants
 * reported inside twenty-one days and nobody can remember who was on the gate.
 *
 * So this file answers, for one kind of paperwork: what has to be on it, who
 * has to keep a copy and for how long, whether paper has to physically travel,
 * and which fields must never be filled in by guessing.
 *
 * ## Every rule here is UNVERIFIED and says so
 *
 * This is the same discipline the HOS registry and the seeded channel banks
 * are under, and for the same reason. Every rule carries a citation and a
 * `verification` of `unverified`, because LeaseOS has not read the instrument
 * — it has read a planning report that read the instrument, and `readFrom` on
 * each citation says exactly that. An unverified rule is shown to a worker as
 * guidance with its clause attached so they can check it, and it is never the
 * basis of a compliance verdict. Verifying is a recorded act by a person, one
 * clause at a time, and there is deliberately no seed that arrives verified:
 * the failure mode of a confident regulatory seed is a company that stops
 * checking.
 *
 * What that buys is the honest version of helpfulness. "Alberta hazardous
 * waste needs the generator's PIN before consignment — Waste Control
 * Regulation, per the 2026-09-21 planning report, UNVERIFIED" sends somebody
 * to the regulation. "Add the PIN" sounds like LeaseOS knows.
 *
 * ## Guidance is not a gate
 *
 * Nothing in this file blocks anything. It advises, names what is missing, and
 * cites. The requirement engine, the dispatch gate and the compliance registry
 * are where blocking lives, they read verified rules, and they would be wrong
 * to read these.
 */

import type { DocumentType } from "./documentExtraction";

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a rule comes from.
 *
 * `readFrom` is the field that keeps this honest. LeaseOS did not read
 * SOR/2001-286; it read a report dated 2026-09-21 that cites SOR/2001-286, and
 * a reader deciding whether to trust a rule needs to know which of those two
 * things happened.
 */
export type Citation = {
  /** The instrument, as an auditor would name it. */
  source: string;
  /** Section, clause or page, where the report gave one. */
  locator: string | null;
  /** What LeaseOS actually read. Never a claim to have read the instrument. */
  readFrom: string;
};

const REPORT = "Planning report “Built-In Document Scanning and Printing for LeaseOS/FieldRoute”, 2026-09-21";

const cite = (source: string, locator: string | null): Citation => ({ source, locator, readFrom: REPORT });

/**
 * Seeded unverified, always.
 *
 * `verified` exists as a value because a person verifying a clause is the act
 * this type is waiting for. Nothing in this file constructs one.
 */
export type GuidanceVerification = "unverified" | "verified";

/* ------------------------------------------------------------------ */
/* The vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * One document vocabulary, extended — not a second one.
 *
 * `DocumentType` is what `classifyDocument` produces from OCR. The four kinds
 * added here are regulated documents the classifier does not yet distinguish:
 * "manifest" currently scores towards `disposal_ticket`, and teaching the
 * keyword table to split them would change how existing tickets classify. So
 * these four are chosen by a person on the capture screen, and a document
 * nobody chose stays whatever the classifier said it was.
 *
 * When the classifier learns them, it learns these names — there is no second
 * table to keep in step.
 */
export type PaperworkKind =
  | DocumentType
  | "tdg_shipping_document"
  | "hazardous_waste_manifest"
  | "bill_of_lading"
  | "inspection_report";

/** The kinds a person selects because the classifier cannot yet produce them. */
export const OPERATOR_SELECTED_KINDS: readonly PaperworkKind[] = [
  "tdg_shipping_document", "hazardous_waste_manifest", "bill_of_lading", "inspection_report",
] as const;

/* ------------------------------------------------------------------ */
/* The shape of a rule                                                 */
/* ------------------------------------------------------------------ */

export type RequiredField = {
  key: string;
  label: string;
  /** Why it is required, in the terms of whoever requires it. */
  why: string;
  /**
   * A field that must never be filled from an OCR read, however confident.
   * Left blank and marked REQUIRED beats filled in and wrong: a wrong UN
   * number on a shipping document is worse than a missing one, because the
   * missing one stops the truck and the wrong one does not.
   */
  neverGuess: boolean;
  citation: Citation;
};

export type RetentionRule = {
  /** null is UNKNOWN — a period nobody established, never a period of none. */
  years: number | null;
  /** Each party that must hold a copy, named separately: they are separate duties. */
  whoMustRetain: readonly string[];
  citation: Citation;
};

export type PaperRule = {
  /** Whether a paper copy must physically travel with the load. null is UNKNOWN. */
  paperRequired: boolean | null;
  /** Where the paper must be, in the regulation's own terms. */
  where: string | null;
  citation: Citation;
};

export type PaperworkGuidance = {
  kind: PaperworkKind;
  title: string;
  /** One line: what this document is for. */
  summary: string;
  requiredFields: readonly RequiredField[];
  retention: readonly RetentionRule[];
  paper: PaperRule | null;
  /** What to do, in the order a worker does it. */
  steps: readonly string[];
  /** Traps worth naming out loud. */
  cautions: readonly string[];
  verification: GuidanceVerification;
};

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

const CRA_SIX_YEARS: RetentionRule = {
  years: 6,
  whoMustRetain: ["the registrant claiming the input tax credit"],
  citation: cite("Income Tax Act / Excise Tax Act record retention, CRA (IC05-1R1 for electronic records; Guide RC4022)", "6 years"),
};

const THERMAL_CAUTION =
  "If this arrived as a thermal printout, the paper is not the record. Thermal images can start fading within six months " +
  "(NARA Bulletin 96-03) and far faster on a dashboard — the scan in LeaseOS is the copy that has to last the retention period.";

const guidance: PaperworkGuidance[] = [
  {
    kind: "tdg_shipping_document",
    title: "TDG shipping document",
    summary: "Travels with dangerous goods and describes what is in the load.",
    requiredFields: [
      { key: "un_number", label: "UN number", why: "Identifies the dangerous good.", neverGuess: true, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
      { key: "shipping_name", label: "Shipping name", why: "The regulated name of the good, not the trade name.", neverGuess: true, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
      { key: "class", label: "Class", why: "Determines placarding and segregation.", neverGuess: true, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
      { key: "packing_group", label: "Packing group", why: "Determines packaging requirements.", neverGuess: true, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
      { key: "quantity", label: "Quantity", why: "Drives threshold quantities and ERAP.", neverGuess: true, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
      { key: "consignor", label: "Consignor", why: "One of the three parties that must retain a copy.", neverGuess: false, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
      { key: "emergency_number", label: "24-hour emergency number", why: "The number somebody calls from the ditch.", neverGuess: true, citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "Part 3") },
    ],
    retention: [{
      years: 2,
      whoMustRetain: ["the consignor", "the carrier", "the importer"],
      citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "at least 2 years"),
    }],
    paper: {
      paperRequired: true,
      where: "If the driver is in the power unit: in a pocket mounted on the driver's door, or within the driver's reach. " +
        "If the driver is out of the power unit: in the door pocket, on the driver's seat, or somewhere clearly visible to anyone entering by the driver's door.",
      citation: cite("Transportation of Dangerous Goods Regulations (SOR/2001-286)", "s. 3.7"),
    },
    steps: [
      "Check the paper copy is in the cab before the wheels turn — as of the September 2026 report, an electronic-only shipping document needs an individual Transport Canada equivalency certificate.",
      "Scan the paper copy into LeaseOS so the retained record survives the trip.",
      "Confirm every extracted field against the page. Nothing on a shipping document is auto-filed.",
      "If a required field is unreadable, leave it blank and mark it REQUIRED rather than accepting the scanner's guess.",
    ],
    cautions: [
      "The June 2026 amendments (SOR/2026-112 and SOR/2026-127) changed the CONTENT rules, not the paper requirement. Do not read them as authorizing a paperless cab.",
      "An equivalency certificate carries a connectivity condition — the document must be updatable at loading and unloading sites — which sits badly with low-coverage lease work.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "hazardous_waste_manifest",
    title: "Hazardous waste manifest",
    summary: "Tracks a hazardous waste shipment from generator through carrier to receiver.",
    requiredFields: [
      { key: "generator_pin", label: "Generator PIN", why: "Alberta requires the generator's PIN before consignment.", neverGuess: true, citation: cite("Alberta Environmental Protection and Enhancement Act / Waste Control Regulation", null) },
      { key: "carrier_pin", label: "Carrier PIN", why: "Alberta requires the carrier's PIN before consignment.", neverGuess: true, citation: cite("Alberta Environmental Protection and Enhancement Act / Waste Control Regulation", null) },
      { key: "receiver_pin", label: "Receiver PIN", why: "Alberta requires the receiver's PIN before consignment.", neverGuess: true, citation: cite("Alberta Environmental Protection and Enhancement Act / Waste Control Regulation", null) },
      { key: "waste_description", label: "Waste description", why: "Identifies what is being moved.", neverGuess: true, citation: cite("Alberta Environmental Protection and Enhancement Act / Waste Control Regulation", null) },
      { key: "quantity", label: "Quantity", why: "Reconciled against what the receiving facility accepts.", neverGuess: true, citation: cite("Alberta Environmental Protection and Enhancement Act / Waste Control Regulation", null) },
      { key: "receiving_signature", label: "Receiving facility signature", why: "The handover nobody can reconstruct later.", neverGuess: true, citation: cite("Alberta Environmental Protection and Enhancement Act / Waste Control Regulation", null) },
    ],
    retention: [{
      years: 2,
      whoMustRetain: ["the generator", "the carrier", "the receiving facility"],
      citation: cite("AER Directive 058 (June 4, 2026 edition) and Manual 034 (March 2026)", "minimum 2 years"),
    }],
    paper: {
      paperRequired: true,
      where: "A six-sheet NCR form travelling with the load; each party keeps its sheet.",
      citation: cite("Alberta hazardous waste manifest / BC hazardous waste manifest", "6-sheet NCR form"),
    },
    steps: [
      "Check all three PINs are filled in before the load is consigned — a missing PIN is a problem at the gate, not at month end.",
      "Get the receiving facility's signature on the gate, and scan the signed sheet before you pull away.",
      "Scan your own sheet into LeaseOS as well, so the retained copy does not depend on the NCR surviving the season.",
      "If the quantity accepted differs from the quantity consigned, record the discrepancy the same day.",
    ],
    cautions: [
      "In BC a TDG shipping document or a bill of lading cannot substitute for the hazardous waste manifest — they are different documents and BC wants the manifest.",
      "Hazardous recyclables over 205 L or kg take a recycle docket rather than a manifest.",
      "Interprovincial and international movements fall under the federal Cross-border Movement of Hazardous Waste and Hazardous Recyclable Material Regulations (SOR/2021-25), where the “Movement Document” is the analogue of the provincial manifest.",
      "An unresolved discrepancy must reach the AER within 21 days. The clock starts at the gate, not when somebody notices.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "disposal_ticket",
    title: "Disposal / facility ticket",
    summary: "What a receiving facility says it took, and the evidence a load actually ended somewhere legal.",
    requiredFields: [
      { key: "facility", label: "Receiving facility", why: "Which facility accepted the load.", neverGuess: true, citation: cite("AER Directive 058 (June 4, 2026 edition)", null) },
      { key: "ticket_number", label: "Ticket number", why: "The facility's own reference, and how a dispute is settled.", neverGuess: true, citation: cite("AER Directive 058 (June 4, 2026 edition)", null) },
      { key: "waste_code", label: "Waste code", why: "New waste codes are accepted in Petrinex from May 2026 production data.", neverGuess: true, citation: cite("AER Directive 058 (June 4, 2026 edition) / Petrinex", null) },
      { key: "volume", label: "Volume accepted", why: "Reconciled against what was consigned, and it is what gets billed.", neverGuess: true, citation: cite("AER Directive 058 (June 4, 2026 edition)", null) },
      { key: "accepted_at", label: "Date and time accepted", why: "Places the load in a day, a shift and a billing period.", neverGuess: true, citation: cite("AER Directive 058 (June 4, 2026 edition)", null) },
    ],
    retention: [{
      years: 2,
      whoMustRetain: ["the generator", "the carrier", "the receiving facility"],
      citation: cite("AER Directive 058 (June 4, 2026 edition) and Manual 034 (March 2026)", "minimum 2 years"),
    }],
    paper: {
      paperRequired: null,
      where: null,
      citation: cite("AER Directive 058 (June 4, 2026 edition)", "form, manifest, truck ticket or bill of lading"),
    },
    steps: [
      "Scan the ticket at the gate while the facility staff are still standing there.",
      "Check the volume on the ticket against the volume you hauled before you leave.",
      "Confirm the ticket number and the waste code by reading them off the page — these two settle disputes and neither auto-files.",
      "If the facility issues no ticket, record that fact rather than leaving the load unevidenced.",
    ],
    cautions: [
      "Directive 058 was overhauled effective June 4, 2026, with the detailed guidance moved into Manual 034 — requirements differ for DOW and non-DOW streams and by facility type.",
      "An unresolved discrepancy must be reported to the AER within 21 days.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "invoice",
    title: "Sales invoice (GST/HST)",
    summary: "What a customer is charged, and what lets them claim the input tax credit.",
    requiredFields: [
      { key: "supplier_name", label: "Supplier or intermediary name", why: "Required at every amount.", neverGuess: false, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
      { key: "invoice_date", label: "Invoice date", why: "Required at every amount.", neverGuess: true, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
      { key: "total", label: "Total amount", why: "Required at every amount, and it decides which tier applies.", neverGuess: true, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
    ],
    retention: [CRA_SIX_YEARS],
    paper: {
      paperRequired: false,
      where: "Electronic invoices and receipts are acceptable provided the required fields are present and the records stay readable for the retention period.",
      citation: cite("CRA IC05-1R1 (electronic records); Memorandum 8-4; Guide RC4022", null),
    },
    steps: [
      "Check which tier the total puts this invoice in — the extra fields are not optional decoration, they are what makes the credit claimable.",
      "If you are registered for GST/HST, show the tax separately on every invoice you issue.",
      "Keep the record readable for six years. A scanned copy counts; an unreadable one does not.",
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
    summary: "Supports a deduction or an input tax credit.",
    requiredFields: [
      { key: "vendor_name", label: "Vendor name", why: "Required at every amount.", neverGuess: false, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
      { key: "transaction_date", label: "Date", why: "Required at every amount, and places it in a period.", neverGuess: true, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
      { key: "total", label: "Total amount", why: "Required at every amount, and decides which tier applies.", neverGuess: true, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: false, where: "An electronic copy is acceptable if it stays readable for the retention period.", citation: cite("CRA IC05-1R1; Guide RC4022", null) },
    steps: [
      "Scan it the day you get it. A fuel receipt in a jacket pocket is a receipt you will not have in March.",
      "Check the total and the date against the page — both are precision-sensitive and neither auto-files.",
      "If the amount puts it over $100, check that the supplier's GST/HST registration number is legible on the paper.",
    ],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "fuel_receipt",
    title: "Fuel receipt",
    summary: "Supports the fuel ledger, the input tax credit, and the IFTA return.",
    requiredFields: [
      { key: "vendor_name", label: "Vendor or cardlock", why: "Identifies where the fuel was bought.", neverGuess: false, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
      { key: "transaction_date", label: "Date", why: "Places the fill in an IFTA quarter and a period.", neverGuess: true, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
      { key: "quantity", label: "Litres", why: "Drives the IFTA return and the fuel ledger.", neverGuess: true, citation: cite("IFTA", null) },
      { key: "jurisdiction", label: "Jurisdiction", why: "IFTA apportions by where the fuel was bought.", neverGuess: true, citation: cite("IFTA", null) },
      { key: "total", label: "Total amount", why: "Precision-sensitive; it becomes money.", neverGuess: true, citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3") },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: false, where: "An electronic copy is acceptable if it stays readable for the retention period.", citation: cite("CRA IC05-1R1; Guide RC4022", null) },
    steps: [
      "Scan at the pump, not at the end of the day.",
      "Check the litres and the jurisdiction — an IFTA return built on a misread litre count is wrong in every quarter it touches.",
      "Confirm the unit number so the fill lands on the right truck.",
    ],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "scale_ticket",
    title: "Scale / weigh ticket",
    summary: "A certified weight, used to reconcile a load and to settle what is billed.",
    requiredFields: [
      { key: "gross", label: "Gross weight", why: "Half of the net calculation.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "tare", label: "Tare weight", why: "The other half.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "net", label: "Net weight", why: "What gets billed and what reconciles against the manifest.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "weighed_at", label: "Date and time weighed", why: "Ties the weight to a specific load.", neverGuess: true, citation: cite("Operational record", null) },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: null, where: null, citation: cite("Operational record", null) },
    steps: [
      "Scan both the inbound and the outbound ticket — one weight is not a net.",
      "Check gross, tare and net all read off the page. A transposed digit in a weight is a transposed digit in an invoice.",
    ],
    cautions: [
      "Weights are kilograms on most Western Canadian scales. A kilogram read as a pound is a 2.2× billing error that looks entirely plausible.",
      THERMAL_CAUTION,
    ],
    verification: "unverified",
  },
  {
    kind: "bill_of_lading",
    title: "Bill of lading",
    summary: "The contract of carriage and the description of what was picked up.",
    requiredFields: [
      { key: "shipper", label: "Shipper", why: "Who tendered the load.", neverGuess: false, citation: cite("Provincial carriage rules", null) },
      { key: "consignee", label: "Consignee", why: "Who is entitled to receive it.", neverGuess: false, citation: cite("Provincial carriage rules", null) },
      { key: "description", label: "Description of goods", why: "What the carrier accepted.", neverGuess: true, citation: cite("Provincial carriage rules", null) },
      { key: "pickup_signature", label: "Pickup signature", why: "Evidence the carrier took custody.", neverGuess: true, citation: cite("Provincial carriage rules", null) },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: null, where: null, citation: cite("Provincial carriage rules", null) },
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
    summary: "What was done on the lease, and what the customer signs for.",
    requiredFields: [
      { key: "lease", label: "Lease or LSD", why: "Where the work happened.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "customer_signature", label: "Customer signature", why: "What turns work into a billable ticket.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "service_date", label: "Service date", why: "Places it in a billing period.", neverGuess: true, citation: cite("Operational record", null) },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: null, where: null, citation: cite("Operational record", null) },
    steps: [
      "Get the signature before you leave the lease.",
      "Check the LSD reads exactly as it is on the page — a transposed legal subdivision bills the wrong well.",
    ],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "inspection_report",
    title: "Inspection report",
    summary: "A pre-trip, post-trip or roadside inspection record.",
    requiredFields: [
      { key: "unit", label: "Unit", why: "Which vehicle was inspected.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "inspected_at", label: "Date and time", why: "An inspection is only current for so long.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "defects", label: "Defects found", why: "What the shop has to act on.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "inspector", label: "Inspector", why: "Who stands behind the result.", neverGuess: true, citation: cite("Operational record", null) },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: null, where: null, citation: cite("Operational record", null) },
    steps: [
      "Scan the report the same shift.",
      "A defect on the page becomes a defect record in LeaseOS only when a person makes it one — scanning it does not raise it.",
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
    summary: "A tailgate, hazard assessment or safety meeting record.",
    requiredFields: [
      { key: "attendees", label: "Attendees", why: "Who was actually there.", neverGuess: true, citation: cite("Operational record", null) },
      { key: "held_at", label: "Date and time", why: "A tailgate is about the work in front of it.", neverGuess: true, citation: cite("Operational record", null) },
    ],
    retention: [CRA_SIX_YEARS],
    paper: { paperRequired: null, where: null, citation: cite("Operational record", null) },
    steps: ["Scan the signed sheet, so the attendee signatures survive with it."],
    cautions: [THERMAL_CAUTION],
    verification: "unverified",
  },
  {
    kind: "unknown",
    title: "Unclassified document",
    summary: "Nobody has established what this is.",
    requiredFields: [],
    retention: [{
      years: null,
      whoMustRetain: [],
      citation: cite("No rule applies until the document is classified", null),
    }],
    paper: null,
    steps: [
      "Tell LeaseOS what this document is. Until somebody does, no guidance applies to it and no retention period is known.",
      "The scan is kept either way — an unclassified document is filed, not discarded.",
    ],
    cautions: [
      "An unclassified document is not a document with no requirements. It is a document whose requirements nobody has looked up.",
    ],
    verification: "unverified",
  },
];

export const PAPERWORK_GUIDANCE: ReadonlyMap<PaperworkKind, PaperworkGuidance> =
  new Map(guidance.map(g => [g.kind, g]));

/* ------------------------------------------------------------------ */
/* Rules that depend on the document in front of you                   */
/* ------------------------------------------------------------------ */

/**
 * What LeaseOS knows about this particular document.
 *
 * Every field is optional and absent means UNKNOWN. That matters most for
 * `totalCents` on an invoice: the CRA's documentation requirements are tiered
 * by amount, so an unknown total means an unknown tier, and the honest answer
 * is to name every tier's fields and say which one applies is not established.
 * Defaulting to the cheapest tier would quietly tell somebody a $900 invoice
 * needs three fields.
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
  if (totalCents == null || !Number.isFinite(totalCents) || totalCents < 0) return "unknown";
  if (totalCents < ITC_TIER_CENTS.middle) return "under_100";
  if (totalCents < ITC_TIER_CENTS.upper) return "from_100_to_499";
  return "500_and_over";
}

const ITC_REG_NUMBER: RequiredField = {
  key: "supplier_gst_number", label: "Supplier's GST/HST registration number",
  why: "Required at $100 and over, in the format 123456789RT0001.",
  neverGuess: true,
  citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3"),
};

const ITC_PAYMENT_TERMS: RequiredField = {
  key: "payment_terms", label: "Payment terms",
  why: "Required at $100 and over where terms apply.",
  neverGuess: false,
  citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3"),
};

const ITC_UPPER: RequiredField[] = [
  {
    key: "recipient_name", label: "Recipient's name",
    why: "Required at $500 and over.", neverGuess: false,
    citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3"),
  },
  {
    key: "supply_description", label: "Description of the supply",
    why: "Required at $500 and over, and must be sufficient to identify what was supplied.",
    neverGuess: true,
    citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3"),
  },
  {
    key: "tax_by_rate", label: "Tax or rate, shown per applicable rate",
    why: "Required at $500 and over.", neverGuess: true,
    citation: cite("Input Tax Credit Information (GST/HST) Regulations (SOR/91-45)", "s. 3"),
  },
];

/** Documents whose required fields move with the amount. */
const ITC_DOCUMENTS: readonly PaperworkKind[] = ["invoice", "expense_receipt", "fuel_receipt"] as const;

/**
 * Guidance for one document, with the rules that depend on its amount and its
 * province folded in.
 *
 * Returns a fresh object each call; the registry is never mutated.
 */
export function guidanceFor(kind: PaperworkKind, ctx: GuidanceContext = {}): PaperworkGuidance {
  const base = PAPERWORK_GUIDANCE.get(kind) ?? PAPERWORK_GUIDANCE.get("unknown")!;
  const requiredFields = [...base.requiredFields];
  const steps = [...base.steps];
  const cautions = [...base.cautions];

  if (ITC_DOCUMENTS.includes(kind)) {
    const tier = itcTierFor(ctx.totalCents);
    if (tier === "unknown") {
      // Naming all of them is the honest move: the reader can see which set
      // they land in the moment they read the total off the page.
      requiredFields.push(ITC_REG_NUMBER, ITC_PAYMENT_TERMS, ...ITC_UPPER);
      cautions.push(
        "The total on this document is not established, so which CRA documentation tier applies is UNKNOWN. " +
        "Every tier's fields are listed: under $100 needs supplier name, date and total; $100 to $499.99 adds the " +
        "supplier's GST/HST number and payment terms; $500 and over adds the recipient's name, a description of the " +
        "supply, and the tax shown per applicable rate.",
      );
    } else if (tier === "from_100_to_499") {
      requiredFields.push(ITC_REG_NUMBER, ITC_PAYMENT_TERMS);
      steps.push("This document is in the $100 to $499.99 tier: check the supplier's GST/HST registration number is legible.");
    } else if (tier === "500_and_over") {
      requiredFields.push(ITC_REG_NUMBER, ITC_PAYMENT_TERMS, ...ITC_UPPER);
      steps.push("This document is $500 or more: it needs the recipient's name, a description of the supply, and the tax shown per applicable rate as well as the supplier's registration number.");
    }
  }

  if (ctx.jurisdiction === "BC" && (kind === "hazardous_waste_manifest" || kind === "bill_of_lading" || kind === "tdg_shipping_document")) {
    cautions.push("In BC the hazardous waste manifest is its own six-sheet paper form. A TDG shipping document or a bill of lading does not stand in for it.");
  }

  if (ctx.jurisdiction === "SK" && (kind === "disposal_ticket" || kind === "hazardous_waste_manifest")) {
    cautions.push("In Saskatchewan, oilfield waste reverts to Ministry of Environment jurisdiction under the Hazardous Waste Regulation once it leaves the site for transport or disposal.");
  }

  if (ctx.jurisdiction == null && (kind === "hazardous_waste_manifest" || kind === "disposal_ticket")) {
    cautions.push("The province this document belongs to is not established, so the provincial rules above may be incomplete. Alberta, BC and Saskatchewan each want something different.");
  }

  return { ...base, requiredFields, steps, cautions };
}

/* ------------------------------------------------------------------ */
/* The checklist                                                       */
/* ------------------------------------------------------------------ */

export type ChecklistItem = {
  field: RequiredField;
  present: boolean;
  /** What to do about it, when it is not present. */
  advice: string | null;
};

export type PaperworkChecklist = {
  kind: PaperworkKind;
  title: string;
  items: ChecklistItem[];
  /** Required fields nobody has supplied. */
  missing: string[];
  /**
   * Missing fields that must never be filled from an OCR read. These are the
   * ones to leave blank and mark REQUIRED rather than accept a guess at.
   */
  missingMustNotGuess: string[];
  /** True when every required field is present. Never true for an unclassified document. */
  complete: boolean;
  retention: readonly RetentionRule[];
  paper: PaperRule | null;
  steps: readonly string[];
  cautions: readonly string[];
  verification: GuidanceVerification;
};

/**
 * What is still missing from this document.
 *
 * `present` is decided by the caller supplying the key, not by the value being
 * truthy: a confirmed quantity of zero is present, and treating it as missing
 * would send somebody to re-read a page that is already correct.
 *
 * An unclassified document is never `complete`. It has no required fields, and
 * reporting "nothing missing" would read as a clean bill of health for a
 * document whose requirements nobody has looked up.
 */
export function paperworkChecklist(args: {
  kind: PaperworkKind;
  presentFieldKeys: readonly string[];
  context?: GuidanceContext;
}): PaperworkChecklist {
  const g = guidanceFor(args.kind, args.context ?? {});
  const present = new Set(args.presentFieldKeys);

  const items: ChecklistItem[] = g.requiredFields.map(field => {
    const isPresent = present.has(field.key);
    return {
      field,
      present: isPresent,
      advice: isPresent ? null
        : field.neverGuess
          ? `${field.label} is missing. Read it off the page and enter it, or leave it blank and mark it REQUIRED — do not accept a scanner's guess at this field.`
          : `${field.label} is missing. ${field.why}`,
    };
  });

  const missingItems = items.filter(i => !i.present);

  return {
    kind: g.kind,
    title: g.title,
    items,
    missing: missingItems.map(i => i.field.key),
    missingMustNotGuess: missingItems.filter(i => i.field.neverGuess).map(i => i.field.key),
    complete: args.kind !== "unknown" && missingItems.length === 0,
    retention: g.retention,
    paper: g.paper,
    steps: g.steps,
    cautions: g.cautions,
    verification: g.verification,
  };
}

/**
 * The longest retention any rule on this document names, in years.
 *
 * `null` is UNKNOWN, and a rule whose own period is unknown makes the answer
 * unknown rather than being skipped over in favour of a shorter rule that
 * happens to have a number. Throwing away a record at two years because the
 * six-year rule was the one nobody had established is the exact failure this
 * guards.
 */
export function longestRetentionYears(rules: readonly RetentionRule[]): number | null {
  if (rules.length === 0) return null;
  if (rules.some(r => r.years == null)) return null;
  return Math.max(...rules.map(r => r.years as number));
}
