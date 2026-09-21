/**
 * TDG Part 6 certificate contents — verified against the consolidated regulation.
 *
 * Source: SOR/2001-286, Part 6, read from laws-lois.justice.gc.ca on 2026-09-11.
 * That consolidation is current to 2026-06-21, last amended 2026-06-17.
 * Note s.6.2 carries amendments SOR/2026-112 ss. 82 and 297 — the list below is
 * the post-amendment text, not a pre-2026 copy.
 *
 * Proposed for checkpoint 0089. Unblocks the `trainingAspects` derivation that
 * 0088 currently leaves as optional free text.
 */

import { stableHash } from "./trainingAcademy";

/**
 * s.6.2 — a person is adequately trained if they have a sound knowledge of all
 * the topics in (a) to (m) *that relate directly to the person's duties and to
 * the dangerous goods the person is expected to handle, offer for transport or
 * transport*.
 *
 * The scoping clause is the whole reason aspects are derivable rather than
 * free text: aspects = the (a)–(m) subset the course version actually covers,
 * qualified by the dangerous-goods scope the employer is certifying.
 */
export const TDG_6_2_TOPICS = [
  { ref: "6.2(a)", code: "classification", label: "the classification criteria and test methods in Part 2 (Classification)" },
  { ref: "6.2(b)", code: "shipping_names", label: "shipping names" },
  { ref: "6.2(c)", code: "schedules", label: "the use of Schedules 1, 2 and 3" },
  { ref: "6.2(d)", code: "documentation", label: "the shipping document and train consist requirements in Part 3 (Documentation)" },
  { ref: "6.2(e)", code: "marks", label: "the dangerous goods marks requirements in Part 4 (Dangerous Goods Marks)" },
  { ref: "6.2(f)", code: "containment", label: "the compliance marks requirements, safety requirements and safety standards in Part 5" },
  { ref: "6.2(g)", code: "erap", label: "the ERAP requirements in Part 7 (Emergency Response Assistance Plan)" },
  { ref: "6.2(h)", code: "reporting", label: "the report requirements in Part 8 (Reporting Requirements)" },
  { ref: "6.2(i)", code: "safe_handling", label: "safe handling and transportation practices, including the characteristics of the dangerous goods" },
  { ref: "6.2(j)", code: "equipment", label: "the proper use of any equipment used to handle or transport the dangerous goods" },
  { ref: "6.2(k)", code: "emergency_measures", label: "the reasonable emergency measures to reduce or eliminate danger from an accidental release" },
  { ref: "6.2(l)", code: "air", label: "for air transport, ICAO Technical Instructions Part 1 Chapter 4 and Part 12 (Air)" },
  { ref: "6.2(m)", code: "marine", label: "for marine transport, the IMDG Code and Part 11 (Marine)" },
] as const;

export type Tdg62TopicCode = (typeof TDG_6_2_TOPICS)[number]["code"];

/** 6.2(a)-(k) apply whatever the mode. */
export const TDG_BASE_TOPIC_CODES: readonly Tdg62TopicCode[] = [
  "classification", "shipping_names", "schedules", "documentation", "marks",
  "containment", "erap", "reporting", "safe_handling", "equipment", "emergency_measures",
];

/** Retained name for road; air and marine are out of scope for it. */
export const TDG_ROAD_TOPIC_CODES = TDG_BASE_TOPIC_CODES;

export type TdgMode = "road" | "rail" | "vessel" | "air";

/**
 * 6.2(l) and (m) are mode-conditional: the air topic applies "in the case of
 * transport by aircraft", the marine topic "in the case of transport by vessel".
 * A course that never covered (l) cannot support a certificate whose statement
 * says "by aircraft", so the requirement is per mode, not per scope wording.
 */
export function requiredTopicsForMode(mode: TdgMode): readonly Tdg62TopicCode[] {
  if (mode === "air") return [...TDG_BASE_TOPIC_CODES, "air"];
  if (mode === "vessel") return [...TDG_BASE_TOPIC_CODES, "marine"];
  return TDG_BASE_TOPIC_CODES;
}

/** The topic a mode adds on top of the base set, if any. */
export function modeConditionalTopic(mode: TdgMode): Tdg62TopicCode | null {
  return mode === "air" ? "air" : mode === "vessel" ? "marine" : null;
}

/** s.6.3(1)(c) — the expiry date must be preceded by these words. */
export const TDG_EXPIRY_LABEL_EN = "Expires on";
export const TDG_EXPIRY_LABEL_FR = "Date d'expiration";

export type CertificateContents = {
  /** 6.3(1)(a) */ employerName: string | null;
  /** 6.3(1)(a) */ employerBusinessAddress: string | null;
  /** 6.3(1)(b) */ employeeName: string | null;
  /** 6.3(1)(c) */ expiresAt: Date | null;
  /** 6.3(1)(d) — derived, not typed by the issuer */ trainingAspects: TrainingAspects | null;
};

export type TrainingAspects = {
  /** The dangerous-goods scope being certified, e.g. "Class 3, Flammable Liquids". */
  dangerousGoodsScope: string;
  /** Which s.6.2 topics the course version covers. */
  topicCodes: readonly Tdg62TopicCode[];
  /** Rendered for the certificate face. */
  statement: string;
  /** Course version this was derived from — so the claim is traceable to content. */
  courseVersionRef: string;
};

/**
 * Derive 6.3(1)(d) aspects from what the course version actually covers.
 *
 * Free text here is the one thing a certificate must not permit: it lets an
 * issuer write scope the training never covered. Deriving from the course
 * version's topic coverage means the aspects on the certificate are provably
 * the aspects the person was trained and assessed on.
 *
 * Phrasing follows Transport Canada's own examples, which take the form
 * "All aspects of handling and transporting propane by vessel".
 */
export function deriveTrainingAspects(args: {
  courseVersionRef: string;
  coveredTopicCodes: readonly Tdg62TopicCode[];
  dangerousGoodsScope: string;
  mode: TdgMode;
}): { aspects: TrainingAspects | null; blockers: string[] } {
  const blockers: string[] = [];
  const scope = args.dangerousGoodsScope.trim();

  if (!scope) blockers.push("A dangerous-goods scope is required — s.6.3(1)(d) certifies the aspects for which the employee is trained");
  if (args.coveredTopicCodes.length === 0) blockers.push("The course version covers no s.6.2 topics, so no training aspects can be derived");

  // The mode-conditional topic is not optional. Every statement this function
  // produces names the mode, so a course that never covered 6.2(l) cannot back a
  // certificate reading "by aircraft" however narrow the goods scope is.
  const conditional = modeConditionalTopic(args.mode);
  if (conditional && !args.coveredTopicCodes.includes(conditional)) {
    const ref = TDG_6_2_TOPICS.find(t => t.code === conditional)!.ref;
    blockers.push(`Mode "${args.mode}" requires ${ref}, which the course version does not cover`);
  }

  const missing = requiredTopicsForMode(args.mode).filter(c => !args.coveredTopicCodes.includes(c));
  // Otherwise not automatically fatal: s.6.2 scopes topics to the person's duties
  // and the goods they handle, so a narrow scope on a partial course is legitimate.
  // But an employer certifying "all" on a course missing core topics is asserting
  // more than the content supports.
  if (missing.length > 0 && /^all\b/i.test(scope)) {
    blockers.push(`Scope claims "all" but the course version does not cover: ${missing.join(", ")}`);
  }

  if (blockers.length > 0) return { aspects: null, blockers };

  const verb = args.mode === "road" || args.mode === "rail" ? "handling and transporting" : "handling, offering for transport and transporting";
  const modeWord = { road: "by road vehicle", rail: "by railway vehicle", vessel: "by vessel", air: "by aircraft" }[args.mode];

  return {
    aspects: {
      dangerousGoodsScope: scope,
      topicCodes: args.coveredTopicCodes,
      statement: `All aspects of ${verb} ${scope} ${modeWord}`,
      courseVersionRef: args.courseVersionRef,
    },
    blockers: [],
  };
}

/**
 * s.6.3(1) content completeness. A certificate missing any required item is
 * non-compliant on its face, so this gates issuance rather than warning after.
 */
export function certificateContentDecision(args: {
  contents: CertificateContents;
  credentialBoundary: "employer_certificate" | "company_certificate";
  regulated: boolean;
}) {
  const blockers: string[] = [];
  if (!args.regulated || args.credentialBoundary !== "employer_certificate") {
    return { permitted: true, blockers, contentHash: null as string | null };
  }

  const c = args.contents;
  if (!c.employerName?.trim()) blockers.push("s.6.3(1)(a): the employer's name is required on the certificate");
  if (!c.employerBusinessAddress?.trim()) blockers.push("s.6.3(1)(a): the address of the employer's place of business is required on the certificate");
  if (!c.employeeName?.trim()) blockers.push("s.6.3(1)(b): the employee's name is required on the certificate");
  if (!c.expiresAt) blockers.push("s.6.3(1)(c): an expiry date is required on the certificate");
  if (!c.trainingAspects) blockers.push("s.6.3(1)(d): the aspects for which the employee is trained are required, derived from the course version's s.6.2 topic coverage");

  if (blockers.length > 0) return { permitted: false, blockers, contentHash: null as string | null };

  return {
    permitted: true,
    blockers,
    contentHash: stableHash({
      employerName: c.employerName,
      employerBusinessAddress: c.employerBusinessAddress,
      employeeName: c.employeeName,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      trainingAspects: c.trainingAspects,
      expiryLabelEn: TDG_EXPIRY_LABEL_EN,
      expiryLabelFr: TDG_EXPIRY_LABEL_FR,
    }) as string | null,
  };
}

/** s.6.3(1)(c) — render the expiry line with the words the regulation specifies. */
export function renderExpiryLine(expiresAt: Date, locale: "en" | "fr" = "en"): string {
  const label = locale === "fr" ? TDG_EXPIRY_LABEL_FR : TDG_EXPIRY_LABEL_EN;
  return `${label} ${expiresAt.toISOString().slice(0, 10)}`;
}
