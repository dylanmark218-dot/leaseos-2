/**
 * P4.2 — what a calibration certifies, and what a failure finding un-certifies.
 *
 * Two questions, and the second is the one that costs money.
 *
 *   **Forwards:** what stands behind this weight? An auditor asking why a number was treated as a
 *   legal axle determination needs the event that certified the device, the standard it was checked
 *   against, the tolerance stated, and how good the fit was — not a boolean.
 *
 *   **Backwards:** a device found out of tolerance in September was not fine until September. The
 *   finding carries `suspectFrom` — the date from which the readings are in question — and every
 *   determination taken in that window is now a determination nobody can stand behind. Somebody has
 *   to be told which loads and which invoices those were, and "the scale was bad, check everything"
 *   is not an answer anyone can act on.
 *
 * What this deliberately does **not** do: rewrite the stored verdict on those snapshots. The
 * determination was made in good faith on the evidence then available, and that fact is part of the
 * record — `0159` stores it for exactly this reason. A failure finding adds a second fact beside
 * the first. Overwriting would destroy the answer to "what did we believe, and on what basis?",
 * which is the question asked when somebody wants to know whether this was negligence or bad luck.
 */

export type CalibrationEventType =
  | "calibrated" | "verified" | "failed" | "adjusted" | "out_of_tolerance_found" | "returned_to_service";

export type CalibrationEvent = {
  id: number;
  measurementDeviceId: number;
  eventType: CalibrationEventType;
  performedAt: Date;
  performedBy: string | null;
  standardReference: string | null;
  toleranceStated: string | null;
  errorFound: string | null;
  /** Set on a failure finding: from when are the readings in question? */
  suspectFrom: Date | null;
  validUntil: Date | null;
  certificateEvidenceId: number | null;
};

export type CalibrationModel = {
  id: number;
  modelRef: string;
  calibrationEventId: number | null;
  slope: number;
  interceptOffset: number;
  pointCount: number;
  rSquared: number | null;
  status: string;
  effectiveAt: Date;
  invalidatedAt: Date | null;
};

/* ------------------------------------------------------------------ */
/* Forwards — what stands behind a weight                              */
/* ------------------------------------------------------------------ */

export type CalibrationEvidence = {
  modelRef: string;
  /** In force at the moment of the reading — not merely the newest model on the device. */
  inForceAtReading: boolean;
  certifiedBy: string | null;
  standardReference: string | null;
  toleranceStated: string | null;
  performedAt: Date | null;
  validUntil: Date | null;
  fit: { pointCount: number; rSquared: number | null; quality: "strong" | "adequate" | "weak" | "unstated" };
  /** One line a person reads. Never a score on its own. */
  summary: string;
  /** What is missing from the evidence, named. An auditor needs the gaps, not a tidy paragraph. */
  gaps: readonly string[];
};

/**
 * How good the fit is, in words.
 *
 * Two points and a perfect r² is not a strong calibration — it is a line through two points, which
 * fits perfectly by construction. Reporting `rSquared: 1.0` without the point count is how a
 * two-point check comes to look like a twelve-point one.
 */
export function fitQuality(pointCount: number, rSquared: number | null): CalibrationEvidence["fit"]["quality"] {
  if (rSquared == null) return "unstated";
  if (pointCount < 3) return "weak";
  if (rSquared >= 0.99 && pointCount >= 5) return "strong";
  if (rSquared >= 0.97) return "adequate";
  return "weak";
}

export function projectCalibrationEvidence(args: {
  model: CalibrationModel;
  event: CalibrationEvent | null;
  readingAt: Date;
}): CalibrationEvidence {
  const { model: m, event: e } = args;
  const inForce =
    m.status === "active" &&
    m.effectiveAt <= args.readingAt &&
    (m.invalidatedAt == null || m.invalidatedAt > args.readingAt) &&
    (e?.validUntil == null || e.validUntil > args.readingAt);

  const quality = fitQuality(m.pointCount, m.rSquared);
  const gaps: string[] = [];
  if (!e) gaps.push("no calibration event is linked to this model, so nothing records who certified the device or against what");
  if (e && !e.standardReference) gaps.push("no standard reference recorded — what the device was checked against is unstated");
  if (e && !e.toleranceStated) gaps.push("no tolerance stated, so 'within tolerance' has no number behind it");
  if (m.rSquared == null) gaps.push("no fit statistic recorded");
  if (m.pointCount < 3) gaps.push(`only ${m.pointCount} calibration point(s): a line through two points fits perfectly by construction and proves nothing`);
  if (!inForce) gaps.push("this model was not in force at the moment of the reading");

  return {
    modelRef: m.modelRef,
    inForceAtReading: inForce,
    certifiedBy: e?.performedBy ?? null,
    standardReference: e?.standardReference ?? null,
    toleranceStated: e?.toleranceStated ?? null,
    performedAt: e?.performedAt ?? null,
    validUntil: e?.validUntil ?? null,
    fit: { pointCount: m.pointCount, rSquared: m.rSquared, quality },
    summary: `${m.modelRef}: ${m.pointCount}-point fit (${quality})${e?.performedBy ? `, certified by ${e.performedBy}` : ""}${e?.standardReference ? ` against ${e.standardReference}` : ""}${inForce ? "" : " — NOT in force at this reading"}.`,
    gaps,
  };
}

/* ------------------------------------------------------------------ */
/* Backwards — what a failure finding calls into question              */
/* ------------------------------------------------------------------ */

export type SuspectWindow = { from: Date; to: Date; because: string } | null;

/**
 * The window a failure finding opens.
 *
 * `to` is the finding itself: readings after it are governed by whatever happened next (an
 * adjustment, a return to service), not by this window. `from` is the person's stated
 * `suspectFrom`, never inferred — how far back a drift reaches is a judgement made by whoever
 * examined the device, and a system that guessed it would be inventing the one number that decides
 * how many invoices are reopened.
 */
export function suspectWindow(event: CalibrationEvent): SuspectWindow {
  if (event.eventType !== "failed" && event.eventType !== "out_of_tolerance_found") return null;
  if (!event.suspectFrom) return null;   // refused at write time; belt and braces here
  return {
    from: event.suspectFrom,
    to: event.performedAt,
    because: `${event.eventType.replace(/_/g, " ")} on ${event.performedAt.toISOString().slice(0, 10)}${event.errorFound ? ` (${event.errorFound})` : ""}, suspect from ${event.suspectFrom.toISOString().slice(0, 10)} as stated by whoever examined the device`,
  };
}

export type SnapshotRef = {
  snapshotRef: string;
  measuredAt: Date;
  measurementDeviceId: number | null;
  legalDetermination: boolean | null;
  loadId: number | null;
};

export type SweepResult = {
  window: SuspectWindow;
  /** Determinations taken inside the window: these are the ones nobody can now stand behind. */
  determinationsInQuestion: readonly SnapshotRef[];
  /** Readings inside the window that were never determinations — listed, but not the same problem. */
  measurementsInQuestion: readonly SnapshotRef[];
  explanation: string;
};

/**
 * Which readings a failure finding calls into question.
 *
 * The two lists are kept apart because they need different work. A reading that was already **not**
 * a legal determination was never relied on as one — it is worth knowing about, and it does not
 * send anybody to reopen an invoice. Merging them would produce a list too long to act on, which in
 * practice means nobody acts on any of it.
 */
export function sweepSuspectReadings(event: CalibrationEvent, snapshots: readonly SnapshotRef[]): SweepResult {
  const window = suspectWindow(event);
  if (!window) {
    return {
      window: null, determinationsInQuestion: [], measurementsInQuestion: [],
      explanation: `${event.eventType.replace(/_/g, " ")} is not a failure finding with a stated suspect date; nothing is called into question by it.`,
    };
  }
  const inWindow = snapshots.filter(s =>
    s.measurementDeviceId === event.measurementDeviceId &&
    s.measuredAt >= window.from && s.measuredAt <= window.to);
  const determinations = inWindow.filter(s => s.legalDetermination === true);
  const measurements = inWindow.filter(s => s.legalDetermination !== true);

  return {
    window,
    determinationsInQuestion: determinations,
    measurementsInQuestion: measurements,
    explanation: determinations.length === 0
      ? `${window.because}. No legal axle determination was taken on this device in that window; ${measurements.length} other reading(s) fall inside it.`
      // Named counts and named loads: "the scale was bad, check everything" is not actionable.
      : `${window.because}. ${determinations.length} legal axle determination(s) were taken on this device inside that window and can no longer be stood behind: ${determinations.map(d => d.snapshotRef).join(", ")}. Their stored verdicts are left as they were — what was believed at the time is part of the record.`,
  };
}
