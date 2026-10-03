/**
 * The ELD device-chain assessment — pure, and shared by the server and the device.
 *
 * Moved here unchanged from `server/_core/eld/ledger.ts` in ELD checkpoint 2d so the device outbox
 * judges its own local chain (gaps, links, clock regressions) with exactly the function the server
 * judges the ledger with. No imports: it runs in the browser and in Node alike.
 */

/** What the assessment needs from a stored row. */
export type ChainRow = {
  eventRef: string;
  deviceSequence: number;
  eventAt: Date;
  previousEventHash: string | null;
  eventHash: string;
};

/**
 * One event's place in its device's HASH chain. Sequence continuity (gaps) and hash continuity
 * (links) are different questions: a device can be contiguous in sequence and broken in hash, or
 * missing a sequence and perfectly linked on either side of the hole.
 *
 *   first                 sequence 0 claiming no predecessor: the chain's root
 *   linked                the claimed predecessor hash equals the stored predecessor's eventHash
 *   predecessor_missing   the predecessor sequence is not on record yet; unverifiable until it is
 *   hash_mismatch         both present and the claim differs from the record
 *   missing_claim         predecessor present, but this event claimed none
 *   dangling_first        sequence 0 claiming a predecessor it cannot have
 */
export type ChainLinkState = "first" | "linked" | "predecessor_missing" | "hash_mismatch" | "missing_claim" | "dangling_first";

export type ChainAssessment = {
  /** Every event's link state, in sequence order. */
  links: { eventRef: string; deviceSequence: number; state: ChainLinkState }[];
  eventCount: number;
  lowestSequence: number | null;
  highestSequence: number | null;
  /** Inclusive ranges of sequence numbers the ledger does not hold. Reported, never filled. */
  gaps: { from: number; to: number }[];
  /** The device said its predecessor hashed to X; the predecessor on record hashes to Y. */
  chainMismatches: { eventRef: string; deviceSequence: number; declaredPreviousEventHash: string; predecessorEventHash: string }[];
  /** The predecessor has not arrived, so the claim cannot be checked yet. Resolves when it does. */
  unverifiableLinks: { eventRef: string; deviceSequence: number; declaredPreviousEventHash: string | null }[];
  /** A later sequence with an earlier device clock. Recorded as observed; a diagnostic decides what it means. */
  timingInconsistencies: { eventRef: string; deviceSequence: number; eventAt: string; previousEventAt: string }[];
  /** A first event (sequence 0, or the lowest on record) that claims a predecessor. */
  danglingFirstLink: { eventRef: string; deviceSequence: number; declaredPreviousEventHash: string } | null;
  verifiedLinks: number;
};

/**
 * Read one device's rows and say what they prove. Pure and idempotent: the same rows give the same
 * answer, and appending the missing predecessor later turns an unverifiable link into a verified
 * one (or a mismatch) without anything being rewritten.
 */
export function assessDeviceChain(rows: readonly ChainRow[]): ChainAssessment {
  const sorted = [...rows].sort((a, b) => a.deviceSequence - b.deviceSequence);
  const bySeq = new Map<number, ChainRow>(sorted.map(r => [r.deviceSequence, r]));
  const a: ChainAssessment = {
    links: [],
    eventCount: sorted.length, lowestSequence: sorted[0]?.deviceSequence ?? null, highestSequence: sorted.at(-1)?.deviceSequence ?? null,
    gaps: [], chainMismatches: [], unverifiableLinks: [], timingInconsistencies: [], danglingFirstLink: null, verifiedLinks: 0,
  };
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, cur = sorted[i]!;
    if (cur.deviceSequence > prev.deviceSequence + 1) a.gaps.push({ from: prev.deviceSequence + 1, to: cur.deviceSequence - 1 });
    if (cur.eventAt.getTime() < prev.eventAt.getTime()) a.timingInconsistencies.push({ eventRef: cur.eventRef, deviceSequence: cur.deviceSequence, eventAt: cur.eventAt.toISOString(), previousEventAt: prev.eventAt.toISOString() });
  }
  const link = (r: ChainRow, state: ChainLinkState) => a.links.push({ eventRef: r.eventRef, deviceSequence: r.deviceSequence, state });
  for (const r of sorted) {
    if (r.deviceSequence === 0) {
      if (r.previousEventHash) { a.danglingFirstLink = { eventRef: r.eventRef, deviceSequence: 0, declaredPreviousEventHash: r.previousEventHash }; link(r, "dangling_first"); }
      else link(r, "first");
      continue;
    }
    const pred = bySeq.get(r.deviceSequence - 1);
    if (!pred) { a.unverifiableLinks.push({ eventRef: r.eventRef, deviceSequence: r.deviceSequence, declaredPreviousEventHash: r.previousEventHash }); link(r, "predecessor_missing"); continue; }
    if (r.previousEventHash == null) { a.chainMismatches.push({ eventRef: r.eventRef, deviceSequence: r.deviceSequence, declaredPreviousEventHash: "", predecessorEventHash: pred.eventHash }); link(r, "missing_claim"); continue; }
    if (r.previousEventHash === pred.eventHash) { a.verifiedLinks++; link(r, "linked"); }
    else { a.chainMismatches.push({ eventRef: r.eventRef, deviceSequence: r.deviceSequence, declaredPreviousEventHash: r.previousEventHash, predecessorEventHash: pred.eventHash }); link(r, "hash_mismatch"); }
  }
  return a;
}

