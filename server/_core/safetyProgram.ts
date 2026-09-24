/**
 * Safety & Compliance Program Builder — pure policy engine.
 *
 * Deliberate boundaries:
 * - a policy exists as a controlled object: the server mints its code, a version
 *   is never rewritten after approval, the approver is never the preparer;
 * - an acknowledgement binds a person to the exact version hash they were shown,
 *   and a signature is refused until read, understood and questions are recorded;
 * - the training matrix is a computation over requirements and evidence, and
 *   says which evidence it relied on;
 * - a corrective action is verified by someone other than the person who
 *   completed it, and "overdue" is derived, never stored;
 * - COR readiness scores evidence that the program OPERATES, not that a
 *   document exists — a policy nobody acknowledged and a review nobody did are
 *   both gaps;
 * - nothing here reads a database; the router feeds it rows and stores what it
 *   returns.
 */
import { createHash } from "node:crypto";
import {
  POLICY_TEMPLATE_SEEDS, SAFETY_PACKS, SAFETY_PROGRAM_MODULES,
  type DocumentKind, type PackKey, type PolicyTemplateSeed, type SafetyModuleKey,
} from "./safetyProgramCatalog";

export function sha256(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(s).digest("hex");
}

/* ---------------- operations profile → obligations and packs ---------------- */

export type OperationsProfile = {
  jurisdictions: readonly string[];       // e.g. ["CA-AB"]
  workforceSize: number;                  // regularly employed workers
  nscCarrier: boolean;
  federalCarrier: boolean;
  oilfield: boolean;
  hydrovac: boolean;
  groundDisturbance: boolean;
  dangerousGoods: boolean;
  workingAlone: boolean;
};

export const EMPTY_PROFILE: OperationsProfile = {
  jurisdictions: [], workforceSize: 0, nscCarrier: false, federalCarrier: false, oilfield: false,
  hydrovac: false, groundDisturbance: false, dangerousGoods: false, workingAlone: false,
};

export type Obligation = {
  key: string;
  title: string;
  applies: boolean;
  basis: string;
  referenceKey: string | null;
  moduleKeys: readonly SafetyModuleKey[];
};

/**
 * What the profile obliges the company to have. Each line names its basis, and
 * the basis is a reference key the company verifies — the engine states what a
 * template author took the rule to be; it does not decide the law.
 */
export function programObligations(p: OperationsProfile): Obligation[] {
  const ab = p.jurisdictions.includes("CA-AB");
  return [
    { key: "hs_program", title: "Written health and safety program", applies: ab && p.workforceSize >= 20, basis: "Alberta: employers with 20 or more regularly employed workers", referenceKey: "ab.ohs_act.health_safety_program", moduleKeys: ["ohs"] },
    { key: "hs_committee", title: "Joint work site health and safety committee", applies: ab && p.workforceSize >= 20, basis: "Alberta: workforce-size threshold for a committee (verify the threshold against the Act as consolidated)", referenceKey: "ab.ohs_act.committee_representative", moduleKeys: ["ohs"] },
    { key: "hs_representative", title: "Health and safety representative", applies: ab && p.workforceSize >= 5 && p.workforceSize < 20, basis: "Alberta: workforce-size threshold for a representative (verify against the Act as consolidated)", referenceKey: "ab.ohs_act.committee_representative", moduleKeys: ["ohs"] },
    { key: "nsc_programs", title: "Written and implemented carrier safety AND maintenance programs", applies: p.nscCarrier, basis: "Alberta NSC carrier; an OHS program alone does not satisfy the transportation requirement", referenceKey: "ab.nsc.commercial_vehicle_safety_regulation", moduleKeys: ["nsc_trucking", "company_foundation"] },
    { key: "federal_hos_eld", title: "Federal hours of service and ELD", applies: p.federalCarrier, basis: "Extra-provincial carrier", referenceKey: "ca.eld_mandate", moduleKeys: ["nsc_trucking"] },
    { key: "violence_harassment", title: "Violence and harassment prevention plan", applies: ab, basis: "Every Alberta employer", referenceKey: "ab.ohs_code.part27_violence_harassment", moduleKeys: ["workplace_conduct"] },
    { key: "hazard_assessment", title: "Hazard assessment, elimination and control", applies: ab, basis: "Every Alberta employer", referenceKey: "ab.ohs_code.part2_hazard_assessment", moduleKeys: ["ohs"] },
    { key: "emergency_response", title: "Emergency response plan", applies: true, basis: "Every employer", referenceKey: "ab.ohs_code.part7_emergency", moduleKeys: ["emergency_management"] },
    { key: "working_alone", title: "Working-alone hazard assessment and check-in", applies: p.workingAlone, basis: "Workers work alone", referenceKey: "ab.ohs_code.part28_working_alone", moduleKeys: ["working_alone_remote"] },
    { key: "whmis", title: "WHMIS program and worker education", applies: true, basis: "Hazardous products in the workplace", referenceKey: "ab.ohs_code.part29_whmis", moduleKeys: ["whmis_chemicals_tdg"] },
    { key: "tdg", title: "TDG program with employer-issued training certificates", applies: p.dangerousGoods, basis: "Dangerous goods handled, offered or transported", referenceKey: "ca.tdg.regulations.part6_training", moduleKeys: ["whmis_chemicals_tdg", "training_competency"] },
    { key: "ground_disturbance", title: "Ground disturbance procedures and locates", applies: p.groundDisturbance || p.hydrovac, basis: "Ground is disturbed (hydrovac is ground disturbance)", referenceKey: "ab.ohs_code.part32_excavating", moduleKeys: ["ground_disturbance"] },
    { key: "oilfield", title: "Oilfield and industrial operating procedures", applies: p.oilfield || p.hydrovac, basis: "Oilfield or hydrovac operations", referenceKey: null, moduleKeys: ["oilfield_industrial"] },
  ];
}

export function recommendedPacks(p: OperationsProfile): { packKey: PackKey; reason: string }[] {
  const flags = new Set<string>();
  for (const j of p.jurisdictions) flags.add(`jurisdiction:${j}`);
  for (const k of ["nscCarrier", "federalCarrier", "oilfield", "hydrovac", "groundDisturbance", "workingAlone"] as const) if (p[k]) flags.add(k);
  const out: { packKey: PackKey; reason: string }[] = [{ packKey: "core", reason: "always" }];
  for (const pack of SAFETY_PACKS) {
    if (pack.packKey === "core" || pack.kind === "overlay") continue;
    const hit = pack.recommendedWhen.filter(w => flags.has(w));
    if (hit.length && (pack.kind === "operations" || pack.recommendedWhen.every(w => flags.has(w)))) out.push({ packKey: pack.packKey, reason: hit.join(", ") });
  }
  return out;
}

export function recommendedModules(p: OperationsProfile): SafetyModuleKey[] {
  return SAFETY_PROGRAM_MODULES
    .filter(m => m.appliesWhen.length === 0 || m.appliesWhen.some(flag => (p as unknown as Record<string, unknown>)[flag] === true))
    .map(m => m.moduleKey);
}

/* ---------------- assembly ---------------- */

/** A seed or a database row: rows carry plain strings, so the keys are strings here and filtered against the catalog. */
export type TemplateLike = { templateKey: string; moduleKey: string; packKey: string; documentKind: DocumentKind; title: string; acknowledgementRequired: boolean; templateVersion?: number; contentStatus?: string };

export type Assembly = {
  packKeys: PackKey[];
  moduleKeys: SafetyModuleKey[];
  included: TemplateLike[];
  byModule: { moduleKey: SafetyModuleKey; title: string; codePrefix: string; templates: TemplateLike[] }[];
  excludedCount: number;
  assemblyHash: string;
};

/** Core is always in; a template is in when its pack is selected and its module is selected. */
export function assembleProgram(selection: { packKeys: readonly string[]; moduleKeys?: readonly string[] }, templates: readonly TemplateLike[] = POLICY_TEMPLATE_SEEDS): Assembly {
  const packKeys = Array.from(new Set<PackKey>(["core", ...selection.packKeys.filter((k): k is PackKey => SAFETY_PACKS.some(p => p.packKey === k))]));
  const moduleKeys = (selection.moduleKeys?.length ? selection.moduleKeys : SAFETY_PROGRAM_MODULES.map(m => m.moduleKey))
    .filter((k): k is SafetyModuleKey => SAFETY_PROGRAM_MODULES.some(m => m.moduleKey === k));
  const packSet = new Set(packKeys); const moduleSet = new Set(moduleKeys);
  const included = templates.filter(t => packSet.has(t.packKey as PackKey) && moduleSet.has(t.moduleKey as SafetyModuleKey));
  const byModule = SAFETY_PROGRAM_MODULES.filter(m => moduleSet.has(m.moduleKey)).map(m => ({
    moduleKey: m.moduleKey, title: m.title, codePrefix: m.codePrefix, templates: included.filter(t => t.moduleKey === m.moduleKey),
  })).filter(m => m.templates.length > 0);
  const assemblyHash = sha256({ packKeys, moduleKeys, keys: included.map(t => `${t.templateKey}@${t.templateVersion ?? 1}`).sort() });
  return { packKeys, moduleKeys, included, byModule, excludedCount: templates.length - included.length, assemblyHash };
}

/* ---------------- policy codes and versions ---------------- */

export const KIND_CODES: Record<DocumentKind, string> = {
  policy: "POL", procedure: "PRC", safe_work_practice: "SWP", plan: "PLN", program: "PRG", form: "FRM", statement: "STM",
};

/** HSE-POL-001. The sequence is per (scope, prefix, kind) and is minted by the server. */
export function policyCode(codePrefix: string, kind: DocumentKind, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("policy sequence must be a positive integer");
  return `${codePrefix}-${KIND_CODES[kind]}-${String(sequence).padStart(3, "0")}`;
}

export function parsePolicyCode(code: string): { codePrefix: string; kindCode: string; sequence: number } | null {
  const m = /^([A-Z]{2,8})-([A-Z]{3})-(\d{3,})$/.exec(code);
  return m ? { codePrefix: m[1]!, kindCode: m[2]!, sequence: Number(m[3]) } : null;
}

export type Section = { heading: string; body: string };

export function contentHash(title: string, sections: readonly Section[], bodyMarkdown: string): string {
  return sha256({ title, sections: sections.map(s => ({ h: s.heading, b: s.body })), body: bodyMarkdown });
}

export function versionHash(args: { policyRef: string; versionNumber: number; contentHash: string; previousVersionHash: string | null }): string {
  return sha256({ p: args.policyRef, n: args.versionNumber, c: args.contentHash, prev: args.previousVersionHash });
}

export function versionLabel(versionNumber: number, minor = 0): string {
  return `${versionNumber}.${minor}`;
}

export function nextReviewDue(effectiveFrom: Date, months: number): Date {
  const d = new Date(effectiveFrom.getTime());
  d.setUTCMonth(d.getUTCMonth() + Math.max(1, months));
  return d;
}

export type Decision = { allowed: true } | { allowed: false; reason: string };

/**
 * Approval is a second person's act. The version must be a draft; the approver
 * is not the preparer; the approver holds the policy's approver role.
 */
export function approvalDecision(args: { state: string; preparedByUserId: number; approverUserId: number; approverRoles: readonly string[]; requiredApproverRole: string }): Decision {
  if (args.state !== "draft") return { allowed: false, reason: `Only a draft can be approved; this version is ${args.state}` };
  if (args.preparedByUserId === args.approverUserId) return { allowed: false, reason: "The person who prepared a version cannot approve it" };
  if (!args.approverRoles.includes(args.requiredApproverRole) && !args.approverRoles.includes("management")) {
    return { allowed: false, reason: `Approval requires the ${args.requiredApproverRole} role` };
  }
  return { allowed: true };
}

/** A version's body is immutable once it leaves draft. */
export function editDecision(state: string): Decision {
  return state === "draft" ? { allowed: true } : { allowed: false, reason: `A ${state} version is immutable; prepare a new version` };
}

export type AckStep = "read" | "understood" | "questions" | "sign";
export type AckProgress = { readAt: Date | null; understoodAt: Date | null; questionsAnsweredAt: Date | null; signedAt: Date | null };

/**
 * Read → Understand → Questions answered → Sign. Each step needs the ones
 * before it; the signature needs all three; nothing repeats after signing.
 */
export function acknowledgementDecision(args: { versionState: string; progress: AckProgress; step: AckStep }): Decision {
  if (args.versionState !== "approved") return { allowed: false, reason: `Only the current approved version can be acknowledged; this version is ${args.versionState}` };
  const p = args.progress;
  if (p.signedAt) return { allowed: false, reason: "Already signed for this version" };
  switch (args.step) {
    case "read": return { allowed: true };
    case "understood": return p.readAt ? { allowed: true } : { allowed: false, reason: "Record reading the policy before confirming understanding" };
    case "questions": return p.understoodAt ? { allowed: true } : { allowed: false, reason: "Confirm understanding before recording that questions were answered" };
    case "sign":
      if (!p.readAt || !p.understoodAt || !p.questionsAnsweredAt) return { allowed: false, reason: "Read, understood and questions-answered must all be recorded before signing" };
      return { allowed: true };
  }
}

export function signatureHash(args: { userId: number; versionHash: string; signedAt: Date; method: string }): string {
  return sha256({ u: args.userId, v: args.versionHash, t: args.signedAt.toISOString(), m: args.method });
}

/* ---------------- training matrix ---------------- */

export type MatrixRequirement = {
  requirementRef: string;
  positionCode: string;
  requirementKind: "external_certificate" | "company_training" | "client_orientation" | "policy_acknowledgement" | "equipment_competency";
  qualificationCode: string | null;
  policyRef: string | null;
  renewalMonths: number | null;
  warnDaysBeforeExpiry: number;
  enforcement: "block" | "review" | "inform";
  title: string;
};
export type MatrixHolding = {
  kind: "worker_qualification" | "academy_qualification" | "training_record";
  ref: string;
  code: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  verified: boolean;
};
export type MatrixAcknowledgement = { policyRef: string; acknowledgementRef: string; currentVersion: boolean; signedAt: Date | null };
export type MatrixWorker = { userId: number; positionCode: string; holdings: readonly MatrixHolding[]; acknowledgements: readonly MatrixAcknowledgement[] };
export type MatrixStatus = "compliant" | "expiring" | "expired" | "missing" | "pending_verification";
export type MatrixRow = {
  userId: number; positionCode: string; requirementRef: string; requirementKind: MatrixRequirement["requirementKind"];
  status: MatrixStatus; expiresAt: Date | null;
  evidenceKind: "worker_qualification" | "academy_qualification" | "training_record" | "policy_acknowledgement" | "none";
  evidenceRef: string | null; detail: string;
};

const DAY = 86_400_000;

function expiryOf(h: MatrixHolding, renewalMonths: number | null): Date | null {
  if (h.expiresAt) return h.expiresAt;
  if (h.issuedAt && renewalMonths) return nextReviewDue(h.issuedAt, renewalMonths);
  return null;
}

/** Position → requirement → evidence → status. Best evidence wins: verified over unverified, latest expiry over earlier. */
export function trainingMatrixFor(requirements: readonly MatrixRequirement[], workers: readonly MatrixWorker[], now: Date): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const w of workers) {
    for (const r of requirements.filter(q => q.positionCode === w.positionCode)) {
      const base = { userId: w.userId, positionCode: w.positionCode, requirementRef: r.requirementRef, requirementKind: r.requirementKind };
      if (r.requirementKind === "policy_acknowledgement") {
        const ack = w.acknowledgements.find(a => a.policyRef === r.policyRef && a.currentVersion && a.signedAt);
        rows.push(ack
          ? { ...base, status: "compliant", expiresAt: null, evidenceKind: "policy_acknowledgement", evidenceRef: ack.acknowledgementRef, detail: `signed ${ack.signedAt!.toISOString()}` }
          : { ...base, status: "missing", expiresAt: null, evidenceKind: "none", evidenceRef: null, detail: `no signed acknowledgement of the current version of ${r.policyRef ?? r.title}` });
        continue;
      }
      const candidates = w.holdings.filter(h => r.qualificationCode && h.code === r.qualificationCode)
        .map(h => ({ h, exp: expiryOf(h, r.renewalMonths) }))
        .sort((a, b) => Number(b.h.verified) - Number(a.h.verified) || (b.exp?.getTime() ?? Infinity) - (a.exp?.getTime() ?? Infinity));
      const best = candidates[0];
      if (!best) { rows.push({ ...base, status: "missing", expiresAt: null, evidenceKind: "none", evidenceRef: null, detail: `no ${r.qualificationCode ?? r.title} on file` }); continue; }
      const ev = { evidenceKind: best.h.kind, evidenceRef: best.h.ref } as const;
      if (best.exp && best.exp.getTime() <= now.getTime()) rows.push({ ...base, ...ev, status: "expired", expiresAt: best.exp, detail: `expired ${best.exp.toISOString().slice(0, 10)}` });
      else if (!best.h.verified) rows.push({ ...base, ...ev, status: "pending_verification", expiresAt: best.exp, detail: "on file, not yet verified" });
      else if (best.exp && best.exp.getTime() - now.getTime() <= r.warnDaysBeforeExpiry * DAY) rows.push({ ...base, ...ev, status: "expiring", expiresAt: best.exp, detail: `expires ${best.exp.toISOString().slice(0, 10)}` });
      else rows.push({ ...base, ...ev, status: "compliant", expiresAt: best.exp, detail: best.exp ? `valid to ${best.exp.toISOString().slice(0, 10)}` : "valid, no expiry" });
    }
  }
  return rows;
}

export function matrixSummary(rows: readonly MatrixRow[]) {
  const by = (s: MatrixStatus) => rows.filter(r => r.status === s).length;
  return { total: rows.length, compliant: by("compliant"), expiring: by("expiring"), expired: by("expired"), missing: by("missing"), pendingVerification: by("pending_verification") };
}

/* ---------------- corrective actions ---------------- */

export type CorrectiveActionLike = { status: string; dueAt: Date; completedByUserId: number | null; completedAt: Date | null };

export function correctiveActionView(a: CorrectiveActionLike, now: Date): { overdue: boolean; daysOverdue: number } {
  const openish = a.status === "open" || a.status === "in_progress";
  const overdue = openish && a.dueAt.getTime() < now.getTime();
  return { overdue, daysOverdue: overdue ? Math.floor((now.getTime() - a.dueAt.getTime()) / DAY) : 0 };
}

export function completionDecision(a: { status: string }): Decision {
  return a.status === "open" || a.status === "in_progress" ? { allowed: true } : { allowed: false, reason: `A ${a.status} action cannot be completed` };
}

/** Verification is a second person's act on a completed action. */
export function verificationDecision(a: { status: string; completedByUserId: number | null }, verifierUserId: number): Decision {
  if (a.status !== "completed") return { allowed: false, reason: `Only a completed action can be verified; this one is ${a.status}` };
  if (a.completedByUserId === verifierUserId) return { allowed: false, reason: "The person who completed an action cannot verify it" };
  return { allowed: true };
}

/* ---------------- policy reviews ---------------- */

export function reviewCompletionDecision(r: { status: string }, outcome: string): Decision {
  if (r.status !== "scheduled") return { allowed: false, reason: `A ${r.status} review cannot be completed` };
  if (!["no_change", "revision_required", "retire"].includes(outcome)) return { allowed: false, reason: "Unknown review outcome" };
  return { allowed: true };
}

/* ---------------- COR readiness ---------------- */

export type CorEvidence = {
  now: Date;
  policies: readonly { moduleKey: string; status: string; acknowledgementRequired: boolean; nextReviewDueAt: Date | null; hasApprovedVersion: boolean }[];
  acknowledgement: { required: number; signed: number };
  matrix: ReturnType<typeof matrixSummary>;
  inspectionsLast90Days: number;
  hazardAssessmentsLast90Days: number;
  safetyMeetingsLast90Days: number;
  incidents: { reported: number; investigated: number; openInvestigations: number };
  correctiveActions: { open: number; overdue: number; completedUnverified: number };
  reviews: { overdue: number; completedLast12Months: number };
  drillsLast12Months: number;
  regulatoryReferences: { cited: number; verified: number };
};

export type CorElementStatus = "ready" | "attention" | "gap" | "no_evidence";
export type CorElement = { key: string; title: string; status: CorElementStatus; reasons: string[] };

function active(e: CorEvidence, moduleKey: string) {
  return e.policies.filter(p => p.moduleKey === moduleKey && p.status === "active" && p.hasApprovedVersion);
}

/**
 * The dashboard. Each element says WHY it is what it is, and "ready" requires
 * operating evidence — a document alone is at best "attention".
 */
export function corReadiness(e: CorEvidence): { overall: CorElementStatus; elements: CorElement[] } {
  const el: CorElement[] = [];
  const push = (key: string, title: string, status: CorElementStatus, reasons: string[]) => el.push({ key, title, status, reasons });

  const foundation = active(e, "company_foundation");
  push("management_commitment", "Management commitment", foundation.length === 0 ? "no_evidence" : e.acknowledgement.required > 0 && e.acknowledgement.signed === 0 ? "attention" : "ready",
    foundation.length === 0 ? ["no active, approved foundation policy (health and safety policy, management commitment)"] : e.acknowledgement.required > 0 && e.acknowledgement.signed === 0 ? ["policies are approved but nobody has acknowledged one"] : []);

  const ohs = active(e, "ohs");
  push("hazard_assessment", "Hazard assessments", ohs.length === 0 ? "no_evidence" : e.hazardAssessmentsLast90Days === 0 ? "gap" : "ready",
    ohs.length === 0 ? ["no active OHS policy or practice"] : e.hazardAssessmentsLast90Days === 0 ? ["no hazard assessment recorded in the last 90 days"] : []);
  push("safe_work_practices", "Safe work practices and procedures", ohs.length === 0 ? "no_evidence" : "ready", ohs.length === 0 ? ["no approved safe work practice or procedure"] : []);

  const m = e.matrix;
  const trainingStatus: CorElementStatus = m.total === 0 ? "no_evidence" : m.expired + m.missing > 0 ? "gap" : m.expiring + m.pendingVerification > 0 ? "attention" : "ready";
  push("training", "Training and competency", trainingStatus, [
    ...(m.total === 0 ? ["no training matrix computed"] : []),
    ...(m.expired ? [`${m.expired} expired`] : []), ...(m.missing ? [`${m.missing} missing`] : []),
    ...(m.expiring ? [`${m.expiring} expiring`] : []), ...(m.pendingVerification ? [`${m.pendingVerification} pending verification`] : []),
  ]);

  push("inspections", "Workplace inspections", e.inspectionsLast90Days === 0 ? "gap" : "ready", e.inspectionsLast90Days === 0 ? ["no inspection recorded in the last 90 days"] : []);

  const erp = active(e, "emergency_management");
  push("emergency_response", "Emergency response", erp.length === 0 ? "no_evidence" : e.drillsLast12Months === 0 ? "attention" : "ready",
    erp.length === 0 ? ["no approved emergency response plan"] : e.drillsLast12Months === 0 ? ["no drill recorded in the last 12 months"] : []);

  const inc = e.incidents;
  push("incident_investigation", "Incident investigations", inc.reported > 0 && inc.investigated === 0 ? "gap" : inc.openInvestigations > 0 ? "attention" : inc.reported === 0 ? "attention" : "ready",
    inc.reported > 0 && inc.investigated === 0 ? ["incidents reported, none investigated"] : inc.openInvestigations > 0 ? [`${inc.openInvestigations} open investigations`] : inc.reported === 0 ? ["no incidents or near misses reported — an auditor will ask why"] : []);

  push("worker_participation", "Worker participation", e.safetyMeetingsLast90Days === 0 ? "gap" : e.acknowledgement.required > e.acknowledgement.signed ? "attention" : "ready", [
    ...(e.safetyMeetingsLast90Days === 0 ? ["no safety meeting or toolbox talk in the last 90 days"] : []),
    ...(e.acknowledgement.required > e.acknowledgement.signed ? [`${e.acknowledgement.required - e.acknowledgement.signed} acknowledgements outstanding`] : []),
  ]);

  const overdueReviews = e.reviews.overdue + e.policies.filter(p => p.status === "active" && p.nextReviewDueAt && p.nextReviewDueAt.getTime() < e.now.getTime()).length;
  const unverifiedRefs = e.regulatoryReferences.cited - e.regulatoryReferences.verified;
  push("document_control", "Document control", overdueReviews > 0 ? "gap" : unverifiedRefs > 0 ? "attention" : e.policies.length === 0 ? "no_evidence" : "ready", [
    ...(overdueReviews ? [`${overdueReviews} policy reviews overdue`] : []),
    ...(unverifiedRefs > 0 ? [`${unverifiedRefs} cited regulatory references not yet verified`] : []),
    ...(e.policies.length === 0 ? ["no policies"] : []),
  ]);

  const ca = e.correctiveActions;
  push("corrective_actions", "Corrective actions", ca.overdue > 0 ? "gap" : ca.completedUnverified > 0 ? "attention" : "ready", [
    ...(ca.overdue ? [`${ca.overdue} overdue`] : []), ...(ca.completedUnverified ? [`${ca.completedUnverified} completed, not verified`] : []),
  ]);

  const rank: Record<CorElementStatus, number> = { ready: 0, attention: 1, no_evidence: 2, gap: 3 };
  const worst = el.reduce<CorElementStatus>((acc, x) => (rank[x.status] > rank[acc] ? x.status : acc), "ready");
  return { overall: worst, elements: el };
}

/* ---------------- vendor compliance package ---------------- */

export type VendorPackageInputs = {
  companyProfile: boolean;
  safetyManual: { activePolicies: number; assembled: boolean };
  corOrSecor: { present: boolean; expiresAt: Date | null };
  wcbClearance: { present: boolean; expiresAt: Date | null };
  insurance: { present: boolean; expiresAt: Date | null };
  safetyFitnessCertificate: { present: boolean; expiresAt: Date | null };
  trainingMatrix: ReturnType<typeof matrixSummary> | null;
  driverQualifications: number;
  fleetList: number;
  cvips: { units: number; current: number };
  incidentStatistics: boolean;
  emergencyPlan: boolean;
  environmentalProgram: boolean;
  references: number;
  signedDeclarations: number;
  now: Date;
};

export type ManifestSection = { key: string; title: string; present: boolean; detail: string };

/** The package is compiled from records the program already holds. A missing section is named, never papered over. */
export function vendorPackageManifest(i: VendorPackageInputs): { sections: ManifestSection[]; complete: boolean; missing: string[]; manifestHash: string } {
  const dated = (x: { present: boolean; expiresAt: Date | null }, label: string): ManifestSection => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), title: label,
    present: x.present && (!x.expiresAt || x.expiresAt.getTime() > i.now.getTime()),
    detail: !x.present ? "not on file" : x.expiresAt && x.expiresAt.getTime() <= i.now.getTime() ? `expired ${x.expiresAt.toISOString().slice(0, 10)}` : x.expiresAt ? `valid to ${x.expiresAt.toISOString().slice(0, 10)}` : "on file",
  });
  const m = i.trainingMatrix;
  const sections: ManifestSection[] = [
    { key: "company_profile", title: "Company profile", present: i.companyProfile, detail: i.companyProfile ? "on file" : "not completed" },
    { key: "safety_manual", title: "Safety manual", present: i.safetyManual.assembled && i.safetyManual.activePolicies > 0, detail: `${i.safetyManual.activePolicies} active policies${i.safetyManual.assembled ? "" : "; program not assembled"}` },
    dated(i.corOrSecor, "COR / SECOR"), dated(i.wcbClearance, "WCB clearance"), dated(i.insurance, "Insurance"), dated(i.safetyFitnessCertificate, "Safety Fitness Certificate"),
    { key: "training_matrix", title: "Training matrix", present: !!m && m.total > 0, detail: m ? `${m.compliant}/${m.total} compliant, ${m.expired} expired, ${m.missing} missing` : "not computed" },
    { key: "driver_qualifications", title: "Driver qualifications", present: i.driverQualifications > 0, detail: `${i.driverQualifications} drivers` },
    { key: "fleet_list", title: "Fleet list", present: i.fleetList > 0, detail: `${i.fleetList} units` },
    { key: "cvips", title: "CVIP inspections", present: i.cvips.units > 0 && i.cvips.current === i.cvips.units, detail: `${i.cvips.current}/${i.cvips.units} current` },
    { key: "incident_statistics", title: "Incident statistics", present: i.incidentStatistics, detail: i.incidentStatistics ? "compiled" : "not compiled" },
    { key: "emergency_plan", title: "Emergency response plan", present: i.emergencyPlan, detail: i.emergencyPlan ? "approved" : "no approved plan" },
    { key: "environmental_program", title: "Environmental program", present: i.environmentalProgram, detail: i.environmentalProgram ? "approved" : "no approved program" },
    { key: "references", title: "References", present: i.references > 0, detail: `${i.references} references` },
    { key: "signed_declarations", title: "Signed declarations", present: i.signedDeclarations > 0, detail: `${i.signedDeclarations} signed` },
  ];
  const missing = sections.filter(s => !s.present).map(s => s.title);
  return { sections, complete: missing.length === 0, missing, manifestHash: sha256(sections) };
}

/* ---------------- event ledger ---------------- */

export type LedgerEvent = { eventRef: string; actorUserId: number | null; subjectType: string; subjectRef: string; eventType: string; eventJson: string; previousHash: string | null; eventHash: string };

export function eventHash(e: Omit<LedgerEvent, "eventHash">): string {
  return sha256({ r: e.eventRef, a: e.actorUserId, st: e.subjectType, sr: e.subjectRef, et: e.eventType, b: e.eventJson, p: e.previousHash });
}

/** Walk the chain in insertion order; the first row whose hash or link disagrees is named. */
export function verifyEventChain(events: readonly LedgerEvent[]): { intact: boolean; brokenAt: string | null; length: number } {
  let prev: string | null = null;
  for (const e of events) {
    if (e.previousHash !== prev || eventHash(e) !== e.eventHash) return { intact: false, brokenAt: e.eventRef, length: events.length };
    prev = e.eventHash;
  }
  return { intact: true, brokenAt: null, length: events.length };
}

/* ---------------- catalog integrity ---------------- */

export function catalogIntegrity(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const modules = new Set(SAFETY_PROGRAM_MODULES.map(m => m.moduleKey));
  const packs = new Set(SAFETY_PACKS.map(p => p.packKey));
  const seen = new Set<string>();
  for (const t of POLICY_TEMPLATE_SEEDS) {
    if (seen.has(t.templateKey)) problems.push(`duplicate template key ${t.templateKey}`);
    seen.add(t.templateKey);
    if (!modules.has(t.moduleKey)) problems.push(`${t.templateKey}: unknown module ${t.moduleKey}`);
    if (!packs.has(t.packKey)) problems.push(`${t.templateKey}: unknown pack ${t.packKey}`);
  }
  const prefixes = SAFETY_PROGRAM_MODULES.map(m => m.codePrefix);
  if (new Set(prefixes).size !== prefixes.length) problems.push("module code prefixes are not unique");
  return { ok: problems.length === 0, problems };
}

export function templateSeedHash(t: PolicyTemplateSeed): string {
  return contentHash(t.title, t.sections.map(h => ({ heading: h, body: "" })), "");
}
