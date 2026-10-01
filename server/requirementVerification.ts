/**
 * Requirement verification through the rule ledger (C1b-2b; owner decision C1b-Q2 = B).
 *
 * A requirement revision is proposed by one person and trusted only after other people have checked
 * it. How deeply they checked it is recorded, never assumed:
 *
 *   UNVERIFIED                proposed; nobody has verified it; it cannot be authoritative.
 *   CITATION_VERIFIED         people verified it against a named official instrument, a citation and
 *                             an official URL. LeaseOS holds no admitted source document for it, so it
 *                             has no automated change detection (`sourceMonitoringAvailable: false`).
 *                             A transitional trust level, not a claim that source licensing is done.
 *   SOURCE_DOCUMENT_VERIFIED  bound to an admitted, versioned source document in the knowledge
 *                             repository, whose content hash the ledger promotion records.
 *   SUPERSEDED                a later verified revision of the same requirement is in force (derived).
 *   WITHDRAWN                 withdrawn; no longer applies.
 *
 * Every step is an append-only `requirementVerificationEvents` row, and every promotion is a ledger
 * row (`hosRuleLimitHistory`, family `compliance_requirement`, one rule per revision). The revision
 * itself is immutable (0198 triggers). Nothing here edits an earlier event: a later level is a new
 * promotion, and the citation promotion it succeeds stays in the record.
 *
 * Separation of duties is by person, not role. The proposer never counts as a verifier; one person
 * never fills both approvals of a dispatch-blocking requirement; switching role or endpoint changes
 * nothing, because the check is on user ids recorded in the events.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  complianceRequirements, knowledgeDocuments, knowledgeVersions, operationalTasks,
  requirementVerificationEvents, sourceVerificationPolicies,
  type RequirementVerificationEventRow,
} from "../drizzle/schema";
import type { RequirementProvenance } from "./_core/compliancePassport";
import { checkCitation } from "./_core/knowledge/citationGuard";
import { promoteRule, type BindingAuthority } from "./_core/knowledge/promotionLedger";
import { getDb } from "./db";
import { packExists } from "./requirementRegistry";

export type VerificationLevel = "UNVERIFIED" | "CITATION_VERIFIED" | "SOURCE_DOCUMENT_VERIFIED" | "SUPERSEDED" | "WITHDRAWN";
export type TargetLevel = "CITATION_VERIFIED" | "SOURCE_DOCUMENT_VERIFIED";
export type PolicyMode = "CITATION_ALLOWED" | "SOURCE_DOCUMENT_REQUIRED";

/** The ledger family requirement promotions are recorded under. One ledger rule per revision. */
export const REQUIREMENT_RULE_FAMILY = "compliance_requirement";
export const ruleRefFor = (key: string, version: number) => `${key}@v${version}`;

/** Transitional default when no policy row matches (owner decision C1b-Q2 = B). */
export const DEFAULT_POLICY_MODE: PolicyMode = "CITATION_ALLOWED";

type RequirementRow = typeof complianceRequirements.$inferSelect;
type PolicyRow = typeof sourceVerificationPolicies.$inferSelect;
type Ev = RequirementVerificationEventRow;

const BINDING = ["law", "official_guidance", "recognized_standard", "manufacturer"] as const;
const isBindingAuthority = (v: string | null | undefined): v is BindingAuthority => BINDING.includes(v as never);

/* ------------------------------------------------------------------ */
/* Pure rules                                                          */
/* ------------------------------------------------------------------ */

/** A requirement that can stop a truck needs two independent verifiers; an informational one needs one. */
export const approvalsRequired = (row: Pick<RequirementRow, "missingSeverity">): 1 | 2 => (row.missingSeverity === "blocked" ? 2 : 1);

/** The fingerprint of what was proposed: content and citation. Every verification event repeats it. */
export function citationHashOf(r: Pick<RequirementRow,
  "requirementKey" | "version" | "family" | "packKey" | "title" | "subjectType" | "jurisdiction" | "appliesWhenJson"
  | "satisfiedByDocTypes" | "renewalIntervalDays" | "warnDaysBeforeExpiry" | "missingSeverity" | "sourceAuthority"
  | "sourceUrl" | "sourceReference" | "effectiveFrom" | "effectiveUntil" | "instrumentTitle" | "authorityType" | "effectiveDateUnknown">): string {
  const canonical = JSON.stringify([
    r.requirementKey, r.version, r.family, r.packKey ?? null, r.title, r.subjectType, r.jurisdiction, r.appliesWhenJson ?? null,
    r.satisfiedByDocTypes, r.renewalIntervalDays ?? null, r.warnDaysBeforeExpiry, r.missingSeverity,
    r.sourceAuthority ?? null, r.sourceUrl ?? null, r.sourceReference ?? null,
    r.effectiveFrom.toISOString(), r.effectiveUntil ? r.effectiveUntil.toISOString() : null,
    r.instrumentTitle ?? null, r.authorityType ?? null, r.effectiveDateUnknown,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * What a revision must carry before anyone may verify it against its citation. Empty means complete.
 * The URL must be an official government or regulator domain (the citation guard's register).
 */
export function citationProblems(r: RequirementRow): string[] {
  const out: string[] = [];
  if (!r.proposedByUserId) out.push("NO_PROPOSER: a revision with no recorded proposer (written before 0198) must be proposed again");
  if (!r.instrumentTitle?.trim()) out.push("NO_INSTRUMENT: the legal or regulatory instrument must be named");
  if (!r.sourceAuthority?.trim()) out.push("NO_ISSUING_AUTHORITY: the issuing authority must be named");
  if (!r.jurisdiction?.trim()) out.push("NO_JURISDICTION: a requirement without a jurisdiction applies to nobody");
  if (!r.sourceReference?.trim()) out.push("NO_CITATION: the section, subsection or equally precise citation must be recorded");
  if (!r.sourceUrl?.trim()) out.push("NO_OFFICIAL_URL: an official government or regulator URL must be recorded");
  else {
    const c = checkCitation(r.sourceUrl, "OFFICIAL_CITATION");
    if (!c.ok) out.push(`${c.code}: ${c.reason}`);
  }
  if (!isBindingAuthority(r.authorityType)) out.push("NO_AUTHORITY_TYPE: the authority level (law, official guidance, standard, manufacturer) must be recorded");
  if (!r.citationHash || r.citationHash !== citationHashOf(r)) out.push("CITATION_HASH_MISMATCH: the stored revision does not match its proposal fingerprint");
  return out;
}

/** A revision's verification level at `at`, read from its events. SUPERSEDED is decided by the registry. */
export function levelAt(events: readonly Ev[], at: Date): Exclude<VerificationLevel, "SUPERSEDED"> {
  const seen = events.filter((e) => e.createdAt <= at);
  if (seen.some((e) => e.eventType === "withdrawn")) return "WITHDRAWN";
  const promoted = seen.filter((e) => e.eventType === "promoted");
  if (promoted.some((e) => e.targetLevel === "SOURCE_DOCUMENT_VERIFIED")) return "SOURCE_DOCUMENT_VERIFIED";
  if (promoted.some((e) => e.targetLevel === "CITATION_VERIFIED")) return "CITATION_VERIFIED";
  return "UNVERIFIED";
}

/** Approvals toward `target` since the last promotion or rejection for it, oldest first. */
export function pendingApprovals(events: readonly Ev[], target: TargetLevel): Ev[] {
  const forTarget = [...events].filter((e) => e.targetLevel === target).sort((a, b) => a.id - b.id);
  let lastReset = -1;
  forTarget.forEach((e, i) => { if (e.eventType === "promoted" || e.eventType === "rejected") lastReset = i; });
  return forTarget.slice(lastReset + 1).filter((e) => e.eventType === "approved");
}

/** The policy governing a revision at `at`: the most specific matching row, then the latest. */
export function resolvePolicy(
  policies: readonly PolicyRow[],
  scope: { orgRef: string; issuingAuthority: string | null; domain: string; jurisdiction: string },
  at: Date,
): { mode: PolicyMode; policyRef: string | null } {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const matches = policies.filter((p) =>
    p.orgRef === scope.orgRef && p.createdAt <= at &&
    (p.issuingAuthority == null || norm(p.issuingAuthority) === norm(scope.issuingAuthority)) &&
    (p.domain == null || norm(p.domain) === norm(scope.domain)) &&
    (p.jurisdiction == null || norm(p.jurisdiction) === norm(scope.jurisdiction)));
  if (!matches.length) return { mode: DEFAULT_POLICY_MODE, policyRef: null };
  const specificity = (p: PolicyRow) => [p.issuingAuthority, p.domain, p.jurisdiction].filter((v) => v != null).length;
  const best = [...matches].sort((a, b) => specificity(b) - specificity(a) || b.id - a.id)[0];
  return { mode: best.mode, policyRef: best.policyRef };
}

export type ApprovalRefusal =
  | "NOT_FOUND" | "WITHDRAWN" | "ALREADY_AT_LEVEL" | "SELF_VERIFICATION" | "SAME_VERIFIER"
  | "STEP_OUT_OF_ORDER" | "SECOND_APPROVAL_NOT_REQUIRED" | "CITATION_INCOMPLETE"
  | "SOURCE_DOCUMENT_REQUIRED" | "SOURCE_REVISION_REQUIRED" | "SOURCE_NOT_ADMITTED"
  | "SOURCE_DOES_NOT_MATCH_CITATION" | "SOURCE_MISMATCH_BETWEEN_APPROVERS" | "LEDGER_REFUSED";

/**
 * May this person record this approval step? Pure: every identity check the procedures rely on is
 * here, against user ids in the events — so a change of role or endpoint cannot get around it.
 */
export function approvalCheck(args: {
  row: RequirementRow; events: readonly Ev[]; actorUserId: number; target: TargetLevel; step: 1 | 2;
  policy: PolicyMode; at: Date;
}): { ok: true; pending: Ev[]; completes: boolean } | { ok: false; code: ApprovalRefusal; reason: string } {
  const { row, events, actorUserId, target, step } = args;
  const level = levelAt(events, args.at);
  if (level === "WITHDRAWN") return { ok: false, code: "WITHDRAWN", reason: "a withdrawn revision cannot be verified" };
  if (level === "SOURCE_DOCUMENT_VERIFIED" || level === target) {
    return { ok: false, code: "ALREADY_AT_LEVEL", reason: `revision is already ${level}` };
  }
  if (target === "CITATION_VERIFIED") {
    const problems = citationProblems(row);
    if (problems.length) return { ok: false, code: "CITATION_INCOMPLETE", reason: problems.join("; ") };
    if (args.policy === "SOURCE_DOCUMENT_REQUIRED") {
      return { ok: false, code: "SOURCE_DOCUMENT_REQUIRED", reason: "policy for this authority requires an admitted source document; citation-only verification is closed" };
    }
  } else if (!row.proposedByUserId) {
    return { ok: false, code: "CITATION_INCOMPLETE", reason: "NO_PROPOSER: a revision with no recorded proposer must be proposed again" };
  }
  if (row.proposedByUserId === actorUserId) {
    return { ok: false, code: "SELF_VERIFICATION", reason: "the proposer of a requirement never verifies it" };
  }
  const pending = pendingApprovals(events, target);
  if (pending.some((p) => p.actorUserId === actorUserId)) {
    return { ok: false, code: "SAME_VERIFIER", reason: "one person cannot give both approvals; a second, independent verifier is required" };
  }
  const needed = approvalsRequired(row);
  if (step === 2 && needed === 1) return { ok: false, code: "SECOND_APPROVAL_NOT_REQUIRED", reason: "an informational requirement is verified by one independent verifier" };
  // The first approval is the one with none pending; the second needs one. Two first approvals that
  // raced each other leave more than one pending — the second approval still completes, it never wedges.
  if (step === 1 && pending.length > 0) return { ok: false, code: "STEP_OUT_OF_ORDER", reason: "the first approval is already recorded; this is the second approval" };
  if (step === 2 && pending.length === 0) return { ok: false, code: "STEP_OUT_OF_ORDER", reason: "the second approval needs a first approval" };
  return { ok: true, pending, completes: pending.length + 1 >= needed };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

const dbOrThrow = async () => {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return db;
};
/**
 * Timestamps are stored to the second. Every date this module writes, or fingerprints, is truncated
 * first, so the fingerprint of what was proposed matches what is read back, and an event never reads
 * as recorded after the moment it was recorded.
 */
const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

export class VerificationError extends Error {
  constructor(readonly code: ApprovalRefusal | "OVERLAPPING_REVISION" | "UNKNOWN_PACK" | "ALREADY_WITHDRAWN", message: string) { super(message); }
}

export type ProposalInput = {
  requirementKey: string; family: string; title: string; packKey?: string | null;
  subjectType: RequirementRow["subjectType"]; jurisdiction: string; appliesWhen?: Record<string, unknown> | null;
  satisfiedByDocTypes: string[]; renewalIntervalDays?: number | null; warnDaysBeforeExpiry: number;
  missingSeverity: "review" | "blocked";
  instrumentTitle?: string | null; issuingAuthority?: string | null; citation?: string | null; officialUrl?: string | null;
  authorityType?: BindingAuthority | null;
  /** Exactly one of these: the date the rule takes effect, or an explicit statement that it is not known. */
  effectiveFrom?: Date | null; effectiveDateUnknown?: boolean;
  effectiveUntil?: Date | null;
};

/**
 * Propose a requirement revision. Always UNVERIFIED; nothing a proposer sends can make it otherwise.
 * `orgRef` is the proposer's acting organization from server scope, never input.
 */
export async function proposeRequirement(input: ProposalInput, proposerUserId: number, orgRef: string, at: Date) {
  const now = sec(at);
  const db = await dbOrThrow();
  if (input.packKey && !(await packExists(input.packKey))) throw new VerificationError("UNKNOWN_PACK", `Unknown pack ${input.packKey}`);
  const effectiveDateUnknown = input.effectiveDateUnknown === true || !input.effectiveFrom;
  const effectiveFrom = sec(input.effectiveFrom ?? now);

  const prior = await db.select().from(complianceRequirements).where(eq(complianceRequirements.requirementKey, input.requirementKey));
  const priorEvents = prior.length
    ? await db.select().from(requirementVerificationEvents).where(inArray(requirementVerificationEvents.requirementId, prior.map((p) => p.id)))
    : [];
  // Canonical policy for overlapping revisions: a revision may not take effect before one already on
  // record for the same requirement (unless that one is withdrawn). Equal dates resolve to the higher
  // version. So which revision governs any date is never ambiguous.
  const live = prior.filter((p) => p.verificationStatus !== "withdrawn" && levelAt(priorEvents.filter((e) => e.requirementId === p.id), now) !== "WITHDRAWN");
  const latestStart = live.reduce<Date | null>((m, p) => (!m || p.effectiveFrom > m ? p.effectiveFrom : m), null);
  if (latestStart && effectiveFrom < latestStart) {
    throw new VerificationError("OVERLAPPING_REVISION", `A revision of ${input.requirementKey} already takes effect ${latestStart.toISOString()}; a new revision cannot take effect before it`);
  }
  const version = prior.reduce((m, p) => Math.max(m, p.version), 0) + 1;

  const content = {
    requirementKey: input.requirementKey, version, family: input.family, packKey: input.packKey ?? null, title: input.title,
    subjectType: input.subjectType, jurisdiction: input.jurisdiction,
    appliesWhenJson: input.appliesWhen ? JSON.stringify(input.appliesWhen) : null,
    satisfiedByDocTypes: JSON.stringify(input.satisfiedByDocTypes), renewalIntervalDays: input.renewalIntervalDays ?? null,
    warnDaysBeforeExpiry: input.warnDaysBeforeExpiry, missingSeverity: input.missingSeverity,
    sourceAuthority: input.issuingAuthority ?? null, sourceUrl: input.officialUrl ?? null, sourceReference: input.citation ?? null,
    effectiveFrom, effectiveUntil: input.effectiveUntil ? sec(input.effectiveUntil) : null,
    instrumentTitle: input.instrumentTitle ?? null, authorityType: input.authorityType ?? null, effectiveDateUnknown,
  };
  const citationHash = citationHashOf(content);

  const requirementId = await db.transaction(async (tx) => {
    const ins = await tx.insert(complianceRequirements).values({
      ...content, citationHash, orgRef, proposedByUserId: proposerUserId, createdAt: now,
      // A proposal is never verified. This column is kept for rows written before 0198 and is not read as authority.
      verificationStatus: "unverified", verifiedByUserId: null, verifiedAt: null,
    });
    const id = Number((ins as unknown as [{ insertId: number }])[0]?.insertId);
    await tx.insert(requirementVerificationEvents).values({
      eventRef: ref("RQV"), requirementId: id, requirementKey: input.requirementKey, version, orgRef,
      eventType: "proposed", actorUserId: proposerUserId, citationHash, createdAt: now,
    });
    return id;
  });
  return { requirementId, requirementKey: input.requirementKey, version, level: "UNVERIFIED" as const, citationHash, effectiveDateUnknown };
}

/** The revision, scoped to the caller's organization. Another organization's revision is "not found". */
async function revisionInScope(requirementKey: string, version: number, orgRef: string) {
  const db = await dbOrThrow();
  const row = (await db.select().from(complianceRequirements)
    .where(and(eq(complianceRequirements.requirementKey, requirementKey), eq(complianceRequirements.version, version))).limit(1))[0];
  if (!row || row.orgRef !== orgRef) throw new VerificationError("NOT_FOUND", "Requirement revision not found");
  const events = await db.select().from(requirementVerificationEvents)
    .where(eq(requirementVerificationEvents.requirementId, row.id)).orderBy(requirementVerificationEvents.id);
  return { db, row, events };
}

export async function policyFor(row: RequirementRow, at: Date) {
  const db = await dbOrThrow();
  const policies = await db.select().from(sourceVerificationPolicies).where(eq(sourceVerificationPolicies.orgRef, row.orgRef ?? ""));
  return resolvePolicy(policies, { orgRef: row.orgRef ?? "", issuingAuthority: row.sourceAuthority, domain: row.family, jurisdiction: row.jurisdiction }, at);
}

const hostOf = (url: string | null | undefined) => { try { return url ? new URL(url).hostname.toLowerCase() : null; } catch { return null; } };
const sameSite = (a: string | null, b: string | null) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

/**
 * The admitted source a SOURCE_DOCUMENT_VERIFIED approval rests on, and how it compares with the
 * citation people approved. Admitted = the document left quarantine through the licence gate and the
 * revision was verified (C1b-1).
 */
async function admittedSource(sourceRevisionRef: string, row: RequirementRow) {
  const db = await dbOrThrow();
  const s = (await db.select({
    versionRef: knowledgeVersions.versionRef, contentHash: knowledgeVersions.contentHash, status: knowledgeVersions.status,
    repealedAt: knowledgeVersions.repealedAt, section: knowledgeVersions.section, citation: knowledgeVersions.citation,
    documentState: knowledgeDocuments.state, documentUrl: knowledgeDocuments.url, documentTitle: knowledgeDocuments.title,
  }).from(knowledgeVersions).leftJoin(knowledgeDocuments, eq(knowledgeDocuments.documentRef, knowledgeVersions.documentRef))
    .where(eq(knowledgeVersions.versionRef, sourceRevisionRef)).limit(1))[0];
  if (!s) return { ok: false as const, code: "SOURCE_NOT_ADMITTED" as const, reason: `no source revision ${sourceRevisionRef}` };
  const admitted = s.status === "verified" && !!s.documentState && s.documentState !== "QUARANTINED" && s.documentState !== "REJECTED" && !s.repealedAt;
  if (!admitted) return { ok: false as const, code: "SOURCE_NOT_ADMITTED" as const, reason: `source revision ${sourceRevisionRef} is not an admitted, verified, unrepealed document (status ${s.status}, document ${s.documentState ?? "missing"})` };
  const comparison = {
    citationUrl: row.sourceUrl, documentUrl: s.documentUrl,
    sameSite: sameSite(hostOf(row.sourceUrl), hostOf(s.documentUrl)),
    citedSection: row.sourceReference, sourceSection: s.section, instrumentTitle: row.instrumentTitle, documentTitle: s.documentTitle,
  };
  // Compared against the citation that was approved: a document from a different publisher is not a
  // source for that citation, however similar it looks.
  if (row.sourceUrl && !comparison.sameSite) {
    return { ok: false as const, code: "SOURCE_DOES_NOT_MATCH_CITATION" as const, reason: `the source document (${s.documentUrl ?? "no URL"}) is not from the cited publisher (${row.sourceUrl})`, comparison };
  }
  return { ok: true as const, versionRef: s.versionRef, contentHash: s.contentHash, comparison };
}

/**
 * Open (or keep open) the governance task that says: this authority's source has not been assessed for
 * licensing, so the citation-verified requirements that rely on it cannot yet be bound to a source
 * document. No licence is inferred from a site being public.
 */
async function ensureLicenceAssessmentTask(tx: { insert: Awaited<ReturnType<typeof dbOrThrow>>["insert"]; select: Awaited<ReturnType<typeof dbOrThrow>>["select"] }, row: RequirementRow) {
  const host = hostOf(row.sourceUrl) ?? "unknown";
  const dedupeKey = `source_licence_assessment|${row.orgRef}|${host}`;
  const open = await tx.select({ id: operationalTasks.id }).from(operationalTasks)
    .where(and(eq(operationalTasks.dedupeKey, dedupeKey), inArray(operationalTasks.status, ["open", "acknowledged", "in_progress", "waiting"]))).limit(1);
  if (open[0]) return;
  await tx.insert(operationalTasks).values({
    taskNumber: ref("TASK-SLA").slice(0, 40), taskType: "source_licence_assessment",
    title: `Assess licensing and reuse of ${row.sourceAuthority ?? host} (${host}) as a regulatory source`,
    description: `Requirements citing ${host} are CITATION_VERIFIED only. Source-document ingestion is pending until a person records a licence assessment for this publisher and admits its documents. LeaseOS has not determined that this site may be reproduced, cached or reused.`,
    status: "open", priority: "normal", tenantId: row.orgRef ?? "default", subjectType: "regulatory_source", subjectId: host.slice(0, 64),
    assignedRole: "legal", sourceRuleKey: "c1b2b.citation_verified", dedupeKey, requiresEvidence: true,
  });
}

export type ApproveInput = {
  requirementKey: string; version: number; target: TargetLevel; step: 1 | 2;
  decision: "approve" | "reject"; reason: string; sourceRevisionRef?: string | null;
};

/**
 * Record one verification step. The approval that completes the threshold promotes the revision
 * through the ledger in the same transaction; a ledger refusal writes nothing.
 */
export async function recordApproval(input: ApproveInput, actorUserId: number, orgRef: string, at: Date) {
  const now = sec(at);
  const { db, row, events } = await revisionInScope(input.requirementKey, input.version, orgRef);
  const policy = await policyFor(row, now);
  const check = approvalCheck({ row, events, actorUserId, target: input.target, step: input.step, policy: policy.mode, at: now });
  if (!check.ok) throw new VerificationError(check.code, check.reason);

  const base = {
    requirementId: row.id, requirementKey: row.requirementKey, version: row.version, orgRef: row.orgRef,
    targetLevel: input.target, actorUserId, reason: input.reason, citationHash: row.citationHash, createdAt: now,
  };

  if (input.decision === "reject") {
    await db.insert(requirementVerificationEvents).values({ ...base, eventRef: ref("RQV"), eventType: "rejected", step: input.step });
    return { level: levelAt(events, now), outcome: "rejected" as const };
  }

  let source: { versionRef: string; contentHash: string; comparison: unknown } | null = null;
  if (input.target === "SOURCE_DOCUMENT_VERIFIED") {
    if (!input.sourceRevisionRef?.trim()) throw new VerificationError("SOURCE_REVISION_REQUIRED", "a source-document approval names the admitted source revision it was checked against");
    const first = check.pending[0];
    if (first && first.sourceRevisionRef !== input.sourceRevisionRef) {
      throw new VerificationError("SOURCE_MISMATCH_BETWEEN_APPROVERS", `the first approval was against ${first.sourceRevisionRef}; both approvals must be against the same source revision`);
    }
    const s = await admittedSource(input.sourceRevisionRef, row);
    if (!s.ok) throw new VerificationError(s.code, s.reason);
    source = s;
  }

  const approval = {
    ...base, eventRef: ref("RQV"), eventType: "approved" as const, step: input.step,
    sourceRevisionRef: source?.versionRef ?? null, sourceHash: source?.contentHash ?? null,
    comparisonJson: source ? JSON.stringify(source.comparison) : null,
  };
  if (!check.completes) {
    await db.insert(requirementVerificationEvents).values(approval);
    return { level: levelAt(events, now), outcome: "awaiting_second_approval" as const };
  }

  const verifiers = [...check.pending.map((p) => ({ userId: p.actorUserId, at: p.createdAt })), { userId: actorUserId, at: now }];
  const [v1, v2] = verifiers;
  const outcome = await promoteRule({
    ruleFamily: REQUIREMENT_RULE_FAMILY, ruleRef: ruleRefFor(row.requirementKey, row.version),
    domain: "documents", dispatchEffect: row.missingSeverity === "blocked" ? "BLOCK" : "WARN",
    payload: { requirementKey: row.requirementKey, version: row.version, citationHash: row.citationHash, requirementId: row.id },
    jurisdiction: row.jurisdiction, authorityType: row.authorityType as BindingAuthority,
    instrumentTitle: row.instrumentTitle ?? "", issuingAuthority: row.sourceAuthority ?? "", sourceSection: row.sourceReference ?? "",
    citationUrl: row.sourceUrl ?? "",
    verificationMethod: input.target === "CITATION_VERIFIED" ? "OFFICIAL_CITATION" : "OFFICIAL_WEB",
    verificationLevel: input.target, sourceRevisionRef: source?.versionRef ?? "",
    supersedesPrevious: input.target === "SOURCE_DOCUMENT_VERIFIED",
    proposedByUserId: row.proposedByUserId!, verifiedByUserId: v1.userId, verifiedAt: v1.at,
    secondVerifierUserId: v2?.userId, secondVerifiedAt: v2?.at,
    effectiveFrom: row.effectiveDateUnknown ? undefined : row.effectiveFrom, effectiveUntil: row.effectiveUntil ?? undefined,
  }, now, async (tx, promotionRef) => {
    // Serialize completions: lock the revision and refuse a second promotion to the same level, so two
    // verifiers completing at once cannot both promote. Throwing here rolls the ledger row back too.
    await tx.select({ id: complianceRequirements.id }).from(complianceRequirements).where(eq(complianceRequirements.id, row.id)).for("update");
    const already = await tx.select({ id: requirementVerificationEvents.id }).from(requirementVerificationEvents)
      .where(and(eq(requirementVerificationEvents.requirementId, row.id), eq(requirementVerificationEvents.eventType, "promoted"), eq(requirementVerificationEvents.targetLevel, input.target))).limit(1);
    if (already[0]) throw new VerificationError("ALREADY_AT_LEVEL", `revision was promoted to ${input.target} concurrently`);
    await tx.insert(requirementVerificationEvents).values(approval);
    await tx.insert(requirementVerificationEvents).values({
      ...base, eventRef: ref("RQV"), eventType: "promoted", promotionRef,
      sourceRevisionRef: source?.versionRef ?? null, sourceHash: source?.contentHash ?? null,
      comparisonJson: source ? JSON.stringify(source.comparison) : null,
      verifierUserIdsJson: JSON.stringify(verifiers.map((v) => v.userId)),
    });
    if (input.target === "CITATION_VERIFIED") await ensureLicenceAssessmentTask(tx as never, row);
  });
  if (!outcome.promoted) throw new VerificationError("LEDGER_REFUSED", `${outcome.code}: ${outcome.reason}`);
  return { level: input.target, outcome: "promoted" as const, promotionRef: outcome.promotionRef, verifierUserIds: verifiers.map((v) => v.userId) };
}

export async function withdrawRevision(requirementKey: string, version: number, reason: string, actorUserId: number, orgRef: string, at: Date) {
  const now = sec(at);
  const { db, row, events } = await revisionInScope(requirementKey, version, orgRef);
  if (levelAt(events, now) === "WITHDRAWN") throw new VerificationError("ALREADY_WITHDRAWN", "revision is already withdrawn");
  await db.insert(requirementVerificationEvents).values({
    eventRef: ref("RQV"), requirementId: row.id, requirementKey, version, orgRef: row.orgRef,
    eventType: "withdrawn", actorUserId, reason, citationHash: row.citationHash, createdAt: now,
  });
  return { level: "WITHDRAWN" as const };
}

export async function setVerificationPolicy(
  scope: { issuingAuthority?: string | null; domain?: string | null; jurisdiction?: string | null },
  mode: PolicyMode, reason: string, actorUserId: number, orgRef: string,
) {
  const db = await dbOrThrow();
  const policyRef = ref("SVP");
  await db.insert(sourceVerificationPolicies).values({
    policyRef, orgRef, issuingAuthority: scope.issuingAuthority ?? null, domain: scope.domain ?? null,
    jurisdiction: scope.jurisdiction ?? null, mode, reason, setByUserId: actorUserId,
  });
  return { policyRef, mode };
}

/**
 * Why LeaseOS trusted (or did not trust) each revision of a requirement: every revision's content
 * fingerprint and citation, and every event in order. Nothing is summarized away.
 */
export async function requirementProvenance(requirementKey: string, orgRef: string) {
  const db = await dbOrThrow();
  const rows = (await db.select().from(complianceRequirements).where(eq(complianceRequirements.requirementKey, requirementKey)))
    .filter((r) => r.orgRef === orgRef || r.orgRef == null);
  if (!rows.length) throw new VerificationError("NOT_FOUND", "Requirement not found");
  const events = await db.select().from(requirementVerificationEvents)
    .where(inArray(requirementVerificationEvents.requirementId, rows.map((r) => r.id))).orderBy(requirementVerificationEvents.id);
  const now = new Date();
  return rows.sort((a, b) => a.version - b.version).map((r) => {
    const mine = events.filter((e) => e.requirementId === r.id);
    return {
      version: r.version, orgRef: r.orgRef, proposedByUserId: r.proposedByUserId, proposedAt: r.createdAt,
      citation: { instrumentTitle: r.instrumentTitle, issuingAuthority: r.sourceAuthority, citation: r.sourceReference, officialUrl: r.sourceUrl, jurisdiction: r.jurisdiction },
      effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil, effectiveDateUnknown: r.effectiveDateUnknown,
      citationHash: r.citationHash, legacyUnattested: r.proposedByUserId == null,
      levelNow: r.proposedByUserId == null ? (r.verificationStatus === "withdrawn" ? "WITHDRAWN" : "UNVERIFIED") : levelAt(mine, now),
      events: mine,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Provenance for readers                                              */
/* ------------------------------------------------------------------ */

/** What a passport or work-authorization item carries about the revision that produced it. */
export function provenanceOf(row: RequirementRow, events: readonly Ev[], level: VerificationLevel, at: Date): RequirementProvenance {
  const promotions = events.filter((e) => e.eventType === "promoted" && e.createdAt <= at).sort((a, b) => b.id - a.id);
  const latest = promotions[0];
  return {
    level,
    promotionRef: latest?.promotionRef ?? null,
    verifierUserIds: latest?.verifierUserIdsJson ? JSON.parse(latest.verifierUserIdsJson) : [],
    proposedByUserId: row.proposedByUserId,
    citation: row.instrumentTitle || row.sourceUrl ? {
      instrumentTitle: row.instrumentTitle, issuingAuthority: row.sourceAuthority, citation: row.sourceReference,
      officialUrl: row.sourceUrl, jurisdiction: row.jurisdiction,
    } : null,
    sourceRevisionRef: latest?.sourceRevisionRef ?? null,
    // Only a revision bound to an admitted source document can be watched for changes to that source.
    sourceMonitoringAvailable: level === "SOURCE_DOCUMENT_VERIFIED",
    citationHash: row.citationHash,
  };
}

/** Promotions recorded for the latest verification of each revision, keyed by requirement id. */
export async function eventsByRequirement(ids: number[]): Promise<Map<number, Ev[]>> {
  const out = new Map<number, Ev[]>();
  if (!ids.length) return out;
  const db = await dbOrThrow();
  const rows = await db.select().from(requirementVerificationEvents)
    .where(inArray(requirementVerificationEvents.requirementId, ids)).orderBy(requirementVerificationEvents.id);
  for (const e of rows) (out.get(e.requirementId) ?? out.set(e.requirementId, []).get(e.requirementId)!).push(e);
  return out;
}

