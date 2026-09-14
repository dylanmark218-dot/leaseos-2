/**
 * Customer projections — what a customer may see, derived from records the
 * contractor holds.
 *
 * Three rules. An operational state comes only from ticket events and
 * signatures — never from a vehicle's speed — and is UNKNOWN when nothing
 * establishes it. A readiness projection passes a verdict and a category
 * derived from a blocker's CODE through a fixed dictionary; the label,
 * the credential, the document, the person's record never cross. A notice
 * is a template chosen by kind and severity; the incident's own title,
 * detail, names and findings never cross.
 */

import type { EventType } from "./siteCloseout";

export type OperationalState = "EN_ROUTE" | "ARRIVED" | "ON_LOCATION" | "WORKING" | "LOADING" | "UNLOADING" | "DISPOSAL" | "STANDBY" | "CUSTOMER_HOLD" | "WEATHER_HOLD" | "BREAKDOWN" | "INCIDENT" | "COMPLETE" | "UNKNOWN";

export type StateEvent = { eventType: EventType; occurredAt: Date; endedAt: Date | null };
export type OpenSafetyEvent = { eventType: string; severity: "info" | "warning" | "critical"; status: "open" | "acknowledged" | "resolved"; occurredAt: Date };

const OPEN_STATE: Partial<Record<EventType, OperationalState>> = {
  site_work: "WORKING", standby: "STANDBY", customer_hold: "CUSTOMER_HOLD", weather_hold: "WEATHER_HOLD",
  travel_to_disposal: "EN_ROUTE", disposal_queue: "DISPOSAL", disposal: "UNLOADING", return_travel: "EN_ROUTE",
  break: "ON_LOCATION", other: "ON_LOCATION",
};

export function operationalState(args: { events: readonly StateEvent[]; siteSigned: boolean; safety: readonly OpenSafetyEvent[]; now: Date }): { state: OperationalState; basis: string; since: Date | null } {
  const openSafety = args.safety.filter(s => s.status !== "resolved").sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  if (openSafety) {
    const mech = /mechanical|breakdown|defect|vehicle/i.test(openSafety.eventType);
    return { state: mech ? "BREAKDOWN" : "INCIDENT", basis: `Open ${mech ? "mechanical" : "safety"} event since ${openSafety.occurredAt.toISOString().slice(11, 16)}`, since: openSafety.occurredAt };
  }
  const sorted = [...args.events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const open = sorted.filter(e => e.endedAt == null || e.endedAt > args.now).pop();
  if (open) {
    const st = OPEN_STATE[open.eventType];
    if (st) return { state: st, basis: `Ticket event ${open.eventType} open since ${open.occurredAt.toISOString().slice(11, 16)}`, since: open.occurredAt };
    // An open internal event (post-trip, restock…) after the site is the company's time: the customer's job is complete.
    return { state: args.siteSigned ? "COMPLETE" : "UNKNOWN", basis: args.siteSigned ? "Site signed; company activity in progress is not customer-visible" : `Open ${open.eventType} event does not establish a customer-visible state`, since: open.occurredAt };
  }
  if (args.siteSigned) return { state: "COMPLETE", basis: "Site signed", since: null };
  const last = sorted[sorted.length - 1];
  if (!last) return { state: "UNKNOWN", basis: "No ticket event recorded — nothing establishes a state", since: null };
  // Between events nothing is running. The unit is on location if site work has happened; we do not guess more.
  return { state: sorted.some(e => e.eventType === "site_work") ? "ON_LOCATION" : "UNKNOWN", basis: `Last event ${last.eventType} ended ${last.endedAt?.toISOString().slice(11, 16) ?? "-"}; no event open`, since: last.endedAt };
}

/* ---- readiness projection ---- */

export type ReadinessProjection = { verdict: "READY" | "REVIEW" | "BLOCKED" | "UNKNOWN"; items: { subject: "worker" | "unit" | "trailer" | "job"; verdict: "REVIEW" | "BLOCKED" | "UNKNOWN"; category: string }[] };

/** Code → the only words the customer sees. Anything not here is "requirement under review". */
const CATEGORY: { test: RegExp; category: string }[] = [
  { test: /licen[cs]e/i, category: "driver licence" },
  { test: /abstract/i, category: "driver abstract" },
  { test: /medical|fitness/i, category: "fitness for duty" },
  { test: /tdg|dangerous/i, category: "TDG certification" },
  { test: /h2s/i, category: "H2S certification" },
  { test: /first.?aid/i, category: "first aid" },
  { test: /whmis/i, category: "WHMIS" },
  { test: /orientation/i, category: "customer or site orientation" },
  { test: /insurance|coi|certificate_of_insurance/i, category: "insurance certificate" },
  { test: /registration/i, category: "vehicle registration" },
  { test: /inspection|cvip/i, category: "vehicle inspection" },
  { test: /defect|mechanic/i, category: "mechanical release" },
  { test: /hos|hours/i, category: "hours of service" },
  { test: /equipment|authoriz/i, category: "equipment authorization" },
  { test: /permit/i, category: "permit" },
  { test: /route|coverage/i, category: "route data" },
];

export function projectReadiness(args: { verdict: string; blockers: readonly { code: string; severity: "blocking" | "review" | "unknown"; subject: "operator" | "truck" | "trailer" | "job" | "route" }[] }): ReadinessProjection {
  const subj = (s: string): ReadinessProjection["items"][number]["subject"] => s === "operator" ? "worker" : s === "truck" ? "unit" : s === "trailer" ? "trailer" : "job";
  const items = args.blockers.map(b => ({ subject: subj(b.subject), verdict: b.severity === "blocking" ? "BLOCKED" as const : b.severity === "review" ? "REVIEW" as const : "UNKNOWN" as const, category: CATEGORY.find(c => c.test.test(b.code))?.category ?? "requirement under review" }));
  const v = args.verdict.toLowerCase();
  const verdict: ReadinessProjection["verdict"] = items.some(i => i.verdict === "BLOCKED") || /ineligible|blocked/.test(v) ? "BLOCKED" : items.some(i => i.verdict === "UNKNOWN") || /unknown/.test(v) ? "UNKNOWN" : items.length || /review/.test(v) ? "REVIEW" : /eligible|ready/.test(v) ? "READY" : "UNKNOWN";
  return { verdict, items };
}

/* ---- customer notices ---- */

export type CustomerNotice = { at: Date; kind: "interruption" | "mechanical" | "incident" | "resolved"; message: string; customerAction: "none" | "may_be_required"; status: "open" | "acknowledged" | "resolved" };

/** Templates only. The event's title, detail, names, injuries and findings never reach here. */
export function noticeFor(ev: { eventType: string; severity: "info" | "warning" | "critical"; status: "open" | "acknowledged" | "resolved"; occurredAt: Date }): CustomerNotice | null {
  if (ev.severity === "info") return null;
  const mech = /mechanical|breakdown|defect|vehicle/i.test(ev.eventType);
  if (ev.status === "resolved") return { at: ev.occurredAt, kind: "resolved", message: mech ? "The mechanical interruption is resolved." : "The earlier interruption is resolved.", customerAction: "none", status: ev.status };
  return {
    at: ev.occurredAt, kind: mech ? "mechanical" : "incident",
    message: mech ? "Work temporarily interrupted — mechanical event under review; replacement equipment being evaluated." : ev.severity === "critical" ? "Work interrupted — an operational event is under review by the contractor." : "Work may be affected — an operational event is under review.",
    customerAction: ev.severity === "critical" ? "may_be_required" : "none", status: ev.status,
  };
}
