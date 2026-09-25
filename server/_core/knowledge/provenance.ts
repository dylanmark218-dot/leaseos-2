/**
 * Provenance: what exactly was read, when, and whether it can be trusted to
 * answer a question about a given place and date.
 *
 * Pure. No network, no database. `repository.ts` enforces these decisions
 * against real tables; this decides them, so every rule is testable without a
 * server.
 *
 * The questions it answers, each fail-closed:
 *
 *   - Is this URL one we may fetch at all?                 `validateSourceUrl`
 *   - Is what came back new, the same, or not what the
 *     collector says it is?                                `classifyRetrieval`
 *   - Which version was in force on a date?                `versionInForce`
 *   - Does a document from one jurisdiction govern
 *     another?                                             `jurisdictionFit`
 *   - Two sources disagree — which one stands?             `resolveClaims`
 *   - May this actor see this passage?                     `scopeHits`
 *
 * Nothing here decides compliance. It decides which text is eligible to be
 * *read* by whatever does.
 */

import { createHash } from "node:crypto";
import { outranks, type AuthorityLevel } from "./admission";

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export const isSha256Hex = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

export type UrlRefusal =
  | "MALFORMED_URL"
  | "INSECURE_SCHEME"
  | "EMBEDDED_CREDENTIALS"
  | "IP_LITERAL_HOST"
  | "LOCAL_OR_INTERNAL_HOST"
  | "NON_DEFAULT_PORT"
  | "PUNYCODE_HOST"
  | "URL_TOO_LONG"
  | "OUTSIDE_SOURCE_DOMAIN";

export type UrlVerdict =
  | { ok: true; url: string; host: string }
  | { ok: false; code: UrlRefusal; reason: string };

/** The width of `knowledgeDocuments.url` and `knowledgeSnapshots.url`. */
export const MAX_URL_LENGTH = 1000;

/** Label-boundary suffix match: `laws-lois.justice.gc.ca` is under `justice.gc.ca`; `evil-justice.gc.ca.example` is not. */
export const hostUnder = (host: string, domain: string): boolean => {
  const h = host.toLowerCase(), d = domain.toLowerCase().replace(/^\.+/, "");
  return h === d || h.endsWith(`.${d}`);
};

const INTERNAL_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".corp", ".intranet"];

/**
 * May a collector be pointed at this URL?
 *
 * The bar is an official publication on the public web, so anything that looks
 * like an attempt to reach something else is refused: a private address, a
 * host with credentials in it, an unusual port, a scheme other than https. A
 * source's own domain list is the final word — a URL that parses perfectly and
 * points somewhere the source never claimed is refused too, which is what stops
 * a redirect or a typo in the registry from quietly widening a crawl.
 *
 * Punycode hosts are refused outright. No official source in the registry needs
 * one, and a lookalike domain is exactly the attack a label-suffix check cannot
 * see.
 */
export function validateSourceUrl(raw: string, allowedDomains: readonly string[]): UrlVerdict {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) {
    return { ok: false, code: "MALFORMED_URL", reason: "the URL is empty or carries surrounding whitespace" };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, code: "URL_TOO_LONG", reason: `URLs longer than ${MAX_URL_LENGTH} characters are not stored` };
  }
  let u: URL;
  try { u = new URL(raw); } catch {
    return { ok: false, code: "MALFORMED_URL", reason: `"${raw}" does not parse as a URL` };
  }
  if (u.protocol !== "https:") {
    return { ok: false, code: "INSECURE_SCHEME", reason: `only https is fetched; got ${u.protocol}` };
  }
  if (u.username || u.password) {
    return { ok: false, code: "EMBEDDED_CREDENTIALS", reason: "a URL carrying credentials is never fetched or stored" };
  }
  if (u.port !== "") {
    return { ok: false, code: "NON_DEFAULT_PORT", reason: `port ${u.port} is not the publisher's public web port` };
  }
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) {
    return { ok: false, code: "IP_LITERAL_HOST", reason: "an address is not a publisher; the host must be a registered domain" };
  }
  if (!host.includes(".") || host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, code: "LOCAL_OR_INTERNAL_HOST", reason: `"${host}" is not a public host` };
  }
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { ok: false, code: "PUNYCODE_HOST", reason: `"${host}" is an internationalized host; lookalike domains are refused` };
  }
  if (!allowedDomains.some((d) => hostUnder(host, d))) {
    return { ok: false, code: "OUTSIDE_SOURCE_DOMAIN",
      reason: `"${host}" is not under the source's declared domain(s): ${allowedDomains.join(", ") || "(none declared)"}` };
  }
  u.hash = "";   // a fragment is the reader's position, not a different document
  return { ok: true, url: u.toString(), host };
}

/* ------------------------------------------------------------------ */
/* Retrievals                                                          */
/* ------------------------------------------------------------------ */

export const RETRIEVAL_OUTCOMES = ["first_seen", "unchanged", "changed", "unavailable", "hash_mismatch"] as const;
export type RetrievalOutcome = (typeof RETRIEVAL_OUTCOMES)[number];

export type RetrievalObservation = {
  httpStatus: number | null;
  /** The bytes the collector kept. Absent when nothing came back. */
  body?: Uint8Array | string;
  /** What the collector says the bytes hash to. Checked, never trusted. */
  declaredSha256?: string | null;
};

export type RetrievalClass = {
  outcome: RetrievalOutcome;
  /** The hash of the bytes actually held, recomputed here. Null when there are none or they cannot be trusted. */
  sha256: string | null;
  /** True when this retrieval should become a new version. */
  newVersion: boolean;
  reason: string;
};

/**
 * What did this retrieval tell us?
 *
 * The hash is always recomputed from the bytes. A collector that reports one
 * hash and hands over bytes with another has either a bug or a problem in the
 * object store, and in both cases the bytes are not evidence of anything — so
 * the retrieval is recorded as `hash_mismatch` and produces no version.
 *
 * A failed fetch (`unavailable`) records that the source was checked and could
 * not be read. It never removes or supersedes what was read before: a page
 * that is down today is not a rule that was repealed today.
 */
export function classifyRetrieval(previousSha256: string | null, obs: RetrievalObservation): RetrievalClass {
  const s = obs.httpStatus;
  if (s === 304 && previousSha256) {
    return { outcome: "unchanged", sha256: previousSha256, newVersion: false, reason: "the publisher reports the document unmodified (304)" };
  }
  if (s === null || s < 200 || s > 299) {
    return { outcome: "unavailable", sha256: null, newVersion: false,
      reason: s === null ? "no response was received" : `the publisher answered ${s}` };
  }
  if (obs.body === undefined) {
    return { outcome: "unavailable", sha256: null, newVersion: false, reason: `a ${s} response with no body retained` };
  }

  const computed = sha256Hex(obs.body);
  if (obs.declaredSha256 != null) {
    const declared = obs.declaredSha256.toLowerCase();
    if (!isSha256Hex(declared) || declared !== computed) {
      return { outcome: "hash_mismatch", sha256: null, newVersion: false,
        reason: `the collector declared ${obs.declaredSha256.slice(0, 16)}… but the bytes hash to ${computed.slice(0, 16)}…` };
    }
  }

  if (previousSha256 === null) return { outcome: "first_seen", sha256: computed, newVersion: true, reason: "no earlier retrieval of this document" };
  if (previousSha256 === computed) return { outcome: "unchanged", sha256: computed, newVersion: false, reason: "identical to the last retrieval" };
  return { outcome: "changed", sha256: computed, newVersion: true, reason: "the content differs from the last retrieval" };
}

/* ------------------------------------------------------------------ */
/* Which version was in force                                          */
/* ------------------------------------------------------------------ */

export type VersionWindow = {
  versionRef: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  supersedesVersionRef?: string | null;
};

export type InForce =
  | { status: "in_force"; version: VersionWindow }
  | { status: "none"; reason: string }
  | { status: "effective_date_unknown"; undated: readonly string[]; reason: string }
  | { status: "ambiguous"; candidates: readonly string[]; reason: string };

/**
 * The version in force at `at`.
 *
 * A version stops being in force at its own `effectiveUntil`, or when a dated
 * successor takes effect — whichever is sooner. That is what lets both
 * "what is the rule now?" and "what applied to this trip in March 2025?" be
 * answered from the same rows without anything being overwritten.
 *
 * Two refusals rather than guesses:
 *
 *   - An undated version that nothing has superseded might be the one in
 *     force; we cannot know, so the answer is `effective_date_unknown`. The
 *     tempting default — treat undated as "always" — is how a draft becomes law.
 *   - Two dated versions in force at once, with neither superseding the other,
 *     is `ambiguous`. Picking the newer one would usually be right and would be
 *     silently wrong exactly when it mattered.
 */
export function versionInForce(versions: readonly VersionWindow[], at: Date): InForce {
  if (versions.length === 0) return { status: "none", reason: "no versions recorded" };

  const successorOf = new Map<string, VersionWindow>();
  for (const v of versions) if (v.supersedesVersionRef) successorOf.set(v.supersedesVersionRef, v);

  const undated = versions.filter((v) => v.effectiveFrom === null && !successorOf.has(v.versionRef));
  if (undated.length) {
    return { status: "effective_date_unknown", undated: undated.map((v) => v.versionRef),
      reason: "a current version carries no effective date, so what was in force cannot be determined" };
  }

  const endOf = (v: VersionWindow): Date | null => {
    const succ = successorOf.get(v.versionRef);
    const succFrom = succ?.effectiveFrom ?? null;
    if (v.effectiveUntil && succFrom) return v.effectiveUntil < succFrom ? v.effectiveUntil : succFrom;
    return v.effectiveUntil ?? succFrom;
  };

  const live = versions.filter((v) => {
    if (!v.effectiveFrom || v.effectiveFrom > at) return false;
    const end = endOf(v);
    return end === null || at < end;
  });

  if (live.length === 1) return { status: "in_force", version: live[0]! };
  if (live.length === 0) return { status: "none", reason: `no version was in force on ${at.toISOString().slice(0, 10)}` };
  return { status: "ambiguous", candidates: live.map((v) => v.versionRef),
    reason: "more than one version is in force and none supersedes the other" };
}

/* ------------------------------------------------------------------ */
/* Jurisdiction                                                        */
/* ------------------------------------------------------------------ */

export type JurisdictionFit =
  | { fit: "applies" }
  | { fit: "conditional"; reason: string }
  | { fit: "mismatch"; reason: string };

/**
 * Does a document from `docJurisdiction` govern a question about `queryJurisdiction`?
 *
 * Codes are `CA-AB`, `CA-FEDERAL`, `US-MT`. Federal Canadian material is
 * *conditional* for a province rather than applicable: whether the federal or
 * the provincial regime governs a carrier turns on its operating status
 * (extra-provincial or not), which is a fact about the carrier, not about the
 * document. Alberta says the same in its own carrier guidance. Anything else
 * across a boundary is a mismatch — a BC rule is not an Alberta rule.
 */
export function jurisdictionFit(docJurisdiction: string, queryJurisdiction: string): JurisdictionFit {
  const d = docJurisdiction.trim().toUpperCase(), q = queryJurisdiction.trim().toUpperCase();
  if (!d || !q) return { fit: "mismatch", reason: "a jurisdiction is missing; none is not all of them" };
  if (d === q) return { fit: "applies" };
  const [dc, dr] = d.split("-"), [qc] = q.split("-");
  if (dc === qc && dr === "FEDERAL" && q !== d) {
    return { fit: "conditional", reason: `${d} governs ${q} operations only where the carrier falls under the federal regime (operating status decides)` };
  }
  return { fit: "mismatch", reason: `${d} material does not govern ${q}` };
}

/* ------------------------------------------------------------------ */
/* Contradictions                                                      */
/* ------------------------------------------------------------------ */

/** One source's statement of one fact. `subject` names the fact, `value` what the source says. */
export type Claim = {
  claimRef: string;
  subject: string;
  value: string;
  authorityLevel: AuthorityLevel;
  jurisdiction: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

export type ClaimResolution = {
  /** The claim that stands, or null when none can be chosen without a person. */
  prevailing: Claim | null;
  /** True when `prevailing` is conditional on the carrier's operating regime. */
  conditional: boolean;
  /** Lower-authority claims that disagree with the prevailing one. Reported, never applied. */
  lowerAuthorityContradictions: readonly Claim[];
  /** Claims set aside, and why. */
  excluded: readonly { claim: Claim; reason: string }[];
  needsReview: boolean;
  reason: string;
};

const inForceAt = (c: Claim, at: Date) =>
  c.effectiveFrom !== null && c.effectiveFrom <= at && (c.effectiveUntil === null || at < c.effectiveUntil);

/**
 * Which of several claims about one fact stands, for a place and a date?
 *
 * In order:
 *
 *   1. Out-of-jurisdiction claims are excluded — not contradictions at all.
 *   2. Claims not in force on the date are excluded. A claim with no effective
 *      date is excluded too, with that reason: it cannot be shown to apply.
 *   3. Claims that apply directly are preferred to conditional (federal) ones.
 *   4. Among the rest, only the highest authority level is eligible. A lower
 *      level that disagrees is reported in `lowerAuthorityContradictions` and
 *      never overrides — that is the rule the whole tier system exists for.
 *   5. If the highest level disagrees with itself, nothing prevails and a
 *      person reviews it. Newer is not the same as superseding.
 */
export function resolveClaims(claims: readonly Claim[], ctx: { jurisdiction: string; at: Date }): ClaimResolution {
  const excluded: { claim: Claim; reason: string }[] = [];
  const subjects = new Set(claims.map((c) => c.subject));
  if (subjects.size > 1) {
    return { prevailing: null, conditional: false, lowerAuthorityContradictions: [], excluded: [], needsReview: true,
      reason: `claims about different facts cannot be reconciled together: ${Array.from(subjects).join(", ")}` };
  }

  const applies: Claim[] = [], conditional: Claim[] = [];
  for (const c of claims) {
    const fit = jurisdictionFit(c.jurisdiction, ctx.jurisdiction);
    if (fit.fit === "mismatch") { excluded.push({ claim: c, reason: fit.reason }); continue; }
    if (c.effectiveFrom === null) { excluded.push({ claim: c, reason: "no effective date; cannot be shown to apply" }); continue; }
    if (!inForceAt(c, ctx.at)) { excluded.push({ claim: c, reason: `not in force on ${ctx.at.toISOString().slice(0, 10)}` }); continue; }
    (fit.fit === "applies" ? applies : conditional).push(c);
  }

  const pool = applies.length ? applies : conditional;
  const isConditional = applies.length === 0 && conditional.length > 0;
  if (pool.length === 0) {
    return { prevailing: null, conditional: false, lowerAuthorityContradictions: [], excluded, needsReview: false,
      reason: "no claim applies to this jurisdiction on this date" };
  }

  const best = pool.reduce((b, c) => (outranks(c.authorityLevel, b.authorityLevel) ? c : b)).authorityLevel;
  const top = pool.filter((c) => !outranks(best, c.authorityLevel));   // equal rank to best
  const lower = pool.filter((c) => outranks(best, c.authorityLevel));
  if (applies.length) for (const c of conditional) excluded.push({ claim: c, reason: "a directly applicable claim exists; federal material is conditional here" });

  const values = new Set(top.map((c) => c.value));
  if (values.size > 1) {
    return { prevailing: null, conditional: isConditional, lowerAuthorityContradictions: [], excluded, needsReview: true,
      reason: `sources of equal authority (${best}) disagree: ${Array.from(values).join(" vs ")}` };
  }

  const prevailing = top[0]!;
  const contradictions = lower.filter((c) => c.value !== prevailing.value);
  return {
    prevailing, conditional: isConditional, lowerAuthorityContradictions: contradictions, excluded,
    // A lower source contradicting a higher one is resolved (the higher stands) but
    // still worth a person's attention: either the lower source is stale or we misread one.
    needsReview: contradictions.length > 0,
    reason: contradictions.length
      ? `${prevailing.authorityLevel} prevails; ${contradictions.length} lower-authority source(s) disagree and are flagged`
      : `${prevailing.authorityLevel} prevails`,
  };
}

/* ------------------------------------------------------------------ */
/* Tenancy                                                             */
/* ------------------------------------------------------------------ */

/**
 * A retrieval hit. The public industry corpus has no owner; an organization's
 * own material always has one.
 */
export type ScopedHit =
  | { ref: string; corpus: "public_industry" }
  | { ref: string; corpus: "organization"; tenantId: string | null };

export type ScopeResult<T extends ScopedHit> = {
  visible: readonly T[];
  refused: readonly { ref: string; reason: string }[];
};

/**
 * Filter hits to what this actor may read.
 *
 * An organization hit is visible only to its own tenant. One with no tenant is
 * refused rather than treated as public — a private row that lost its owner is
 * still private, and the public corpus is a different table, not a missing
 * value. `contextAssembly.assembleContext` applies the same rule to the blocks
 * that reach the model; this applies it one step earlier, so a foreign passage
 * is never even ranked.
 */
export function scopeHits<T extends ScopedHit>(hits: readonly T[], actor: { tenantId: string | null }): ScopeResult<T> {
  const visible: T[] = [], refused: { ref: string; reason: string }[] = [];
  for (const h of hits) {
    if (h.corpus === "public_industry") { visible.push(h); continue; }
    if (!h.tenantId) { refused.push({ ref: h.ref, reason: "organization material with no owning tenant is never shown" }); continue; }
    if (!actor.tenantId || h.tenantId !== actor.tenantId) {
      refused.push({ ref: h.ref, reason: "belongs to another organization" });
      continue;
    }
    visible.push(h);
  }
  return { visible, refused };
}
