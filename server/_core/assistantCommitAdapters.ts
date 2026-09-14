/**
 * Typed boundary from a reviewed Assistant proposal to an operational write.
 *
 * The Assistant may extract and propose facts; it does not get a generic
 * "write anything" primitive. Every form key is explicitly adapted to one
 * domain action, with a separate permission and a lossless provenance rule.
 */

import type { CommittedField } from "./aiProposal";

export const ASSISTANT_COMMIT_ADAPTER_VERSION = "p3.commit.v1";

export type AssistantCommitContext = {
  proposalId: string;
  formKey: string;
  targetRef: string;
  targetRecordId?: number | null;
  tripId?: number | null;
  unitId?: number | null;
  /** v20.16 — resolved by the server for disposal tickets. Never from the client. */
  loadId?: number | null;
  facilityId?: number | null;
  /** v20.18 — the fleet card the proposal was opened against, from its token. */
  fleetCardId?: number | null;
  eventDateLocal?: string | null;
  utcOffsetMinutes?: number | null;
  actorUserId: number;
  capturedAt: Date;
};

export type UnloadStopPatch = {
  arrivedAt?: Date;
  operationStartedAt?: Date;
  operationCompletedAt?: Date;
  departedAt?: Date;
  waitMinutes?: number;
  quantity?: number;
  quantityUnit?: "L";
};

export type AssistantCommitIntent =
  | {
      kind: "trip_stop_update";
      action: "update";
      targetType: "trip_stop";
      targetRecordId: number;
      requiredPermission: "trip.write";
      values: UnloadStopPatch;
      delayReason?: string | null;
      /** Kept in the receipt; tripStops has no safe measurement-method field. */
      measurementMethod: string;
    }
  | {
      kind: "maintenance_defect_create";
      action: "create";
      targetType: "maintenance_defect";
      requiredPermission: "maintenance.write_defect";
      values: {
        unitId: number;
        title: string;
        severity: "advisory";
        status: "open";
        detail: string;
        reportedAt: Date;
        reportedBy: number;
      };
      isNew: boolean;
    }
  | {
      /**
       * v20.15 — a photographed receipt becomes an expense DRAFT.
       *
       * The draft's tax treatment is forced to `unknown_review_required` and
       * is not part of the values — a receipt is not a deduction, and OCR is
       * not an accountant. Nothing here touches billing, and the amounts arrive
       * only after a human confirmed the precision-sensitive fields.
       */
      kind: "expense_draft_create";
      action: "create";
      targetType: "expense_record";
      requiredPermission: "tax.expense.create";
      values: {
        financialEntityId: number;
        vendorName: string | null;
        transactionDate: Date;
        total: number;
        subtotal: number | null;
        salesTaxAmount: number | null;
        currency: string;
        businessUsePercent: number;
        categorySource: "ai_proposed";
        evidenceRecordId: number | null;
        status: "draft";
      };
      /** Recorded in the receipt: which fields the OCR read and a human confirmed. */
      ocrConfirmedFields: string[];
    }
  | {
      /**
       * v20.16 — a photographed disposal or scale ticket becomes a disposal
       * ticket row in `needs_review`. Never `verified`: the billing gate counts
       * verified tickets only, so an OCR'd ticket is invisible to an invoice
       * until a person verifies it. The load's chain state is not touched —
       * advancing to `disposal_verified` is the verifier's act, not the
       * scanner's.
       */
      kind: "disposal_ticket_create";
      action: "create";
      targetType: "disposal_ticket";
      requiredPermission: "load.write";
      values: {
        loadId: number;
        facilityId: number;
        facilityTicketNumber: string;
        scaleInAt: Date | null;
        grossKg: number | null;
        tareKg: number | null;
        netKg: number | null;
        quantity: number | null;
        quantityUnit: string | null;
        verificationStatus: "needs_review";
        source: "photo_ocr";
        confidence: "low" | "medium" | "high";
      };
      material: string | null;
    }
  | {
      /**
       * v20.18 — a fuel receipt becomes a fuel transaction in `needs_review`
       * plus an expense DRAFT it hangs off. The adapter carries the slip's
       * facts and its hints. It does not classify: who paid and what consumed
       * the fuel are resolved by the service from the card token and the
       * assignment, and classified there. "Unit 142" printed on the slip is a
       * hint for the reviewer, never a binding.
       */
      kind: "fuel_transaction_create";
      action: "create";
      targetType: "fuel_transaction";
      requiredPermission: "tax.expense.create";
      values: {
        financialEntityId: number;
        vendorName: string | null;
        // v21.3 — from the receipt, for IFTA.
        jurisdiction: string | null;
        jurisdictionSource: "receipt" | null;
        occurredAt: Date;
        fuelType: "diesel" | "gasoline" | "def" | "propane" | "cng" | "lng" | "electric_charge" | "other";
        quantity: number;
        quantityUnit: string;
        unitPrice: number | null;
        subtotal: number | null;
        taxAmount: number | null;
        total: number;
        odometerKm: number | null;
        unitNumberHint: string | null;
        cardLastFourHint: string | null;
        fleetCardId: number | null;
        unitId: number | null;
        tripId: number | null;
        status: "needs_review";
      };
    };

export type AssistantCommitPlan =
  | { ok: true; intent: AssistantCommitIntent }
  | { ok: false; refusals: string[] };

const byKey = (fields: readonly CommittedField[]) =>
  new Map(fields.map(field => [field.key, field] as const));

function requiredField(
  fields: Map<string, CommittedField>,
  key: string,
  refusals: string[]
): CommittedField | null {
  const field = fields.get(key);
  if (!field || field.value === null || field.status === "rejected") {
    refusals.push(`${key} is required by the commit adapter`);
    return null;
  }
  return field;
}

function exactField(
  fields: Map<string, CommittedField>,
  key: string,
  refusals: string[],
  required = true
): CommittedField | null {
  const field = fields.get(key);
  if (!field || field.value === null || field.status === "rejected") {
    if (required) refusals.push(`${key} is required by the commit adapter`);
    return null;
  }
  if (field.precision !== "exact") {
    refusals.push(
      `${key} is ${field.precision}; target storage has no precision channel, so the adapter refuses to flatten it`
    );
    return null;
  }
  return field;
}

function asString(field: CommittedField | null, key: string, refusals: string[]) {
  if (!field) return null;
  if (typeof field.value !== "string" || field.value.trim() === "") {
    refusals.push(`${key} must be a non-empty string`);
    return null;
  }
  return field.value.trim();
}

function asNumber(field: CommittedField | null, key: string, refusals: string[]) {
  if (!field) return null;
  if (typeof field.value !== "number" || !Number.isFinite(field.value)) {
    refusals.push(`${key} must be a finite number`);
    return null;
  }
  return field.value;
}

function asBoolean(field: CommittedField | null, key: string, refusals: string[]) {
  if (!field) return null;
  if (typeof field.value !== "boolean") {
    refusals.push(`${key} must be boolean`);
    return null;
  }
  return field.value;
}

function allowedEnum(
  value: string | null,
  key: string,
  allowed: readonly string[],
  refusals: string[]
): string | null {
  if (value === null) return null;
  if (!allowed.includes(value)) {
    refusals.push(`${key} must be one of: ${allowed.join(", ")}`);
    return null;
  }
  return value;
}

function parseClock(text: string, key: string, refusals: string[]): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) {
    refusals.push(`${key} must be HH:MM or HH:MM:SS`);
    return null;
  }
  const h = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] ?? "0");
  if (h > 23 || minute > 59 || second > 59) {
    refusals.push(`${key} contains an invalid clock time`);
    return null;
  }
  return h * 3600 + minute * 60 + second;
}

function parseLocalDate(text: string, refusals: string[]): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) {
    refusals.push("eventDateLocal must be YYYY-MM-DD");
    return null;
  }
  const y = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, month - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== d
  ) {
    refusals.push("eventDateLocal is not a valid calendar date");
    return null;
  }
  return [y, month, d];
}

/**
 * Convert ordered local HH:MM values to UTC. A clock moving backwards once is
 * treated as crossing midnight. More than one rollover is refused: the compact
 * form does not carry enough date information to prove a >24h sequence.
 */
function resolveOrderedTimes(args: {
  eventDateLocal: string;
  utcOffsetMinutes: number;
  entries: Array<{ key: string; text: string | null }>;
  refusals: string[];
}): Record<string, Date> {
  const out: Record<string, Date> = {};
  const date = parseLocalDate(args.eventDateLocal, args.refusals);
  if (!date) return out;
  if (!Number.isInteger(args.utcOffsetMinutes) || args.utcOffsetMinutes < -840 || args.utcOffsetMinutes > 840) {
    args.refusals.push("utcOffsetMinutes must be an integer between -840 and 840");
    return out;
  }

  let previousSeconds: number | null = null;
  let dayOffset = 0;
  let rollovers = 0;

  for (const entry of args.entries) {
    if (entry.text === null) continue;
    const seconds = parseClock(entry.text, entry.key, args.refusals);
    if (seconds === null) continue;
    if (previousSeconds !== null && seconds < previousSeconds) {
      dayOffset += 1;
      rollovers += 1;
    }
    if (rollovers > 1) {
      args.refusals.push(
        "time sequence crosses midnight more than once; record explicit dates instead of compact clock values"
      );
      return {};
    }
    previousSeconds = seconds;

    const [y, month, d] = date;
    const midnightUtc = Date.UTC(y, month - 1, d + dayOffset, 0, 0, 0);
    out[entry.key] = new Date(
      midnightUtc + seconds * 1000 - args.utcOffsetMinutes * 60_000
    );
  }
  return out;
}

function planUnloadStop(
  ctx: AssistantCommitContext,
  committed: readonly CommittedField[]
): AssistantCommitPlan {
  const refusals: string[] = [];
  if (!ctx.targetRecordId || ctx.targetRecordId <= 0) {
    refusals.push("unload_stop requires a positive targetRecordId for the trip stop");
  }
  if (!ctx.tripId || ctx.tripId <= 0) {
    refusals.push("unload_stop requires a positive tripId");
  }
  if (!ctx.eventDateLocal) {
    refusals.push("unload_stop requires eventDateLocal to anchor clock times");
  }
  if (ctx.utcOffsetMinutes === null || ctx.utcOffsetMinutes === undefined) {
    refusals.push("unload_stop requires utcOffsetMinutes; server timezone must not be guessed");
  }

  const fields = byKey(committed);
  const arrived = exactField(fields, "arrivedAt", refusals);
  const started = exactField(fields, "operationStartedAt", refusals);
  const completed = exactField(fields, "operationCompletedAt", refusals);
  const departed = exactField(fields, "departedAt", refusals, false);
  const wait = exactField(fields, "waitMinutes", refusals, false);
  const quantity = exactField(fields, "quantity", refusals);
  const measurement = requiredField(fields, "measurementMethod", refusals);
  const delay = fields.get("delayReason") ?? null;

  const arrivedText = asString(arrived, "arrivedAt", refusals);
  const startedText = asString(started, "operationStartedAt", refusals);
  const completedText = asString(completed, "operationCompletedAt", refusals);
  const departedText = departed ? asString(departed, "departedAt", refusals) : null;
  const quantityValue = asNumber(quantity, "quantity", refusals);
  const waitValue = wait ? asNumber(wait, "waitMinutes", refusals) : null;
  const measurementMethod = allowedEnum(
    asString(measurement, "measurementMethod", refusals),
    "measurementMethod",
    ["Meter", "Scale", "Gauge", "Estimate"],
    refusals
  );
  const delayReason = delay
    ? allowedEnum(
        asString(delay, "delayReason", refusals),
        "delayReason",
        [
          "Queue",
          "Scale delay",
          "Site unavailable",
          "Customer delay",
          "Equipment unavailable",
          "Paperwork",
          "Weather",
          "Other",
        ],
        refusals
      )
    : null;

  if (quantityValue !== null && quantityValue < 0) refusals.push("quantity cannot be negative");
  if (waitValue !== null && waitValue < 0) refusals.push("waitMinutes cannot be negative");

  let resolved: Record<string, Date> = {};
  if (
    ctx.eventDateLocal &&
    ctx.utcOffsetMinutes !== null &&
    ctx.utcOffsetMinutes !== undefined &&
    arrivedText &&
    startedText &&
    completedText
  ) {
    resolved = resolveOrderedTimes({
      eventDateLocal: ctx.eventDateLocal,
      utcOffsetMinutes: ctx.utcOffsetMinutes,
      entries: [
        { key: "arrivedAt", text: arrivedText },
        { key: "operationStartedAt", text: startedText },
        { key: "operationCompletedAt", text: completedText },
        { key: "departedAt", text: departedText },
      ],
      refusals,
    });
  }

  if (refusals.length > 0 || quantityValue === null || !measurementMethod) {
    return { ok: false, refusals };
  }

  const values: UnloadStopPatch = {
    arrivedAt: resolved.arrivedAt,
    operationStartedAt: resolved.operationStartedAt,
    operationCompletedAt: resolved.operationCompletedAt,
    quantity: quantityValue,
    quantityUnit: "L",
  };
  if (resolved.departedAt) values.departedAt = resolved.departedAt;
  if (waitValue !== null) values.waitMinutes = waitValue;

  return {
    ok: true,
    intent: {
      kind: "trip_stop_update",
      action: "update",
      targetType: "trip_stop",
      targetRecordId: ctx.targetRecordId!,
      requiredPermission: "trip.write",
      values,
      delayReason,
      measurementMethod,
    },
  };
}

function planDefectReport(
  ctx: AssistantCommitContext,
  committed: readonly CommittedField[]
): AssistantCommitPlan {
  const refusals: string[] = [];
  if (!ctx.unitId || ctx.unitId <= 0) {
    refusals.push("defect_report requires a positive unitId resolved by the server");
  }
  const fields = byKey(committed);
  const system = allowedEnum(
    asString(requiredField(fields, "system", refusals), "system", refusals),
    "system",
    [
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
    refusals
  );
  const observation = asString(
    requiredField(fields, "observation", refusals),
    "observation",
    refusals
  );
  const isNew = asBoolean(requiredField(fields, "isNew", refusals), "isNew", refusals);

  // unitNumber is required by the conversational form for human verification,
  // but the actual DB relation uses ctx.unitId, which is server-resolved.
  asString(requiredField(fields, "unitNumber", refusals), "unitNumber", refusals);

  if (refusals.length > 0 || !system || !observation || isNew === null) {
    return { ok: false, refusals };
  }

  return {
    ok: true,
    intent: {
      kind: "maintenance_defect_create",
      action: "create",
      targetType: "maintenance_defect",
      requiredPermission: "maintenance.write_defect",
      values: {
        unitId: ctx.unitId!,
        title: `Driver-reported ${system} observation`,
        // The assistant records an observation; it does not diagnose severity.
        severity: "advisory",
        status: "open",
        detail: observation,
        reportedAt: ctx.capturedAt,
        reportedBy: ctx.actorUserId,
      },
      isNew,
    },
  };
}

function planExpenseReceipt(
  ctx: AssistantCommitContext,
  committed: readonly CommittedField[]
): AssistantCommitPlan {
  const refusals: string[] = [];
  const fields = byKey(committed);

  // The financial entity is resolved by the server into targetRecordId. A
  // client cannot file a receipt into another company's books by naming it.
  if (!ctx.targetRecordId || ctx.targetRecordId <= 0) {
    refusals.push("expense_receipt requires a positive financialEntityId resolved by the server");
  }

  const total = asNumber(requiredField(fields, "total", refusals), "total", refusals);
  if (total !== null && total <= 0) refusals.push("total must be positive");

  const dateField = requiredField(fields, "transactionDate", refusals);
  const dateStr = asString(dateField, "transactionDate", refusals);
  let transactionDate: Date | null = null;
  if (dateStr) {
    // A calendar date, not a clock time: no offset arithmetic, no guessing.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      refusals.push("transactionDate must be an ISO calendar date (YYYY-MM-DD)");
    } else {
      transactionDate = new Date(`${dateStr}T00:00:00Z`);
      if (Number.isNaN(transactionDate.getTime())) refusals.push("transactionDate is not a valid date");
    }
  }

  const subtotal = fields.has("subtotal") ? asNumber(fields.get("subtotal")!, "subtotal", refusals) : null;
  const salesTax = fields.has("salesTaxAmount") ? asNumber(fields.get("salesTaxAmount")!, "salesTaxAmount", refusals) : null;
  const pctRaw = fields.has("businessUsePercent") ? asNumber(fields.get("businessUsePercent")!, "businessUsePercent", refusals) : 100;
  const pct = pctRaw === null ? 100 : pctRaw;
  if (pct < 0 || pct > 100) refusals.push("businessUsePercent must be between 0 and 100");

  if (subtotal !== null && salesTax !== null && total !== null) {
    const diff = Math.abs(subtotal + salesTax - total);
    // A subtotal and tax that do not add to the total is a misread, not a
    // rounding difference. Refuse rather than store three numbers that
    // disagree with each other.
    if (diff > 0.02) refusals.push(`subtotal + tax (${(subtotal + salesTax).toFixed(2)}) does not equal total (${total.toFixed(2)})`);
  }

  const vendor = fields.has("vendorName") ? asString(fields.get("vendorName")!, "vendorName", refusals) : null;
  const currency = fields.has("currency") ? (asString(fields.get("currency")!, "currency", refusals) ?? "CAD") : "CAD";

  // A field committed from OCR that a human then confirmed carries
  // `human_corrected` or `confirmed`; either way the person is on record.
  const ocrConfirmedFields = committed
    .filter(f => f.source === "photo_ocr" || f.source === "human_corrected")
    .map(f => f.key);

  if (refusals.length > 0 || total === null || transactionDate === null) {
    return { ok: false, refusals };
  }

  return {
    ok: true,
    intent: {
      kind: "expense_draft_create",
      action: "create",
      targetType: "expense_record",
      requiredPermission: "tax.expense.create",
      values: {
        financialEntityId: ctx.targetRecordId!,
        vendorName: vendor,
        transactionDate,
        total,
        subtotal,
        salesTaxAmount: salesTax,
        currency,
        businessUsePercent: pct,
        categorySource: "ai_proposed",
        evidenceRecordId: null,
        status: "draft",
      },
      ocrConfirmedFields,
    },
  };
}

function planDisposalTicket(
  ctx: AssistantCommitContext,
  committed: readonly CommittedField[]
): AssistantCommitPlan {
  const refusals: string[] = [];
  const fields = byKey(committed);

  if (!ctx.loadId || ctx.loadId <= 0) {
    refusals.push("disposal_ticket requires a positive loadId resolved by the server");
  }
  if (!ctx.facilityId || ctx.facilityId <= 0) {
    refusals.push("disposal_ticket requires a positive facilityId resolved by the server");
  }

  const ticketNo = asString(requiredField(fields, "facilityTicketNumber", refusals), "facilityTicketNumber", refusals);
  if (ticketNo && !/^[A-Za-z0-9\-\/ ]{2,80}$/.test(ticketNo)) {
    refusals.push("facilityTicketNumber contains characters no facility prints");
  }

  const dateStr = asString(requiredField(fields, "ticketDate", refusals), "ticketDate", refusals);
  let scaleInAt: Date | null = null;
  if (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      refusals.push("ticketDate must be an ISO calendar date (YYYY-MM-DD)");
    } else {
      const time = fields.has("scaleInTime") ? asString(fields.get("scaleInTime")!, "scaleInTime", refusals) : null;
      if (time && /^\d{2}:\d{2}$/.test(time) && ctx.utcOffsetMinutes != null) {
        // Same rule as the unload stop: a clock time only becomes an instant
        // with a date and an offset. Both are known here.
        const [hh, mm] = time.split(":").map(Number);
        const utc = Date.UTC(
          Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
          hh, mm
        ) - ctx.utcOffsetMinutes * 60_000;
        scaleInAt = new Date(utc);
      } else if (time) {
        refusals.push("scaleInTime needs HH:MM and a UTC offset to become a timestamp");
      }
    }
  }

  const num = (k: string) => (fields.has(k) ? asNumber(fields.get(k)!, k, refusals) : null);
  const gross = num("grossWeightKg");
  const tare = num("tareWeightKg");
  const net = num("netWeightKg");
  const volume = num("volumeM3");

  for (const [k, v] of [["grossWeightKg", gross], ["tareWeightKg", tare], ["netWeightKg", net], ["volumeM3", volume]] as const) {
    if (v !== null && v < 0) refusals.push(`${k} cannot be negative`);
  }
  if (gross !== null && tare !== null && gross < tare) {
    refusals.push("gross weight is less than tare — the scale ticket was misread");
  }
  if (gross !== null && tare !== null && net !== null) {
    // Same discipline as the receipt: three numbers that disagree are a
    // misread, not a tolerance. Scales print to the nearest 10 or 20 kg.
    if (Math.abs(gross - tare - net) > 20) {
      refusals.push(`gross − tare (${gross - tare}) does not equal net (${net})`);
    }
  }
  if (net === null && volume === null && !(gross !== null && tare !== null)) {
    refusals.push("a disposal ticket needs a net weight, a volume, or gross and tare");
  }

  const derivedNet = net ?? (gross !== null && tare !== null ? gross - tare : null);
  const quantity = derivedNet ?? volume;
  const quantityUnit = derivedNet !== null ? "kg" : volume !== null ? "m3" : null;
  const material = fields.has("material") ? asString(fields.get("material")!, "material", refusals) : null;

  // The record's confidence is its weakest weight. A confident facility name
  // does not make an uncertain net kilogram figure any more certain.
  const weightConfidences = committed
    .filter(f => ["grossWeightKg", "tareWeightKg", "netWeightKg", "volumeM3"].includes(f.key))
    .map(f => f.confidence);
  const confidence: "low" | "medium" | "high" =
    weightConfidences.includes("low") ? "low" : weightConfidences.includes("medium") ? "medium" : "high";

  if (refusals.length > 0 || !ticketNo) return { ok: false, refusals };

  return {
    ok: true,
    intent: {
      kind: "disposal_ticket_create",
      action: "create",
      targetType: "disposal_ticket",
      requiredPermission: "load.write",
      values: {
        loadId: ctx.loadId!,
        facilityId: ctx.facilityId!,
        facilityTicketNumber: ticketNo.trim(),
        scaleInAt,
        grossKg: gross,
        tareKg: tare,
        netKg: derivedNet,
        quantity,
        quantityUnit,
        verificationStatus: "needs_review",
        source: "photo_ocr",
        confidence,
      },
      material,
    },
  };
}

const FUEL_TYPES = new Set(["diesel", "gasoline", "def", "propane", "cng", "lng", "electric_charge", "other"]);

function planFuelReceipt(
  ctx: AssistantCommitContext,
  committed: readonly CommittedField[]
): AssistantCommitPlan {
  const refusals: string[] = [];
  const fields = byKey(committed);

  if (!ctx.targetRecordId || ctx.targetRecordId <= 0) {
    refusals.push("fuel_receipt requires a positive financialEntityId resolved by the server");
  }

  const total = asNumber(requiredField(fields, "total", refusals), "total", refusals);
  if (total !== null && total <= 0) refusals.push("total must be positive");
  const quantity = asNumber(requiredField(fields, "quantity", refusals), "quantity", refusals);
  if (quantity !== null && quantity <= 0) refusals.push("quantity must be positive");

  const fuelTypeRaw = asString(requiredField(fields, "fuelType", refusals), "fuelType", refusals);
  if (fuelTypeRaw && !FUEL_TYPES.has(fuelTypeRaw)) refusals.push(`fuelType ${fuelTypeRaw} is not a known fuel`);

  const dateStr = asString(requiredField(fields, "transactionDate", refusals), "transactionDate", refusals);
  let occurredAt: Date | null = null;
  if (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      refusals.push("transactionDate must be an ISO calendar date (YYYY-MM-DD)");
    } else {
      const time = fields.has("transactionTime") ? asString(fields.get("transactionTime")!, "transactionTime", refusals) : null;
      if (time && /^\d{2}:\d{2}$/.test(time) && ctx.utcOffsetMinutes != null) {
        const [hh, mm] = time.split(":").map(Number);
        occurredAt = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), hh, mm) - ctx.utcOffsetMinutes * 60_000);
      } else if (time) {
        refusals.push("transactionTime needs HH:MM and a UTC offset to become a timestamp");
      } else {
        occurredAt = new Date(`${dateStr}T00:00:00Z`);
      }
    }
  }

  const num = (k: string) => (fields.has(k) ? asNumber(fields.get(k)!, k, refusals) : null);
  const unitPrice = num("unitPrice"), subtotal = num("subtotal"), tax = num("salesTaxAmount"), odometer = num("odometerKm");
  if (odometer !== null && odometer < 0) refusals.push("odometerKm cannot be negative");

  // Three numbers that disagree are a misread. Four, in fuel's case.
  if (subtotal !== null && tax !== null && total !== null && Math.abs(subtotal + tax - total) > 0.02) {
    refusals.push(`subtotal + tax (${(subtotal + tax).toFixed(2)}) does not equal total (${total.toFixed(2)})`);
  }
  if (unitPrice !== null && quantity !== null && subtotal !== null && Math.abs(unitPrice * quantity - subtotal) > 0.05) {
    refusals.push(`quantity × price (${(unitPrice * quantity).toFixed(2)}) does not equal subtotal (${subtotal.toFixed(2)})`);
  }

  const quantityUnit = fields.has("quantityUnit") ? (asString(fields.get("quantityUnit")!, "quantityUnit", refusals) ?? "L") : "L";
  const jurisdiction = fields.has("jurisdiction") ? asString(fields.get("jurisdiction")!, "jurisdiction", refusals) : null;
  const vendor = fields.has("vendorName") ? asString(fields.get("vendorName")!, "vendorName", refusals) : null;
  const unitHint = fields.has("unitNumber") ? asString(fields.get("unitNumber")!, "unitNumber", refusals) : null;
  const last4 = fields.has("cardLastFour") ? asString(fields.get("cardLastFour")!, "cardLastFour", refusals) : null;
  if (last4 && !/^\d{4}$/.test(last4)) refusals.push("cardLastFour must be exactly four digits — nothing more is ever stored");

  if (refusals.length > 0 || total === null || quantity === null || !fuelTypeRaw || !occurredAt) {
    return { ok: false, refusals };
  }
  return {
    ok: true,
    intent: {
      kind: "fuel_transaction_create",
      action: "create",
      targetType: "fuel_transaction",
      requiredPermission: "tax.expense.create",
      values: {
        financialEntityId: ctx.targetRecordId!,
        vendorName: vendor,
        jurisdiction: jurisdiction,
        jurisdictionSource: jurisdiction ? "receipt" : null,
        occurredAt,
        fuelType: fuelTypeRaw as never,
        quantity,
        quantityUnit,
        unitPrice,
        subtotal,
        taxAmount: tax,
        total,
        odometerKm: odometer,
        unitNumberHint: unitHint,
        cardLastFourHint: last4,
        // Bindings, from context the server resolved — not from the hints.
        fleetCardId: ctx.fleetCardId ?? null,
        unitId: ctx.unitId ?? null,
        tripId: ctx.tripId ?? null,
        status: "needs_review",
      },
    },
  };
}

export function planAssistantCommit(
  ctx: AssistantCommitContext,
  committed: readonly CommittedField[]
): AssistantCommitPlan {
  switch (ctx.formKey) {
    case "unload_stop":
      return planUnloadStop(ctx, committed);
    case "defect_report":
      return planDefectReport(ctx, committed);
    case "expense_receipt":
      return planExpenseReceipt(ctx, committed);
    case "disposal_ticket":
      return planDisposalTicket(ctx, committed);
    case "fuel_receipt":
      return planFuelReceipt(ctx, committed);
    default:
      return {
        ok: false,
        refusals: [
          `No typed commit adapter is registered for form ${ctx.formKey}; generic writes are forbidden`,
        ],
      };
  }
}
