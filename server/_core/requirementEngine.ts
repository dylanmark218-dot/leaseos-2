/**
 * Generalized Requirement Engine.
 *
 *   WHO + WHAT EQUIPMENT + WHAT ATTACHMENTS + WHAT WORK + WHERE + WHEN
 *   + WHAT CARGO + WHAT CUSTOMER + WHAT JURISDICTION  =  WHAT IS REQUIRED
 *
 * v20.21 evaluated a requirement against one subject. This evaluates a
 * requirement against a WORK CONTEXT — the whole combination — and adds three
 * things the equipment side needs:
 *
 *   Packs.  A requirement in a pack applies only to companies where the pack
 *           is active. A hydrovac company and a crane company run the same
 *           core and receive different rules. Core requirements have no pack.
 *
 *   Equipment authorization.  Worker × exact equipment type × attachment. The
 *           four elements the OHS rule names — trained, competent, familiar
 *           with the instructions, authorized by the employer — are four
 *           evidence fields. Missing any one is not authorized.
 *
 *   Calibration.  A device's calibration state, and — the part that matters —
 *           what that state means depending on what the measurement is FOR.
 *           An expired scale calibration puts billing on hold and makes weight
 *           compliance uncertifiable; it does not by itself stop the truck.
 *           And when a device is found wrong, which records depended on it.
 */

import {
  buildPassport, candidateVerdict, requirementApplies,
  type Credential, type Passport, type PassportVerdict, type Requirement, type Subject,
} from "./compliancePassport";

/* ------------------------------------------------------------------ */
/* Packs                                                                */
/* ------------------------------------------------------------------ */

export type Pack = {
  packKey: string;
  title: string;
  jurisdiction: string;
  core: boolean;
  /** Predicate on the company profile; same grammar as requirement applicability. */
  activatesWhen?: Record<string, unknown> | null;
};

export type CompanyProfile = {
  jurisdiction: string;
  attributes: Record<string, unknown>;
};

/** Which packs a company profile activates automatically. Explicit activations are added by the caller. */
export function packsActivatedBy(profile: CompanyProfile, packs: readonly Pack[]): string[] {
  return packs
    .filter(p => p.core || ((p.jurisdiction === "*" || p.jurisdiction === profile.jurisdiction) && predicateHolds(p.activatesWhen ?? {}, profile.attributes)))
    .map(p => p.packKey);
}

/** Only requirements whose pack is active (or which have no pack) are in force for a company. */
export function requirementsInForce(requirements: readonly Requirement[], activePacks: ReadonlySet<string>): Requirement[] {
  return requirements.filter(r => !r.packKey || activePacks.has(r.packKey));
}

function predicateHolds(pred: Record<string, unknown>, attrs: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(pred)) {
    if (k.endsWith("Any")) {
      const attr = attrs[k.replace(/Any$/, "")];
      const list = Array.isArray(attr) ? attr : attr == null ? [] : [attr];
      if (!Array.isArray(v) || !v.some(x => list.includes(x))) return false;
    } else if (k.endsWith("AtLeast")) {
      const attr = attrs[k.replace(/AtLeast$/, "")];
      if (typeof attr !== "number" || attr < (v as number)) return false;
    } else if (JSON.stringify(attrs[k] ?? null) !== JSON.stringify(v ?? null)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Work context                                                         */
/* ------------------------------------------------------------------ */

export type WorkContext = {
  jurisdiction: string;
  at: Date;
  worker: { id: number; attributes: Record<string, unknown>; credentials: readonly Credential[] } | null;
  equipment: { id: number; equipmentType: string; attributes: Record<string, unknown>; credentials: readonly Credential[] } | null;
  attachments: readonly { id: number; attachmentType: string; attributes?: Record<string, unknown>; credentials?: readonly Credential[] }[];
  work: { workType: string; attributes?: Record<string, unknown> };
  site: { id: number | null; attributes?: Record<string, unknown> } | null;
  cargo: { classification: string | null; dangerousGoods: boolean } | null;
  customer: { ref: string | null; requiredDocTypes?: readonly string[] } | null;
};

/** The flattened attribute bag a work_context requirement's predicate sees. */
export function flattenContext(ctx: WorkContext): Record<string, unknown> {
  return {
    ...prefix("worker", ctx.worker?.attributes),
    ...prefix("equipment", ctx.equipment?.attributes),
    equipmentType: ctx.equipment?.equipmentType ?? null,
    attachmentTypes: ctx.attachments.map(a => a.attachmentType),
    workType: ctx.work.workType,
    ...prefix("work", ctx.work.attributes),
    ...prefix("site", ctx.site?.attributes),
    cargoClassification: ctx.cargo?.classification ?? null,
    dangerousGoods: ctx.cargo?.dangerousGoods ?? false,
    customerRef: ctx.customer?.ref ?? null,
  };
}
function prefix(p: string, attrs?: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) out[`${p}.${k}`] = v;
  return out;
}

export type WorkAuthorization = {
  verdict: "authorized" | "review" | "blocked" | "unknown";
  parts: Record<string, PassportVerdict | "absent">;
  contextItems: Passport["items"];
  reasons: string[];
};

const RANK: Record<PassportVerdict, number> = { ready: 0, review: 1, unknown: 2, blocked: 3 };

/**
 * Evaluate the whole combination. Each participant gets its own passport
 * against its own subject-type requirements; then work_context requirements
 * are evaluated against the flattened combination with the union of all
 * credentials on hand. Worst wins; unknown does not round up.
 */
export function evaluateWorkContext(args: {
  ctx: WorkContext;
  requirements: readonly Requirement[];
  activePacks: ReadonlySet<string>;
}): WorkAuthorization {
  const inForce = requirementsInForce(args.requirements, args.activePacks);
  const parts: Record<string, PassportVerdict | "absent"> = {};
  const reasons: string[] = [];
  let worst: PassportVerdict = "ready";
  const bump = (v: PassportVerdict) => { if (RANK[v] > RANK[worst]) worst = v; };

  const part = (name: string, subject: Subject | null, credentials: readonly Credential[]) => {
    if (!subject) { parts[name] = "absent"; return; }
    const p = buildPassport({ subject, requirements: inForce, credentials, now: args.ctx.at });
    parts[name] = p.verdict; bump(p.verdict);
    for (const r of p.reasons) reasons.push(`${name}: ${r}`);
  };
  part("worker", args.ctx.worker ? { subjectType: "operator", jurisdiction: args.ctx.jurisdiction, attributes: args.ctx.worker.attributes } : null, args.ctx.worker?.credentials ?? []);
  part("equipment", args.ctx.equipment ? { subjectType: "equipment", jurisdiction: args.ctx.jurisdiction, attributes: { ...args.ctx.equipment.attributes, equipmentType: args.ctx.equipment.equipmentType } } : null, args.ctx.equipment?.credentials ?? []);
  args.ctx.attachments.forEach((a, i) =>
    part(`attachment${i + 1}`, { subjectType: "attachment", jurisdiction: args.ctx.jurisdiction, attributes: { ...(a.attributes ?? {}), attachmentType: a.attachmentType } }, a.credentials ?? [])
  );

  // The combination itself.
  const allCredentials = [
    ...(args.ctx.worker?.credentials ?? []), ...(args.ctx.equipment?.credentials ?? []),
    ...args.ctx.attachments.flatMap(a => a.credentials ?? []),
  ];
  const combo = buildPassport({
    subject: { subjectType: "work_context", jurisdiction: args.ctx.jurisdiction, attributes: flattenContext(args.ctx) },
    requirements: inForce, credentials: allCredentials, now: args.ctx.at,
  });
  parts.context = combo.verdict; bump(combo.verdict);
  for (const r of combo.reasons) reasons.push(`context: ${r}`);

  // Customer-required documents are a requirement the customer wrote, not the law.
  if (args.ctx.customer?.requiredDocTypes?.length) {
    // SPINE item 2: "on record" means in force by the canonical verdict. This used to count any
    // verified row of the type, expired or not.
    const inForce = (t: string) => {
      const v = candidateVerdict(allCredentials.filter(c => c.docType === t), args.ctx.at, 30).verdict;
      return v.state === "in_force" || v.state === "expiring";
    };
    const missing = args.ctx.customer.requiredDocTypes.filter(t => !inForce(t));
    if (missing.length) { bump("review"); reasons.push(`customer: requires ${missing.join(", ")} — not in force on record`); }
  }

  const verdict = worst === "ready" ? "authorized" : worst;
  return { verdict, parts, contextItems: combo.items, reasons };
}

/* ------------------------------------------------------------------ */
/* Equipment authorization — four elements                              */
/* ------------------------------------------------------------------ */

export type EquipmentAuthorizationRecord = {
  equipmentType: string;
  attachmentType?: string | null;
  trainingEvidenceId?: number | null;
  competencyEvidenceId?: number | null;
  competencyAssessedAt?: Date | null;
  instructionsAcknowledgedAt?: Date | null;
  authorizedByUserId?: number | null;
  authorizedAt?: Date | null;
  expiresAt?: Date | null;
  status: "pending" | "authorized" | "suspended" | "revoked" | "expired";
};

export type EquipmentAuthorizationVerdict = {
  verdict: "authorized" | "review" | "blocked";
  elements: { trained: boolean; competent: boolean; familiarWithInstructions: boolean; employerAuthorized: boolean };
  reason: string;
};

/**
 * "Joe is an equipment operator" is not a fact LeaseOS holds. "Joe is trained,
 * assessed competent, has acknowledged the instructions, and is authorized by
 * the employer on excavators over 35 t with a hydraulic breaker, until March"
 * is. Each element is evidence; the authorization is the conjunction.
 */
export function equipmentAuthorization(args: {
  records: readonly EquipmentAuthorizationRecord[];
  equipmentType: string;
  attachmentTypes: readonly string[];
  now: Date;
}): EquipmentAuthorizationVerdict {
  const none = { trained: false, competent: false, familiarWithInstructions: false, employerAuthorized: false };
  const forType = args.records.filter(r => r.equipmentType === args.equipmentType);
  if (forType.length === 0) return { verdict: "blocked", elements: none, reason: `No authorization on record for ${args.equipmentType} — not authorized` };

  const assess = (r: EquipmentAuthorizationRecord) => ({
    trained: r.trainingEvidenceId != null,
    competent: r.competencyEvidenceId != null || r.competencyAssessedAt != null,
    familiarWithInstructions: r.instructionsAcknowledgedAt != null,
    employerAuthorized: r.authorizedByUserId != null && r.authorizedAt != null,
  });

  // The equipment itself.
  const base = forType.find(r => !r.attachmentType) ?? forType[0]!;
  if (base.status === "revoked" || base.status === "suspended") return { verdict: "blocked", elements: assess(base), reason: `Authorization for ${args.equipmentType} is ${base.status}` };
  if (base.expiresAt && base.expiresAt <= args.now) return { verdict: "blocked", elements: assess(base), reason: `Authorization for ${args.equipmentType} expired` };
  const el = assess(base);
  const missing = Object.entries(el).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { verdict: "blocked", elements: el, reason: `${args.equipmentType}: missing ${missing.join(", ")} — all four elements are required` };

  // Each attachment is its own authorization. A bucket does not authorize a personnel basket.
  for (const att of args.attachmentTypes) {
    const rec = forType.find(r => r.attachmentType === att);
    if (!rec) return { verdict: "blocked", elements: el, reason: `Not authorized on attachment ${att} for ${args.equipmentType}` };
    if (rec.status !== "authorized" || (rec.expiresAt && rec.expiresAt <= args.now)) return { verdict: "blocked", elements: el, reason: `Attachment ${att} authorization is ${rec.status}` };
    const ael = assess(rec);
    if (!ael.trained || !ael.competent || !ael.employerAuthorized) return { verdict: "blocked", elements: ael, reason: `Attachment ${att}: incomplete authorization` };
  }
  if (base.expiresAt && (base.expiresAt.getTime() - args.now.getTime()) / 86_400_000 <= 30) {
    return { verdict: "review", elements: el, reason: `Authorization for ${args.equipmentType} expires within 30 days` };
  }
  return { verdict: "authorized", elements: el, reason: `Authorized on ${args.equipmentType}${args.attachmentTypes.length ? ` with ${args.attachmentTypes.join(", ")}` : ""}` };
}

/* ------------------------------------------------------------------ */
/* Calibration                                                          */
/* ------------------------------------------------------------------ */

export type CalibrationEvent = {
  eventType: "calibrated" | "verified" | "failed" | "adjusted" | "out_of_tolerance_found" | "returned_to_service";
  performedAt: Date;
  validUntil?: Date | null;
  suspectFrom?: Date | null;
};

export type CalibrationState = {
  status: "current" | "due_soon" | "expired" | "failed" | "unknown";
  validUntil: Date | null;
  daysRemaining: number | null;
  reason: string;
};

export function calibrationStatus(args: { events: readonly CalibrationEvent[]; intervalDays: number | null; now: Date; warnDays?: number }): CalibrationState {
  const sorted = [...args.events].sort((a, b) => b.performedAt.getTime() - a.performedAt.getTime());
  const latest = sorted[0];
  if (!latest) return { status: "unknown", validUntil: null, daysRemaining: null, reason: "No calibration on record" };
  // A failure or out-of-tolerance finding after the last calibration voids it until returned to service.
  const lastGood = sorted.find(e => e.eventType === "calibrated" || e.eventType === "returned_to_service" || e.eventType === "verified");
  const lastBad = sorted.find(e => e.eventType === "failed" || e.eventType === "out_of_tolerance_found");
  if (lastBad && (!lastGood || lastBad.performedAt >= lastGood.performedAt)) {
    return { status: "failed", validUntil: null, daysRemaining: null, reason: `Device ${lastBad.eventType.replace(/_/g, " ")} on ${lastBad.performedAt.toISOString().slice(0, 10)} and not returned to service` };
  }
  if (!lastGood) return { status: "unknown", validUntil: null, daysRemaining: null, reason: "No successful calibration on record" };
  const validUntil = lastGood.validUntil ?? (args.intervalDays ? new Date(lastGood.performedAt.getTime() + args.intervalDays * 86_400_000) : null);
  if (!validUntil) return { status: "unknown", validUntil: null, daysRemaining: null, reason: "Calibrated, but no validity or interval recorded — currency unknown" };
  const days = Math.floor((validUntil.getTime() - args.now.getTime()) / 86_400_000);
  if (days < 0) return { status: "expired", validUntil, daysRemaining: days, reason: `Calibration expired ${-days} day(s) ago` };
  if (days <= (args.warnDays ?? 30)) return { status: "due_soon", validUntil, daysRemaining: days, reason: `Calibration due in ${days} day(s)` };
  return { status: "current", validUntil, daysRemaining: days, reason: `Calibrated; ${days} day(s) remaining` };
}

export type MeasurementUse = "billing" | "weight_compliance" | "dispatch_availability" | "safety_reading" | "operational_reference";

export type UseEffect = { effect: "ok" | "review" | "hold" | "cannot_certify" | "unknown"; reason: string };

/**
 * One expiry, different consequences. The number a scale produces is a fact
 * about the truck; what it may be USED for depends on how much the use trusts
 * the instrument.
 */
export function calibrationEffectOnUse(state: CalibrationState, use: MeasurementUse): UseEffect {
  const s = state.status;
  if (s === "current") return { effect: "ok", reason: "Calibrated instrument" };
  if (s === "due_soon") return use === "billing" || use === "weight_compliance" ? { effect: "review", reason: state.reason } : { effect: "ok", reason: state.reason };
  switch (use) {
    case "billing": return { effect: "hold", reason: `Billing measurement on hold — ${state.reason}` };
    case "weight_compliance": return { effect: "cannot_certify", reason: `Cannot certify axle or gross weight — ${state.reason}` };
    case "safety_reading": return { effect: s === "failed" ? "hold" : "review", reason: `Safety reading from an uncalibrated instrument — ${state.reason}` };
    case "dispatch_availability": return { effect: "review", reason: `Unit may still be available; measurement-dependent uses are affected — ${state.reason}` };
    case "operational_reference": return { effect: "review", reason: state.reason };
  }
}

export type DependentMeasurement = {
  recordType: "load" | "disposal_ticket" | "fuel_transaction" | "other";
  recordId: number;
  measuredAt: Date;
  downstream: { invoiceRefs?: string[]; permitRefs?: string[]; billingBookIds?: number[] };
};

export type CalibrationImpact = {
  suspectFrom: Date;
  suspectUntil: Date;
  affected: DependentMeasurement[];
  invoiceRefs: string[];
  permitRefs: string[];
  billingBookIds: number[];
  summary: string;
};

/**
 * "Which records depended on it?" — answerable because loads and tickets
 * record the device that measured them. The window runs from `suspectFrom`
 * (often earlier than the finding) to the finding or return-to-service.
 */
export function calibrationImpact(args: { finding: CalibrationEvent; dependents: readonly DependentMeasurement[]; returnedToServiceAt?: Date | null }): CalibrationImpact {
  const suspectFrom = args.finding.suspectFrom ?? args.finding.performedAt;
  const suspectUntil = args.returnedToServiceAt ?? args.finding.performedAt;
  const affected = args.dependents.filter(d => d.measuredAt >= suspectFrom && d.measuredAt <= suspectUntil);
  const uniq = (xs: string[]) => Array.from(new Set(xs));
  const invoiceRefs = uniq(affected.flatMap(d => d.downstream.invoiceRefs ?? []));
  const permitRefs = uniq(affected.flatMap(d => d.downstream.permitRefs ?? []));
  const billingBookIds = Array.from(new Set(affected.flatMap(d => d.downstream.billingBookIds ?? [])));
  return {
    suspectFrom, suspectUntil, affected, invoiceRefs, permitRefs, billingBookIds,
    summary: `${affected.length} measurement(s) between ${suspectFrom.toISOString().slice(0, 10)} and ${suspectUntil.toISOString().slice(0, 10)} depended on this device; ${invoiceRefs.length} invoice(s) and ${permitRefs.length} permit(s) downstream`,
  };
}

export { requirementApplies };
