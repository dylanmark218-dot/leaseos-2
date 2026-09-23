/**
 * 0172 — "Explain this section": a retrieval-grounded study tutor.
 *
 * Pure. No model. Built on the same grounding the assistant uses
 * (`evidenceGrounding.verifyClaim/verifyAnswer`): the answer is what approved
 * lesson passages say, each line cited to its source and edition, and when
 * nothing approved supports an answer the tutor says UNKNOWN / REFER TO
 * AUTHORITY instead of answering from memory.
 *
 * Only passages whose governing source has been REVIEWED may support an
 * answer. An unreviewed source is shown as "where to look", never quoted as
 * the answer — the difference between study material and an authority is the
 * whole point of the Academy's source review.
 *
 * The tutor never says a learner passed an official test, never issues or
 * implies a credential, and never presents LeaseOS study text as law.
 */
import { MIN_SUPPORT_SCORE, verifyAnswer, verifyClaim, type Passage } from "./evidenceGrounding";

export type TutorPassage = {
  passageRef: string;
  sourceRef: string;
  sourceTitle: string;
  sourceUrl: string | null;
  sourceEdition: string | null;
  sourceReviewStatus: "unreviewed" | "reviewed" | "superseded" | "rejected";
  section: string | null;
  jurisdiction: string | null;
  text: string;
  companySpecific?: boolean;
};
export type TutorQuestion = { code: string; domain: string; prompt: string; options: readonly string[]; correctIndex: number; explanation: string; sourceRef?: string | null; sourceSection?: string | null };
export type TutorMode = "explain" | "quiz" | "why_wrong" | "more_examples";

export type TutorAnswer = {
  status: "GROUNDED" | "UNKNOWN_REFER_TO_AUTHORITY" | "REFUSED";
  mode: TutorMode;
  lines: string[];
  citations: { sourceRef: string; title: string; edition: string | null; section: string | null; url: string | null }[];
  referTo: { sourceRef: string; title: string; url: string | null; reviewStatus: string }[];
  practice: { code: string; prompt: string; options: readonly string[] }[];
  notice: string;
};

const STOP = new Set("a an and are as at be by can do does for from how i if in is it its me my of on or should so than that the their then there these this to was what when where which who why will with you your".split(" "));
export const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));

export function scorePassage(question: string, text: string): number {
  const q = Array.from(new Set(tokens(question)));
  if (!q.length) return 0;
  const p = new Set(tokens(text));
  const hits = q.filter(w => p.has(w) || Array.from(p).some(x => x.length > 4 && w.length > 4 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))))).length;
  return hits / q.length;
}

const FORBIDDEN: { re: RegExp; reply: string }[] = [
  { re: /\b(did|have) i pass(ed)?\b.*\b(official|government|knowledge|road|registry|test|exam)\b|\bam i (licen[cs]ed|certified|endorsed)\b/i, reply: "LeaseOS cannot tell you whether you passed an official government or provider test. Only the issuing authority or its examiner can. Your LeaseOS practice results are preparation only." },
  { re: /\b(issue|give|grant|add|create)\b.*\b(q|air[- ]?brake|licen[cs]e|endorsement|h2s|first aid|certificate)\b/i, reply: "LeaseOS study does not issue a provincial licence, road-test result, Q endorsement or external certificate. The Request Training button starts a handoff to the office instead." },
  { re: /\bis (this|that|it) (the )?(law|legal requirement|regulation)\b/i, reply: "LeaseOS study text is not law. The approved source it cites is linked below; for a legal requirement, read the authority's current publication." },
];

export function tutorAnswer(args: {
  mode: TutorMode;
  question: string;
  passages: readonly TutorPassage[];
  bank?: readonly TutorQuestion[];
  wrongAnswer?: { questionCode: string; chosenIndex: number } | null;
  at: Date;
  jurisdiction?: string | null;
}): TutorAnswer {
  const empty: Omit<TutorAnswer, "status" | "notice"> = { mode: args.mode, lines: [], citations: [], referTo: [], practice: [] };
  for (const f of FORBIDDEN) if (f.re.test(args.question)) return { ...empty, status: "REFUSED", lines: [f.reply], notice: f.reply };

  const scored = args.passages.map(p => ({ p, score: scorePassage(args.question, `${p.section ?? ""} ${p.text}`) })).sort((a, b) => b.score - a.score);
  const relevant = scored.filter(s => s.score >= MIN_SUPPORT_SCORE);
  const approved = relevant.filter(s => s.p.sourceReviewStatus === "reviewed");
  const referTo = uniqBy(relevant.filter(s => s.p.sourceReviewStatus !== "reviewed" && s.p.sourceReviewStatus !== "rejected").map(s => ({ sourceRef: s.p.sourceRef, title: s.p.sourceTitle, url: s.p.sourceUrl, reviewStatus: s.p.sourceReviewStatus })), x => x.sourceRef);

  if (args.mode === "why_wrong" && args.wrongAnswer && args.bank) {
    const q = args.bank.find(x => x.code === args.wrongAnswer!.questionCode);
    if (!q) return { ...empty, status: "UNKNOWN_REFER_TO_AUTHORITY", referTo, notice: "That question is not in the current bank." };
    const chosen = q.options[args.wrongAnswer.chosenIndex] ?? "(no answer)";
    const grounding = tutorAnswer({ ...args, mode: "explain", question: `${q.prompt} ${q.options[q.correctIndex]}`, wrongAnswer: null });
    const lines = [
      `You chose: "${chosen}". The expected answer is: "${q.options[q.correctIndex]}".`,
      `Why: ${q.explanation}`,
      ...(grounding.status === "GROUNDED" ? grounding.lines.slice(0, 2) : []),
    ];
    return { ...empty, status: grounding.status === "GROUNDED" ? "GROUNDED" : "UNKNOWN_REFER_TO_AUTHORITY", lines, citations: grounding.citations, referTo: grounding.referTo, notice: grounding.status === "GROUNDED" ? "Explanation from the LeaseOS original question bank, supported by the approved source cited." : "The bank explanation is shown, but no approved source passage supports it yet — check the official source before relying on it." };
  }

  if (args.mode === "quiz" || args.mode === "more_examples") {
    const topic = new Set(tokens(args.question));
    const pool = (args.bank ?? []).map(q => ({ q, s: tokens(`${q.domain} ${q.prompt} ${q.sourceSection ?? ""}`).filter(t => topic.has(t)).length })).filter(x => x.s > 0 || topic.size === 0).sort((a, b) => b.s - a.s);
    const practice = pool.slice(0, args.mode === "quiz" ? 1 : 5).map(x => ({ code: x.q.code, prompt: x.q.prompt, options: x.q.options }));
    return { ...empty, status: practice.length ? "GROUNDED" : "UNKNOWN_REFER_TO_AUTHORITY", practice, referTo, notice: practice.length ? "Original LeaseOS practice questions — not government exam questions." : "No practice question in the current bank covers that topic." };
  }

  if (!approved.length) {
    return { ...empty, status: "UNKNOWN_REFER_TO_AUTHORITY", referTo, lines: ["UNKNOWN — the approved training sources loaded for this course do not support an answer. Refer to the authority's current publication."], notice: referTo.length ? "Related material exists but its source has not been reviewed, so it is not quoted as an answer." : "Nothing in the approved sources addresses this." };
  }

  // Extractive: each sentence of a supporting passage is a claim citing that passage, verified by the shared grounding rule.
  const top = approved.slice(0, 3);
  const asPassage = (s: { p: TutorPassage; score: number }): Passage => ({
    passageRef: s.p.passageRef, documentRef: s.p.sourceRef, documentTitle: s.p.sourceTitle, section: s.p.section, page: null,
    text: s.p.text, revision: s.p.sourceEdition ?? "unstated", effectiveFrom: null, supersededAt: null, jurisdiction: s.p.jurisdiction, score: s.score,
  });
  const passages = top.map(asPassage);
  const claims = top.flatMap(s => s.p.text.split(/(?<=[.!?])\s+/).filter(x => x.trim().length > 12).slice(0, 3).map((text, i) => ({ claimRef: `${s.p.passageRef}#${i}`, text, citedPassageRefs: [s.p.passageRef], jurisdiction: args.jurisdiction ?? null })));
  const verdicts = claims.map(c => verifyClaim({ claim: c, passages, at: args.at }));
  const answer = verifyAnswer(verdicts);
  if (answer.state === "insufficient_evidence" || answer.state === "conflicting") {
    return { ...empty, status: "UNKNOWN_REFER_TO_AUTHORITY", referTo, lines: [answer.headline, "UNKNOWN — refer to the authority."], notice: answer.headline };
  }
  const supported = verdicts.filter(v => v.state === "supported");
  return {
    ...empty,
    status: "GROUNDED",
    lines: supported.map(v => claims.find(c => c.claimRef === v.claimRef)!.text),
    citations: uniqBy(top.map(s => ({ sourceRef: s.p.sourceRef, title: s.p.sourceTitle, edition: s.p.sourceEdition, section: s.p.section, url: s.p.sourceUrl })), c => `${c.sourceRef}:${c.section}`),
    referTo,
    notice: top.some(s => s.p.companySpecific) ? "Includes company-specific training content, identified as such — company procedure, not regulation." : "Quoted from approved study material with its source. Study material is preparation; the official publication governs.",
  };
}

function uniqBy<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}
