/**
 * Document extraction — a photographed receipt or ticket becoming proposed
 * fields.
 *
 * OCR output is a proposal. It has the same standing as a transcribed voice
 * note: provenance (`photo_ocr`), a confidence, a precision, and a `proposed`
 * status until a person confirms it. Nothing here writes a fact.
 *
 * Four gates decide what happens to each extracted field, and they are applied
 * in this order so the strictest wins:
 *
 *   sensitive      always a human, regardless of confidence. Amounts that
 *                  become money, dates that drive a filing, quantities that
 *                  drive billing, anything precision-sensitive.
 *   ask            confidence below the floor — a question goes on the queue.
 *   review         confident but not certain — proposed, shown for review.
 *   auto_file      very confident AND low-risk metadata only. A vendor name
 *                  can be auto-filed. A total cannot.
 *
 * Confidence thresholds are policy, declared once, and the auto-file band is
 * deliberately narrow: the failure mode of a generous auto-filer is a wrong
 * number nobody looked at.
 */

import { FORMS, type FieldSource, type FormDefinition, type ProposedField } from "./aiProposal";

export type DocumentType =
  | "expense_receipt"
  | "fuel_receipt"
  | "disposal_ticket"
  | "load_ticket"
  | "scale_ticket"
  | "invoice"
  | "safety_document"
  | "unknown";

/** What the OCR engine hands us. Deliberately engine-neutral. */
export type OcrField = {
  key: string;
  /** 0–100. */
  confidence: number;
  value: string | number | boolean | null;
  /** The text region this came from, so a person can check the read. */
  sourceText?: string | null;
};

export type OcrResult = {
  engine: string;
  engineVersion?: string | null;
  /** The engine's own document-type guess, if it makes one. */
  documentTypeHint?: DocumentType | null;
  documentTypeConfidence?: number | null;
  rawText: string;
  fields: OcrField[];
};

/* ------------------------------------------------------------------ */
/* Policy                                                               */
/* ------------------------------------------------------------------ */

export const CONFIDENCE_POLICY = {
  /** At or above: may auto-file, but only low-risk metadata. */
  autoFile: 98,
  /** At or above: proposed for review without a question. */
  review: 85,
  /** Below `review`: a question is asked. */
} as const;

/**
 * Fields that never auto-file however confident the OCR is. Money, dates that
 * drive filings, quantities that drive billing, identifiers that drive
 * compliance. A typo in a vendor name is an annoyance; a misread total is a
 * misfiled expense.
 */
const ALWAYS_HUMAN: ReadonlySet<string> = new Set([
  "total",
  "subtotal",
  "salesTaxAmount",
  "quantity",
  "netWeightKg",
  "grossWeightKg",
  "tareWeightKg",
  "volumeM3",
  "transactionDate",
  "ticketDate",
  "unNumber",
  "manifestNumber",
  "ticketNumber",
  "loadTicketNumber",
  "facilityTicketNumber",
  "businessUsePercent",
  // v20.18 — fuel: an odometer drives maintenance and fuel economy; an
  // authorization code is an identifier; a unit price is money.
  "odometerKm",
  "unitPrice",
  "authorizationCode",
]);

/** Low-risk metadata that a very confident read may file without a question. */
const AUTO_FILE_ELIGIBLE: ReadonlySet<string> = new Set([
  "vendorName",
  "vendorAddress",
  "vendorCity",
  "currency",
  "paymentMethod",
  "cardLastFour",
  "facilityName",
  "referenceNote",
]);

export type FieldDisposition =
  | "auto_file"
  | "review"
  | "ask"
  | "human_only";

export function disposeField(args: {
  fieldKey: string;
  confidence: number;
  precisionSensitive?: boolean;
  hasValue: boolean;
}): FieldDisposition {
  if (ALWAYS_HUMAN.has(args.fieldKey) || args.precisionSensitive) {
    return "human_only";
  }
  if (!args.hasValue || args.confidence < CONFIDENCE_POLICY.review) {
    return "ask";
  }
  if (
    args.confidence >= CONFIDENCE_POLICY.autoFile &&
    AUTO_FILE_ELIGIBLE.has(args.fieldKey)
  ) {
    return "auto_file";
  }
  return "review";
}

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

export type Classification = {
  documentType: DocumentType;
  confidence: number;
  source: "ocr_model" | "merchant_memory" | "keyword";
  /** True when the type needs a human to confirm before fields are trusted. */
  ambiguous: boolean;
  reasons: string[];
};

const KEYWORDS: Array<[DocumentType, RegExp[]]> = [
  ["scale_ticket", [/\bgross\b/i, /\btare\b/i, /\bnet\b.*\bkg\b/i, /\bscale\b/i]],
  ["disposal_ticket", [/\bdisposal\b/i, /\bmanifest\b/i, /\bfacility\b/i, /\bm3\b|\bm³\b/i]],
  ["load_ticket", [/\bload\b/i, /\blease\b/i, /\blsd\b/i, /\bwell\b/i]],
  ["fuel_receipt", [/\bdiesel\b/i, /\blitres?\b/i, /\bpump\b/i, /\bcardlock\b/i]],
  ["invoice", [/\binvoice\b/i, /\bdue\b/i, /\bremit\b/i, /\bnet\s?30\b/i]],
  ["expense_receipt", [/\breceipt\b/i, /\bsubtotal\b/i, /\bgst\b|\bhst\b/i, /\btotal\b/i]],
];

/**
 * Classify a document. Keyword scoring is a floor, not a verdict: an engine
 * hint or merchant memory can override it, and a close race between two types
 * is `ambiguous` — a scale ticket read as a receipt files kilograms as dollars.
 */
export function classifyDocument(args: {
  ocr: OcrResult;
  merchantMemory?: { vendorName: string; documentType: DocumentType; confidence: number } | null;
}): Classification {
  const reasons: string[] = [];

  if (args.merchantMemory && args.merchantMemory.confidence >= 90) {
    reasons.push(`Merchant memory: ${args.merchantMemory.vendorName} usually produces ${args.merchantMemory.documentType}`);
    return {
      documentType: args.merchantMemory.documentType,
      confidence: args.merchantMemory.confidence,
      source: "merchant_memory",
      ambiguous: false,
      reasons,
    };
  }

  const scores = new Map<DocumentType, number>();
  for (const [type, patterns] of KEYWORDS) {
    const hits = patterns.filter(p => p.test(args.ocr.rawText)).length;
    if (hits > 0) scores.set(type, hits / patterns.length);
  }

  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;

  if (args.ocr.documentTypeHint && (args.ocr.documentTypeConfidence ?? 0) >= CONFIDENCE_POLICY.review) {
    reasons.push(`Engine hint: ${args.ocr.documentTypeHint} at ${args.ocr.documentTypeConfidence}`);
    const agrees = best && best[0] === args.ocr.documentTypeHint;
    return {
      documentType: args.ocr.documentTypeHint,
      confidence: args.ocr.documentTypeConfidence ?? 0,
      source: "ocr_model",
      ambiguous: !agrees && !!best,
      reasons: agrees ? reasons : [...reasons, "Keyword scoring disagrees with the engine hint"],
    };
  }

  if (!best) {
    return {
      documentType: "unknown",
      confidence: 0,
      source: "keyword",
      ambiguous: true,
      reasons: ["No recognizable document markers"],
    };
  }

  const confidence = Math.round(best[1] * 100);
  const closeRace = !!second && best[1] - second[1] < 0.25;
  reasons.push(`Keywords favour ${best[0]}`);
  if (closeRace) reasons.push(`Close race with ${second![0]}`);

  return {
    documentType: best[0],
    confidence,
    source: "keyword",
    ambiguous: closeRace || confidence < CONFIDENCE_POLICY.review,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Extraction to proposal                                               */
/* ------------------------------------------------------------------ */

export type ExtractionQuestion = {
  fieldKey: string;
  question: string;
  reason:
    | "missing_required"
    | "low_confidence"
    | "precision_unresolved"
    | "sensitive_human_only"
    | "ambiguous_classification";
  options?: string[];
  priority: number;
};

export type ExtractionOutcome = {
  formKey: string;
  classification: Classification;
  fields: ProposedField[];
  questions: ExtractionQuestion[];
  counts: { autoFiled: number; review: number; asked: number; humanOnly: number };
  /** Set when the document type could not be mapped to a form at all. */
  refusal?: string;
};

const DOC_TO_FORM: Partial<Record<DocumentType, string>> = {
  expense_receipt: "expense_receipt",
  // v20.18 — fuel is not a generic expense.
  fuel_receipt: "fuel_receipt",
  // v20.16 — one form, both tickets. A scale ticket is the weights; a facility
  // ticket is the weights plus the facility's own reference.
  disposal_ticket: "disposal_ticket",
  scale_ticket: "disposal_ticket",
};

function toConfidence(n: number): ProposedField["confidence"] {
  if (n >= CONFIDENCE_POLICY.autoFile) return "high";
  if (n >= CONFIDENCE_POLICY.review) return "medium";
  return "low";
}

/**
 * Turn OCR output into a proposal for a form. Every field is `proposed`, every
 * field carries `photo_ocr` as its source, and the questions are exactly the
 * ones the gates say need asking — no more.
 */
export function extractToProposal(args: {
  ocr: OcrResult;
  classification: Classification;
  forms?: Record<string, FormDefinition>;
}): ExtractionOutcome {
  const forms = args.forms ?? FORMS;
  const formKey = DOC_TO_FORM[args.classification.documentType];
  const counts = { autoFiled: 0, review: 0, asked: 0, humanOnly: 0 };
  const questions: ExtractionQuestion[] = [];

  if (!formKey || !forms[formKey]) {
    return {
      formKey: "",
      classification: args.classification,
      fields: [],
      questions: [],
      counts,
      refusal: `No form accepts a ${args.classification.documentType} — file it as evidence, do not extract`,
    };
  }

  const form = forms[formKey];
  const byKey = new Map(args.ocr.fields.map(f => [f.key, f]));

  if (args.classification.ambiguous) {
    questions.push({
      fieldKey: "__documentType",
      question: "What kind of document is this?",
      reason: "ambiguous_classification",
      options: ["expense_receipt", "fuel_receipt", "disposal_ticket", "scale_ticket", "load_ticket", "invoice"],
      priority: 100,
    });
  }

  const fields: ProposedField[] = [];

  for (const def of form.fields) {
    const ocr = byKey.get(def.key);
    const hasValue = ocr != null && ocr.value !== null && ocr.value !== "";
    const disposition = disposeField({
      fieldKey: def.key,
      confidence: ocr?.confidence ?? 0,
      precisionSensitive: def.precisionSensitive,
      hasValue,
    });

    const source: FieldSource = "photo_ocr";

    if (disposition === "auto_file") counts.autoFiled++;
    else if (disposition === "review") counts.review++;
    else if (disposition === "ask") counts.asked++;
    else counts.humanOnly++;

    fields.push({
      key: def.key,
      label: def.label,
      value: hasValue ? ocr!.value : null,
      // OCR reads what is printed. A printed number is exact as read; whether
      // it is *correct* is what the confidence and the human are for.
      precision: hasValue ? "exact" : "approximate",
      source,
      confidence: toConfidence(ocr?.confidence ?? 0),
      // Never `confirmed` from here. Even an auto-filed field is proposed —
      // auto-file means "no question", not "no review".
      status: "proposed",
      sourceUtterance: ocr?.sourceText ?? null,
    });

    if (disposition === "ask") {
      questions.push({
        fieldKey: def.key,
        question: hasValue
          ? `Is "${def.label}" ${String(ocr!.value)}? The read was uncertain.`
          : `What is the ${def.label.toLowerCase()}?`,
        reason: hasValue ? "low_confidence" : "missing_required",
        options: def.type === "enum" ? def.options : undefined,
        priority: def.required ? 90 : 60,
      });
    } else if (disposition === "human_only") {
      questions.push({
        fieldKey: def.key,
        question: hasValue
          ? `Confirm ${def.label.toLowerCase()}: ${String(ocr!.value)}`
          : `Enter the ${def.label.toLowerCase()}`,
        reason: hasValue ? "sensitive_human_only" : "missing_required",
        priority: 95,
      });
    }
  }

  questions.sort((a, b) => b.priority - a.priority);

  return { formKey, classification: args.classification, fields, questions, counts };
}

/* ------------------------------------------------------------------ */
/* Merchant memory                                                      */
/* ------------------------------------------------------------------ */

export type MerchantMemoryEntry = {
  vendorNormalized: string;
  documentType: DocumentType;
  categoryKey?: string | null;
  seenCount: number;
  confirmedCount: number;
};

export function normalizeVendor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Merchant memory is a strong hint and still not a decision. It earns
 * confidence from *confirmed* filings, not from how often a vendor appears —
 * a vendor seen forty times and never confirmed is forty unconfirmed guesses.
 */
export function merchantMemoryConfidence(e: MerchantMemoryEntry): number {
  if (e.confirmedCount === 0) return 0;
  const ratio = e.confirmedCount / Math.max(e.seenCount, 1);
  const volume = Math.min(e.confirmedCount, 10) / 10;
  return Math.round(ratio * volume * 100);
}
