/**
 * P3.1 — the manifest holds a reference and a printed word for the same fact. Which one is true?
 *
 * Found by auditing this row against its original definition, which ends "**by reference**".
 * `manifests` carries `operatorId` **and** `driver`, `trailerUnitId` **and** `trailer`,
 * `destinationFacilityId` **and** `facility`, and the custody state is built from both. Nothing
 * said which was authoritative, nothing recorded that the text was a snapshot, and nothing checked
 * that the two agreed.
 *
 * The answer is not "delete the text". A sealed manifest is a document, and what it printed is
 * evidence of what was presented at the roadside — freezing that is correct. The answer is that
 * the duplication has to be **declared and timed**:
 *
 *   **Before sealing**, the reference is authoritative and the text must agree with it. A manifest
 *   whose printed driver is not the operator on the record is a document that will be questioned
 *   the first time anybody compares them, and the cheapest moment to fix it is before it is sealed.
 *
 *   **After sealing**, the text is authoritative *for what was presented* and the reference
 *   remains authoritative *for what is true now*. They may legitimately diverge — a name is
 *   corrected, a trailer is renumbered — and that divergence is not an error to repair. It is the
 *   document being a document.
 */

export type ManifestFactKey = "driver" | "trailer" | "facility";

export type FactPair = {
  key: ManifestFactKey;
  /** What the manifest printed. */
  printed: string | null;
  /** What the reference resolves to now. */
  resolved: string | null;
  /** The reference itself, so a mismatch names something a person can open. */
  referenceId: number | null;
};

export type FactFinding = {
  key: ManifestFactKey;
  kind: "agrees" | "differs" | "printed_without_reference" | "reference_without_print" | "neither";
  detail: string;
};

export type ReconciliationVerdict = {
  sealed: boolean;
  findings: readonly FactFinding[];
  /** Before sealing, a contradiction is a blocker. After, it is history. */
  blocking: readonly FactFinding[];
  /** A printed field left blank whose reference is known: fillable, not a contradiction. */
  review: readonly FactFinding[];
  explanation: string;
};

const LABEL: Record<ManifestFactKey, string> = { driver: "driver", trailer: "trailer", facility: "destination facility" };

/** Compare loosely enough to survive spacing and case, strictly enough to catch a different person. */
const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

export function reconcileManifestFacts(
  pairs: readonly FactPair[],
  opts: {
    sealed: boolean;
    /** Facts an authorized person has accepted in writing (0162). Never granted by the author. */
    overriddenFactKeys?: readonly ManifestFactKey[];
  },
): ReconciliationVerdict {
  const findings: FactFinding[] = pairs.map(p => {
    if (p.printed && p.resolved) {
      return same(p.printed, p.resolved)
        ? { key: p.key, kind: "agrees", detail: `${LABEL[p.key]}: printed "${p.printed}" matches the record.` }
        : { key: p.key, kind: "differs", detail: `${LABEL[p.key]}: the manifest prints "${p.printed}" but reference #${p.referenceId ?? "?"} resolves to "${p.resolved}".` };
    }
    if (p.printed && !p.resolved) {
      // A printed name with nothing behind it cannot be checked by anybody, ever.
      return { key: p.key, kind: "printed_without_reference", detail: `${LABEL[p.key]}: the manifest prints "${p.printed}" with no record behind it, so nothing can confirm who or what that was.` };
    }
    if (!p.printed && p.resolved) {
      return { key: p.key, kind: "reference_without_print", detail: `${LABEL[p.key]}: the record says "${p.resolved}" but the manifest prints nothing, so the document is short a field somebody will ask for.` };
    }
    return { key: p.key, kind: "neither", detail: `${LABEL[p.key]}: neither printed nor referenced.` };
  });

  /*
   * Owner decision (2026-09-19): a real **contradiction** blocks sealing; an **incomplete** printed
   * field whose canonical reference is known is REVIEW, not a contradiction, and may be filled from
   * that record before sealing so long as the manifest says the value was generated rather than
   * stated.
   *
   * `printed_without_reference` is the one case the decision does not name, and it is **review**,
   * not a block. A printed trailer with no `trailerUnitId` is unverifiable, which is worth saying
   * loudly — but whether a manifest may seal without that binding is the **evidence profile's**
   * question, and the decision says so explicitly ("if the applicable profile requires the printed
   * value ... the existing evidence-profile rules may block sealing"). Blocking it here would be
   * this gate deciding a requirement that belongs to the profile, and two engines answering the
   * same question is how they start disagreeing.
   *
   * So: contradictions are this gate's business. Completeness is the profile's.
   *
   * After sealing nothing blocks: a name corrected or a trailer renumbered afterwards does not
   * retroactively make the sealed page wrong.
   */
  const overridden = new Set(opts.overriddenFactKeys ?? []);
  const blocking = opts.sealed ? [] : findings.filter(f => f.kind === "differs" && !overridden.has(f.key));
  const review = opts.sealed ? [] : findings.filter(f =>
    f.kind === "reference_without_print" || (f.kind === "printed_without_reference" && !overridden.has(f.key)));

  return {
    sealed: opts.sealed,
    findings,
    blocking,
    review,
    explanation: opts.sealed
      ? findings.some(f => f.kind === "differs")
        ? `Sealed. The printed text stands as what was presented; the records have since moved: ${findings.filter(f => f.kind === "differs").map(f => f.detail).join(" ")} This is history, not an error to repair.`
        : "Sealed, and the printed text still matches the records it was drawn from."
      : blocking.length === 0
        ? review.length === 0
          ? "Not sealed, and every printed fact agrees with the record behind it."
          : `Not sealed. Nothing contradicts the record; ${review.length} field(s) need review: ${review.map(f => f.detail).join(" ")}`
        : `Not sealed. Fix before sealing — the cheapest moment is now: ${blocking.map(f => f.detail).join(" ")}`,
  };
}
