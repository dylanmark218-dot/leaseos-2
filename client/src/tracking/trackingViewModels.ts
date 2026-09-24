/**
 * 0175 — The tracking page's view-models: pure, so what a customer reads first is tested without
 * a browser. The page renders these and decides nothing itself.
 *
 * The inputs are the tracking API's own return shapes (dates may arrive as strings over the wire).
 */

export type Tone = "scheduled" | "moving" | "working" | "hold" | "attention" | "done" | "unknown";

const TONE: Record<string, Tone> = {
  Scheduled: "scheduled", Dispatched: "moving", "En Route": "moving", "On Location": "working", "In Progress": "working", "On Hold": "hold",
  Transporting: "moving", "At Disposal": "working", Returning: "moving", Attention: "attention", Completed: "done", Cancelled: "unknown", Unknown: "unknown",
};
export const toneOf = (label: string): Tone => TONE[label] ?? "unknown";

const asDate = (d: string | Date | null | undefined): Date | null => (d == null ? null : d instanceof Date ? d : new Date(d));

/** "13:05" in the reader's locale, or "—" when nothing is recorded. */
export function clock(d: string | Date | null | undefined, locale?: string): string {
  const x = asDate(d);
  return x ? x.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "—";
}
export function dayAndClock(d: string | Date | null | undefined, locale?: string): string {
  const x = asDate(d);
  return x ? x.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

/** Cents as "$1,234.50"; null is "—", never "$0.00" — an unpriced line is not a free one. */
export function money(cents: number | null | undefined, currency = "CAD"): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-CA", { style: "currency", currency });
}

export type TimelineRow = { step: string; reached: boolean; current: boolean; at: string };

/** The progress timeline: reached steps with their times, the current one marked, the rest ahead. */
export function timelineRows(timeline: readonly { step: string; reached: boolean; at: string | Date | null }[], currentLabel: string): TimelineRow[] {
  const lastReached = [...timeline].map((s, i) => (s.reached ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  return timeline.map((s, i) => ({ step: s.step, reached: s.reached, current: i === lastReached && currentLabel !== "Attention" && currentLabel !== "On Hold", at: clock(s.at) }));
}

export type LocationLine = { headline: string; detail: string | null; stale: boolean; coordinates: string | null };

/** What the page says about where the unit is. A stale fix says so in the headline. */
export function locationLine(loc: { mode: string; position: { latitude: number; longitude: number; precision: string } | null; recordedAt: string | Date | null; ageMinutes: number | null; stale: boolean; note: string }, eta: string | null): LocationLine {
  if (!loc.position) return { headline: eta ? `ETA ${eta}` : "Location not shared", detail: loc.note, stale: false, coordinates: null };
  const coords = `${loc.position.latitude.toFixed(loc.position.precision === "approximate" ? 2 : 5)}, ${loc.position.longitude.toFixed(loc.position.precision === "approximate" ? 2 : 5)}`;
  const when = loc.ageMinutes != null ? `${loc.ageMinutes} min ago` : clock(loc.recordedAt);
  if (loc.stale) return { headline: `Last known position — stale (${when})`, detail: "The position shown is not live. It is the last one recorded.", stale: true, coordinates: coords };
  return { headline: loc.position.precision === "approximate" ? `Approximate area · ${when}` : `Live position · ${when}`, detail: eta ? `ETA ${eta}` : null, stale: false, coordinates: coords };
}

export type LoadRow = { title: string; state: string; tone: Tone; lines: string[] };

const LOAD_STATE: Record<string, { label: string; tone: Tone }> = { completed: { label: "Completed", tone: "done" }, at_disposal: { label: "At disposal", tone: "working" }, in_transit: { label: "In transit", tone: "moving" }, picked_up: { label: "Picked up", tone: "working" }, in_progress: { label: "In progress", tone: "scheduled" } };

export function loadRows(items: readonly { sequence: number; loadNumber: string; status: string; pickedUpAt: string | Date | null; material: string | null; quantity: number | null; quantityUnit: string | null; measured: string; destination: string | null; disposalTicketNumber: string | null; disposalVerified: boolean }[]): LoadRow[] {
  return items.map(l => {
    const st = LOAD_STATE[l.status] ?? { label: l.status, tone: "unknown" as Tone };
    const lines: string[] = [];
    if (l.pickedUpAt) lines.push(`Picked up ${clock(l.pickedUpAt)}`);
    if (l.quantity != null) lines.push(`${l.quantity} ${l.quantityUnit ?? ""} ${l.material ?? ""} (${l.measured})`.replace(/\s+/g, " ").trim());
    else if (l.material) lines.push(`${l.material} — quantity not recorded`);
    if (l.destination) lines.push(`To ${l.destination}`);
    if (l.disposalTicketNumber) lines.push(`Disposal ticket ${l.disposalTicketNumber}${l.disposalVerified ? " · verified" : " · on file, not yet verified"}`);
    return { title: `Load ${l.sequence}`, state: st.label, tone: st.tone, lines };
  });
}

export function loadsSummary(l: { total: number; completed: number; active: number }): string {
  return l.total === 0 ? "No loads yet" : `${l.total} total · ${l.completed} completed · ${l.active} active`;
}

export type TicketLineRow = { description: string; quantity: string; amount: string; decision: "accepted" | "disputed" | "pending"; detail: string | null };

/** The open ticket as the customer reads it: lines, then one clearly labelled figure per stage. */
export function ticketView(t: { ticketNumber: string; status: string; customerPoNumber: string | null; lines: readonly { description: string; quantity: number | null; unit: string | null; amountCents: number | null; priced: boolean; decision: "accepted" | "disputed" | "pending"; load: string | null; amendment: boolean }[]; accrued: { subtotalCents: number; pricedLines: number; unpricedLines: number; label: string }; finalized: { totalCents: number; at: string | Date; label: string } | null; invoiced: { invoiceNumber: string; status: string; subtotalCents: number; taxCents: number; totalCents: number } | null; actions: { acknowledge: boolean; approve: boolean; dispute: boolean; comment: boolean; sign: boolean } }) {
  const statusLabel: Record<string, string> = { DRAFT: "Draft", OPEN: "Open", AWAITING_CUSTOMER_REVIEW: "Ready for your review", CUSTOMER_ACCEPTED: "Accepted", DISPUTED: "Disputed", FINALIZED: "Finalized", INVOICED: "Invoiced", VOID: "Void" };
  return {
    ticketNumber: t.ticketNumber,
    status: statusLabel[t.status] ?? t.status,
    po: t.customerPoNumber,
    lines: t.lines.map((l): TicketLineRow => ({ description: `${l.amendment ? "Amendment: " : ""}${l.description}`, quantity: l.quantity != null ? `${l.quantity} ${l.unit ?? ""}`.trim() : "", amount: l.priced ? money(l.amountCents) : "not yet priced", decision: l.decision, detail: l.load ? `Load ${l.load}` : null })),
    figures: [
      ...(t.invoiced ? [{ label: `Invoice ${t.invoiced.invoiceNumber} (${t.invoiced.status})`, value: money(t.invoiced.totalCents), sub: `Subtotal ${money(t.invoiced.subtotalCents)} · Tax ${money(t.invoiced.taxCents)}`, kind: "invoice" as const }] : []),
      ...(t.finalized ? [{ label: t.finalized.label, value: money(t.finalized.totalCents), sub: `Finalized ${dayAndClock(t.finalized.at)}`, kind: "final" as const }] : []),
      { label: t.accrued.label, value: money(t.accrued.subtotalCents), sub: `${t.accrued.pricedLines} priced line(s)${t.accrued.unpricedLines ? ` · ${t.accrued.unpricedLines} not yet priced` : ""}`, kind: "estimate" as const },
    ],
    actions: t.actions,
    reviewable: t.actions.approve || t.actions.dispute,
  };
}

/** The line under the job number: "Hydrovac excavation · from 10-22-045-06-W5 · to Edson TRD". */
export function routeLine(v: { serviceType: string; origin: string; destination: string | null }): string {
  return [v.serviceType, `from ${v.origin}`, v.destination ? `to ${v.destination}` : null].filter(Boolean).join(" · ");
}

/** Why the page cannot be shown, in the recipient's words. The server's reason is passed through when it names one. */
export function refusalMessage(message: string | null): { headline: string; detail: string } {
  const m = message ?? "";
  if (/revoked/i.test(m)) return { headline: "This link has been revoked", detail: "Ask the contractor for a current link." };
  if (/expired/i.test(m)) return { headline: "This link has expired", detail: "Ask the contractor for a current link." };
  if (/replaced/i.test(m)) return { headline: "This link was replaced", detail: "A newer link was issued; ask the contractor for it." };
  if (/access limit/i.test(m)) return { headline: "This link has reached its limit", detail: "Ask the contractor for a current link." };
  if (/disabled/i.test(m)) return { headline: "This link is paused", detail: "The contractor has paused it; ask them to re-enable it." };
  return { headline: "This link cannot be opened", detail: "It may be incomplete or no longer valid. Ask the contractor for a current link." };
}
