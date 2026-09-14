/**
 * v22.20 — a claim stands on what was retrieved, or it does not stand.
 *
 * Pure. No network, no model.
 *
 * This is the part that makes an assistant usable in an operation where being
 * wrong has consequences. A language model asked about brake adjustment limits
 * will answer confidently whether or not the company's manual says anything on
 * the subject, and the answer will read identically either way. That is the
 * failure to engineer against — not rudeness, not refusal, but fluent text with
 * nothing underneath it.
 *
 * So the model's answer is never the output. The answer is decomposed into
 * claims, each claim is matched against passages actually retrieved from the
 * company's own documents, and the verdict is reported honestly:
 *
 *   SUPPORTED       passages say this, and they are current and applicable
 *   UNSUPPORTED     nothing retrieved says it — the model may still be right,
 *                   and we are not going to present that as the manual's word
 *   CONFLICTING     two passages disagree; a reader must decide, not us
 *   SUPERSEDED      the only support is a revision no longer in force
 *   OUT_OF_SCOPE    the only support is another jurisdiction's rule
 *
 * **Unsupported is not a failure state.** It is the correct answer to most
 * questions a company has never written down, and saying so is more useful than
 * a plausible paragraph. The temptation this module exists to resist is
 * softening it — "generally, brake adjustment limits are…" is the same
 * unsupported claim wearing a hedge.
 */

export type Passage = {
  passageRef: string;
  documentRef: string;
  documentTitle: string;
  /** Where in the document, so a reader can go and look. */
  section: string | null;
  page: number | null;
  text: string;
  /** Which revision this passage came from. */
  revision: string;
  effectiveFrom: Date | null;
  supersededAt: Date | null;
  /** Null means the document states no jurisdiction, which is not "all of them". */
  jurisdiction: string | null;
  /** Retrieval score. Ranking only — it never turns an absence into support. */
  score: number;
};

export type Claim = {
  claimRef: string;
  text: string;
  /** Passages the retriever offered for this claim. */
  citedPassageRefs: readonly string[];
  /** Where the answer would apply. */
  jurisdiction: string | null;
};

export type ClaimState = "supported" | "unsupported" | "conflicting" | "superseded" | "out_of_scope";

export type ClaimVerdict = {
  claimRef: string;
  state: ClaimState;
  /** Only passages that actually support it. Empty whenever it does not stand. */
  support: Passage[];
  /** Passages that were offered and rejected, with the reason. */
  rejected: { passageRef: string; reason: string }[];
  line: string;
};

/**
 * The floor below which a passage is not treated as support.
 *
 * A retriever always returns its best matches, and its best match for a
 * question the corpus cannot answer is still a number. Without a floor, every
 * claim is supported by whatever was least irrelevant.
 */
export const MIN_SUPPORT_SCORE = 0.35;

function rejectionFor(passage: Passage, claim: Claim, at: Date): string | null {
  if (passage.score < MIN_SUPPORT_SCORE) {
    return `retrieval score ${passage.score.toFixed(2)} is below the floor; the closest match to an unanswerable question is still a number`;
  }
  if (passage.effectiveFrom && passage.effectiveFrom.getTime() > at.getTime()) {
    return `revision ${passage.revision} does not take effect until ${passage.effectiveFrom.toISOString().slice(0, 10)}`;
  }
  if (passage.supersededAt && passage.supersededAt.getTime() <= at.getTime()) {
    return `revision ${passage.revision} was superseded on ${passage.supersededAt.toISOString().slice(0, 10)}`;
  }
  if (claim.jurisdiction && passage.jurisdiction && passage.jurisdiction !== claim.jurisdiction) {
    return `${passage.documentTitle} states ${passage.jurisdiction}; the question is about ${claim.jurisdiction}`;
  }
  return null;
}

/** Passages that disagree with each other, detected rather than resolved. */
export type Contradiction = { aPassageRef: string; bPassageRef: string; note: string };

/**
 * Verify one claim against what was retrieved.
 *
 * `contradictions` is supplied rather than inferred: deciding that two
 * paragraphs of a manual disagree is a reading task, and this module's job is
 * to make sure a detected disagreement is reported rather than silently
 * resolved by taking the higher-scoring passage.
 */
export function verifyClaim(args: {
  claim: Claim;
  passages: readonly Passage[];
  at: Date;
  contradictions?: readonly Contradiction[];
}): ClaimVerdict {
  const byRef = new Map(args.passages.map(p => [p.passageRef, p]));
  const offered = args.claim.citedPassageRefs.map(r => byRef.get(r)).filter((p): p is Passage => !!p);

  const support: Passage[] = [];
  const rejected: { passageRef: string; reason: string }[] = [];
  for (const p of offered) {
    const reason = rejectionFor(p, args.claim, args.at);
    if (reason) rejected.push({ passageRef: p.passageRef, reason });
    else support.push(p);
  }

  const cite = (p: Passage) =>
    `${p.documentTitle}${p.section ? ` §${p.section}` : ""}${p.page != null ? ` p.${p.page}` : ""} (rev ${p.revision})`;

  if (support.length) {
    const contradiction = (args.contradictions ?? []).find(c =>
      support.some(p => p.passageRef === c.aPassageRef) && support.some(p => p.passageRef === c.bPassageRef));
    if (contradiction) {
      return {
        claimRef: args.claim.claimRef, state: "conflicting", support, rejected,
        // Picking the higher score here would be inventing an answer the
        // documents do not give.
        line: `Sources disagree: ${support.map(cite).join(" vs ")}. ${contradiction.note}`,
      };
    }
    return {
      claimRef: args.claim.claimRef, state: "supported", support, rejected,
      line: `${args.claim.text} — ${support.map(cite).join("; ")}`,
    };
  }

  // Nothing stands. Say which kind of nothing.
  // A retired revision and one not yet in force are the same fact from two
  // directions: no revision in force supports this. Reporting them as merely
  // unsupported would hide that the company does address the subject.
  const outOfForce = (reason: string) => reason.includes("superseded") || reason.includes("take effect");
  const superseded = rejected.find(r => outOfForce(r.reason));
  if (superseded && rejected.every(r => outOfForce(r.reason))) {
    return {
      claimRef: args.claim.claimRef, state: "superseded", support: [], rejected,
      line: `The only source for this is no longer in force: ${superseded.reason}`,
    };
  }
  const scope = rejected.find(r => r.reason.includes("the question is about"));
  if (scope && rejected.every(r => r.reason.includes("the question is about"))) {
    return {
      claimRef: args.claim.claimRef, state: "out_of_scope", support: [], rejected,
      line: `The only source for this covers a different jurisdiction: ${scope.reason}`,
    };
  }
  return {
    claimRef: args.claim.claimRef, state: "unsupported", support: [], rejected,
    line: `Nothing in the loaded documents supports this. It may still be true; it is not something these documents say.`,
  };
}

/* ------------------------------------------------------------------ */
/* The whole answer                                                     */
/* ------------------------------------------------------------------ */

export type AnswerVerdict = {
  state: "verified" | "partially_supported" | "insufficient_evidence" | "conflicting";
  claims: ClaimVerdict[];
  /** What a person should be shown above the answer. */
  headline: string;
  /** Every distinct source, for the citation list. */
  sources: { documentRef: string; documentTitle: string; revision: string }[];
};

/**
 * Grade the answer as a whole.
 *
 * An answer is only `verified` when every claim in it stands. One unsupported
 * sentence inside four supported ones makes the whole thing partially
 * supported, because a reader who sees a citation list assumes it covers the
 * paragraph — and the one uncited sentence is exactly where the error will be.
 */
export function verifyAnswer(claims: readonly ClaimVerdict[]): AnswerVerdict {
  const sources = new Map<string, { documentRef: string; documentTitle: string; revision: string }>();
  for (const c of claims) {
    for (const p of c.support) {
      sources.set(`${p.documentRef}:${p.revision}`, { documentRef: p.documentRef, documentTitle: p.documentTitle, revision: p.revision });
    }
  }
  const list = Array.from(sources.values());

  if (!claims.length) {
    return { state: "insufficient_evidence", claims: [], headline: "Nothing was checked, so nothing is verified.", sources: [] };
  }
  const conflicting = claims.filter(c => c.state === "conflicting");
  if (conflicting.length) {
    return {
      state: "conflicting", claims: [...claims], sources: list,
      headline: `${conflicting.length} statement(s) have sources that disagree. Somebody has to decide which applies.`,
    };
  }
  const standing = claims.filter(c => c.state === "supported");
  if (standing.length === claims.length) {
    return { state: "verified", claims: [...claims], sources: list, headline: `All ${claims.length} statement(s) are supported by the loaded documents.` };
  }
  if (!standing.length) {
    return {
      state: "insufficient_evidence", claims: [...claims], sources: list,
      headline: "None of this is supported by the loaded documents.",
    };
  }
  return {
    state: "partially_supported", claims: [...claims], sources: list,
    headline: `${standing.length} of ${claims.length} statement(s) are supported; the rest are not. A citation list does not cover the uncited sentence.`,
  };
}

/** Only the claims a person needs to look at. */
export const needsAttention = (verdict: AnswerVerdict): ClaimVerdict[] =>
  verdict.claims.filter(c => c.state !== "supported");
