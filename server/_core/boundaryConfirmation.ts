/**
 * Which of a trip stop's five timestamps a person stands behind.
 *
 * SPINE ordering item 1 (`docs/register/SPINE_WIRING_PLAN.md:47-49`): "Per-boundary
 * confirmation on `tripStops` … `siteBaseline` filters on exactly that and cannot be
 * wired to real data without it. One resolver, read by both engines." This is that
 * resolver. `siteBaseline.phaseConfirmation` turns its five verdicts into four phase
 * verdicts; the billing path is meant to read the same five when it is adapted onto
 * `priceLineAndRecord` (see the note on `phaseConfirmation`), and this module is the
 * one neither engine owns so that the question is not answered twice differently.
 *
 * ## Committed evidence, not proposals
 *
 * The evidence is `assistantCommitReceipts.fieldManifest`: what a commit actually
 * wrote, sealed with a sha256 and hung off the receipt that names the stop. It is
 * NOT `proposalFields`. A proposal is what the assistant offered; a manifest is what
 * reached the row. `commitProposal` drops rejected and null fields before the
 * manifest is built, so a rejected value can never be read back out of it as though
 * it had been committed.
 *
 *     proposal  ≠  committed evidence
 *
 * Reading receipts for a stop, checking their seals, and refusing a chain some later
 * write has broken is the receipt reader's job. In this repository there is none yet:
 * that reader decides whether a stop was edited after its newest commit by comparing
 * `tripStops.updatedAt` with the receipt's `committedAt`, and this repository's
 * `tripStops` has no `updatedAt` — its migrations stop at 0168, before the trip-stop
 * provenance migration. See docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md.
 * Everything here is pure: no database, no clock, no caller context, and no runtime
 * import at all.
 *
 * ## Three verdicts, never two
 *
 *   confirmed   — the newest committed evidence for the boundary is `confirmed` or
 *                 `corrected`: a person acted on that value.
 *   unconfirmed — there IS committed evidence, and its newest word is `proposed`:
 *                 it reached the record under the proposal's read-back without
 *                 anyone acting on this field. A later commit can confirm it.
 *   unknown     — nothing recorded speaks for the current value, or what was
 *                 recorded cannot be read or ordered. No amount of confirming fixes
 *                 that; only a new commit can.
 *
 * `siteBaseline.ts:38-44` gives the reason the last two stay apart: they are
 * different queues of work, and collapsing them hides which one a sample is in.
 *
 * ## Precedence, per boundary
 *
 *   1. Only the five boundary keys are read; every other manifest key is ignored.
 *   2. `setupStartedAt` is refused outright — see `UNREACHABLE_BOUNDARIES`.
 *   3. `rejected` evidence is ignored. It records that a value was NOT accepted, so
 *      it says nothing about the value that was, and must not poison a correction
 *      beside it (`siteBaseline.ts:91-93`).
 *   4. Evidence that cannot be read — an unrecognised status or source, or a
 *      commit instant that is not a real date — makes that boundary `unknown`. It
 *      cannot be ordered against the rest, so nothing can be said to supersede it,
 *      and ignoring it could let older evidence speak for a newer value.
 *   5. Otherwise the newest `committedAt` wins. Source never demotes a status: a
 *      confirmed GPS detection is confirmed, because the status is the act.
 *   6. An exact tie at the newest instant resolves to the WEAKER verdict. Two
 *      commits in one instant that disagree are not something this can
 *      adjudicate, and choosing the stronger would manufacture a confirmation.
 *
 * Array order is never a tie-break, so the answer does not depend on the order a
 * query returned rows in.
 */
import type { FieldSource, FieldStatus } from "./aiProposal";
import type { BoundaryConfirmation, BoundaryKey } from "./siteBaseline";

/** One committed field, as a receipt's manifest records it. */
export type BoundaryEvidence = {
  fieldKey: string;
  source: FieldSource;
  status: FieldStatus;
  committedAt: Date;
};

/*
 * Runtime mirrors of three unions defined elsewhere. Each is a `Record` keyed by
 * the imported type, so the compiler refuses a missing member and an extra one:
 * a new source or status added in `aiProposal.ts` fails typecheck here rather
 * than being silently read as unrecognised. They are checks, not definitions.
 */
const BOUNDARY_KEY_SET: Record<BoundaryKey, true> = {
  arrivedAt: true,
  setupStartedAt: true,
  operationStartedAt: true,
  operationCompletedAt: true,
  departedAt: true,
};

const FIELD_SOURCE_SET: Record<FieldSource, true> = {
  driver_voice: true,
  driver_typed: true,
  gps: true,
  photo_ocr: true,
  system_inferred: true,
  imported: true,
  human_corrected: true,
};

const FIELD_STATUS_SET: Record<FieldStatus, true> = {
  proposed: true,
  confirmed: true,
  rejected: true,
  corrected: true,
};

/** The five boundaries, in the order `tripStops` declares them. */
export const BOUNDARY_KEYS = Object.keys(BOUNDARY_KEY_SET) as readonly BoundaryKey[];

/**
 * Boundaries no committed evidence can speak for.
 *
 * No form collects `setupStartedAt` and `UnloadStopPatch` has no column for it, so
 * no assistant commit can ever write it. Evidence claiming to is refused rather than
 * honoured: its appearance would mean something upstream changed without this
 * module being told. Because `combineBoundaries` lets `unknown` dominate, the
 * `setup` and `wait` phases — both bounded by `setupStartedAt` — stay `unknown`
 * however much else is confirmed. That is a gap in the capture path, recorded here
 * so it is not rediscovered; it is not closed by adding the field to a form.
 */
export const UNREACHABLE_BOUNDARIES: readonly BoundaryKey[] = ["setupStartedAt"];

const isBoundaryKey = (key: string): key is BoundaryKey =>
  Object.prototype.hasOwnProperty.call(BOUNDARY_KEY_SET, key);
const isFieldSource = (v: unknown): v is FieldSource =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(FIELD_SOURCE_SET, v);
const isFieldStatus = (v: unknown): v is FieldStatus =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(FIELD_STATUS_SET, v);
const isRealDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());

type Verdict = Exclude<BoundaryConfirmation, "unknown">;

/** What a status says about the committed value. `null`: nothing — see rule 3. */
function verdictOf(status: FieldStatus): Verdict | null {
  switch (status) {
    case "confirmed":
    case "corrected":
      return "confirmed";
    case "proposed":
      return "unconfirmed";
    case "rejected":
      return null;
  }
}

/** Lower is weaker. Used only to break an exact tie toward the weaker verdict. */
const STRENGTH: Record<Verdict, number> = { unconfirmed: 0, confirmed: 1 };

function resolveBoundary(key: BoundaryKey, evidence: readonly BoundaryEvidence[]): BoundaryConfirmation {
  if (UNREACHABLE_BOUNDARIES.includes(key)) return "unknown";

  let newest = Number.NEGATIVE_INFINITY;
  let verdict: Verdict | null = null;

  for (const e of evidence) {
    if (e.fieldKey !== key) continue;
    // Rule 4: unreadable evidence about this boundary poisons it.
    if (!isFieldStatus(e.status) || !isFieldSource(e.source) || !isRealDate(e.committedAt)) {
      return "unknown";
    }
    const v = verdictOf(e.status);
    if (v === null) continue; // Rule 3.
    const t = e.committedAt.getTime();
    if (t > newest) {
      newest = t;
      verdict = v;
    } else if (t === newest && verdict !== null && STRENGTH[v] < STRENGTH[verdict]) {
      verdict = v; // Rule 6.
    }
  }

  return verdict ?? "unknown";
}

/**
 * The five boundary verdicts for one stop, from every piece of committed evidence
 * about it. Every key is always present, so no caller has to guard for a missing
 * one. The input is not modified.
 */
export function boundaryConfirmations(
  evidence: readonly BoundaryEvidence[],
): Record<BoundaryKey, BoundaryConfirmation> {
  const out = {} as Record<BoundaryKey, BoundaryConfirmation>;
  for (const key of BOUNDARY_KEYS) out[key] = resolveBoundary(key, evidence);
  return out;
}

/**
 * A manifest read, and whether every entry in it could be read.
 *
 * `intact` is false when the text is not a JSON array, or when any element of it is
 * not a readable field. The entries that WERE readable are still returned — dropping
 * one can only lose evidence, never invent it — but a caller composing several
 * receipts must treat a non-intact manifest as a break in the chain, because an
 * unreadable entry may be the newest word on a boundary.
 */
export function readFieldManifest(
  json: string,
  committedAt: Date,
): { evidence: BoundaryEvidence[]; intact: boolean } {
  if (!isRealDate(committedAt)) return { evidence: [], intact: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { evidence: [], intact: false };
  }
  if (!Array.isArray(parsed)) return { evidence: [], intact: false };

  const evidence: BoundaryEvidence[] = [];
  let intact = true;
  for (const entry of parsed) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as { key?: unknown }).key !== "string" ||
      (entry as { key: string }).key.length === 0 ||
      !isFieldSource((entry as { source?: unknown }).source) ||
      !isFieldStatus((entry as { status?: unknown }).status)
    ) {
      intact = false;
      continue;
    }
    const { key, source, status } = entry as { key: string; source: FieldSource; status: FieldStatus };
    evidence.push({ fieldKey: key, source, status, committedAt: new Date(committedAt.getTime()) });
  }
  return { evidence, intact };
}

/**
 * The readable evidence in one manifest. Malformed text yields nothing; a malformed
 * entry is dropped. Never throws, and never upgrades anything it could not read.
 *
 * Keys that are not boundaries — `quantity`, `waitMinutes`, `measurementMethod` —
 * are reported as the manifest records them; `boundaryConfirmations` is what
 * ignores them.
 */
export function parseFieldManifest(json: string, committedAt: Date): BoundaryEvidence[] {
  return readFieldManifest(json, committedAt).evidence;
}
