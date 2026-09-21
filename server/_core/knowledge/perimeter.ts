/**
 * LeaseOS AI — the request perimeter, and the learning intake.
 *
 * Two gates, deliberately separate, because they answer different questions:
 *
 *   **Request perimeter** — *may this be asked of LeaseOS at all?*
 *     Refuses off-domain work: writing code, building apps, general assistance.
 *     Not on principle — on cost. Every off-domain request spends model time,
 *     context and money that the fleet is paying for, and an assistant that
 *     will write somebody's Python script is an assistant nobody trusts to
 *     stay inside the compliance envelope either.
 *
 *   **Learning intake** — *may LeaseOS learn this?*
 *     Deliberately wide. The internet is fair game for anything that bears on
 *     commercial operations, and staying current on regulation and technology
 *     is the point. What is narrow is not the *source* but the *destination*:
 *     discovery may be autonomous, promotion into authoritative rules may not.
 *
 * The perimeter document is explicit on the second:
 *
 *   "I would not let the AI continuously self-teach from user conversations
 *    into its authoritative regulatory database... Once verified, they can
 *    become operational knowledge. That protects us from one bad conversation
 *    contaminating a fleet-wide compliance rule."
 *
 * So: learn widely, record with provenance, promote only through review.
 */

import { AUTHORITY_LEVELS, type AuthorityLevel, type KnowledgeAuthority } from "./admission";

/* ------------------------------------------------------------------ */
/* The domains LeaseOS is for                                          */
/* ------------------------------------------------------------------ */

/** The knowledge universe from the perimeter document, unabridged. */
export const PERIMETER_DOMAINS = [
  "commercial_transportation", "hours_of_service", "dangerous_goods",
  "equipment_operations", "mechanical_fleet", "oilfield_operations",
  "construction", "logging_forestry", "routing_navigation", "dispatch",
  "safety_ohs", "training", "office_administration", "billing",
  "payroll_workforce", "customer_operations", "environmental",
  "emergency_management", "company_governance", "audit_enforcement",
] as const;

export type PerimeterDomain = (typeof PERIMETER_DOMAINS)[number];

/* ------------------------------------------------------------------ */
/* Request classification                                              */
/* ------------------------------------------------------------------ */

export type RequestVerdict =
  | { admitted: true; domain: PerimeterDomain; note?: string }
  | { admitted: false; code: RefusalCode; reason: string; suggestion?: string };

export type RefusalCode =
  | "OUT_OF_PERIMETER"
  | "SOFTWARE_DEVELOPMENT"
  | "GENERAL_ASSISTANT"
  | "UNCLASSIFIABLE";

/**
 * Work LeaseOS declines even though the model could do it.
 *
 * Software development is called out on its own because it is the most likely
 * misuse: the assistant is competent at it, the request looks harmless, and it
 * is the fastest way to turn a fleet's AI budget into somebody's side project.
 */
const SOFTWARE_SIGNALS = [
  "write code", "write a script", "build an app", "build me a", "debug this",
  "refactor", "unit test", "regex", "sql query for my", "python", "javascript",
  "typescript", "react component", "css", "docker", "kubernetes", "terraform",
  "git ", "pull request", "stack trace", "npm install", "compile",
];

/** General-assistant work with no commercial-operations bearing. */
const GENERAL_SIGNALS = [
  "write a poem", "tell me a joke", "recipe", "movie", "workout", "vacation",
  "birthday", "gift idea", "essay about", "homework", "translate this song",
  "who won", "sports score", "stock price", "crypto", "dating",
];

/**
 * Words that place a request inside a domain.
 *
 * Deliberately generous — a driver asking in plain language about "the gate at
 * the lease" should land inside, and a false refusal is worse than a false
 * admission here. The admission gate downstream still governs what may be
 * *answered with*.
 */
const DOMAIN_SIGNALS: Readonly<Record<PerimeterDomain, readonly string[]>> = {
  commercial_transportation: ["nsc", "safety fitness", "cvip", "roadside", "cargo securement", "weights and dimensions", "carrier", "commercial vehicle", "trip inspection"],
  hours_of_service: ["hours of service", "hos", "eld", "logbook", "log book", "cycle", "sleeper berth", "deferral", "duty status", "off duty", "on duty", "hours can i drive", "how many hours", "hours left", "drive today", "hours remaining"],
  dangerous_goods: ["tdg", "dangerous goods", "un number", "placard", "shipping document", "erap", "class 3 flammable", "h2s", "hazmat"],
  equipment_operations: ["hydrovac", "vac truck", "vacuum truck", "picker", "crane", "winch tractor", "excavator", "loader", "grader", "dozer", "pto", "pump"],
  mechanical_fleet: ["defect", "work order", "preventive maintenance", "brake", "air system", "tire", "suspension", "engine hours", "service interval", "recall", "out of service"],
  oilfield_operations: ["lease", "lsd", "well", "rig", "disposal", "produced water", "ground disturbance", "site orientation", "battery site"],
  construction: ["haul road", "excavation", "lifting", "traffic accommodation", "site safety", "ground disturbance"],
  logging_forestry: ["logging", "forestry", "log truck", "scale", "forestry road", "radio calling"],
  routing_navigation: ["route", "routing", "bridge", "clearance", "road ban", "seasonal restriction", "truck route", "detour", "gps", "map"],
  dispatch: ["dispatch", "assign", "readiness", "qualified to take", "who can take", "job ready", "what am i missing"],
  safety_ohs: ["hazard assessment", "flha", "jsa", "jha", "ppe", "incident", "near miss", "emergency response", "competency"],
  training: ["training", "course", "certification", "air brake", "class 1", "whmis", "refresher", "quiz", "learn", "teach me"],
  office_administration: ["records", "expiry", "permit", "licence", "license", "insurance", "audit prep", "retention", "correspondence"],
  billing: ["field ticket", "invoice", "billing", "rate card", "standby", "disposal ticket", "job number", "charge"],
  payroll_workforce: ["payroll", "timecard", "subsistence", "living out allowance", "hours worked", "entitlement"],
  customer_operations: ["customer", "client portal", "job specification", "service verification", "contract requirement"],
  environmental: ["spill", "waste classification", "manifest", "contaminated", "environmental"],
  emergency_management: ["collision", "rollover", "evacuation", "lost communication", "medical event", "escalation"],
  company_governance: ["company policy", "sop", "authorization limit", "supervisory", "approval chain"],
  audit_enforcement: ["audit", "evidence package", "inspection history", "compliance exception", "enforcement"],
};

const has = (text: string, signals: readonly string[]): string | null =>
  signals.find((s) => text.includes(s)) ?? null;

/**
 * Terms of art that decide a domain regardless of what else matched.
 *
 * Length was the first tie-break and it was a proxy for specificity that broke
 * immediately: "what PPE do I need on that lease" went to oilfield, because
 * "lease" is longer than "ppe". It is also a far commoner word. Specificity is
 * the thing that matters, so it is stated rather than inferred.
 */
const STRONG_SIGNALS: Readonly<Record<string, PerimeterDomain>> = {
  ppe: "safety_ohs", flha: "safety_ohs", jsa: "safety_ohs", jha: "safety_ohs",
  tdg: "dangerous_goods", "un number": "dangerous_goods", placard: "dangerous_goods", h2s: "dangerous_goods",
  hos: "hours_of_service", eld: "hours_of_service", logbook: "hours_of_service",
  cvip: "commercial_transportation", nsc: "commercial_transportation",
  lsd: "oilfield_operations", hydrovac: "equipment_operations",
  whmis: "training", "air brake": "training",
};

/** A term of art, matched on a word boundary so "hos" does not match "hose". */
const strongHit = (text: string): { domain: PerimeterDomain; signal: string } | null => {
  for (const [signal, domain] of Object.entries(STRONG_SIGNALS)) {
    const boundary = new RegExp(`(^|[^a-z0-9])${signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    if (boundary.test(text)) return { domain, signal };
  }
  return null;
};

/**
 * Decide whether a request belongs to LeaseOS.
 *
 * Runs **before** retrieval and before any model call. That ordering is the
 * whole point: an off-domain request should cost a string comparison, not a
 * context window.
 */
export function classifyRequest(raw: string): RequestVerdict {
  const text = raw.toLowerCase().trim();

  if (text.length === 0) {
    return { admitted: false, code: "UNCLASSIFIABLE", reason: "empty request" };
  }

  // Domain first. A dispatcher asking for "a query to find units out of
  // service" is asking an operations question, and refusing it because it
  // contains the word "query" would be the gate failing at its job.
  //
  // Matched by **longest signal**, not by whichever domain is declared first.
  // The first version took the first hit in key order, which sent "air brake
  // ticket expires" to mechanical_fleet on "brake" and "what PPE do I need on
  // that lease" to oilfield on "lease". Both are real questions answered by the
  // wrong domain, which is worse than a refusal because nobody sees it happen.
  const strong = strongHit(text);
  if (strong) return { admitted: true, domain: strong.domain, note: `matched term of art "${strong.signal}"` };

  const matches: { domain: PerimeterDomain; signal: string }[] = [];
  for (const d of Object.keys(DOMAIN_SIGNALS) as PerimeterDomain[]) {
    for (const signal of DOMAIN_SIGNALS[d]) {
      if (text.includes(signal)) matches.push({ domain: d, signal });
    }
  }

  if (matches.length > 0) {
    const best = matches.reduce((a, b) => (b.signal.length > a.signal.length ? b : a));
    return { admitted: true, domain: best.domain, note: `matched "${best.signal}"` };
  }

  const software = has(text, SOFTWARE_SIGNALS);
  if (software) {
    return {
      admitted: false, code: "SOFTWARE_DEVELOPMENT",
      reason: `LeaseOS is a commercial-operations assistant, not a development tool (matched "${software}")`,
      suggestion: "If this is about LeaseOS itself, raise it with the engineering team rather than here.",
    };
  }

  const general = has(text, GENERAL_SIGNALS);
  if (general) {
    return {
      admitted: false, code: "GENERAL_ASSISTANT",
      reason: `outside the commercial-operations perimeter (matched "${general}")`,
      suggestion: "LeaseOS answers questions about trucks, jobs, compliance, equipment, safety, billing and training.",
    };
  }

  return {
    admitted: false, code: "OUT_OF_PERIMETER",
    reason: "no commercial-operations subject was recognised in this request",
    suggestion: "Ask about a job, unit, driver, route, document, ticket or regulation and LeaseOS will answer.",
  };
}

/* ------------------------------------------------------------------ */
/* Learning intake                                                     */
/* ------------------------------------------------------------------ */

export type LearningOrigin =
  | "web_discovery"        // the AI went and found it
  | "regulator_feed"       // a watched authority published something
  | "user_statement"       // somebody told the assistant
  | "field_observation"    // a driver reported it from a job
  | "job_outcome"          // derived from how work actually went
  | "vendor_document";     // a manufacturer or supplier document

/**
 * Where a piece of learned material is allowed to land.
 *
 * The distinction the perimeter insists on. Everything may be *recorded*;
 * almost nothing may be *promoted* without a person.
 */
export type LearningDestination =
  | "discovery_queue"      // recorded, searchable by reviewers, not answerable
  | "operational_knowledge"// Level E — usable to explain, never to authorize
  | "authoritative_rules"; // Level A–C — requires human verification, always

export type LearningIntake = {
  origin: LearningOrigin;
  domain: PerimeterDomain;
  claim: string;
  sourceUrl?: string;
  observedAt: Date;
  /** Whoever or whatever produced it, for the provenance trail. */
  reportedBy: string;
};

export type IntakeDecision = {
  destination: LearningDestination;
  authorityLevel: AuthorityLevel;
  requiresHumanReview: boolean;
  reason: string;
};

/**
 * Route learned material to where it may go.
 *
 * No origin routes straight to `authoritative_rules`. Not a regulator feed, not
 * a web find, not a hundred drivers agreeing. A regulator publishing something
 * is excellent evidence *for* a reviewer; it is not a reviewer.
 */
export function routeLearning(intake: LearningIntake): IntakeDecision {
  switch (intake.origin) {
    case "regulator_feed":
      return {
        destination: "discovery_queue", authorityLevel: "unverified", requiresHumanReview: true,
        reason: "a regulator publication is strong evidence for a rule change and still needs a person to establish jurisdiction, effective date and applicability",
      };
    case "web_discovery":
      return {
        destination: "discovery_queue", authorityLevel: "unverified", requiresHumanReview: true,
        reason: "found by the assistant; nothing found on the internet enters the rule store without verification",
      };
    case "vendor_document":
      return {
        destination: "discovery_queue", authorityLevel: "unverified", requiresHumanReview: true,
        reason: "manufacturer material is recognized standard once identified, but the document and its applicability must be confirmed first",
      };
    case "field_observation":
    case "job_outcome":
      return {
        // This is the learning that can be autonomous, because it describes how
        // work went rather than what the law is.
        destination: "operational_knowledge", authorityLevel: "operational", requiresHumanReview: false,
        reason: "operational knowledge: it may explain and inform, and may never support a compliance or dispatch decision",
      };
    case "user_statement":
      return {
        destination: "discovery_queue", authorityLevel: "unverified", requiresHumanReview: true,
        reason: "one conversation must not be able to change a fleet-wide rule",
      };
  }
}

/**
 * Promote reviewed material into the authoritative store.
 *
 * The only path to Level A–C, and it will not run without a named reviewer and
 * a cited source.
 */
export type Promotion =
  | { promoted: true; authority: KnowledgeAuthority }
  | { promoted: false; reason: string };

export function promote(
  intake: LearningIntake,
  review: { reviewerUserId: number; reviewedAt: Date; authorityLevel: AuthorityLevel; sourceTitle: string; jurisdiction: string; contentHash: string; sourceUrl?: string },
): Promotion {
  if (!Number.isInteger(review.reviewerUserId) || review.reviewerUserId < 1) {
    return { promoted: false, reason: "a named reviewer is required; automated promotion is not available" };
  }
  if (!AUTHORITY_LEVELS.includes(review.authorityLevel)) {
    return { promoted: false, reason: `unknown authority level "${review.authorityLevel}"` };
  }
  if (review.authorityLevel === "unverified") {
    return { promoted: false, reason: "promoting something as unverified is not a promotion" };
  }
  if (!review.sourceTitle.trim() || !review.jurisdiction.trim()) {
    return { promoted: false, reason: "a promoted rule needs a source title and a jurisdiction" };
  }

  return {
    promoted: true,
    authority: {
      id: `K-${review.contentHash.slice(0, 12)}`,
      jurisdiction: review.jurisdiction,
      authorityLevel: review.authorityLevel,
      sourceTitle: review.sourceTitle,
      ...(review.sourceUrl ? { sourceUrl: review.sourceUrl } : {}),
      lastVerifiedAt: review.reviewedAt,
      contentHash: review.contentHash,
      // Promotion establishes authority. It does not establish a licence —
      // that assessment is separate and still has to happen.
      licenceStatus: "unknown",
      allowedUses: { search: false, aiAnswer: false, training: false, reproduce: false },
      confidence: "human_verified",
    },
  };
}

/** Origins that may reach operational knowledge without a person. */
export const AUTONOMOUS_ORIGINS: readonly LearningOrigin[] = ["field_observation", "job_outcome"];
