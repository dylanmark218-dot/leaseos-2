/**
 * s.6.2 topic coverage — vocabulary, reconciliation, approval binding.
 *
 * Stands between "a course version claims to teach some topics" and "a
 * certificate may state the aspects for which an employee is trained". Pure and
 * DB-free; the router reads the rows and calls these.
 *
 * THE INVARIANT THIS EXISTS TO HOLD
 *
 * There must be no path from arbitrary client text to the aspects of handling,
 * offering for transport or transporting dangerous goods printed on a
 * certificate. Aspects are derived from approved coverage or they are not
 * produced at all.
 *
 * Authored truth is per module. Version coverage is a declaration that must
 * reconcile against the union of its modules — a course cannot claim to teach a
 * topic no module delivers.
 */

import { TDG_6_2_TOPICS, type Tdg62TopicCode, type TdgMode } from "./tdgCertificateContents";

const CANONICAL: ReadonlySet<string> = new Set(TDG_6_2_TOPICS.map(t => t.code));

export type CoverageRefusalCode =
  | "TDG_MODE_UNSET"
  | "TDG_MODE_MISMATCH"
  | "TDG_TOPIC_COVERAGE_UNMAPPED"
  | "TDG_TOPIC_COVERAGE_INVALID"
  | "TDG_TOPIC_COVERAGE_DIVERGENCE"
  | "TDG_TOPIC_COVERAGE_UNREVIEWED"
  | "TDG_TOPIC_REVIEW_STALE";

export type CoverageDecision =
  | { ok: true; mode: TdgMode; topicCodes: readonly Tdg62TopicCode[]; coverageHash: string }
  | { ok: false; code: CoverageRefusalCode; message: string };

/**
 * Parse a stored topic array. Rejects anything outside the canonical s.6.2
 * vocabulary, and rejects duplicates — a mapping that lists a topic twice was
 * not authored carefully enough to certify training scope from.
 */
export function parseTopicCodes(raw: unknown):
  | { ok: true; codes: Tdg62TopicCode[] }
  | { ok: false; reason: string } {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, reason: "coverage is not valid JSON" }; }
  }
  if (!Array.isArray(value)) return { ok: false, reason: "coverage is not an array" };
  if (value.length === 0) return { ok: false, reason: "coverage is empty" };

  const seen = new Set<string>();
  const codes: Tdg62TopicCode[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false, reason: `non-string topic code: ${JSON.stringify(entry)}` };
    if (!CANONICAL.has(entry)) return { ok: false, reason: `unknown topic code "${entry}" — not in the s.6.2 vocabulary` };
    if (seen.has(entry)) return { ok: false, reason: `duplicate topic code "${entry}"` };
    seen.add(entry);
    codes.push(entry as Tdg62TopicCode);
  }
  return { ok: true, codes };
}

/** Sorted and deduplicated, so a reorder is not a change. */
export function normalizeTopicCodes(codes: readonly Tdg62TopicCode[]): Tdg62TopicCode[] {
  return Array.from(new Set(codes)).sort();
}

/**
 * Fingerprint of an exact mapping. Approval binds to this, not to a status flag
 * — otherwise the mapping can be edited after review while the row still reads
 * "approved". Order-independent by construction: reordering the same topics
 * yields the same hash, adding or removing one does not.
 */
export function coverageFingerprint(mode: TdgMode, codes: readonly Tdg62TopicCode[]): string {
  const payload = `${mode}|${normalizeTopicCodes(codes).join(",")}`;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < payload.length; i++) {
    h1 = Math.imul(h1 ^ payload.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + payload.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0"));
}

export type CoverageRow = {
  courseVersionRef: string;
  tdgMode: TdgMode | null;
  /** The version's declaration. Reconciled against the modules, not trusted alone. */
  declaredTopicCodesJson: unknown;
  reviewStatus: "unmapped" | "draft" | "in_review" | "approved";
  /** Fingerprint captured at the moment of approval. */
  reviewedHash: string | null;
  /** Authored truth: one entry per module, each its own topic array. */
  moduleTopicCodesJson: readonly unknown[];
};

/**
 * Reconcile the version declaration against the union of its modules.
 *
 * Divergence in either direction is a refusal. A version claiming a topic no
 * module teaches is asserting scope the training does not deliver; a module
 * teaching a topic the version omits means the declaration is stale and nobody
 * reviewed what is actually there.
 */
export function reconcileCoverage(row: CoverageRow):
  | { ok: true; declared: Tdg62TopicCode[]; union: Tdg62TopicCode[] }
  | { ok: false; code: CoverageRefusalCode; message: string } {
  const declared = parseTopicCodes(row.declaredTopicCodesJson);
  if (!declared.ok) {
    return row.reviewStatus === "unmapped"
      ? { ok: false, code: "TDG_TOPIC_COVERAGE_UNMAPPED", message: `${row.courseVersionRef} declares no s.6.2 topic coverage` }
      : { ok: false, code: "TDG_TOPIC_COVERAGE_INVALID", message: `${row.courseVersionRef} coverage is unusable: ${declared.reason}` };
  }

  const union = new Set<Tdg62TopicCode>();
  for (const m of row.moduleTopicCodesJson) {
    if (m === null || m === undefined) continue;   // a module may teach no TDG topic
    const parsed = parseTopicCodes(m);
    if (!parsed.ok) return { ok: false, code: "TDG_TOPIC_COVERAGE_INVALID", message: `module coverage is unusable: ${parsed.reason}` };
    for (const c of parsed.codes) union.add(c);
  }

  const d = normalizeTopicCodes(declared.codes);
  const u = normalizeTopicCodes(Array.from(union));
  const claimedNotTaught = d.filter(c => !union.has(c));
  const taughtNotClaimed = u.filter(c => !d.includes(c));

  if (claimedNotTaught.length || taughtNotClaimed.length) {
    const parts: string[] = [];
    if (claimedNotTaught.length) parts.push(`claimed but no module teaches: ${claimedNotTaught.join(", ")}`);
    if (taughtNotClaimed.length) parts.push(`taught but not declared: ${taughtNotClaimed.join(", ")}`);
    return { ok: false, code: "TDG_TOPIC_COVERAGE_DIVERGENCE", message: `${row.courseVersionRef} coverage does not reconcile — ${parts.join("; ")}` };
  }

  return { ok: true, declared: d, union: u };
}

/**
 * May a learner study against this coverage? Anything mapped and parseable,
 * reviewed or not. Deliberately separate from the issuance gate so callers stop
 * reinterpreting draft / in_review / approved for themselves.
 */
export function canStudyFromCoverage(row: CoverageRow): boolean {
  return row.reviewStatus !== "unmapped" && parseTopicCodes(row.declaredTopicCodesJson).ok;
}

/**
 * May a certificate be issued from this coverage, for this mode?
 *
 * Every refusal carries its own code. One generic "certificate invalid" is the
 * thing people eventually work around.
 */
export function canIssueCertificateFromCoverage(row: CoverageRow, requestedMode: TdgMode): CoverageDecision {
  if (row.tdgMode === null) {
    return { ok: false, code: "TDG_MODE_UNSET", message: `${row.courseVersionRef} has no transport mode set, so no certificate mode can be derived from it` };
  }
  if (row.tdgMode !== requestedMode) {
    return { ok: false, code: "TDG_MODE_MISMATCH", message: `${row.courseVersionRef} is mapped for ${row.tdgMode}; a ${requestedMode} certificate cannot be derived from it` };
  }

  const reconciled = reconcileCoverage(row);
  if (!reconciled.ok) return reconciled;

  if (row.reviewStatus !== "approved") {
    return { ok: false, code: "TDG_TOPIC_COVERAGE_UNREVIEWED", message: `${row.courseVersionRef} coverage is ${row.reviewStatus}; only approved coverage may support issuance` };
  }

  const current = coverageFingerprint(row.tdgMode, reconciled.declared);
  if (row.reviewedHash !== current) {
    return { ok: false, code: "TDG_TOPIC_REVIEW_STALE", message: `${row.courseVersionRef} coverage has changed since it was approved; it must be reviewed again` };
  }

  return { ok: true, mode: row.tdgMode, topicCodes: reconciled.declared, coverageHash: current };
}
