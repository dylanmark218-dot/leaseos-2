/**
 * The committed evidence about one trip stop's boundaries, read from its receipts.
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
 * This module does the two things the resolver must not: it reads the database, and
 * it decides whether the receipts it found still describe the row. It resolves
 * nothing itself — every verdict comes from `boundaryConfirmations`. The code is the
 * sibling repository's (`leaseos`, `claude/spine-boundary-confirmation`), unchanged;
 * what changed is that `tripStops` here now carries the last write it compares
 * against, through `0179_trip_stop_provenance.sql` (leaseos's 0169, reconciled
 * forward — docs/register/MIGRATION_0169_RECONCILIATION.md).
 *
 * ## Association
 *
 * A receipt speaks for a stop only when `targetType = 'trip_stop'` AND
 * `targetRecordId` is that stop's id. Both are required: ids are per table, so a
 * `maintenance_defect` receipt can carry the same number as a stop and must not be
 * read as one. There is no other link — the manifest names fields, not rows.
 *
 * ## Scope
 *
 * Neither `tripStops` nor `assistantCommitReceipts` carries an `orgRef`. A stop
 * belongs to its trip, and the trip carries the organization, so the stop is read
 * only through `orgScopeWhere(trips, scope)` — the same predicate every tenant-scoped
 * reader in `db.ts` uses. A stop outside the caller's scope and a stop that does not
 * exist return the same answer, so the result cannot be used to probe for another
 * organization's stops. Knowing a stop's id is not a way past this: the id is only
 * ever looked up inside the scope.
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
 * The cost is a boundary an older commit confirmed and nothing has touched since reading
 * `unknown` once a later commit leaves it out. Proving nothing touched it needs per-field
 * write provenance on the direct edit path — a schema question, deferred.
 *
 * ## When the receipts stop describing the row at all — the chain rule
 *
 * The assistant commit stamps `tripStops.updatedAt` with the same instant it writes into
 * the receipt's `committedAt`, and `updatedByUserId` with its actor. A stop whose last
 * write is anything other than its newest commit gets NO evidence, every boundary
 * `unknown`, and the reason:
 *
 *     edited_after_commit      — `updatedAt` is later. `tripStops.update` stamps its own
 *                                `updatedAt` and records which ROW it touched, never which
 *                                FIELD, so no receipt can be trusted to describe the row.
 *     no_write_recorded        — `updatedAt` is NULL. Rows older than 0179 recorded no
 *                                write at all, so an edit after the commit cannot be ruled
 *                                out.
 *     write_predates_commit    — `updatedAt` is earlier than a commit that wrote the row.
 *                                No current writer produces that; a row that contradicts
 *                                its own receipts is not one to read confirmation from.
 *     written_by_another_actor — the stamps agree but the row's last writer is not the
 *                                newest commit's actor. Both columns are second-precision,
 *                                so a hand edit landing in the commit's second truncates to
 *                                the same stamp; the writer does not. A NULL writer is
 *                                refused the same way.
 *     seal_mismatch            — ANY receipt's manifest no longer matches its sha256.
 *     unreadable_manifest      — ANY receipt's manifest is not a readable array of fields.
 *
 * The last two look at the whole history, not only the newest receipt: a stop whose
 * record has been altered anywhere is not one to read confirmation from.
 *
 * Failing to `unknown` is the safe direction. It can only exclude a sample from a
 * baseline; it can never admit one nobody stands behind. The costs are real and stated:
 * an edit that only touched `notes` still breaks the chain; and a hand edit by the
 * committing user themself, in the same second as their own commit, is the one write the
 * rule cannot see — a person's own value either way, but not the one the receipt names.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { assistantCommitReceipts, tripStops, trips } from "../../drizzle/schema";
import { orgScopeWhere, type TenantScope } from "../db";
import type { DbOrTx } from "./dbTypes";
import { readFieldManifest, type BoundaryEvidence } from "./boundaryConfirmation";

/** What a receipt contributes to the chain check. */
export type StopReceipt = {
  fieldManifest: string;
  fieldManifestHash: string;
  committedAt: Date;
  actorUserId: number;
};

/** What the stop's own row says about its last write. */
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

/**
 * The committed evidence for one stop, or `null` when the stop does not exist or is
 * outside `scope`. The two are deliberately indistinguishable.
 */
export async function boundaryEvidenceForStop(
  db: DbOrTx,
  stopId: number,
  scope: TenantScope,
): Promise<StopEvidence | null> {
  const stop = (
    await db
      .select({ id: tripStops.id, updatedAt: tripStops.updatedAt, updatedByUserId: tripStops.updatedByUserId })
      .from(tripStops)
      .where(
        and(
          eq(tripStops.id, stopId),
          inArray(
            tripStops.tripId,
            db.select({ id: trips.id }).from(trips).where(orgScopeWhere(trips, scope)),
          ),
        ),
      )
      .limit(1)
  )[0];
  if (!stop) return null;

  const receipts = await db
    .select({
      fieldManifest: assistantCommitReceipts.fieldManifest,
      fieldManifestHash: assistantCommitReceipts.fieldManifestHash,
      committedAt: assistantCommitReceipts.committedAt,
      actorUserId: assistantCommitReceipts.actorUserId,
    })
    .from(assistantCommitReceipts)
    .where(
      and(
        eq(assistantCommitReceipts.targetType, "trip_stop"),
        eq(assistantCommitReceipts.targetRecordId, stop.id),
      ),
    );

  return evidenceFromReceipts({ updatedAt: stop.updatedAt, updatedByUserId: stop.updatedByUserId }, receipts);
}
