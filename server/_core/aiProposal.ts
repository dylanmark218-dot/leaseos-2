/**
 * Typed AI proposals — the engine under the Assistant.
 *
 * A spoken sentence does not become a record. It becomes a PROPOSAL: a typed,
 * inspectable object with one entry per field, each carrying where it came
 * from and how sure we are. The person then changes, rejects or accepts it,
 * hears it read back, and only then does anything commit.
 *
 *     utterance → extraction → gaps → minimum questions → read-back → commit
 *
 * The rule this file exists to enforce, from the original design notes:
 *
 *     "About 8,000 litres" must not silently become an exact measured
 *     quantity. "Around ten" must not become 10:00:00.
 *
 * So `precision` is a first-class property of every value, an approximate
 * value cannot be committed as exact without someone saying so, and the
 * assistant records what a driver said rather than deciding what it meant.
 */

export type Precision = "exact" | "approximate";

export type FieldSource =
  | "driver_voice"
  | "driver_typed"
  | "gps"
  | "photo_ocr"
  | "system_inferred"
  | "imported"
  | "human_corrected";

export type FieldStatus = "proposed" | "confirmed" | "rejected" | "corrected";

export type FieldType =
  | "time"
  | "duration"
  | "quantity"
  | "text"
  | "enum"
  | "boolean"
  // v20.15 — document extraction. A total is money, not a quantity, and a
  // receipt date is a calendar date, not a clock time.
  | "number"
  | "date";

export type FormFieldDef = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  unit?: string;
  options?: string[];
  /**
   * True for values where an approximation is materially different from a
   * measurement — times that drive HOS, quantities that drive billing. These
   * force a precision question rather than accepting a hedge.
   */
  precisionSensitive?: boolean;
};

export type FormDefinition = {
  key: string;
  version: number;
  title: string;
  fields: FormFieldDef[];
};

export type ProposedField = {
  key: string;
  label: string;
  value: string | number | boolean | null;
  precision: Precision;
  source: FieldSource;
  confidence: "low" | "medium" | "high";
  status: FieldStatus;
  /** The words this came from. Kept so a person can check the interpretation. */
  sourceUtterance?: string | null;
  correctedFrom?: string | number | boolean | null;
};

export type Gap = {
  key: string;
  label: string;
  kind: "missing_required" | "precision_unresolved" | "low_confidence";
  question: string;
};

export type CommitState =
  | "drafting"
  | "awaiting_answers"
  | "awaiting_readback"
  | "committed"
  | "rejected";

export type Proposal = {
  proposalId: string;
  formKey: string;
  formVersion: number;
  title: string;
  /** What this proposal would modify, e.g. "TRIP-2026-004821 unload stop". */
  targetRef: string;
  fields: ProposedField[];
  gaps: Gap[];
  questions: string[];
  readBack: string | null;
  readBackAcknowledged: boolean;
  commitState: CommitState;
};

/* ========================= form definitions ========================= */

export const FORMS: Record<string, FormDefinition> = {
  unload_stop: {
    key: "unload_stop",
    version: 1,
    title: "Unload stop",
    fields: [
      {
        key: "arrivedAt",
        label: "Arrived",
        type: "time",
        required: true,
        precisionSensitive: true,
      },
      {
        key: "waitMinutes",
        label: "Wait",
        type: "duration",
        required: false,
        unit: "min",
        // Wait time can feed customer billing and the target tripStops table has
        // no approximation channel. Voice hedges therefore require confirmation.
        precisionSensitive: true,
      },
      {
        key: "delayReason",
        label: "Delay reason",
        type: "enum",
        required: false,
        options: [
          "Queue",
          "Scale delay",
          "Site unavailable",
          "Customer delay",
          "Equipment unavailable",
          "Paperwork",
          "Weather",
          "Other",
        ],
      },
      {
        key: "operationStartedAt",
        label: "Unloading started",
        type: "time",
        required: true,
        precisionSensitive: true,
      },
      {
        key: "operationCompletedAt",
        label: "Unloading complete",
        type: "time",
        required: true,
        precisionSensitive: true,
      },
      {
        key: "quantity",
        label: "Quantity",
        type: "quantity",
        required: true,
        unit: "L",
        precisionSensitive: true,
      },
      {
        key: "measurementMethod",
        label: "Measured by",
        type: "enum",
        required: true,
        options: ["Meter", "Scale", "Gauge", "Estimate"],
      },
      {
        key: "departedAt",
        label: "Departed",
        type: "time",
        required: false,
        precisionSensitive: true,
      },
    ],
  },
  defect_report: {
    key: "defect_report",
    version: 1,
    title: "Defect report",
    fields: [
      { key: "unitNumber", label: "Unit", type: "text", required: true },
      {
        key: "system",
        label: "System",
        type: "enum",
        required: true,
        options: [
          "Brakes",
          "Steering",
          "Lights",
          "Tires",
          "Coupling",
          "Pump / PTO",
          "Tank",
          "Hoses",
          "Engine",
          "Other",
        ],
      },
      // Deliberately the driver's words, not a diagnosis.
      {
        key: "observation",
        label: "What you noticed",
        type: "text",
        required: true,
      },
      {
        key: "isNew",
        label: "New since last trip",
        type: "boolean",
        required: true,
      },
    ],
  },

  /**
   * A photographed receipt. Every field is proposed by OCR; the money fields
   * are precision-sensitive so a human confirms them, and there is no
   * treatment field at all — a receipt is not a deduction (B20.5).
   */
  expense_receipt: {
    key: "expense_receipt",
    version: 1,
    title: "Expense receipt",
    fields: [
      { key: "vendorName", label: "Vendor", type: "text", required: true },
      {
        key: "transactionDate",
        label: "Date",
        type: "date",
        required: true,
        precisionSensitive: true,
      },
      {
        key: "total",
        label: "Total",
        type: "number",
        required: true,
        precisionSensitive: true,
      },
      { key: "subtotal", required: false, label: "Subtotal", type: "number", precisionSensitive: true },
      { key: "salesTaxAmount", required: false, label: "Sales tax", type: "number", precisionSensitive: true },
      { key: "currency", required: false, label: "Currency", type: "text" },
      { key: "paymentMethod", required: false, label: "Paid with", type: "text" },
      { key: "cardLastFour", required: false, label: "Card last four", type: "text" },
      {
        key: "categoryKey",
        required: false,
        label: "Category",
        type: "enum",
        options: [
          "fuel", "def", "repairs_parts", "tools_shop_supplies", "safety_ppe",
          "lodging", "meals_travel", "permits_fees", "cellular", "office", "other",
        ],
      },
      { key: "jobRef", required: false, label: "Job", type: "text" },
      { key: "unitRef", required: false, label: "Unit", type: "text" },
      {
        key: "businessUsePercent",
        required: false,
        label: "Business use %",
        type: "number",
        precisionSensitive: true,
      },
    ],
  },

  /**
   * A photographed disposal or scale ticket. One form serves both: a scale
   * ticket is the weights, a facility ticket is the weights plus the
   * facility's own reference. Every field is proposed by OCR and every weight
   * is precision-sensitive, because net kilograms drive both the disposal gate
   * and the invoice. The record lands as `needs_review` and is invisible to
   * billing until a person verifies it.
   */
  disposal_ticket: {
    key: "disposal_ticket",
    version: 1,
    title: "Disposal / scale ticket",
    fields: [
      { key: "facilityName", required: true, label: "Facility", type: "text" },
      {
        key: "facilityTicketNumber",
        required: true,
        label: "Facility ticket number",
        type: "text",
        precisionSensitive: true,
      },
      { key: "loadRef", required: true, label: "Load", type: "text" },
      {
        key: "ticketDate",
        required: true,
        label: "Ticket date",
        type: "date",
        precisionSensitive: true,
      },
      { key: "scaleInTime", required: false, label: "Scale-in time", type: "time" },
      { key: "grossWeightKg", required: false, label: "Gross (kg)", type: "number", precisionSensitive: true },
      { key: "tareWeightKg", required: false, label: "Tare (kg)", type: "number", precisionSensitive: true },
      { key: "netWeightKg", required: false, label: "Net (kg)", type: "number", precisionSensitive: true },
      { key: "volumeM3", required: false, label: "Volume (m³)", type: "number", precisionSensitive: true },
      { key: "material", required: false, label: "Material", type: "text" },
    ],
  },

  /**
   * A fuel receipt. Its own form, not a generic expense: a fueling event
   * answers four separate questions and none of the answers come from the
   * slip. `unitNumber` and `cardLastFour` as printed are HINTS for the
   * reviewer — the unit and the card that bind the transaction are resolved
   * by the server from the assignment and the card token.
   */
  fuel_receipt: {
    key: "fuel_receipt",
    version: 1,
    title: "Fuel receipt",
    fields: [
      { key: "vendorName", required: true, label: "Vendor", type: "text" },
      { key: "transactionDate", required: true, label: "Date", type: "date", precisionSensitive: true },
      { key: "transactionTime", required: false, label: "Time", type: "time" },
      {
        key: "fuelType", required: true, label: "Fuel type", type: "enum",
        options: ["diesel", "gasoline", "def", "propane", "cng", "lng", "electric_charge", "other"],
      },
      { key: "quantity", required: true, label: "Quantity", type: "number", precisionSensitive: true },
      { key: "quantityUnit", required: false, label: "Unit of measure", type: "enum", options: ["L", "gal", "kg", "kWh"] },
      { key: "unitPrice", required: false, label: "Price per unit", type: "number", precisionSensitive: true },
      { key: "subtotal", required: false, label: "Subtotal", type: "number", precisionSensitive: true },
      { key: "salesTaxAmount", required: false, label: "Tax", type: "number", precisionSensitive: true },
      { key: "total", required: true, label: "Total", type: "number", precisionSensitive: true },
      { key: "cardLastFour", required: false, label: "Card last four (as printed)", type: "text" },
      { key: "unitNumber", required: false, label: "Unit (as printed)", type: "text" },
      { key: "odometerKm", required: false, label: "Odometer (km)", type: "number", precisionSensitive: true },
      { key: "authorizationCode", required: false, label: "Authorization code", type: "text" },
      // v21.3 — where the litres were bought, as printed. The receipt is the source; IFTA reads it.
      { key: "jurisdiction", required: false, label: "Province/state (as printed)", type: "enum", options: ["CA-AB", "CA-BC", "CA-SK", "CA-MB", "CA-ON", "CA-NT", "US-MT", "US-ND", "US-WA", "US-ID"] },
    ],
  },
};

/* ========================= building a proposal ========================= */

export type ExtractedValue = {
  key: string;
  value: string | number | boolean | null;
  precision?: Precision;
  source: FieldSource;
  confidence: "low" | "medium" | "high";
  sourceUtterance?: string | null;
};

function stableId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `PROP-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Assemble a proposal from schema-constrained extraction. Values arrive only
 * for declared fields — anything the model produced outside the form is
 * dropped rather than stored as a stray attribute.
 */
export function buildProposal(
  form: FormDefinition,
  targetRef: string,
  extracted: ExtractedValue[],
  proposalId?: string
): Proposal {
  const declared = new Set(form.fields.map(f => f.key));
  const kept = extracted.filter(e => declared.has(e.key));

  const fields: ProposedField[] = kept.map(e => {
    const def = form.fields.find(f => f.key === e.key)!;
    return {
      key: e.key,
      label: def.label,
      value: e.value,
      // Anything from voice is approximate until someone says otherwise.
      precision:
        e.precision ?? (e.source === "driver_voice" ? "approximate" : "exact"),
      source: e.source,
      confidence: e.confidence,
      status: "proposed",
      sourceUtterance: e.sourceUtterance ?? null,
    };
  });

  const gaps = detectGaps(form, fields);
  return {
    // Server request paths supply a unique capture id. The deterministic fallback
    // keeps the pure engine convenient for tests/non-persistent callers only.
    proposalId:
      proposalId ??
      stableId(
        `${form.key}:${targetRef}:${JSON.stringify(
          kept
            .map(k => ({ key: k.key, value: k.value, sourceUtterance: k.sourceUtterance ?? null }))
            .sort((a, b) => a.key.localeCompare(b.key))
        )}`
      ),
    formKey: form.key,
    formVersion: form.version,
    title: form.title,
    targetRef,
    fields,
    gaps,
    questions: minimumQuestions(gaps),
    readBack: null,
    readBackAcknowledged: false,
    commitState: gaps.length > 0 ? "awaiting_answers" : "drafting",
  };
}

/**
 * Only three things create a gap: a required field with no value, a
 * precision-sensitive value that is still approximate, and a low-confidence
 * extraction. Everything else is left alone — the point is to ask the fewest
 * questions that make the record safe.
 */
export function detectGaps(
  form: FormDefinition,
  fields: ProposedField[]
): Gap[] {
  const gaps: Gap[] = [];
  const byKey = new Map(fields.map(f => [f.key, f]));

  for (const def of form.fields) {
    const f = byKey.get(def.key);
    const empty =
      !f || f.value === null || f.value === "" || f.status === "rejected";

    if (def.required && empty) {
      gaps.push({
        key: def.key,
        label: def.label,
        kind: "missing_required",
        question: questionFor(def),
      });
      continue;
    }
    if (!f || empty) continue;

    if (
      def.precisionSensitive &&
      f.precision === "approximate" &&
      f.status === "proposed"
    ) {
      gaps.push({
        key: def.key,
        label: def.label,
        kind: "precision_unresolved",
        question: `You said ${f.sourceUtterance ? `“${f.sourceUtterance}”` : `about ${f.value}`} — was that exact, or approximate?`,
      });
      continue;
    }
    if (f.confidence === "low" && f.status === "proposed") {
      gaps.push({
        key: def.key,
        label: def.label,
        kind: "low_confidence",
        question: `I wasn't sure about ${def.label.toLowerCase()}. Is ${f.value} right?`,
      });
    }
  }
  return gaps;
}

function questionFor(def: FormFieldDef): string {
  if (def.type === "enum" && def.options) {
    return `What was the ${def.label.toLowerCase()}? (${def.options.slice(0, 4).join(", ")}…)`;
  }
  if (def.type === "quantity") return `How much? (${def.unit ?? "quantity"})`;
  if (def.type === "time") return `What time was ${def.label.toLowerCase()}?`;
  if (def.type === "boolean") return `${def.label}?`;
  return `What was the ${def.label.toLowerCase()}?`;
}

/** Deduplicated, ordered, and capped — a wall of questions defeats the point. */
export function minimumQuestions(gaps: Gap[], max = 3): string[] {
  const order = {
    missing_required: 0,
    precision_unresolved: 1,
    low_confidence: 2,
  };
  return gaps
    .slice()
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map(g => g.question)
    .filter((q, i, all) => all.indexOf(q) === i)
    .slice(0, max);
}

/* ========================= answering and correcting ========================= */

export function answerField(
  proposal: Proposal,
  form: FormDefinition,
  key: string,
  value: string | number | boolean | null,
  precision: Precision = "exact"
): Proposal {
  const def = form.fields.find(f => f.key === key);
  const existing = proposal.fields.find(f => f.key === key);

  const fields = existing
    ? proposal.fields.map(f =>
        f.key === key
          ? {
              ...f,
              value,
              precision,
              status: "corrected" as FieldStatus,
              source: "human_corrected" as FieldSource,
              confidence: "high" as const,
              correctedFrom: f.value,
            }
          : f
      )
    : [
        ...proposal.fields,
        {
          key,
          label: def?.label ?? key,
          value,
          precision,
          source: "driver_typed" as FieldSource,
          confidence: "high" as const,
          status: "confirmed" as FieldStatus,
          sourceUtterance: null,
        },
      ];

  return refresh({ ...proposal, fields }, form);
}

export function setFieldStatus(
  proposal: Proposal,
  form: FormDefinition,
  key: string,
  status: FieldStatus
): Proposal {
  const fields = proposal.fields.map(f =>
    f.key === key ? { ...f, status } : f
  );
  return refresh({ ...proposal, fields }, form);
}

/** Any change to the fields invalidates a read-back the person already heard. */
function refresh(proposal: Proposal, form: FormDefinition): Proposal {
  const gaps = detectGaps(form, proposal.fields);
  return {
    ...proposal,
    gaps,
    questions: minimumQuestions(gaps),
    readBack: null,
    readBackAcknowledged: false,
    commitState: gaps.length > 0 ? "awaiting_answers" : "drafting",
  };
}

/* ========================= read-back ========================= */

const fmt = (f: ProposedField): string => {
  const v =
    typeof f.value === "boolean" ? (f.value ? "yes" : "no") : String(f.value);
  return f.precision === "approximate" ? `about ${v}` : v;
};

/**
 * The sentence said back before anything commits. Approximations are spoken
 * as approximations — that is the whole point of saying it out loud.
 */
export function generateReadBack(proposal: Proposal): Proposal {
  const live = proposal.fields.filter(
    f => f.status !== "rejected" && f.value !== null
  );
  if (live.length === 0) {
    return { ...proposal, readBack: null, commitState: "drafting" };
  }
  const parts = live.map(f => `${f.label.toLowerCase()} ${fmt(f)}`);
  const readBack = `${proposal.title} on ${proposal.targetRef}: ${parts.join(", ")}. Is that right?`;
  return {
    ...proposal,
    readBack,
    readBackAcknowledged: false,
    commitState:
      proposal.gaps.length > 0 ? "awaiting_answers" : "awaiting_readback",
  };
}

export function acknowledgeReadBack(proposal: Proposal): Proposal {
  if (proposal.commitState !== "awaiting_readback") return proposal;
  return { ...proposal, readBackAcknowledged: true };
}

/* ========================= commit gate ========================= */

export type CommitCheck = { canCommit: boolean; refusals: string[] };

/**
 * Nothing reaches the operational record until every one of these holds.
 * Deliberately a separate function from the commit itself, so the UI can show
 * exactly what is still outstanding.
 */
export function checkCommit(
  proposal: Proposal,
  form: FormDefinition
): CommitCheck {
  const refusals: string[] = [];

  if (proposal.commitState === "rejected")
    refusals.push("Proposal was rejected");
  if (proposal.commitState === "committed")
    refusals.push("Proposal is already committed");

  const gaps = detectGaps(form, proposal.fields);
  for (const g of gaps) {
    refusals.push(
      g.kind === "missing_required"
        ? `${g.label} is required and has no value`
        : g.kind === "precision_unresolved"
          ? `${g.label} is still marked approximate — confirm whether it is exact`
          : `${g.label} was extracted with low confidence and needs confirming`
    );
  }

  if (!proposal.readBack) refusals.push("Read-back has not been generated");
  else if (!proposal.readBackAcknowledged)
    refusals.push("Read-back has not been confirmed");

  return { canCommit: refusals.length === 0, refusals };
}

export type CommittedField = ProposedField & { committedAt: Date };
export type CommitResult =
  | { ok: true; formKey: string; targetRef: string; fields: CommittedField[] }
  | { ok: false; refusals: string[] };

export function commitProposal(
  proposal: Proposal,
  form: FormDefinition,
  now: Date
): CommitResult {
  const check = checkCommit(proposal, form);
  if (!check.canCommit) return { ok: false, refusals: check.refusals };

  return {
    ok: true,
    formKey: proposal.formKey,
    targetRef: proposal.targetRef,
    // Rejected fields never reach the record; provenance travels with the rest.
    fields: proposal.fields
      .filter(f => f.status !== "rejected" && f.value !== null)
      .map(f => ({ ...f, committedAt: now })),
  };
}

export function rejectProposal(proposal: Proposal): Proposal {
  return { ...proposal, commitState: "rejected" };
}

/* ========================= assistant boundaries ========================= */

/**
 * Phrases that would have the assistant assert something it has no standing
 * to assert. A defect report records what a driver noticed; deciding what is
 * wrong with the truck is a mechanic's job, and the same holds for TDG
 * classification, HOS compliance and vehicle release.
 */
const OVERREACH = [
  /\bis (?:safe|unsafe|legal|illegal|compliant|non-compliant)\b/i,
  /\b(?:approved?|certif(?:y|ied)|cleared) (?:for|to) (?:dispatch|depart|haul)\b/i,
  /\byou (?:can|may) (?:legally )?(?:depart|dispatch|haul)\b/i,
  /\bdiagnos(?:is|ed|e)\b/i,
  /\bthe (?:problem|fault|cause) is\b/i,
];

export function detectOverreach(text: string): {
  overreaches: boolean;
  matched: string[];
} {
  const matched = OVERREACH.filter(r => r.test(text)).map(r => r.source);
  return { overreaches: matched.length > 0, matched };
}
