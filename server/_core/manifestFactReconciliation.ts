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
  /** Before sealing, a disagreement is a blocker. After, it is history. */
  blocking: readonly FactFinding[];
  explanation: string;
};

const LABEL: Record<ManifestFactKey, string> = { driver: "driver", trailer: "trailer", facility: "destination facility" };

/** Compare loosely enough to survive spacing and case, strictly enough to catch a different person. */
const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

export function reconcileManifestFacts(pairs: readonly FactPair[], opts: { sealed: boolean }): ReconciliationVerdict {
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

  // After sealing, a divergence is the document being a document: a name corrected or a trailer
  // renumbered afterwards does not retroactively make the sealed page wrong.
  const blocking = opts.sealed ? [] : findings.filter(f => f.kind === "differs" || f.kind === "printed_without_reference");

  return {
    sealed: opts.sealed,
    findings,
    blocking,
    explanation: opts.sealed
      ? findings.some(f => f.kind === "differs")
        ? `Sealed. The printed text stands as what was presented; the records have since moved: ${findings.filter(f => f.kind === "differs").map(f => f.detail).join(" ")} This is history, not an error to repair.`
        : "Sealed, and the printed text still matches the records it was drawn from."
      : blocking.length === 0
        ? "Not sealed, and every printed fact agrees with the record behind it."
        : `Not sealed. Fix before sealing — the cheapest moment is now: ${blocking.map(f => f.detail).join(" ")}`,
  };
}
