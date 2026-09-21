/**
 * v22.20 — how good the retrieval is, answered with a number or not at all.
 *
 * Pure. No network, no database.
 *
 * The assistant currently reports how well a passage matched the question. It
 * has never reported whether the right passage was found at all, and those are
 * different questions with different failure modes. A confident citation from
 * the second-best passage looks exactly like a confident citation from the best
 * one, and the reader has no way to tell that the paragraph which actually
 * answered their question was never retrieved.
 *
 * So recall is measured against labelled probes: somebody who knows the corpus
 * writes down a question and the passages that ought to answer it, and the
 * retriever is scored against that. Two consequences worth stating.
 *
 * **Unmeasured is a state, not a zero.** A corpus nobody has probed has unknown
 * retrieval quality. Reporting that honestly is the difference between "we do
 * not know how often this misses" and the silence that reads as "it doesn't".
 *
 * **A small probe set measures little.** Three probes that all pass say almost
 * nothing, and a system that reported 100% from three would be worse than one
 * reporting nothing — so the sample size travels with the result and the grade
 * refuses to improve past what the sample can support.
 */

/**
 * Where a probe's question came from.
 *
 * A question written while looking at the passage inherits its vocabulary, so a
 * set of those measures whether retrieval finds a passage from its own words —
 * which it nearly always does, and which is not the thing anybody wanted to
 * know. A question somebody actually asked is the real test.
 */
export type ProbeOrigin = "authored_from_document" | "real_question";

export type Probe = {
  probeRef: string;
  question: string;
  origin: ProbeOrigin;
  /** Passages a person who knows the corpus says should answer this. */
  expectedPassageRefs: readonly string[];
  /** Who asserted that, since a probe is a claim like any other. */
  authoredByUserId: number;
};

export type ProbeResult = {
  probeRef: string;
  question: string;
  origin: ProbeOrigin;
  expected: string[];
  retrieved: string[];
  found: string[];
  missed: string[];
  /** Fraction of expected passages the retriever actually surfaced. */
  recall: number;
  /** Where the first expected passage landed, or null if it never appeared. */
  firstExpectedRank: number | null;
};

/**
 * Score one probe against what retrieval returned.
 *
 * Rank matters separately from recall: a passage retrieved eleventh when the
 * answer shows three is retrieved and useless, and a recall figure that counts
 * it as found would be measuring the wrong thing.
 */
export function scoreProbe(probe: Probe, retrieved: readonly string[], k: number): ProbeResult {
  const topK = retrieved.slice(0, k);
  const expected = [...probe.expectedPassageRefs];
  const found = expected.filter(ref => topK.includes(ref));
  const missed = expected.filter(ref => !topK.includes(ref));
  const ranks = expected.map(ref => topK.indexOf(ref)).filter(i => i >= 0);
  return {
    probeRef: probe.probeRef, question: probe.question, origin: probe.origin, expected,
    retrieved: topK, found, missed,
    recall: expected.length ? found.length / expected.length : 0,
    firstExpectedRank: ranks.length ? Math.min(...ranks) + 1 : null,
  };
}

export type RetrievalGrade = "unmeasured" | "insufficient_sample" | "poor" | "adequate" | "good";

export type RetrievalQuality = {
  grade: RetrievalGrade;
  probeCount: number;
  /** Mean recall across probes, or null when there is nothing to average. */
  meanRecall: number | null;
  /** Probes where nothing expected was retrieved at all. */
  completeMisses: string[];
  k: number;
  line: string;
};

import { domainTerms } from "./domainTokens";

/** Below this, a result describes the probes rather than the retriever. */
export const MIN_MEANINGFUL_PROBES = 20;

/**
 * Grade a corpus's retrievability.
 *
 * The grade cannot exceed what the sample supports: nineteen perfect probes
 * report `insufficient_sample`, not `good`. That is deliberately frustrating,
 * because the alternative is a green number derived from a handful of examples
 * somebody wrote in an afternoon.
 */
export function gradeRetrieval(results: readonly ProbeResult[], k: number, answerK?: number): RetrievalQuality {
  // recall@20 does not describe an assistant that shows eight. A measurement
  // taken at a different depth than the product uses is a different claim.
  const depthNote = answerK != null && answerK !== k
    ? ` Measured at ${k} while answers show ${answerK}; this does not describe what a reader sees.`
    : "";
  if (!results.length) {
    return {
      grade: "unmeasured", probeCount: 0, meanRecall: null, completeMisses: [], k,
      line: "No probes have been run. Retrieval quality is unknown, which is not the same as fine." + depthNote,
    };
  }
  /* Graded on real questions alone.
   *
   * Averaging across every probe let one real question unlock a figure
   * dominated by questions written from the passages — twenty-five easy
   * self-vocabulary hits and one real-world miss came out near ninety per cent
   * and reported the retriever as adequate. Document-authored probes are worth
   * keeping: they catch mechanical breakage and regressions. They are worth
   * nothing as evidence of how retrieval behaves for people, so they carry no
   * weight in the grade. */
  const real = results.filter(r => r.origin === "real_question");
  const meanRecall = real.length
    ? real.reduce((sum, r) => sum + r.recall, 0) / real.length
    : results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const completeMisses = results.filter(r => r.found.length === 0).map(r => r.probeRef);

  if (real.length < MIN_MEANINGFUL_PROBES) {
    return {
      grade: "insufficient_sample", probeCount: results.length, meanRecall, completeMisses, k,
      line: real.length === 0
        ? `${results.length} probe(s), none of them a question anybody asked. That measures retrieval against its own vocabulary, not against how people ask.` + depthNote
        : `${real.length} real question(s) of ${results.length} probes, averaging ${(meanRecall * 100).toFixed(0)}% — too few to describe the retriever rather than the probes.` + depthNote,
    };
  }

  if (results.length < MIN_MEANINGFUL_PROBES) {
    return {
      grade: "insufficient_sample", probeCount: results.length, meanRecall, completeMisses, k,
      line: `${results.length} probe(s) at recall@${k} averaging ${(meanRecall * 100).toFixed(0)}% — too few to describe the retriever rather than the probes.` + depthNote,
    };
  }
  const grade: RetrievalGrade = meanRecall >= 0.9 ? "good" : meanRecall >= 0.7 ? "adequate" : "poor";
  return {
    grade, probeCount: results.length, meanRecall, completeMisses, k,
    line: `recall@${k} is ${(meanRecall * 100).toFixed(0)}% across ${real.length} real question(s)${completeMisses.length ? `, with ${completeMisses.length} question(s) finding nothing expected` : ""}.` + depthNote,
  };
}

/* ------------------------------------------------------------------ */
/* What an answer should say about its own retrieval                    */
/* ------------------------------------------------------------------ */

export type AnswerCaveat = {
  /** Whether the answer may be presented without a retrieval caveat. */
  clean: boolean;
  caveat: string | null;
};

/**
 * What to say alongside an answer, given what is known about retrieval.
 *
 * An answer from an unmeasured corpus is not wrong — it is uncalibrated, and
 * the reader deserves to know the difference. The wording avoids undermining a
 * correct citation while refusing to imply completeness nobody has established.
 */
export function caveatFor(quality: RetrievalQuality): AnswerCaveat {
  switch (quality.grade) {
    case "unmeasured":
      return {
        clean: false,
        caveat: "Retrieval has not been measured on this corpus, so how often it misses a relevant passage is unknown. What is cited is in the documents; whether something better was missed is not established.",
      };
    case "insufficient_sample":
      return {
        clean: false,
        caveat: `Retrieval has been measured on only ${quality.probeCount} question(s) — too few to say how it behaves generally.`,
      };
    case "poor":
      return {
        clean: false,
        caveat: `Retrieval finds the expected passage about ${((quality.meanRecall ?? 0) * 100).toFixed(0)}% of the time on this corpus. Treat an answer as a starting point rather than a complete one.`,
      };
    case "adequate":
      return { clean: false, caveat: `Retrieval recall is ${((quality.meanRecall ?? 0) * 100).toFixed(0)}% on this corpus; a relevant passage is sometimes missed.` };
    case "good":
      return { clean: true, caveat: null };
  }
}

/* ------------------------------------------------------------------ */
/* Where lexical retrieval is known to fail                             */
/* ------------------------------------------------------------------ */

export type VocabularyGap = { probeRef: string; questionTerms: string[]; note: string };

/**
 * Probes that missed while sharing no vocabulary with what they sought.
 *
 * This is the diagnosis term-overlap retrieval cannot make about itself: a
 * question asking about "brake adjustment" against a manual saying "pushrod
 * travel" is not a ranking problem, and no amount of tuning the score fixes
 * it. Naming that distinguishes "the retriever ranked badly" from "the
 * retriever could never have found this", which are different repairs.
 */
/**
 * A crude stem, for comparing question words to passage words.
 *
 * "brakes" against "brake" is not a vocabulary gap — it is the same word, and
 * calling it a gap would send somebody to buy embeddings for a problem a
 * suffix caused. English plurals and common verb endings only; this is a
 * classifier for a diagnosis, not a linguistics engine, and it errs toward
 * calling things the same word rather than different ones.
 */
export function stem(word: string): string {
  const w = word.toLowerCase();
  // "es" only where it is genuinely the plural ending — stripping it from
  // "brakes" gives "brak", which does not match "brake" and would report the
  // commonest word in this domain as a vocabulary gap.
  if (/(?:s|x|z|ch|sh)es$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  for (const suffix of ["ing", "ed"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  }
  return w;
}

const sharesStem = (term: string, body: string): boolean => {
  const t = stem(term);
  return domainTerms(body).some(w => stem(w) === t);
};

export function vocabularyGaps(
  results: readonly ProbeResult[],
  bodyOf: (passageRef: string) => string | null,
): VocabularyGap[] {
  const gaps: VocabularyGap[] = [];
  for (const r of results) {
    if (r.found.length) continue;
    const terms = domainTerms(r.question);
    const bodies = r.expected.map(bodyOf).filter((b): b is string => !!b).map(b => b.toLowerCase());
    if (!bodies.length) continue;
    // Compared on stems: a plural or a verb ending is the same word, and
    // misclassifying that as a vocabulary gap would recommend the wrong repair.
    const shared = terms.filter(t => bodies.some(b => sharesStem(t, b)));
    if (!shared.length) {
      gaps.push({
        probeRef: r.probeRef, questionTerms: terms,
        note: "The question and the passage share no words. Term overlap cannot bridge this; only a retriever that understands meaning can.",
      });
    }
  }
  return gaps;
}
