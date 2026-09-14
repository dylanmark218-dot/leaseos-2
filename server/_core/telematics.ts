/**
 * Telematics — the engines.
 *
 * An odometer from the truck is reconciled against the trips and the shop,
 * not trusted over them. A fault code's severity is a rule; with no verified
 * rule it is unknown, and an active fault is REVIEW — never clear, never
 * BLOCKED by itself; a mechanic's acknowledgement makes it a defect with the
 * severity the mechanic determined. A driving event is reviewed by a
 * person; no number is computed about a driver.
 */

export type Reconciliation = { telemetryKm: number | null; tripsKm: number | null; lastShopKm: number | null; findings: string[]; determination: "consistent" | "discrepancy" | "unknown" };

export function odometerReconciliation(args: { telemetryKm: number | null; telemetryAt: Date | null; tripsKmSum: number | null; lastShopKm: number | null; lastShopAt: Date | null; tolerancePct?: number }): Reconciliation {
  const tol = args.tolerancePct ?? 3;
  const f: string[] = [];
  if (args.telemetryKm == null) f.push("No telemetry odometer on record");
  if (args.lastShopKm != null && args.telemetryKm != null) {
    if (args.telemetryKm < args.lastShopKm) f.push(`Telemetry ${args.telemetryKm} km is below the shop's last reading ${args.lastShopKm} km — a rolled-back or swapped unit; REVIEW`);
    else if (args.lastShopAt && args.telemetryAt && args.telemetryAt < args.lastShopAt) f.push("Telemetry is older than the shop's last reading — not current");
  }
  if (args.tripsKmSum != null && args.telemetryKm != null && args.lastShopKm != null && args.telemetryKm >= args.lastShopKm) {
    const since = args.telemetryKm - args.lastShopKm;
    const diff = Math.abs(since - args.tripsKmSum);
    const base = Math.max(since, args.tripsKmSum, 1);
    if (diff / base * 100 > tol) f.push(`Trips since the shop reading account for ${args.tripsKmSum} km; telemetry advanced ${since} km — ${Math.round(diff)} km apart (${Math.round(diff / base * 100)}%, tolerance ${tol}%)`);
  }
  const determination: Reconciliation["determination"] = args.telemetryKm == null ? "unknown" : f.length ? "discrepancy" : "consistent";
  return { telemetryKm: args.telemetryKm, tripsKm: args.tripsKmSum, lastShopKm: args.lastShopKm, findings: f, determination };
}

export type FaultRule = { severity: "advisory" | "inspection_required" | "critical"; source: string } | null;

/** What an active fault means for dispatch. Unknown severity is REVIEW with the reason; only a person's determination blocks. */
export function faultDispatchEffect(f: { status: string; severityDetermination: string; code: string; occurrenceCount: number }): { severity: "blocking" | "review" | "unknown" | null; label: string } {
  if (f.status === "cleared") return { severity: null, label: "" };
  if (f.status === "acknowledged") {
    if (f.severityDetermination === "critical") return { severity: "blocking", label: `Fault ${f.code} acknowledged as critical — mechanic release required` };
    if (f.severityDetermination === "inspection_required") return { severity: "review", label: `Fault ${f.code} acknowledged — inspection required` };
    return { severity: null, label: "" };
  }
  return { severity: "unknown", label: `Fault ${f.code} active (${f.occurrenceCount}×), severity not determined — no verified fault rule; a mechanic decides` };
}

export function reviewDecision(args: { current: string; decision: "coached" | "dismissed" | "escalated"; note: string; hasVideo: boolean; videoViewedByReviewer: boolean }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.current !== "unreviewed") r.push(`Event is already ${args.current} — a review is not redone; a second opinion is a note`);
  if (args.note.trim().length < 10) r.push("A review needs a note a colleague can read");
  if (args.hasVideo && !args.videoViewedByReviewer && args.decision !== "escalated") r.push("Video is attached and was not viewed — coach or dismiss only after viewing; escalation may proceed");
  return { permitted: r.length === 0, refusals: r };
}

/** A queue, not a leaderboard: unreviewed events, oldest first, grouped by unit; nothing per driver is summed. */
export function reviewQueue(events: readonly { eventRef: string; unitId: number; kind: string; recordedAt: Date; reviewStatus: string; hasVideo: boolean }[]): { unitId: number; count: number; oldest: Date; kinds: string[]; withVideo: number }[] {
  const by = new Map<number, { unitId: number; count: number; oldest: Date; kinds: Set<string>; withVideo: number }>();
  for (const e of events) {
    if (e.reviewStatus !== "unreviewed") continue;
    const g = by.get(e.unitId) ?? { unitId: e.unitId, count: 0, oldest: e.recordedAt, kinds: new Set<string>(), withVideo: 0 };
    g.count++; g.kinds.add(e.kind); if (e.recordedAt < g.oldest) g.oldest = e.recordedAt; if (e.hasVideo) g.withVideo++;
    by.set(e.unitId, g);
  }
  return Array.from(by.values()).map(g => ({ unitId: g.unitId, count: g.count, oldest: g.oldest, kinds: Array.from(g.kinds).sort(), withVideo: g.withVideo })).sort((a, b) => a.oldest.getTime() - b.oldest.getTime());
}
