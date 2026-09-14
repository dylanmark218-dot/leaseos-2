/**
 * Workforce — the engines.
 *
 * A hire cannot start while a required screening is pending or failed; a
 * pass needs evidence. Onboarding gaps are named with their due dates. A
 * verified training record becomes a compliance document — the same
 * registry dispatch reads — and an unverified one becomes nothing.
 * Competency is signed off by someone else. Probation is recommended and
 * decided by two people. Offboarding closes only when every door is shut.
 */

export type Screening = { kind: string; required: boolean; result: "pending" | "pass" | "fail" | "not_required"; evidenceRecordId: number | null };

export function hireReadiness(screenings: readonly Screening[], requiredKinds: readonly string[]): { ready: boolean; blockers: string[]; pending: string[] } {
  const blockers: string[] = [], pending: string[] = [];
  for (const k of requiredKinds) {
    const s = screenings.find(x => x.kind === k);
    if (!s || s.result === "pending") { pending.push(k); continue; }
    if (s.result === "fail") blockers.push(`${k.replace(/_/g, " ")}: failed`);
    if (s.result === "pass" && !s.evidenceRecordId) blockers.push(`${k.replace(/_/g, " ")}: passed without evidence on record`);
  }
  if (pending.length) blockers.push(`Pending required screening: ${pending.map(p => p.replace(/_/g, " ")).join(", ")}`);
  return { ready: blockers.length === 0, blockers, pending };
}

export function screeningRecordDecision(args: { result: "pass" | "fail" | "not_required"; evidenceRecordId: number | null; required: boolean }): { permitted: boolean; refusal: string | null } {
  if (args.result === "pass" && !args.evidenceRecordId) return { permitted: false, refusal: "A pass needs its evidence record — the abstract, the certificate, the reference notes" };
  if (args.result === "not_required" && args.required) return { permitted: false, refusal: "A required screening is not marked not-required; change the requirement first, with a reason" };
  return { permitted: true, refusal: null };
}

export type OnboardingTask = { taskCode: string; title: string; required: boolean; dueBy: Date | null; completedAt: Date | null; credentialDocType: string | null; verifiedAt: Date | null };

export function onboardingGaps(tasks: readonly OnboardingTask[], now: Date): { complete: boolean; missing: { taskCode: string; title: string; overdue: boolean; awaitingVerification: boolean }[]; summary: string } {
  const missing = tasks.filter(t => t.required && (!t.completedAt || (t.credentialDocType && !t.verifiedAt))).map(t => ({ taskCode: t.taskCode, title: t.title, overdue: !!t.dueBy && now > t.dueBy && !t.completedAt, awaitingVerification: !!t.completedAt && !!t.credentialDocType && !t.verifiedAt }));
  const overdue = missing.filter(m => m.overdue).length, awaiting = missing.filter(m => m.awaitingVerification).length;
  return { complete: missing.length === 0, missing, summary: missing.length === 0 ? "Onboarding complete" : `${missing.length} required task(s) open${overdue ? `, ${overdue} overdue` : ""}${awaiting ? `, ${awaiting} awaiting verification` : ""}` };
}

/** Which registry document a course stands for — configuration, not inference; an unmapped course becomes nothing. */
export const COURSE_CREDENTIALS: Readonly<Record<string, { docType: string; validDays: number | null }>> = {
  H2S_ALIVE: { docType: "h2s_alive", validDays: 3 * 365 },
  FIRST_AID_STANDARD: { docType: "first_aid", validDays: 3 * 365 },
  TDG_GROUND: { docType: "tdg_certificate", validDays: 3 * 365 },
  WHMIS_2015: { docType: "whmis", validDays: null },
  CSTS_2020: { docType: "csts", validDays: null },
  GROUND_DISTURBANCE_2: { docType: "ground_disturbance", validDays: 3 * 365 },
  CONFINED_SPACE: { docType: "confined_space", validDays: 3 * 365 },
  FALL_PROTECTION: { docType: "fall_protection", validDays: 3 * 365 },
};

export function trainingVerification(args: { courseCode: string; evidenceRecordId: number | null; expiresAt: Date | null; completedAt: Date; recordedByUserId: number; verifierUserId: number }): { permitted: boolean; refusals: string[]; credential: { docType: string; expiresAt: Date | null } | null } {
  const r: string[] = [];
  if (!args.evidenceRecordId) r.push("Verification needs the certificate in the evidence vault");
  if (args.recordedByUserId === args.verifierUserId) r.push("The person who recorded the training may not verify it");
  const map = COURSE_CREDENTIALS[args.courseCode];
  const credential = map ? { docType: map.docType, expiresAt: args.expiresAt ?? (map.validDays ? new Date(args.completedAt.getTime() + map.validDays * 86_400_000) : null) } : null;
  if (!map) r.push(`Course ${args.courseCode} is not mapped to a credential — verified as training only; nothing enters the registry`);
  return { permitted: r.filter(x => !x.includes("not mapped")).length === 0, refusals: r, credential };
}

export function competencyDecision(args: { workerUserId: number; signerUserId: number; level: "trainee" | "competent" | "senior"; priorLevel: string | null }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.workerUserId === args.signerUserId) r.push("Competency is not self-declared");
  if (args.level === "senior" && args.priorLevel !== "competent") r.push("Senior follows competent — a trainee is not signed off as senior in one step");
  return { permitted: r.length === 0, refusals: r };
}

export function probationDecision(args: { recommendedByUserId: number; deciderUserId: number; recommendation: "confirm" | "extend" | "end"; decision: "confirm" | "extend" | "end"; extendedTo: Date | null; probationEndsAt: Date | null }): { permitted: boolean; refusals: string[] } {
  const r: string[] = [];
  if (args.recommendedByUserId === args.deciderUserId) r.push("The person who recommended may not decide");
  if (args.decision === "extend" && !args.extendedTo) r.push("An extension needs its new end date");
  if (args.decision === "extend" && args.extendedTo && args.probationEndsAt && args.extendedTo <= args.probationEndsAt) r.push("An extension ends after the current probation end");
  return { permitted: r.length === 0, refusals: r };
}

export function offboardingClose(args: { activeRoles: number; activeDevices: number; activeIdentities: number; toolsOut: number; finalPayProposed: boolean; lastDay: Date; now: Date }): { permitted: boolean; open: string[] } {
  const open: string[] = [];
  if (args.activeRoles) open.push(`${args.activeRoles} role grant(s) still active`);
  if (args.activeDevices) open.push(`${args.activeDevices} field device(s) not revoked`);
  if (args.activeIdentities) open.push(`${args.activeIdentities} portal identit${args.activeIdentities === 1 ? "y" : "ies"} still active`);
  if (args.toolsOut) open.push(`${args.toolsOut} tool(s) still checked out`);
  if (!args.finalPayProposed) open.push("Final pay not proposed to payroll");
  if (args.now < args.lastDay) open.push(`Last day ${args.lastDay.toISOString().slice(0, 10)} has not passed`);
  return { permitted: open.length === 0, open };
}
