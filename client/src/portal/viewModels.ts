/**
 * Portal view-models.
 *
 * The shell is thin; every decision about what a person sees first is here,
 * as a pure function of the server's answers, so it can be tested without a
 * browser. The rule the whole portal serves: a person should not open
 * LeaseOS and wonder which of thirty-five modules they need. They should see
 * their day, what needs attention, what to do next, and a way to capture.
 */

import type { CaptureKind } from "../runtime/contracts";

export type PortalKey =
  | "field_workforce" | "field_leadership" | "safety_compliance" | "dispatch_operations" | "office_administration"
  | "finance_billing" | "fleet_maintenance" | "sales_customer" | "management" | "executive" | "hr_workforce"
  | "worker_self_service" | "customer" | "vendor_facility" | "auditor_regulator" | "incident_emergency";

export type Severity = "critical" | "high" | "medium" | "low";

export type ExceptionItem = { key: string; category: string; severity: Severity; title: string; reason: string; action: string; deepLink: { portal: string; route: string }; dueAt: string | Date | null };
export type InboxItem = { kind: string; ref: string; title: string; detail: string | null; dueAt: string | Date | null; since: string | Date; deepLink: { portal: string; route: string } };
export type MyDay = {
  portals: string[];
  attention: { total: number; bySeverity: Record<Severity, number>; byCategory: Partial<Record<string, number>>; headline: string };
  toDo: { count: number; items: InboxItem[] };
  waitingFor: { count: number; items: InboxItem[] };
  next: { kind: "exception" | "inbox"; title: string; action: string; deepLink: { portal: string; route: string } } | null;
};
export type SearchHit = { entityType: string; entityId: number | string; label: string; status: string | null; deepLink: { portal: string; route: string } };
export type OutboxStatus = { counts: Record<"saved_locally" | "queued" | "syncing" | "synchronized" | "failed" | "conflict", number>; oldestUnsyncedCaptureMinutes: number | null };

/* ------------------------------------------------------------------ */
/* Portals                                                              */
/* ------------------------------------------------------------------ */

export const PORTAL_LABELS: Record<PortalKey, string> = {
  field_workforce: "Field", field_leadership: "Field lead", safety_compliance: "Safety", dispatch_operations: "Dispatch",
  office_administration: "Office", finance_billing: "Finance", fleet_maintenance: "Fleet", sales_customer: "Sales",
  management: "Management", executive: "Executive", hr_workforce: "HR", worker_self_service: "Me",
  customer: "Customer", vendor_facility: "Vendor", auditor_regulator: "Audit", incident_emergency: "Emergency",
};

/** Which portal opens first: the most operational one the person holds. */
const OPEN_FIRST: PortalKey[] = ["incident_emergency", "field_workforce", "dispatch_operations", "fleet_maintenance", "office_administration", "finance_billing", "safety_compliance", "hr_workforce", "management", "executive", "field_leadership", "sales_customer", "worker_self_service", "auditor_regulator", "customer", "vendor_facility"];

export function defaultPortal(held: readonly string[]): PortalKey | null {
  for (const p of OPEN_FIRST) if (held.includes(p)) return p;
  return null;
}

export function switcherModel(held: readonly string[], current: string | null): { key: PortalKey; label: string; current: boolean }[] {
  return OPEN_FIRST.filter(p => held.includes(p)).map(p => ({ key: p, label: PORTAL_LABELS[p], current: p === current }));
}

/* ------------------------------------------------------------------ */
/* My Day                                                               */
/* ------------------------------------------------------------------ */

export function greeting(now: Date, name: string | null): string {
  const h = now.getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}`.toUpperCase() : part.toUpperCase();
}

export type MyDayView = {
  greeting: string;
  assignment: { title: string; detail: string | null; deepLink: { portal: string; route: string } } | null;
  attention: { headline: string; items: { title: string; severity: Severity; deepLink: { portal: string; route: string } }[]; more: number };
  next: { title: string; action: string; deepLink: { portal: string; route: string } } | null;
  waitingFor: { count: number; first: string | null };
  quickCapture: QuickCaptureAction[];
};

const SEV: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The layout the specification draws:
 *   GOOD MORNING, DYLAN / Current assignment / 3 things need attention / Next / QUICK CAPTURE.
 * Attention shows at most three, worst first; the rest is a count. The assignment is the
 * first task-kind inbox item, because that is what "current assignment" is on the server today.
 */
export function composeMyDayView(args: { myDay: MyDay; exceptions: readonly ExceptionItem[]; portal: PortalKey; now: Date; displayName: string | null }): MyDayView {
  const task = args.myDay.toDo.items.find(i => i.kind === "task") ?? null;
  const sorted = [...args.exceptions].sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const shown = sorted.slice(0, 3);
  return {
    greeting: greeting(args.now, args.displayName),
    assignment: task ? { title: task.title, detail: task.detail, deepLink: task.deepLink } : null,
    attention: {
      headline: args.myDay.attention.total === 0 ? "Nothing needs your attention" : `${args.myDay.attention.total} thing${args.myDay.attention.total === 1 ? "" : "s"} need${args.myDay.attention.total === 1 ? "s" : ""} attention`,
      items: shown.map(x => ({ title: x.title, severity: x.severity, deepLink: x.deepLink })),
      more: Math.max(0, args.exceptions.length - shown.length),
    },
    next: args.myDay.next ? { title: args.myDay.next.title, action: args.myDay.next.action, deepLink: args.myDay.next.deepLink } : null,
    waitingFor: { count: args.myDay.waitingFor.count, first: args.myDay.waitingFor.items[0]?.title ?? null },
    quickCapture: quickCaptureActions(args.portal),
  };
}

/* ------------------------------------------------------------------ */
/* Office / management: the same backend, a different first screen      */
/* ------------------------------------------------------------------ */

export type OfficeDayView = { rows: { label: string; count: number; deepLink: { portal: string; route: string } | null }[] };

/** Counts by category, in the order the office reads them. Categories with nothing are still rows: a zero is information. */
export function composeOfficeView(exceptions: readonly ExceptionItem[], inbox: readonly InboxItem[]): OfficeDayView {
  const count = (pred: (x: ExceptionItem) => boolean) => exceptions.filter(pred).length;
  return {
    rows: [
      { label: "Critical", count: count(x => x.severity === "critical"), deepLink: { portal: "office_administration", route: "/exceptions?severity=critical" } },
      { label: "Needs review", count: count(x => x.severity !== "critical"), deepLink: { portal: "office_administration", route: "/exceptions" } },
      { label: "Waiting on field", count: inbox.filter(i => i.kind === "ai_question" || i.kind === "my_request").length, deepLink: { portal: "office_administration", route: "/inbox" } },
      { label: "Billing", count: count(x => x.category === "billing" || x.category === "finance"), deepLink: { portal: "finance_billing", route: "/exceptions?category=billing" } },
      { label: "Dispatch", count: count(x => x.category === "dispatch" || x.category === "critical"), deepLink: { portal: "dispatch_operations", route: "/exceptions?category=dispatch" } },
      { label: "Fleet", count: count(x => x.category === "fleet" || x.category === "calibration"), deepLink: { portal: "fleet_maintenance", route: "/exceptions?category=fleet" } },
      { label: "Workforce", count: count(x => x.category === "workforce" || x.category === "compliance"), deepLink: { portal: "hr_workforce", route: "/exceptions?category=workforce" } },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Exception indicator                                                  */
/* ------------------------------------------------------------------ */

export function exceptionIndicator(summary: MyDay["attention"]): { badge: string | null; tone: "critical" | "high" | "quiet" } {
  if (summary.total === 0) return { badge: null, tone: "quiet" };
  if (summary.bySeverity.critical > 0) return { badge: String(summary.bySeverity.critical), tone: "critical" };
  return { badge: String(summary.total), tone: summary.bySeverity.high > 0 ? "high" : "quiet" };
}

/* ------------------------------------------------------------------ */
/* Quick Capture                                                        */
/* ------------------------------------------------------------------ */

export type QuickCaptureAction = { key: string; label: string; kind: CaptureKind; formKey: string | null; category: string; needsPhoto: boolean; needsVoice: boolean };

const FIELD_CAPTURE: QuickCaptureAction[] = [
  { key: "receipt", label: "Receipt", kind: "fuel_receipt", formKey: "fuel_receipt", category: "receipt", needsPhoto: true, needsVoice: false },
  { key: "ticket", label: "Ticket", kind: "disposal_ticket", formKey: "disposal_ticket", category: "ticket", needsPhoto: true, needsVoice: false },
  { key: "photo", label: "Photo", kind: "photo", formKey: null, category: "photo", needsPhoto: true, needsVoice: false },
  { key: "defect", label: "Defect", kind: "defect_report", formKey: "defect_report", category: "defect", needsPhoto: false, needsVoice: true },
  { key: "incident", label: "Incident", kind: "incident", formKey: null, category: "incident", needsPhoto: true, needsVoice: true },
  { key: "voice", label: "Voice", kind: "voice_note", formKey: null, category: "voice", needsPhoto: false, needsVoice: true },
];
const OFFICE_CAPTURE: QuickCaptureAction[] = [
  { key: "bill", label: "Vendor bill", kind: "expense_receipt", formKey: "expense_receipt", category: "bill", needsPhoto: true, needsVoice: false },
  { key: "receipt", label: "Receipt", kind: "expense_receipt", formKey: "expense_receipt", category: "receipt", needsPhoto: true, needsVoice: false },
];

/** Quick capture is for people who capture. Executives and auditors read; they do not photograph receipts. */
export function quickCaptureActions(portal: PortalKey): QuickCaptureAction[] {
  switch (portal) {
    case "field_workforce": case "field_leadership": case "incident_emergency": case "worker_self_service": return FIELD_CAPTURE;
    case "fleet_maintenance": return FIELD_CAPTURE.filter(a => ["photo", "defect", "voice"].includes(a.key));
    case "office_administration": case "finance_billing": return OFFICE_CAPTURE;
    default: return [];
  }
}

/* ------------------------------------------------------------------ */
/* Sync indicator                                                       */
/* ------------------------------------------------------------------ */

export function syncIndicator(status: OutboxStatus | null, online: boolean): { label: string; tone: "ok" | "pending" | "offline" | "attention" } {
  if (!status) return { label: online ? "Online" : "Offline", tone: online ? "ok" : "offline" };
  const pending = status.counts.queued + status.counts.syncing + status.counts.saved_locally;
  const problems = status.counts.failed + status.counts.conflict;
  const age = status.oldestUnsyncedCaptureMinutes;
  const ageText = age == null ? "" : age >= 120 ? ` · oldest ${Math.round(age / 60)}h` : age >= 1 ? ` · oldest ${age}m` : "";
  if (problems > 0) return { label: `${problems} need${problems === 1 ? "s" : ""} attention${pending ? ` · ${pending} pending` : ""}`, tone: "attention" };
  if (!online) return { label: pending ? `Offline · ${pending} queued${ageText}` : "Offline · nothing pending", tone: "offline" };
  if (pending > 0) return { label: `${pending} pending${ageText}`, tone: "pending" };
  return { label: "All synchronized", tone: "ok" };
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

const ENTITY_LABELS: Record<string, string> = { unit: "Units", job: "Jobs", trip: "Trips", load: "Loads", disposalTicket: "Disposal tickets", invoice: "Invoices", workOrder: "Work orders", purchaseAuthorization: "Purchases", vendorBill: "Vendor bills", roadsideEvent: "Roadside", fieldDevice: "Devices", measurementDevice: "Measurement devices", insurancePolicy: "Policies", fuelTransaction: "Fuel" };

export function searchGroups(hits: readonly SearchHit[]): { label: string; hits: SearchHit[] }[] {
  const by = new Map<string, SearchHit[]>();
  for (const h of hits) by.set(h.entityType, [...(by.get(h.entityType) ?? []), h]);
  return Array.from(by.entries()).map(([t, hs]) => ({ label: ENTITY_LABELS[t] ?? t, hits: hs })).sort((a, b) => b.hits.length - a.hits.length || a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ */
/* Context ribbon                                                       */
/* ------------------------------------------------------------------ */

export function contextRibbon(args: { portal: PortalKey; assignment: MyDayView["assignment"]; online: boolean; deviceStatus: "active" | "revoked" | "unknown" | null }): string[] {
  const parts = [PORTAL_LABELS[args.portal]];
  if (args.assignment) parts.push(args.assignment.title);
  if (args.deviceStatus === "revoked") parts.push("Device revoked — recapture on an enrolled device");
  else if (!args.online) parts.push("Working offline");
  return parts;
}
