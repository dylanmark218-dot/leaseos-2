/**
 * The digital safety binder, scored per unit.
 *
 * The rule this file exists to enforce: unverified is not present. A licence
 * photographed but never checked, a permit whose expiry nobody entered, and a
 * document that simply is not there all count the same against the score —
 * because a roadside inspector counts them the same.
 *
 * The score is always shown as a fraction with its denominator visible. "78%"
 * hides whether the missing 22% is a spare-key receipt or the insurance slip;
 * "7 of 9 required documents verified" does not.
 *
 * Applicability follows the same discipline as the passport package: a
 * requirement whose applicability nobody has decided is counted as REQUIRED and
 * surfaced as an open question, never quietly excluded from the denominator.
 *
 * Expiry is read against a supplied clock and never inferred from a renewal
 * interval. A document type that renews every 12 months does not thereby have an
 * expiry date — if nobody recorded one, the binder says nobody recorded one.
 */

export type DocumentCondition =
  | "always"
  | "if_dangerous_goods"
  | "if_interprovincial"
  | "if_air_brake"
  | "if_trailer_attached";

export type RequirementType = {
  code: string;
  label: string;
  condition: DocumentCondition;
  /** Days before expiry at which the item becomes an office task. Null means no lead time. */
  warnWithinDays: number | null;
};

export type HeldDocument = {
  code: string;
  /** Null means nobody recorded one. That is not "does not expire". */
  expiresAt: Date | null;
  verification: "unverified" | "verified" | "rejected";
  evidenceRecordId: number | null;
};

/**
 * What is true about this unit today. `unknown` on any axis propagates into the
 * requirement that depends on it.
 */
export type UnitContext = {
  unitId: number;
  unitNumber: string;
  carriesDangerousGoods: boolean | "unknown";
  operatesInterprovincially: boolean | "unknown";
  hasAirBrakes: boolean | "unknown";
  trailerAttached: boolean | "unknown";
};

export type ItemStatus =
  | "verified_current"
  | "verified_expiring"
  | "expired"
  | "expiry_unrecorded"
  | "unverified"
  | "rejected"
  | "missing"
  | "applicability_unknown"
  | "not_applicable";

export type BinderItem = {
  code: string;
  label: string;
  status: ItemStatus;
  /** Counts toward the denominator. Unknown applicability counts; not-applicable does not. */
  counted: boolean;
  /** Counts toward the numerator. Only verified and in date. */
  satisfied: boolean;
  expiresAt: Date | null;
  daysUntilExpiry: number | null;
  detail: string;
};

export type OfficeTask = {
  unitId: number;
  unitNumber: string;
  code: string;
  /** Ordering for a work queue: expired and rejected first, questions last. */
  priority: "urgent" | "soon" | "open_question";
  action: string;
  dueAt: Date | null;
};

export type BinderScore = {
  unitId: number;
  unitNumber: string;
  /** Verified and in date. */
  satisfied: number;
  /** Everything required or unresolved. The denominator, always shown. */
  required: number;
  /** "7 of 9 required documents verified" — never a bare percentage. */
  summary: string;
  /** Null when nothing is required, which is different from a perfect score. */
  percent: number | null;
  items: BinderItem[];
  tasks: OfficeTask[];
  /** True when any applicability question is unanswered. */
  hasOpenQuestions: boolean;
};

const DAY_MS = 86_400_000;

function appliesTo(condition: DocumentCondition, ctx: UnitContext): boolean | "unknown" {
  switch (condition) {
    case "always": return true;
    case "if_dangerous_goods": return ctx.carriesDangerousGoods;
    case "if_interprovincial": return ctx.operatesInterprovincially;
    case "if_air_brake": return ctx.hasAirBrakes;
    case "if_trailer_attached": return ctx.trailerAttached;
  }
}

const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

function classify(
  type: RequirementType,
  held: HeldDocument | undefined,
  applicability: boolean | "unknown",
  now: Date,
): BinderItem {
  const base = { code: type.code, label: type.label, expiresAt: held?.expiresAt ?? null };

  if (applicability === "unknown") {
    return {
      ...base,
      status: "applicability_unknown",
      counted: true,
      satisfied: false,
      daysUntilExpiry: null,
      detail: `nobody has recorded whether ${type.label} applies to this unit`,
    };
  }

  if (applicability === false) {
    return { ...base, status: "not_applicable", counted: false, satisfied: false, daysUntilExpiry: null, detail: `not required for this unit` };
  }

  if (!held) {
    return { ...base, status: "missing", counted: true, satisfied: false, daysUntilExpiry: null, detail: `no ${type.label} on file` };
  }

  if (held.verification === "rejected") {
    return { ...base, status: "rejected", counted: true, satisfied: false, daysUntilExpiry: null, detail: `${type.label} was rejected on review` };
  }

  if (held.verification === "unverified") {
    return {
      ...base,
      status: "unverified",
      counted: true,
      satisfied: false,
      daysUntilExpiry: held.expiresAt ? daysBetween(now, held.expiresAt) : null,
      detail: `${type.label} is on file but nobody has verified it`,
    };
  }

  // Verified from here down.
  if (held.expiresAt === null) {
    return {
      ...base,
      status: "expiry_unrecorded",
      counted: true,
      satisfied: false,
      daysUntilExpiry: null,
      detail: `${type.label} is verified but carries no expiry date`,
    };
  }

  const days = daysBetween(now, held.expiresAt);
  if (days < 0) {
    return { ...base, status: "expired", counted: true, satisfied: false, daysUntilExpiry: days, detail: `${type.label} expired ${Math.abs(days)} day(s) ago` };
  }

  const expiring = type.warnWithinDays !== null && days <= type.warnWithinDays;
  return {
    ...base,
    status: expiring ? "verified_expiring" : "verified_current",
    counted: true,
    satisfied: true,
    daysUntilExpiry: days,
    detail: expiring ? `${type.label} expires in ${days} day(s)` : `${type.label} verified, ${days} day(s) remaining`,
  };
}

function taskFor(item: BinderItem, ctx: UnitContext): OfficeTask | null {
  const common = { unitId: ctx.unitId, unitNumber: ctx.unitNumber, code: item.code, dueAt: item.expiresAt };

  switch (item.status) {
    case "verified_current":
    case "not_applicable":
      return null;
    case "expired":
      return { ...common, priority: "urgent", action: `Replace ${item.label} — expired` };
    case "rejected":
      return { ...common, priority: "urgent", action: `Obtain a replacement ${item.label} — the one on file was rejected` };
    case "missing":
      return { ...common, priority: "urgent", action: `Obtain ${item.label} for unit ${ctx.unitNumber}` };
    case "unverified":
      return { ...common, priority: "soon", action: `Verify the ${item.label} already on file` };
    case "expiry_unrecorded":
      return { ...common, priority: "soon", action: `Record the expiry date on the verified ${item.label}` };
    case "verified_expiring":
      return { ...common, priority: "soon", action: `Renew ${item.label} — expires in ${item.daysUntilExpiry} day(s)` };
    case "applicability_unknown":
      return { ...common, priority: "open_question", action: `Decide whether ${item.label} applies to unit ${ctx.unitNumber}`, dueAt: null };
  }
}

const PRIORITY_ORDER: Record<OfficeTask["priority"], number> = { urgent: 0, soon: 1, open_question: 2 };

export function scoreSafetyBinder(args: {
  context: UnitContext;
  requirements: RequirementType[];
  held: HeldDocument[];
  now: Date;
}): BinderScore {
  const byCode = new Map(args.held.map(h => [h.code, h]));

  const items = args.requirements.map(type =>
    classify(type, byCode.get(type.code), appliesTo(type.condition, args.context), args.now),
  );

  const required = items.filter(i => i.counted).length;
  const satisfied = items.filter(i => i.satisfied).length;

  const tasks = items
    .map(i => taskFor(i, args.context))
    .filter((t): t is OfficeTask => t !== null)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.code.localeCompare(b.code));

  return {
    unitId: args.context.unitId,
    unitNumber: args.context.unitNumber,
    satisfied,
    required,
    summary:
      required === 0
        ? `No documents are required for unit ${args.context.unitNumber} under the current requirement set`
        : `${satisfied} of ${required} required documents verified and in date`,
    percent: required === 0 ? null : Math.round((satisfied / required) * 100),
    items,
    tasks,
    hasOpenQuestions: items.some(i => i.status === "applicability_unknown"),
  };
}

/** The office queue across a fleet, worked in priority order. */
export function fleetTaskQueue(scores: BinderScore[]): OfficeTask[] {
  return scores
    .flatMap(s => s.tasks)
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.unitNumber.localeCompare(b.unitNumber),
    );
}
