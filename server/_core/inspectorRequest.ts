/**
 * Inspector requests for training records — TDG s.6.7.
 *
 * Pure and DB-free. The router loads the rows and calls these.
 *
 * WHAT THE SECTION REQUIRES
 *
 * On a written request from an inspector, the employer must provide, within
 * 15 days: a copy of the training certificate; if applicable, a copy of the
 * record of training or the statement of experience; and a description of the
 * training material used in the person's training.
 *
 * The retention guards keep that evidence alive. This assembles it. A guard
 * without a retrieval path is half a control — the records survive and nobody
 * can produce them inside the window.
 *
 * ANCHOR DATE — CONFIRM BEFORE RELYING ON THE CLOCK
 *
 * The 15 days run from the request. Whether that is the date the inspector made
 * it or the date the employer received it changes the deadline, sometimes by
 * days. `requestReceivedAt` is modelled separately from `requestDatedAt` and the
 * clock runs from the later of the two, which is the conservative reading — but
 * confirm the anchor against the regulation text before this is depended on, and
 * record the source on the regulatory profile.
 */

export const INSPECTOR_RESPONSE_DAYS = 15;

export type InspectorRequest = {
  requestRef: string;
  /** Date on the inspector's written request. */
  requestDatedAt: Date;
  /** Date the employer actually received it. */
  requestReceivedAt: Date | null;
  subjectUserId: number;
  certificateRef: string;
};

/**
 * Deadline, and how much of the window is left.
 *
 * Runs from the later of dated and received. If the received date is unknown the
 * clock runs from the request date — the earlier, tighter deadline — because
 * assuming late receipt would quietly extend a statutory window.
 */
export function responseDeadline(req: InspectorRequest, asOf: Date) {
  const dated = req.requestDatedAt.getTime();
  const received = req.requestReceivedAt?.getTime() ?? dated;
  const anchor = new Date(Math.max(dated, received));
  const dueAt = new Date(anchor.getTime());
  dueAt.setUTCDate(dueAt.getUTCDate() + INSPECTOR_RESPONSE_DAYS);

  const msLeft = dueAt.getTime() - asOf.getTime();
  const daysRemaining = Math.floor(msLeft / 86_400_000);
  return {
    anchoredOn: req.requestReceivedAt && received > dated ? ("received" as const) : ("dated" as const),
    dueAt,
    daysRemaining,
    overdue: msLeft < 0,
    /** Surfaces in the exception centre from five days out, and immediately once overdue. */
    urgent: msLeft < 0 || daysRemaining <= 5,
  };
}

export type PackagePart =
  | "training_certificate"
  | "record_of_training"
  | "statement_of_experience"
  | "training_material_description";

export type AvailableEvidence = {
  certificatePresent: boolean;
  /** The assessment attempt(s) behind the certificate. */
  recordOfTrainingPresent: boolean;
  statementOfExperiencePresent: boolean;
  /**
   * Content blocks still resolvable for the course version the certificate names.
   * Zero means the material is gone, which for a certificate issued before the
   * retention guards existed is entirely possible.
   */
  contentBlockCount: number;
  courseVersionPresent: boolean;
  /** Certificates issued before the retention chain guards were installed. */
  predatesRetentionGuards: boolean;
};

export type PackageDecision = {
  complete: boolean;
  parts: PackagePart[];
  missing: { part: PackagePart; code: string; message: string }[];
  /**
   * True when the package is incomplete and the evidence cannot be recovered —
   * the response to the inspector has to say so rather than arrive looking whole.
   */
  irrecoverable: boolean;
};

/**
 * Decide what can be produced and what cannot.
 *
 * Never returns a partial package as if it were complete. s.6.6 requires the
 * record of training OR the statement of experience, so either satisfies that
 * part; the certificate and the material description have no alternative.
 */
export function assembleInspectorPackage(ev: AvailableEvidence): PackageDecision {
  const parts: PackagePart[] = [];
  const missing: PackageDecision["missing"] = [];

  if (ev.certificatePresent) parts.push("training_certificate");
  else missing.push({
    part: "training_certificate",
    code: "INSPECTOR_PACKAGE_NO_CERTIFICATE",
    message: "No training certificate is on file for this request. s.6.7 has no alternative to it.",
  });

  // 6.6 phrases these as alternatives: the record of training or the statement
  // of experience. Either satisfies the obligation; both is better.
  if (ev.recordOfTrainingPresent) parts.push("record_of_training");
  if (ev.statementOfExperiencePresent) parts.push("statement_of_experience");
  if (!ev.recordOfTrainingPresent && !ev.statementOfExperiencePresent) {
    missing.push({
      part: "record_of_training",
      code: "INSPECTOR_PACKAGE_NO_TRAINING_RECORD",
      message: "Neither a record of training nor a statement of experience is on file. One of the two is required.",
    });
  }

  if (ev.courseVersionPresent && ev.contentBlockCount > 0) {
    parts.push("training_material_description");
  } else {
    missing.push({
      part: "training_material_description",
      code: ev.courseVersionPresent
        ? "INSPECTOR_PACKAGE_NO_TRAINING_MATERIAL"
        : "INSPECTOR_PACKAGE_NO_COURSE_VERSION",
      message: ev.courseVersionPresent
        ? "The course version is on file but none of its content remains, so no description of the training material can be produced."
        : "The course version this certificate names is no longer on file, so the training material cannot be described.",
    });
  }

  const materialGone = missing.some(m => m.part === "training_material_description");

  return {
    complete: missing.length === 0,
    parts,
    missing,
    // Anything lost before the guards were in place is gone for good; there is no
    // recovery path, and the reply has to state that rather than imply a delay.
    irrecoverable: missing.length > 0 && ev.predatesRetentionGuards && materialGone,
  };
}

/** One line for the exception centre. Names the deadline, not just the state. */
export function inspectorRequestSummary(req: InspectorRequest, ev: AvailableEvidence, asOf: Date): string {
  const d = responseDeadline(req, asOf);
  const p = assembleInspectorPackage(ev);
  const when = d.overdue
    ? `overdue by ${Math.abs(d.daysRemaining)} day${Math.abs(d.daysRemaining) === 1 ? "" : "s"}`
    : `${d.daysRemaining} day${d.daysRemaining === 1 ? "" : "s"} left`;
  return p.complete
    ? `${req.requestRef}: package ready, ${when} (due ${d.dueAt.toISOString().slice(0, 10)})`
    : `${req.requestRef}: ${p.missing.length} item(s) missing, ${when} — ${p.missing.map(m => m.code).join(", ")}`;
}
