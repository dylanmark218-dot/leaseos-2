/**
 * v22.20 — money dates and company dates on the calendar, without the calendar
 * becoming the record.
 *
 * Pure. No network, no database.
 *
 * **The invariant.** If AR-421 is due on 20 October, the calendar says so
 * because the invoice says so. Dragging the event must not quietly rewrite the
 * invoice — a due date changed on a calendar screen is a payment term changed
 * without an approval, a customer never told, and an audit trail that leads
 * nowhere. So a projection here carries no mutation path at all: asking to move
 * one returns a redirect to the workflow that owns the date, and nothing else.
 *
 * That is the same rule the billing records already follow — reference the
 * evidence, do not copy it — applied to dates instead of amounts.
 *
 * **Company events are three different things** that happen to share a
 * calendar. A Christmas party is informational. A safety stand-down needs an
 * acknowledgement from each person. A payroll cutoff produces work somebody has
 * to complete. Treating them alike is how a mandatory acknowledgement ends up
 * with the same weight as a social invitation.
 */

import type { EventSource, Severity } from "./calendarProjection";

/* ------------------------------------------------------------------ */
/* Money                                                                */
/* ------------------------------------------------------------------ */

export type FinancialKind =
  | "ap_invoice_received" | "ap_approval_due" | "ap_payment_run" | "ap_payment_scheduled"
  | "ar_invoice_sent" | "ar_payment_due" | "ar_overdue" | "ar_follow_up"
  | "payroll_cutoff" | "payday" | "t4_target" | "remittance_due";

/** Which record owns the date. The calendar never does. */
export type DateOwner = "vendorBill" | "customerInvoice" | "payrollPeriod" | "taxFiling";

export type FinancialProjection = {
  kind: FinancialKind;
  /** Read from the owning record, never edited here. */
  at: Date;
  label: string;
  amountCents: number | null;
  counterparty: string | null;
  severity: Severity;
  owner: DateOwner;
  source: EventSource;
  /** Structurally. There is no shape of this type that can be written back. */
  readOnly: true;
};

export function projectFinancial(input: Omit<FinancialProjection, "readOnly">): FinancialProjection {
  return { ...input, readOnly: true };
}

export type DateChangeRedirect = {
  applied: false;
  owner: DateOwner;
  sourceRef: string;
  /** The workflow that may actually change it, named rather than implied. */
  workflow: string;
  reason: string;
};

const WORKFLOW: Record<DateOwner, string> = {
  vendorBill: "accounts payable — revise the bill's terms",
  customerInvoice: "accounts receivable — issue a revised invoice or record an agreed extension",
  payrollPeriod: "payroll configuration — change the period calendar",
  taxFiling: "tax configuration — the filing deadline is not ours to move",
};

/**
 * Somebody tried to move a date on the calendar.
 *
 * Never applies it. The redirect names the workflow that can, because "you
 * cannot do that here" without saying where is how people end up changing the
 * number in a spreadsheet instead.
 */
export function requestDateChange(projection: FinancialProjection): DateChangeRedirect {
  return {
    applied: false,
    owner: projection.owner,
    sourceRef: projection.source.sourceRef,
    workflow: WORKFLOW[projection.owner],
    reason: `${projection.source.sourceRef} owns this date. The calendar shows it; it does not hold it. Change it through ${WORKFLOW[projection.owner]}.`,
  };
}

export type AgeingBand = "current" | "due_soon" | "overdue_1_30" | "overdue_31_60" | "overdue_61_plus";

/** Ageing for a receivable, from its own due date. */
export function ageing(dueAt: Date, now: Date): { band: AgeingBand; daysOverdue: number } {
  const days = Math.floor((now.getTime() - dueAt.getTime()) / 86_400_000);
  if (days < -7) return { band: "current", daysOverdue: 0 };
  if (days < 0) return { band: "due_soon", daysOverdue: 0 };
  if (days <= 30) return { band: "overdue_1_30", daysOverdue: days };
  if (days <= 60) return { band: "overdue_31_60", daysOverdue: days };
  return { band: "overdue_61_plus", daysOverdue: days };
}

/* ------------------------------------------------------------------ */
/* Company events                                                       */
/* ------------------------------------------------------------------ */

export type EventClass = "informational" | "requires_acknowledgement" | "produces_task";

export type CompanyEvent = {
  eventRef: string;
  title: string;
  at: Date;
  endsAt: Date | null;
  eventClass: EventClass;
  audience: "company" | "branch" | "crew";
  audienceRef: string | null;
  source: EventSource;
  /** Only meaningful where the class demands it. */
  acknowledgementDueBy: Date | null;
  taskTemplate: string | null;
};

export type EventObligation =
  | { obligation: "none"; note: string }
  | { obligation: "acknowledge"; dueBy: Date | null; outstanding: boolean; note: string }
  | { obligation: "task"; template: string; note: string };

/**
 * What an event actually asks of a person.
 *
 * A social invitation asks nothing and should not be dressed as compliance; a
 * safety stand-down asks for a name against it. The class decides, and an event
 * declaring itself acknowledgement-requiring without a way to acknowledge is a
 * configuration error rather than something to paper over.
 */
export function obligationOf(event: CompanyEvent, acknowledgedBy: readonly number[], userId: number): EventObligation {
  switch (event.eventClass) {
    case "informational":
      return { obligation: "none", note: `${event.title} is informational. Nothing is required.` };
    case "requires_acknowledgement": {
      const outstanding = !acknowledgedBy.includes(userId);
      return {
        obligation: "acknowledge", dueBy: event.acknowledgementDueBy, outstanding,
        note: outstanding
          ? `${event.title} needs your acknowledgement${event.acknowledgementDueBy ? ` by ${event.acknowledgementDueBy.toISOString().slice(0, 10)}` : ""}`
          : `${event.title} — acknowledged`,
      };
    }
    case "produces_task":
      return {
        obligation: "task",
        template: event.taskTemplate ?? "unspecified",
        note: `${event.title} raises work to complete, not a note to read`,
      };
  }
}

export class EventMisconfigured extends Error {}

/**
 * Refuse an event that cannot do what its class claims.
 *
 * An acknowledgement-requiring event nobody can acknowledge, or a task event
 * with no task, is worse than an informational one: it reports compliance that
 * was never possible.
 */
export function validateEvent(event: CompanyEvent): void {
  if (event.eventClass === "produces_task" && !event.taskTemplate) {
    throw new EventMisconfigured(`${event.eventRef} says it produces a task and names none`);
  }
  if (event.audience !== "company" && !event.audienceRef) {
    throw new EventMisconfigured(`${event.eventRef} is scoped to a ${event.audience} and names none`);
  }
  if (event.endsAt && event.endsAt.getTime() < event.at.getTime()) {
    throw new EventMisconfigured(`${event.eventRef} ends before it begins`);
  }
}

/** Who this event reaches, from the audience it declares. */
export function reaches(event: CompanyEvent, person: { branchId: string | null; crewRef: string | null }): boolean {
  if (event.audience === "company") return true;
  if (event.audience === "branch") return person.branchId === event.audienceRef;
  return person.crewRef === event.audienceRef;
}
