/**
 * LeaseOS Training Academy — pure policy engine.
 *
 * Deliberate boundaries:
 * - an online course completion is not a government licence/endorsement;
 * - an assessment opens only for the same published course version whose
 *   required modules the learner completed;
 * - a practical course needs a separate competent-person sign-off;
 * - a certificate may only be issued from a reviewed source snapshot;
 * - TDG direct supervision means physical presence, never app/GPS/phone-only.
 */

export type CredentialBoundary = "employer_certificate" | "company_certificate" | "external_track_only" | "knowledge_only";
export type AcademyQuestion = {
  id?: number;
  code: string;
  domain: string;
  prompt: string;
  options: readonly string[];
  correctIndex: number;
  explanation: string;
  critical?: boolean;
};

export type AssessmentPolicy = {
  questionCount: number;
  passingScorePercent: number;
  maxAttempts?: number | null;
  domainMinimumPercent?: Record<string, number>;
  failOnCriticalMiss?: boolean;
};

export type ModuleRequirement = { moduleId?: number; moduleCode: string; moduleHash: string; required: boolean };
export type ModuleCompletion = { moduleId?: number; moduleCode: string; contentVersionHash: string; status: "started" | "completed" | "invalidated" };

export function stableHash(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5];
  const chunks = seeds.map(seed => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= h >>> 13;
    }
    return h.toString(16).padStart(8, "0");
  });
  return chunks.join("").slice(0, 64);
}

function seedNumber(seed: string): number {
  return Number.parseInt(stableHash(seed).slice(0, 8), 16) || 1;
}
function rng(seed: string) {
  let x = seedNumber(seed) >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const random = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function moduleGate(requirements: readonly ModuleRequirement[], completions: readonly ModuleCompletion[]) {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const req of requirements.filter(x => x.required)) {
    const c = completions.find(x => x.moduleCode === req.moduleCode && x.status === "completed");
    if (!c) { missing.push(req.moduleCode); continue; }
    if (c.contentVersionHash !== req.moduleHash) stale.push(req.moduleCode);
  }
  return {
    ready: missing.length === 0 && stale.length === 0,
    missing,
    stale,
    reason: missing.length ? `Complete current modules first: ${missing.join(", ")}` : stale.length ? `Module completion is from a different content version: ${stale.join(", ")}` : null,
  };
}

export type PresentedAssessmentItem = {
  questionCode: string;
  sequenceIndex: number;
  domain: string;
  critical: boolean;
  prompt: string;
  presentedPromptHash: string;
  answerOrder: number[];
  presentedOptions: string[];
};

export function buildAssessment(args: {
  attemptSeed: string;
  questions: readonly AcademyQuestion[];
  policy: AssessmentPolicy;
}): { items: PresentedAssessmentItem[]; questionSetHash: string; policySnapshot: AssessmentPolicy } {
  if (args.policy.questionCount < 1) throw new Error("Assessment question count must be positive");
  if (args.questions.length < args.policy.questionCount) throw new Error("Question bank is smaller than the assessment policy");
  const chosen = seededShuffle(args.questions, `${args.attemptSeed}:questions`).slice(0, args.policy.questionCount);
  const items = chosen.map((q, index) => {
    const answerOrder = seededShuffle(q.options.map((_, i) => i), `${args.attemptSeed}:${q.code}:answers`);
    return {
      questionCode: q.code,
      sequenceIndex: index,
      domain: q.domain,
      critical: !!q.critical,
      prompt: q.prompt,
      presentedPromptHash: stableHash(q.prompt),
      answerOrder,
      presentedOptions: answerOrder.map(i => q.options[i]),
    };
  });
  return { items, questionSetHash: stableHash(items.map(i => ({ q: i.questionCode, a: i.answerOrder }))), policySnapshot: JSON.parse(JSON.stringify(args.policy)) };
}

export function gradeAssessment(args: {
  bank: readonly AcademyQuestion[];
  presented: readonly PresentedAssessmentItem[];
  responses: Record<string, number>; // presented option index, not source option index
  policy: AssessmentPolicy;
}) {
  let correct = 0;
  const domain = new Map<string, { correct: number; total: number }>();
  const criticalFailures: string[] = [];
  const itemResults = args.presented.map(item => {
    const q = args.bank.find(x => x.code === item.questionCode);
    if (!q) throw new Error(`Question ${item.questionCode} no longer exists in the snapshotted bank`);
    const presentedIndex = args.responses[item.questionCode];
    const sourceIndex = Number.isInteger(presentedIndex) ? item.answerOrder[presentedIndex] : undefined;
    const ok = sourceIndex === q.correctIndex;
    if (ok) correct++;
    else if (q.critical) criticalFailures.push(q.code);
    const d = domain.get(q.domain) ?? { correct: 0, total: 0 };
    d.total++; if (ok) d.correct++; domain.set(q.domain, d);
    return { questionCode: q.code, correct: ok, domain: q.domain, critical: !!q.critical, responsePresentedIndex: Number.isInteger(presentedIndex) ? presentedIndex : null };
  });
  const scorePercent = args.presented.length ? Math.round((correct / args.presented.length) * 100) : 0;
  const domainScores: Record<string, number> = {};
  for (const [k, v] of domain) domainScores[k] = Math.round((v.correct / v.total) * 100);
  const domainFailures = Object.entries(args.policy.domainMinimumPercent ?? {}).filter(([k, min]) => (domainScores[k] ?? 0) < min).map(([k]) => k);
  const passed = scorePercent >= args.policy.passingScorePercent && domainFailures.length === 0 && !(args.policy.failOnCriticalMiss && criticalFailures.length);
  return { passed, scorePercent, domainScores, domainFailures, criticalFailures, itemResults };
}

export function practicalGate(args: { requiresPractical: boolean; courseVersionId: number; evaluation?: { status: string; courseVersionId: number } | null }) {
  if (!args.requiresPractical) return { ready: true, reason: null };
  if (!args.evaluation) return { ready: false, reason: "A separate practical competency evaluation is required" };
  if (args.evaluation.courseVersionId !== args.courseVersionId) return { ready: false, reason: "Practical evidence belongs to a different course version" };
  if (args.evaluation.status !== "competent") return { ready: false, reason: `Practical evaluation is ${args.evaluation.status}, not competent` };
  return { ready: true, reason: null };
}

export function certificateDecision(args: {
  credentialBoundary: CredentialBoundary;
  courseVersionId: number;
  assignmentCourseVersionId: number;
  assessmentPassed: boolean;
  practicalReady: boolean;
  sourceSnapshotRef: string | null;
  sourceReviewStatus: "unreviewed" | "reviewed" | "superseded" | "rejected" | null;
  sourceTier?: "authority" | "industry_association" | "vendor" | "unknown" | null;
}) {
  const blockers: string[] = [];
  if (args.credentialBoundary === "external_track_only") blockers.push("This is an external/track-only credential; LeaseOS may record it but may not manufacture it");
  if (args.credentialBoundary === "knowledge_only") blockers.push("This course is knowledge-only and does not issue a credential");
  if (args.assignmentCourseVersionId !== args.courseVersionId) blockers.push("Assignment and certificate course versions do not match");
  if (!args.assessmentPassed) blockers.push("The final assessment has not been passed for this course version");
  if (!args.practicalReady) blockers.push("Required practical competency evidence is not complete for this course version");
  if (!args.sourceSnapshotRef) blockers.push("The course version has no governing source snapshot");
  if (args.sourceReviewStatus !== "reviewed") blockers.push("The governing source snapshot has not been reviewed and approved for certificate issuance");
  if ((args.credentialBoundary === "employer_certificate" || args.credentialBoundary === "company_certificate") && args.sourceTier === "vendor") blockers.push("Vendor-sourced material cannot satisfy the governing-source certificate gate");
  if ((args.credentialBoundary === "employer_certificate" || args.credentialBoundary === "company_certificate") && (!args.sourceTier || args.sourceTier === "unknown")) blockers.push("The governing source tier is unknown and cannot authorize certificate issuance");
  return { permitted: blockers.length === 0, blockers };
}

export function directSupervisionDecision(args: {
  traineeUserId: number;
  supervisorUserId: number;
  supervisorQualificationStatus: "pending" | "current" | "expired" | "revoked" | "rejected";
  supervisorQualificationCode: string;
  requiredQualificationCode: string;
  physicalPresenceAttested: boolean;
  startsAt: Date;
  endsAt: Date;
  jobId: number | null;
  scope: string | null;
}) {
  const blockers: string[] = [];
  if (args.traineeUserId === args.supervisorUserId) blockers.push("A trainee cannot directly supervise themself");
  if (args.supervisorQualificationStatus !== "current") blockers.push("The supervising person's qualification is not current");
  if (args.supervisorQualificationCode !== args.requiredQualificationCode) blockers.push("The supervisor qualification does not match the required TDG scope");
  if (!args.physicalPresenceAttested) blockers.push("Direct supervision requires physical presence; GPS, telephone, video or app monitoring alone is not direct supervision");
  if (!args.jobId) blockers.push("Direct supervision must be bound to a specific job");
  if (!args.scope?.trim()) blockers.push("Direct supervision needs an explicit task/material scope");
  if (!(args.endsAt > args.startsAt)) blockers.push("Direct supervision requires a valid start/end time window");
  return { permitted: blockers.length === 0, blockers };
}

export type TrainingRequirement = { code: string; qualificationCode: string; title: string; enforcement: "block" | "review" | "inform"; recoveryPath?: string | null };
export type ActiveQualification = { code: string; status: "pending" | "current" | "expired" | "revoked" | "rejected"; expiresAt?: Date | null };
export function trainingDispatchDecision(requirements: readonly TrainingRequirement[], qualifications: readonly ActiveQualification[], now = new Date()) {
  const blockers: string[] = [], review: string[] = [], satisfied: string[] = [];
  for (const r of requirements) {
    const q = qualifications.find(x => x.code === r.qualificationCode);
    const current = q?.status === "current" && (!q.expiresAt || q.expiresAt > now);
    if (current) { satisfied.push(r.code); continue; }
    const detail = `${r.title}: ${r.recoveryPath ?? `obtain/verify ${r.qualificationCode}`}`;
    if (r.enforcement === "block") blockers.push(detail); else if (r.enforcement === "review") review.push(detail);
  }
  return { status: blockers.length ? "blocked" : review.length ? "needs_review" : "ready", blockers, review, satisfied } as const;
}
