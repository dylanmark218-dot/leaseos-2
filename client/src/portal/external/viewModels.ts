/**
 * The customer portal's view-models — pure, so the decisions about what a
 * customer sees first are tested without a browser. The shell renders these.
 */

export type OperationalState = "EN_ROUTE" | "ARRIVED" | "ON_LOCATION" | "WORKING" | "LOADING" | "UNLOADING" | "DISPOSAL" | "STANDBY" | "CUSTOMER_HOLD" | "WEATHER_HOLD" | "BREAKDOWN" | "INCIDENT" | "COMPLETE" | "UNKNOWN";

export type JobBoardTicket = { ticketNumber: string; jobCode: string | null; site: string | null; unitId: number | null; operational: { state: OperationalState; basis: string; since: string | Date | null }; arrivalAt: string | Date | null; siteCloseAt: string | Date | null; loads: { completed: number; total: number }; material: { material: string; quantity: number; unit: string }[]; delays: { count: number; hours: number; billing: "review" | "per_ticket" | "none" }; underReview: number; closeout: string; invoiceReady: boolean };

export const STATE_TONE: Record<OperationalState, "working" | "hold" | "attention" | "done" | "unknown" | "moving"> = {
  WORKING: "working", LOADING: "working", UNLOADING: "working", DISPOSAL: "working",
  STANDBY: "hold", CUSTOMER_HOLD: "hold", WEATHER_HOLD: "hold",
  BREAKDOWN: "attention", INCIDENT: "attention",
  COMPLETE: "done", EN_ROUTE: "moving", ARRIVED: "moving", ON_LOCATION: "moving", UNKNOWN: "unknown",
};

/** Order the board the way a supervisor scans it: attention first, then working, holds, moving, unknown, complete last. */
export function boardOrder(tickets: readonly JobBoardTicket[]): JobBoardTicket[] {
  const rank: Record<ReturnType<typeof toneOf>, number> = { attention: 0, working: 1, hold: 2, moving: 3, unknown: 4, done: 5 };
  return [...tickets].sort((a, b) => rank[toneOf(a)] - rank[toneOf(b)] || a.ticketNumber.localeCompare(b.ticketNumber));
}
export const toneOf = (t: JobBoardTicket) => STATE_TONE[t.operational.state];

export function boardSummary(tickets: readonly JobBoardTicket[]): { active: number; needingAttention: number; onHold: number; complete: number; unknown: number; loadsCompleted: number; delayHours: number; awaitingSignature: number; invoiceReady: number } {
  const tone = (x: string) => tickets.filter(t => toneOf(t) === x).length;
  return { active: tone("working") + tone("moving"), needingAttention: tone("attention"), onHold: tone("hold"), complete: tone("done"), unknown: tone("unknown"), loadsCompleted: tickets.reduce((a, t) => a + t.loads.completed, 0), delayHours: Math.round(tickets.reduce((a, t) => a + t.delays.hours, 0) * 100) / 100, awaitingSignature: tickets.filter(t => t.closeout === "SITE_CLOSE_PENDING").length, invoiceReady: tickets.filter(t => t.invoiceReady).length };
}

/** What the customer reads on a state chip: the state and, when it is UNKNOWN, why — never a guess dressed as a fact. */
export function stateLabel(op: JobBoardTicket["operational"]): string {
  const name = op.state.replace(/_/g, " ").toLowerCase().replace(/^\w/, c => c.toUpperCase());
  return op.state === "UNKNOWN" ? `Unknown — ${op.basis}` : name;
}

/* ---- pre-clearance ---- */
export type ReadinessProjection = { verdict: "READY" | "REVIEW" | "BLOCKED" | "UNKNOWN"; items: { subject: "worker" | "unit" | "trailer" | "job"; verdict: "REVIEW" | "BLOCKED" | "UNKNOWN"; category: string }[] };

export function clearanceView(p: ReadinessProjection): { headline: string; rows: { subject: string; verdict: string; category: string }[]; action: string | null } {
  const headline = p.verdict === "READY" ? "Crew and unit are cleared for this work" : p.verdict === "BLOCKED" ? "Not ready — the contractor must resolve the items below" : p.verdict === "REVIEW" ? "Under review by the contractor" : "Readiness unknown — the contractor has not established it";
  return { headline, rows: p.items.map(i => ({ subject: i.subject, verdict: i.verdict, category: i.category })), action: p.verdict === "BLOCKED" ? "Ask the contractor to resolve, or request a replacement" : null };
}

/* ---- sign-off review ---- */
export type SignOffReview = { ticketNumber: string; siteBillableHours: number; standbyHours: number; standbyBillable: "yes" | "no" | "review"; loads: number; lines: { id: number; lineKind: string; description: string; quantity: number | null; unit: string | null }[]; excluded: { what: string }[]; postSiteRequired: boolean; authoritiesAvailable: string[] };

/** What the signer reviews, in the order the document lists it, and what the signature will NOT cover. */
export function signOffModel(r: SignOffReview): { sections: { title: string; rows: string[] }[]; signatureCovers: string[]; signatureDoesNotCover: string[]; postSiteNote: string | null } {
  return {
    sections: [
      { title: "Site work", rows: [`Site billable time ${r.siteBillableHours.toFixed(2)} h`, `Standby ${r.standbyHours.toFixed(2)} h — ${r.standbyBillable === "review" ? "billing under contract review" : r.standbyBillable === "yes" ? "billable per contract" : "not billable"}`, `Loads ${r.loads}`] },
      { title: "Lines", rows: r.lines.map(l => `${l.lineKind}: ${l.description}${l.quantity != null ? ` — ${l.quantity} ${l.unit ?? ""}` : ""}`) },
      { title: "Excluded from this ticket", rows: r.excluded.length ? r.excluded.map(x => x.what) : ["Nothing excluded on this revision"] },
    ],
    signatureCovers: r.authoritiesAvailable.map(a => a.replace(/_/g, " ")),
    signatureDoesNotCover: ["Post-trip inspection, restocking, washout, fuelling, internal paperwork — the contractor's clock, never billed", r.postSiteRequired ? "The post-site disposal or travel time itself — you sign the BASIS it may be billed on, not a future number" : "Any work after the site closes"],
    postSiteNote: r.postSiteRequired ? "Disposal is required after the site closes: your signature authorizes the billing basis; the final revision (R2) follows with the evidence." : null,
  };
}

/* ---- adjustments ---- */
export function adjustmentPreview(a: { kind: string; amountCents?: number; percent?: number; hourEquivalent?: number; agreedHourlyRateCents?: number | null; siteSubtotalCents?: number }): { amountCents: number | null; note: string } {
  if (a.kind === "hour_equivalent") return a.agreedHourlyRateCents ? { amountCents: Math.round((a.hourEquivalent ?? 0) * a.agreedHourlyRateCents), note: `${(a.hourEquivalent ?? 0).toFixed(2)} hour-equivalent at the agreed rate — billing value, NOT worked time; no clock changes` } : { amountCents: null, note: "An hour-equivalent needs the agreed hourly rate; record a flat amount instead, or ask the contractor to price the ticket" };
  if (a.kind === "percent") return { amountCents: Math.round((a.siteSubtotalCents ?? 0) * (a.percent ?? 0) / 100), note: `${a.percent ?? 0}% of the site subtotal` };
  return { amountCents: a.amountCents ?? null, note: "A voluntary amount added to the ticket" };
}

/* ---- chain of custody ---- */
export type CustodyLoad = { loadNumber: string; material: string; quantity: number | null; unit: string | null; measurementMethod: string; chainState: string; unitId: number | null; destination: string | null; disposal: { facilityTicketNumber: string | null; evidence: "verified" | "rejected" | "needs_review" | "no_ticket_yet"; confidence: string | null; source: string } | null };

/** Quantity with its method — a number is never shown without how it was measured; evidence is the disposal ticket's state, never certified past it. */
export function custodyRows(loads: readonly CustodyLoad[]): { loadNumber: string; material: string; quantityText: string; route: string; evidenceText: string; evidenceTone: "ok" | "warn" | "muted" }[] {
  return loads.map(l => ({
    loadNumber: l.loadNumber, material: l.material,
    quantityText: l.quantity != null ? `${l.quantity} ${l.unit ?? ""} (${l.measurementMethod})` : `quantity not recorded (${l.measurementMethod})`,
    route: `Unit ${l.unitId ?? "-"} → ${l.destination ?? "destination not recorded"} · ${l.chainState.replace(/_/g, " ")}`,
    evidenceText: !l.disposal ? "No disposal ticket yet" : l.disposal.evidence === "verified" ? `Disposal ticket ${l.disposal.facilityTicketNumber ?? ""} verified (${l.disposal.confidence})` : l.disposal.evidence === "rejected" ? `Disposal ticket rejected — under review` : `Disposal ticket ${l.disposal.facilityTicketNumber ?? ""} on file, ${l.disposal.source} — awaiting the contractor's verification`,
    evidenceTone: l.disposal?.evidence === "verified" ? "ok" : l.disposal ? "warn" : "muted",
  }));
}

/* ---- approval queue ---- */
export function queueSummary(q: { toSign: unknown[]; toDecide: unknown[]; unreadAlerts: number }): string {
  const parts = [q.toSign.length ? `${q.toSign.length} ticket${q.toSign.length === 1 ? "" : "s"} to sign` : null, q.toDecide.length ? `${q.toDecide.length} line${q.toDecide.length === 1 ? "" : "s"} to decide` : null, q.unreadAlerts ? `${q.unreadAlerts} unread alert${q.unreadAlerts === 1 ? "" : "s"}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing awaits you";
}
