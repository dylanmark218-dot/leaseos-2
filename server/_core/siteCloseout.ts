/**
 * Site sign-off and the post-site billing chain.
 *
 * Several clocks describe one day without pretending to be the same thing.
 * Each ticket event belongs to a clock, and only the customer-billing clock
 * reaches the customer. The site signature freezes a snapshot — a hash of
 * what was known and agreed at the lease — and a later change is a new
 * revision, never an edit. Post-site travel and disposal are appended only
 * under the billing basis the consultant signed. Restocking, post-trip,
 * washout, fuel and paperwork are the company's clock, and stay off the
 * customer's bill unless a contract rule says otherwise. A delay is billable
 * when a contract rule says so, non-billable when the kind can never be, and
 * REVIEW REQUIRED until the rule is configured — never a made-up answer.
 */

import { createHash } from "node:crypto";

export type Clock = "duty" | "payroll" | "job" | "customer_billing" | "equipment" | "standby" | "travel" | "disposal" | "internal_service";
export type EventType = "site_work" | "standby" | "customer_hold" | "weather_hold" | "travel_to_disposal" | "disposal_queue" | "disposal" | "return_travel" | "post_trip" | "restock" | "washout" | "fuel" | "paperwork" | "break" | "other";

/** Which clock an event type belongs to, and whether the customer pays for it by default. */
export const EVENT_CLOCK: Record<EventType, { clock: Clock; customerBillable: "yes" | "no" | "review"; phase: "site" | "post_site" | "internal" }> = {
  site_work: { clock: "customer_billing", customerBillable: "yes", phase: "site" },
  standby: { clock: "standby", customerBillable: "review", phase: "site" },
  customer_hold: { clock: "standby", customerBillable: "review", phase: "site" },
  weather_hold: { clock: "standby", customerBillable: "review", phase: "site" },
  travel_to_disposal: { clock: "travel", customerBillable: "review", phase: "post_site" },
  disposal_queue: { clock: "disposal", customerBillable: "review", phase: "post_site" },
  disposal: { clock: "disposal", customerBillable: "review", phase: "post_site" },
  return_travel: { clock: "travel", customerBillable: "review", phase: "post_site" },
  post_trip: { clock: "internal_service", customerBillable: "no", phase: "internal" },
  restock: { clock: "internal_service", customerBillable: "no", phase: "internal" },
  washout: { clock: "internal_service", customerBillable: "no", phase: "internal" },
  fuel: { clock: "internal_service", customerBillable: "no", phase: "internal" },
  paperwork: { clock: "internal_service", customerBillable: "no", phase: "internal" },
  break: { clock: "duty", customerBillable: "no", phase: "internal" },
  other: { clock: "job", customerBillable: "review", phase: "site" },
};

export type TicketEvent = { id: number; eventType: EventType; occurredAt: Date; endedAt: Date | null; customerBillable: "yes" | "no" | "review"; source: string | null; confidence: "low" | "medium" | "high" | null; detail: string | null; billableMinutes?: number | null; billingRuleRef?: string | null };
export type TicketLine = { id: number; lineKind: string; description: string; quantity: number | null; quantityUnit: string | null; measurementMethod: string | null; sourceTrackingNumber?: string | null; disposition: "not_presented" | "accepted" | "disputed"; operatorStatement: string | null; customerStatement: string | null };

/** What a customer reads beside a segment — never a code. */
const SOURCE_LABEL: Record<string, string> = { driver_stated: "Driver stated", gps: "GPS supported", pto: "PTO recorded", ticket: "Ticket", system_inferred: "System inferred — review", human_corrected: "Corrected by office" };

const HOURS = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 100) / 100;

export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map(k => [k, sort((x as Record<string, unknown>)[k])])) : x instanceof Date ? x.toISOString() : x;
  return JSON.stringify(sort(v));
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------------ */
/* Stage 1 — the site snapshot                                          */
/* ------------------------------------------------------------------ */

export type SiteSnapshot = {
  ticketNumber: string; jobId: number | null; customer: string; site: string | null; unitId: number | null; operatorId: number | null;
  arrivalAt: string | null; workStartAt: string | null; siteWorkCompleteAt: string | null;
  loads: number; siteBillableHours: number; standbyHours: number; standbyBillable: "yes" | "no" | "review";
  minimumApplied: { minimumHours: number; billableHoursBefore: number; ruleRef: string } | null;
  lines: { id: number; lineKind: string; description: string; quantity: number | null; unit: string | null; measurementMethod: string | null }[];
  events: { eventType: EventType; from: string; to: string | null; hours: number | null; customerBillable: "yes" | "no" | "review" }[];
  postSiteRequired: boolean;
  unclosedSiteEvents: number;
};

export function composeSiteSnapshot(args: { ticket: { ticketNumber: string; jobId: number | null; customer: string; site: string | null; unitId: number | null; operatorId: number | null }; lines: readonly TicketLine[]; events: readonly TicketEvent[]; siteWorkCompleteAt: Date | null; minimum?: { hours: number; ruleRef: string } | null; postSiteRequired: boolean }): { snapshot: SiteSnapshot; hash: string; findings: string[] } {
  const findings: string[] = [];
  const site = args.events.filter(e => EVENT_CLOCK[e.eventType].phase === "site");
  const arrival = site.length ? new Date(Math.min(...site.map(e => e.occurredAt.getTime()))) : null;
  const work = site.filter(e => e.eventType === "site_work");
  const workStart = work.length ? new Date(Math.min(...work.map(e => e.occurredAt.getTime()))) : null;
  const complete = args.siteWorkCompleteAt;
  const unclosed = site.filter(e => !e.endedAt).length;
  if (unclosed) findings.push(`${unclosed} site event(s) still open — close them before the consultant signs`);
  const hoursOf = (es: TicketEvent[]) => es.filter(e => e.endedAt).reduce((a, e) => a + HOURS(e.occurredAt, e.endedAt!), 0);
  const standbyEvents = site.filter(e => e.eventType === "standby" || e.eventType === "customer_hold" || e.eventType === "weather_hold");
  // Site billable = work the customer pays for + standby a contract rule says they pay for. Review standby is not counted until decided.
  // v22.1 — a contract term may have reduced what the customer pays for (grace minutes); the clock is untouched.
  const billableHoursOf = (es: TicketEvent[]) => es.filter(e => e.endedAt).reduce((a, e) => a + (e.billableMinutes != null ? e.billableMinutes / 60 : HOURS(e.occurredAt, e.endedAt!)), 0);
  const billable = hoursOf(work.filter(e => e.customerBillable === "yes")) + billableHoursOf(standbyEvents.filter(e => e.customerBillable === "yes"));
  const standby = hoursOf(standbyEvents);
  const standbyBillable: SiteSnapshot["standbyBillable"] = standbyEvents.length === 0 ? "no" : standbyEvents.every(e => e.customerBillable === "yes") ? "yes" : standbyEvents.some(e => e.customerBillable === "review") ? "review" : "no";
  if (standbyBillable === "review") findings.push("Standby is on the ticket but no contract rule decides whether the customer pays for it — REVIEW");
  for (const e of standbyEvents) if (e.billingRuleRef) findings.push(`${e.eventType.replace(/_/g, " ")} decided by ${e.billingRuleRef}`);
  // v22.2 — a minimum-hours term raises what is billed, never what was worked; the raise is named.
  let billedHours = Math.round(billable * 100) / 100;
  let minimumApplied: SiteSnapshot["minimumApplied"] = null;
  if (args.minimum && billedHours > 0 && billedHours < args.minimum.hours) { minimumApplied = { minimumHours: args.minimum.hours, billableHoursBefore: billedHours, ruleRef: args.minimum.ruleRef }; billedHours = args.minimum.hours; findings.push(`Minimum ${args.minimum.hours} h per ${args.minimum.ruleRef}: ${minimumApplied.billableHoursBefore} h billable raised to ${args.minimum.hours} h`); }
  const snapshot: SiteSnapshot = {
    ticketNumber: args.ticket.ticketNumber, jobId: args.ticket.jobId, customer: args.ticket.customer, site: args.ticket.site, unitId: args.ticket.unitId, operatorId: args.ticket.operatorId,
    arrivalAt: arrival?.toISOString() ?? null, workStartAt: workStart?.toISOString() ?? null, siteWorkCompleteAt: complete?.toISOString() ?? null,
    loads: args.lines.filter(l => l.lineKind === "load").length, siteBillableHours: billedHours, minimumApplied, standbyHours: Math.round(standby * 100) / 100, standbyBillable,
    lines: args.lines.map(l => ({ id: l.id, lineKind: l.lineKind, description: l.description, quantity: l.quantity, unit: l.quantityUnit, measurementMethod: l.measurementMethod })),
    events: site.map(e => ({ eventType: e.eventType, from: e.occurredAt.toISOString(), to: e.endedAt?.toISOString() ?? null, hours: e.endedAt ? HOURS(e.occurredAt, e.endedAt) : null, customerBillable: e.customerBillable })),
    postSiteRequired: args.postSiteRequired, unclosedSiteEvents: unclosed,
  };
  return { snapshot, hash: sha256(canonicalJson(snapshot)), findings };
}

/* ------------------------------------------------------------------ */
/* The signature: what it exercised, and whether that was allowed       */
/* ------------------------------------------------------------------ */

export type Authority = "work_confirmation" | "time_confirmation" | "quantity_confirmation" | "standby_approval" | "change_order_authorization" | "invoice_approval";
export type SignatoryAuthority = { signatoryName: string; mayConfirmWork: boolean; maySignTicket: boolean; mayApproveStandby: boolean; extraWorkLimitCents: number | null; mayApproveInvoice: boolean; mayChangeRates: boolean; validTo: Date | null; status: "active" | "revoked" };
export type PostSiteAuthorization = { disposalRequired: boolean; travelToDisposal: boolean; disposalWait: boolean; disposalUnload: boolean; returnTravel: "yes" | "no" | "per_contract"; capRule: "none" | "per_contract"; restockingBillable: false; postTripBillable: false };

export function signatureDecision(args: { requested: readonly Authority[]; authority: SignatoryAuthority | null; extraWorkCents: number; signedAt: Date; snapshotHashAtSigning: string; currentSnapshotHash: string }): { permitted: boolean; refusals: string[]; exercised: Authority[]; refused: { authority: Authority; reason: string }[]; withinAuthority: "yes" | "no" | "unknown" } {
  const refusals: string[] = [];
  if (args.snapshotHashAtSigning !== args.currentSnapshotHash) refusals.push("The ticket changed between review and signature — present it again");
  if (args.requested.length === 0) refusals.push("A signature must say what it confirms");
  const a = args.authority;
  const refused: { authority: Authority; reason: string }[] = [];
  const exercised: Authority[] = [];
  const active = a && a.status === "active" && (!a.validTo || a.validTo > args.signedAt);
  for (const r of args.requested) {
    if (!a) { exercised.push(r); continue; } // unknown authority: recorded as exercised, marked unknown, reviewed later
    if (!active) { refused.push({ authority: r, reason: `${a.signatoryName}'s authority is ${a.status === "revoked" ? "revoked" : "expired"}` }); continue; }
    const ok = r === "work_confirmation" ? a.mayConfirmWork : r === "time_confirmation" || r === "quantity_confirmation" ? a.maySignTicket : r === "standby_approval" ? a.mayApproveStandby : r === "change_order_authorization" ? a.extraWorkLimitCents != null && args.extraWorkCents <= a.extraWorkLimitCents : r === "invoice_approval" ? a.mayApproveInvoice : false;
    if (ok) exercised.push(r); else refused.push({ authority: r, reason: r === "change_order_authorization" ? `Extra work $${(args.extraWorkCents / 100).toFixed(2)} exceeds ${a.signatoryName}'s limit${a.extraWorkLimitCents != null ? ` of $${(a.extraWorkLimitCents / 100).toFixed(2)}` : " — no extra-work authority"}` : `${a.signatoryName} may not exercise ${r.replace(/_/g, " ")}` });
  }
  if (a && exercised.length === 0 && args.requested.length > 0) refusals.push(`Nothing requested is within ${a.signatoryName}'s authority: ${refused.map(x => x.reason).join("; ")}`);
  return { permitted: refusals.length === 0, refusals, exercised, refused, withinAuthority: !a ? "unknown" : refused.length === 0 ? "yes" : "no" };
}

/* ------------------------------------------------------------------ */
/* Per-line acceptance: both sides kept                                 */
/* ------------------------------------------------------------------ */

export function lineDecision(line: TicketLine, decision: { disposition: "accepted" | "disputed"; customerQuantity?: number | null; customerStatement?: string | null }): { line: TicketLine; refusal: string | null } {
  if (decision.disposition === "disputed" && !decision.customerStatement) return { line, refusal: `A disputed line needs the customer's statement of what they accept and why` };
  const statement = decision.disposition === "disputed" ? `${decision.customerQuantity != null ? `Accepted ${decision.customerQuantity}${line.quantityUnit ? ` ${line.quantityUnit}` : ""} of ${line.quantity ?? "?"}. ` : ""}${decision.customerStatement ?? ""}`.trim() : decision.customerStatement ?? "Accepted";
  // The operator's statement and quantity are never overwritten.
  return { line: { ...line, disposition: decision.disposition, customerStatement: statement }, refusal: null };
}

/* ------------------------------------------------------------------ */
/* Stage 2 — the post-site supplement, only under what was signed       */
/* ------------------------------------------------------------------ */

export type Supplement = {
  included: { eventType: EventType; from: string; to: string; hours: number; evidence: string; basis: string }[];
  excluded: { eventType: EventType; from: string; to: string | null; hours: number | null; reason: string }[];
  discrepancies: { subject: string; detail: string }[];
  postSiteBillableHours: number;
  determination: "ready" | "review" | "blocked";
  reasons: string[];
};

export function postSiteSupplement(args: { authorization: PostSiteAuthorization | null; events: readonly TicketEvent[]; siteWorkCompleteAt: Date; disposalTicket: { receivedAt: Date | null; releasedAt: Date | null; ticketNumber: string | null } | null; gpsFacilityArrivalAt: Date | null; contractReturnTravel: "yes" | "no" | null }): Supplement {
  const included: Supplement["included"] = [], excluded: Supplement["excluded"] = [], discrepancies: Supplement["discrepancies"] = [], reasons: string[] = [];
  const auth = args.authorization;
  if (!auth) reasons.push("No post-site authorization was signed at the lease — nothing after site work can be billed");
  const after = args.events.filter(e => e.occurredAt >= args.siteWorkCompleteAt && EVENT_CLOCK[e.eventType].phase !== "site");
  for (const e of after) {
    const meta = EVENT_CLOCK[e.eventType];
    const hours = e.endedAt ? HOURS(e.occurredAt, e.endedAt) : null;
    const from = e.occurredAt.toISOString(), to = e.endedAt?.toISOString() ?? null;
    if (meta.phase === "internal") { excluded.push({ eventType: e.eventType, from, to, hours, reason: "Company activity — recorded for HOS, payroll, maintenance and cost; not customer billable" }); continue; }
    if (!auth || !e.endedAt) { excluded.push({ eventType: e.eventType, from, to, hours, reason: !auth ? "No signed post-site authorization" : "Event still open" }); continue; }
    const basis = e.eventType === "travel_to_disposal" ? (auth.travelToDisposal ? "Authorized: travel to approved disposal" : null)
      : e.eventType === "disposal_queue" ? (auth.disposalWait ? "Authorized: disposal wait time" : null)
      : e.eventType === "disposal" ? (auth.disposalUnload ? "Authorized: disposal/unloading time" : null)
      : e.eventType === "return_travel" ? (auth.returnTravel === "yes" ? "Authorized: return travel" : auth.returnTravel === "per_contract" ? (args.contractReturnTravel === "yes" ? "Authorized per contract: return travel" : args.contractReturnTravel === "no" ? null : "REVIEW") : null)
      : null;
    if (basis === "REVIEW") { excluded.push({ eventType: e.eventType, from, to, hours, reason: "Return travel is per contract and the contract rule is not configured — REVIEW" }); reasons.push("Return travel awaits the contract rule"); continue; }
    if (!basis) { excluded.push({ eventType: e.eventType, from, to, hours, reason: "Not within the signed post-site authorization" }); continue; }
    const evidence = e.eventType === "disposal" && args.disposalTicket?.ticketNumber ? `Disposal ticket ${args.disposalTicket.ticketNumber}` : e.source === "gps" ? "GPS supported" : e.eventType === "disposal_queue" ? "Facility geofence" : SOURCE_LABEL[e.source ?? "driver_stated"] ?? "Driver stated";
    included.push({ eventType: e.eventType, from, to: to!, hours: hours!, evidence, basis });
  }
  // The disposal ticket and GPS must agree; when they do not, LeaseOS does not choose the larger.
  if (args.disposalTicket?.receivedAt && args.gpsFacilityArrivalAt) {
    const diffMin = Math.abs(args.disposalTicket.receivedAt.getTime() - args.gpsFacilityArrivalAt.getTime()) / 60_000;
    if (diffMin > 15) discrepancies.push({ subject: "facility arrival", detail: `TIME DISCREPANCY — GPS arrival ${args.gpsFacilityArrivalAt.toISOString().slice(11, 16)}, ticket received ${args.disposalTicket.receivedAt.toISOString().slice(11, 16)} (${Math.round(diffMin)} min) — REVIEW` });
  }
  if (auth?.disposalRequired && !args.disposalTicket) reasons.push("Disposal was required and no disposal ticket is attached");
  if (auth?.capRule === "per_contract") reasons.push("A post-site cap applies per contract — confirm the cap rule before invoicing");
  const total = Math.round(included.reduce((a, i) => a + i.hours, 0) * 100) / 100;
  const determination: Supplement["determination"] = !auth || (auth.disposalRequired && !args.disposalTicket) ? "blocked" : discrepancies.length || reasons.length ? "review" : "ready";
  return { included, excluded, discrepancies, postSiteBillableHours: total, determination, reasons };
}

/* ------------------------------------------------------------------ */
/* Delays                                                               */
/* ------------------------------------------------------------------ */

export type DelayKind = "customer_hold" | "disposal_queue" | "weather" | "road_hazard" | "collision" | "driver_break" | "breakdown" | "other";
export type DelayRules = Partial<Record<DelayKind, "billable" | "non_billable">>;

export function classifyDelay(kind: DelayKind, rules: DelayRules | null): { classification: "billable" | "non_billable" | "review_required"; ruleRef: string | null } {
  if (kind === "driver_break" || kind === "breakdown") return { classification: "non_billable", ruleRef: "leaseos:never_customer_billable" };
  const rule = rules?.[kind];
  if (!rule) return { classification: "review_required", ruleRef: null };
  return { classification: rule, ruleRef: `contract:${kind}` };
}

/* ------------------------------------------------------------------ */
/* Three closes                                                         */
/* ------------------------------------------------------------------ */

export type CloseoutState = {
  fieldClosed: { at: string | null; by: string | null };
  operationallyClosed: { at: string | null };
  financiallyReady: boolean;
  invoiceReady: boolean;
  state: "OPEN" | "WORK_ACTIVE" | "SITE_CLOSE_PENDING" | "SITE_SIGNED" | "SITE_DISPUTED" | "POST_SITE_ACTIVE" | "POST_SITE_COMPLETE" | "BILLING_RECONCILIATION" | "BILLING_READY";
  blockers: string[];
};

export function closeoutState(args: { events: readonly TicketEvent[]; lines: readonly TicketLine[]; siteWorkCompleteAt: Date | null; signature: { signedAt: Date; signerName: string; result: string } | null; supplement: Supplement | null; postSiteRequired: boolean; loadsWithDisposalEvidence: number; loads: number }): CloseoutState {
  const blockers: string[] = [];
  const site = args.events.filter(e => EVENT_CLOCK[e.eventType].phase === "site");
  const internal = args.events.filter(e => EVENT_CLOCK[e.eventType].phase === "internal");
  const postSite = args.events.filter(e => EVENT_CLOCK[e.eventType].phase === "post_site");
  const disputed = args.lines.filter(l => l.disposition === "disputed");
  const opClosedAt = args.siteWorkCompleteAt && [...postSite, ...internal].every(e => e.endedAt) && (internal.length || !args.postSiteRequired) ? new Date(Math.max(args.siteWorkCompleteAt.getTime(), ...[...postSite, ...internal].map(e => e.endedAt!.getTime()))) : null;
  if (!args.signature) blockers.push("Site ticket not signed");
  if (args.signature?.result === "refused") blockers.push("Customer refused the site ticket");
  for (const l of disputed) blockers.push(`Line disputed: ${l.description} — office resolves`);
  if (args.postSiteRequired && !args.supplement) blockers.push("Post-site supplement not prepared");
  if (args.supplement && args.supplement.determination === "blocked") blockers.push(...args.supplement.reasons);
  if (args.loads > args.loadsWithDisposalEvidence) blockers.push(`${args.loads - args.loadsWithDisposalEvidence} load(s) without disposal evidence`);
  const financiallyReady = blockers.length === 0;
  const state: CloseoutState["state"] = !site.length ? "OPEN" : !args.siteWorkCompleteAt ? "WORK_ACTIVE" : !args.signature ? "SITE_CLOSE_PENDING" : disputed.length ? "SITE_DISPUTED" : args.postSiteRequired && postSite.some(e => !e.endedAt) ? "POST_SITE_ACTIVE" : args.postSiteRequired && !args.supplement ? "POST_SITE_COMPLETE" : !financiallyReady ? "BILLING_RECONCILIATION" : "BILLING_READY";
  return { fieldClosed: { at: args.signature?.signedAt.toISOString() ?? null, by: args.signature?.signerName ?? null }, operationallyClosed: { at: opClosedAt?.toISOString() ?? null }, financiallyReady, invoiceReady: financiallyReady && (args.supplement?.determination ?? "ready") === "ready", state, blockers };
}

/* ------------------------------------------------------------------ */
/* WHY IS THIS 11.82 HOURS?                                             */
/* ------------------------------------------------------------------ */

export function whyTheseHours(snapshot: SiteSnapshot, signedBy: string | null, supplement: Supplement | null): { sections: { title: string; rows: { window: string; what: string; hours: number; evidence: string }[]; subtotal: number }[]; notIncluded: { what: string; hours: number | null }[]; totalHours: number } {
  const hhmm = (iso: string) => iso.slice(11, 16);
  const siteRows = snapshot.events.filter(e => e.to && e.customerBillable === "yes" && (e.eventType === "site_work" || e.eventType === "standby" || e.eventType === "customer_hold" || e.eventType === "weather_hold")).map(e => ({ window: `${hhmm(e.from)}–${hhmm(e.to!)}`, what: e.eventType === "site_work" ? "Site work" : `${e.eventType.replace(/_/g, " ")} — billable per contract`, hours: e.hours!, evidence: signedBy ? `Signed by ${signedBy}` : "Unsigned" }));
  const sections = [{ title: "SITE WORK", rows: siteRows, subtotal: snapshot.siteBillableHours }];
  if (supplement) sections.push({ title: "POST-SITE", rows: supplement.included.map(i => ({ window: `${hhmm(i.from)}–${hhmm(i.to)}`, what: i.eventType.replace(/_/g, " "), hours: i.hours, evidence: i.evidence })), subtotal: supplement.postSiteBillableHours });
  const notIncluded = [
    ...snapshot.events.filter(e => e.customerBillable !== "yes").map(e => ({ what: `${e.eventType.replace(/_/g, " ")}${e.customerBillable === "review" ? " (review)" : ""}`, hours: e.hours })),
    ...(supplement?.excluded ?? []).map(x => ({ what: `${x.eventType.replace(/_/g, " ")} — ${x.reason}`, hours: x.hours })),
  ];
  return { sections, notIncluded, totalHours: Math.round(sections.reduce((a, s) => a + s.subtotal, 0) * 100) / 100 };
}
