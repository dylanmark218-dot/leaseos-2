/**
 * The committed evidence about one trip stop's boundaries — the chain rule, without the
 * reader.
 *
 * The chain SPINE item 1 names, end to end:
 *
 *     tripStops.id
 *       → assistantCommitReceipts   (targetType 'trip_stop', targetRecordId = the stop)
 *       → fieldManifest             (sha256-sealed on the receipt)
 *       → readFieldManifest
 *       → boundaryConfirmations     (boundaryConfirmation.ts — pure, and the only resolver)
 *       → siteBaseline.phaseConfirmation
 *
 * In the sibling repository (`leaseos`, branch `claude/spine-boundary-confirmation`) this
 * module has two halves: `evidenceFromReceipts`, which decides whether a stop's receipts
 * still describe the row, and `boundaryEvidenceForStop`, which reads the row and its
 * receipts through `orgScopeWhere(trips, scope)`. **Only the first half is here**, and the
 * code of it is the sibling's, unchanged. It resolves nothing itself — every verdict comes
 * from `boundaryConfirmations`.
 *
 * ## Why the reader is not here
 *
 * The chain rule needs the row's last write: `tripStops.updatedAt` and `updatedByUserId`,
 * which `0169_trip_stop_provenance.sql` adds in the sibling. This repository never received
 * that migration, and its `0169` slot is taken by `0169_defect_resolution.sql` (PR #4, now
 * on `main`) — the collision recorded in docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md.
 * With no last write to compare against, the only honest input a reader here could supply
 * is `{ updatedAt: null, updatedByUserId: null }`, and the rule below answers that with
 * `no_write_recorded` for every stop: a receipt whose row may have been edited since is not
 * evidence. A reader that always answers `unknown` is not worth mounting, and one that
 * invents a last write would be the fail-open this file exists to refuse. So the reader
 * waits for the migration, and the rule is kept identical so that it can be dropped in.
 *
 * ## Only the newest commit speaks
 *
 * Every boundary the newest commit wrote is exact: it wrote the column, and — if the
 * checks below hold — nothing wrote the row after it. A boundary it did NOT write is
 * another matter. The unload form's departure is optional and an omitted field is not
 * written, so that column may hold an older commit's value or one typed through
 * `tripStops.update` in between, and nothing left on the row says which: the later
 * commit re-stamped `updatedAt` and erased the edit's trace. So an older receipt cannot
 * speak for it. Receipts committed at the newest instant all speak — within one second
 * they cannot be ordered, and none was followed by a foreign write.
 *
 * ## When the receipts stop describing the row at all — the chain rule
 *
 * A stop whose last write is anything other than its newest commit gets NO evidence,
 * every boundary `unknown`, and the reason:
 *
 *     edited_after_commit      — `updatedAt` is later than the newest commit.
 *     no_write_recorded        — `updatedAt` is NULL. Here, every stop, until 0169 lands.
 *     write_predates_commit    — `updatedAt` is earlier than a commit that wrote the row.
 *     written_by_another_actor — the stamps agree but the row's last writer is not the
 *                                newest commit's actor. A NULL writer is refused the same way.
 *     seal_mismatch            — ANY receipt's manifest no longer matches its sha256.
 *     unreadable_manifest      — ANY receipt's manifest is not a readable array of fields.
 *
 * Failing to `unknown` is the safe direction. It can only exclude a sample from a
 * baseline; it can never admit one nobody stands behind.
 */
import { createHash } from "node:crypto";
import { readFieldManifest, type BoundaryEvidence } from "./boundaryConfirmation";

/** What a receipt contributes to the chain check. */
export type StopReceipt = {
  fieldManifest: string;
  fieldManifestHash: string;
  committedAt: Date;
  actorUserId: number;
};

/** What the stop's own row says about its last write. Here: nothing, until 0169. */
export type StopLastWrite = {
  updatedAt: Date | null;
  updatedByUserId: number | null;
};

export type ChainState =
  | "intact"
  | "no_receipts"
  | "edited_after_commit"
  | "no_write_recorded"
  | "write_predates_commit"
  | "written_by_another_actor"
  | "seal_mismatch"
  | "unreadable_manifest";

export type StopEvidence = {
  /** The newest commit's readable fields, or none when the chain is broken. */
  evidence: BoundaryEvidence[];
  /** Why the evidence is what it is. Only `intact` carries any. */
  chain: ChainState;
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Decide what a stop's receipts can still say about it.
 *
 * Pure: no database, no clock. The order `receipts` arrives in does not matter.
 */
export function evidenceFromReceipts(
  stop: StopLastWrite,
  receipts: readonly StopReceipt[],
): StopEvidence {
  if (receipts.length === 0) return { evidence: [], chain: "no_receipts" };

  let newest = Number.NEGATIVE_INFINITY;
  for (const r of receipts) {
    const t = r.committedAt instanceof Date ? r.committedAt.getTime() : Number.NaN;
    if (!Number.isFinite(t)) return { evidence: [], chain: "unreadable_manifest" };
    if (t > newest) newest = t;
  }

  const lastWrite = stop.updatedAt instanceof Date ? stop.updatedAt.getTime() : Number.NaN;
  if (!Number.isFinite(lastWrite)) return { evidence: [], chain: "no_write_recorded" };
  if (lastWrite > newest) return { evidence: [], chain: "edited_after_commit" };
  if (lastWrite < newest) return { evidence: [], chain: "write_predates_commit" };

  const newestReceipts = receipts.filter(r => r.committedAt.getTime() === newest);
  if (stop.updatedByUserId === null || !newestReceipts.some(r => r.actorUserId === stop.updatedByUserId)) {
    return { evidence: [], chain: "written_by_another_actor" };
  }

  const read = new Map<StopReceipt, BoundaryEvidence[]>();
  for (const r of receipts) {
    if (sha256(r.fieldManifest) !== r.fieldManifestHash) {
      return { evidence: [], chain: "seal_mismatch" };
    }
    const manifest = readFieldManifest(r.fieldManifest, r.committedAt);
    if (!manifest.intact) return { evidence: [], chain: "unreadable_manifest" };
    read.set(r, manifest.evidence);
  }

  return { evidence: newestReceipts.flatMap(r => read.get(r)!), chain: "intact" };
}
