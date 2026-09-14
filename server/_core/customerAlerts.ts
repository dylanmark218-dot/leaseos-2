/**
 * Customer alerts — templates only, on the customer-safe event kinds.
 * A kind not listed here cannot be subscribed to, so nothing private has a
 * path to a customer's inbox. Everything defaults ON except the two that
 * can page a person at night; a customer turns anything off.
 */
import type { CUSTOMER_ALERT_KINDS } from "../../drizzle/schema";

export type AlertKind = (typeof CUSTOMER_ALERT_KINDS)[number];

export const DEFAULT_ON: Record<AlertKind, boolean> = { arrival: true, work_start: true, delay: true, breakdown: true, incident_notice: true, load_complete: false, disposal_complete: false, signoff_ready: true, r1_available: true, r2_available: true, document_ready: true, dispute_update: true, billing_update: true, job_complete: true };

export function alertText(kind: AlertKind, ctx: { ticketNumber: string; jobCode?: string | null; detail?: string | null }): { title: string; body: string; deepLink: string } {
  const where = ctx.jobCode ? `${ctx.jobCode} (${ctx.ticketNumber})` : ctx.ticketNumber;
  const t: Record<AlertKind, [string, string]> = {
    arrival: ["Crew arrived", `The crew has arrived on ${where}.`],
    work_start: ["Work started", `Work has started on ${where}.`],
    delay: ["Delay recorded", `A hold was recorded on ${where}${ctx.detail ? `: ${ctx.detail}` : ""}. Billing treatment is under review unless a contract rule decides it.`],
    breakdown: ["Work interrupted", `Work on ${where} is temporarily interrupted — mechanical event under review; replacement equipment being evaluated.`],
    incident_notice: ["Operational notice", `An operational event on ${where} is under review by the contractor.`],
    load_complete: ["Load completed", `A load on ${where} is complete.`],
    disposal_complete: ["Disposal completed", `A disposal on ${where} is complete and its ticket is on file.`],
    signoff_ready: ["Ticket ready to sign", `${where} is ready for your review and signature before the unit leaves site.`],
    r1_available: ["Signed ticket available", `The signed site ticket for ${where} (R1) is available to download.`],
    r2_available: ["Final ticket available", `The post-site revision for ${where} (R2) is available; R1 is unchanged.`],
    document_ready: ["Document ready", `A document for ${where} is ready to download.`],
    dispute_update: ["Dispute update", `Your dispute on ${where} has been updated${ctx.detail ? `: ${ctx.detail}` : ""}.`],
    billing_update: ["Billing update", `Billing on ${where} changed${ctx.detail ? `: ${ctx.detail}` : ""}.`],
    job_complete: ["Job complete", `${where} is complete and financially ready.`],
  };
  return { title: t[kind][0], body: t[kind][1], deepLink: `/customer?ticket=${encodeURIComponent(ctx.ticketNumber)}` };
}

export function wants(prefs: readonly { eventKind: AlertKind; enabled: boolean }[], kind: AlertKind): boolean {
  const p = prefs.find(x => x.eventKind === kind);
  return p ? p.enabled : DEFAULT_ON[kind];
}
