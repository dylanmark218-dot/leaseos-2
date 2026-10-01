/**
 * v23.31 — the pure half of the Customer / Contract / Rate domain.
 *
 * No database, no clock: every rule the service enforces is a function here, so a state
 * transition, the choice of a sheet version at a date, the commercial readiness gate and the
 * snapshot's canonical form can each be tested without a row.
 *
 * Non-negotiable: a job done under a $185/h line in June shows $185/h years later when the
 * customer's current line is $215/h. That is what the snapshot payload and its hash are for.
 */
import { createHash } from "node:crypto";
import type { DispatchBlocker } from "./dispatchReadiness";
import { CONTACT_PARTY_ROLES, type ContractStatus, type PartyRole, type ReferenceKind, type SheetVersionStatus } from "../../shared/commercialVocabulary";

/* ------------------------------------------------------------------ hashing */

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------- contract lifecycle */

export type ContractEvent = "submit" | "approve" | "reject" | "activate" | "suspend" | "resume" | "expire" | "terminate" | "supersede";

/** Every legal transition, and nothing else. A missing entry is a refusal, not a default. */
const CONTRACT_TRANSITIONS: Record<ContractStatus, Partial<Record<ContractEvent, ContractStatus>>> = {
  draft: { submit: "pending_approval" },
  pending_approval: { approve: "active", reject: "draft" },
  active: { suspend: "suspended", expire: "expired", terminate: "terminated", supersede: "superseded" },
  suspended: { resume: "active", terminate: "terminated", expire: "expired", supersede: "superseded" },
  expired: { supersede: "superseded" },
  terminated: {},
  superseded: {},
};
export type Transition<S> = { ok: true; to: S } | { ok: false; reason: string };
export function contractTransition(from: ContractStatus, event: ContractEvent): Transition<ContractStatus> {
  const to = CONTRACT_TRANSITIONS[from]?.[event];
  return to ? { ok: true, to } : { ok: false, reason: `A ${from} contract cannot ${event}` };
}
/** Once a job has snapshotted a contract, its commercial fields are frozen; a change is a superseding version. */
export const CONTRACT_EDITABLE_STATUSES: readonly ContractStatus[] = ["draft", "pending_approval"];
export function contractInWindow(c: { effectiveFrom: Date; effectiveTo: Date | null }, at: Date): boolean {
  return c.effectiveFrom.getTime() <= at.getTime() && (c.effectiveTo == null || at.getTime() < c.effectiveTo.getTime());
}
/** A contract a job may be worked under at `at`: active (or suspended-then-resumed is active) and in window. */
export function contractUsable(c: { status: ContractStatus; effectiveFrom: Date; effectiveTo: Date | null }, at: Date): { usable: boolean; reason: string } {
  if (c.status !== "active") return { usable: false, reason: `contract is ${c.status}` };
  if (!contractInWindow(c, at)) return { usable: false, reason: `contract window ${c.effectiveFrom.toISOString().slice(0, 10)}–${c.effectiveTo ? c.effectiveTo.toISOString().slice(0, 10) : "open"} does not cover ${at.toISOString().slice(0, 10)}` };
  return { usable: true, reason: "active and in window" };
}

/* ---------------------------------------------------- sheet version lifecycle */

export type VersionEvent = "submit" | "approve" | "reject" | "reopen" | "supersede" | "retire";
const VERSION_TRANSITIONS: Record<SheetVersionStatus, Partial<Record<VersionEvent, SheetVersionStatus>>> = {
  draft: { submit: "pending_approval" },
  pending_approval: { approve: "approved", reject: "rejected" },
  rejected: { reopen: "draft" },
  approved: { supersede: "superseded", retire: "retired" },
  superseded: {},
  retired: {},
};
export function versionTransition(from: SheetVersionStatus, event: VersionEvent): Transition<SheetVersionStatus> {
  const to = VERSION_TRANSITIONS[from]?.[event];
  return to ? { ok: true, to } : { ok: false, reason: `A ${from} rate sheet version cannot ${event}` };
}
/** Lines are edited only on a draft version. Approved, superseded and retired lines are history. */
export const VERSION_LINE_EDITABLE: readonly SheetVersionStatus[] = ["draft"];

export type VersionRow = { id: number; versionRef: string; version: number; status: SheetVersionStatus; effectiveFrom: Date; effectiveTo: Date | null };
export type VersionChoice<T extends VersionRow = VersionRow> =
  | { outcome: "resolved"; version: T; reasons: string[] }
  | { outcome: "none"; reasons: string[] }
  | { outcome: "conflict"; candidates: T[]; reasons: string[] };

/**
 * Which version of a sheet governs at `at`. Approved or superseded versions whose window covers
 * the date. A superseded version still governs its own window (the December job after January's
 * sheet). Two versions covering the same date is a data fault a person resolves: CONFLICT, never
 * "the newest".
 */
export function chooseVersionAt<T extends VersionRow>(versions: readonly T[], at: Date): VersionChoice<T> {
  const reasons: string[] = [];
  const live = versions.filter(v => (v.status === "approved" || v.status === "superseded") && contractInWindow(v, at));
  const pending = versions.filter(v => v.status === "pending_approval" || v.status === "draft");
  if (pending.length) reasons.push(`${pending.length} version(s) not yet approved — a draft prices nothing`);
  if (live.length === 1) { reasons.push(`Version ${live[0]!.version} (${live[0]!.versionRef}) governs ${at.toISOString().slice(0, 10)}`); return { outcome: "resolved", version: live[0]!, reasons }; }
  if (live.length > 1) { reasons.push(`${live.length} approved versions cover ${at.toISOString().slice(0, 10)} — a person decides which governs`); return { outcome: "conflict", candidates: live, reasons }; }
  const future = versions.filter(v => v.status === "approved" && v.effectiveFrom.getTime() > at.getTime());
  if (future.length) reasons.push(`${future.length} approved version(s) take effect after ${at.toISOString().slice(0, 10)} — a future rate is not today's rate`);
  const expired = versions.filter(v => (v.status === "approved" || v.status === "superseded") && v.effectiveTo && v.effectiveTo.getTime() <= at.getTime());
  if (expired.length) reasons.push(`${expired.length} version(s) expired before ${at.toISOString().slice(0, 10)}`);
  reasons.push("NO RATE SHEET VERSION GOVERNS — REVIEW REQUIRED");
  return { outcome: "none", reasons };
}

/**
 * The window a new version may take: it must start after the version it supersedes started
 * (two versions never share a start), and the superseded version's window closes where the new
 * one opens unless it closed earlier already.
 */
export function supersessionWindow(prior: { effectiveFrom: Date; effectiveTo: Date | null }, next: { effectiveFrom: Date }): { ok: true; priorEffectiveTo: Date } | { ok: false; reason: string } {
  if (next.effectiveFrom.getTime() <= prior.effectiveFrom.getTime()) return { ok: false, reason: `The new version must take effect after the version it supersedes (${prior.effectiveFrom.toISOString().slice(0, 10)})` };
  const priorEffectiveTo = prior.effectiveTo && prior.effectiveTo.getTime() < next.effectiveFrom.getTime() ? prior.effectiveTo : next.effectiveFrom;
  return { ok: true, priorEffectiveTo };
}

/** The canonical content of a version: its lines, in line order, minus anything that is not a term of the rate. */
export type LineForHash = { lineNo: number | null; serviceCode: string; lineKind: string | null; pricingMethod: string; unit: string; rateMillis: number | null; flatCents: number | null; basisPoints: number | null; multiplierMillis: number | null; minimumQuantityMillis: number | null; minimumChargeCents: number | null; billingIncrementMillis: number | null; roundingMode: string; measurementBasis: string; conditionKey: string | null; applicabilityJson: string | null; resourceClass: string | null; unitId: number | null; effectiveFrom: Date; effectiveTo: Date | null };
export function versionContentHash(lines: readonly LineForHash[]): string {
  const ordered = [...lines].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0) || a.serviceCode.localeCompare(b.serviceCode));
  return sha256(canonicalJson(ordered.map(l => ({ ...l, effectiveFrom: l.effectiveFrom.toISOString(), effectiveTo: l.effectiveTo?.toISOString() ?? null }))));
}

/* ------------------------------------------------- references and the gate */

export type AccountForGate = { status: "active" | "on_hold" | "inactive"; holdReason: string | null; requiresPurchaseOrder: boolean; requiresAfe: boolean; requiredReferenceKindsJson: string | null; archivedAt: Date | null };
export type ContractForGate = { status: ContractStatus; effectiveFrom: Date; effectiveTo: Date | null; poRequirement: "inherit" | "required" | "not_required"; requiredReferenceKindsJson: string | null } | null;

const parseKinds = (json: string | null): ReferenceKind[] => { try { const v = json ? JSON.parse(json) : []; return Array.isArray(v) ? v.filter((x): x is ReferenceKind => typeof x === "string") : []; } catch { return []; } };

/** What must be on the job: the account's list, the contract's list, and the two legacy booleans, unioned; the contract may switch the PO off. */
export function requiredReferenceKinds(account: AccountForGate, contract: ContractForGate): ReferenceKind[] {
  const kinds = new Set<ReferenceKind>(parseKinds(account.requiredReferenceKindsJson));
  if (account.requiresPurchaseOrder) kinds.add("po");
  if (account.requiresAfe) kinds.add("afe");
  if (contract) {
    for (const k of parseKinds(contract.requiredReferenceKindsJson)) kinds.add(k);
    if (contract.poRequirement === "required") kinds.add("po");
    if (contract.poRequirement === "not_required") kinds.delete("po");
  }
  return Array.from(kinds).sort();
}

export type GateInput = {
  account: AccountForGate | null;
  contract: ContractForGate;
  references: readonly { referenceKind: string; referenceValue: string }[];
  /** A recorded decision that the job proceeds without a required reference (emergency work). */
  waiver: { reason: string } | null;
  emergency: boolean;
  snapshot: { status: "current" } | null;
  sheetChoice: "resolved" | "none" | "conflict" | "not_selected";
  at: Date;
};

/**
 * The commercial readiness findings for a job. Codes are stable (the classifier keys on them):
 *   commercial_context_missing          no customer on the job — review, never a stop (a job may not be billable work)
 *   commercial_account_on_hold          the customer is on billing hold — blocking, overridable by management
 *   commercial_account_inactive         archived/inactive customer — blocking, overridable by management
 *   commercial_contract_not_usable      contract named but not active / out of window — blocking, overridable
 *   commercial_reference_missing        a required PO/AFE/… is absent — blocking; REVIEW when a waiver or emergency is recorded
 *   commercial_rate_sheet_unresolved    no governing sheet version, or two — review (billing will say UNKNOWN RATE)
 *   commercial_snapshot_missing         no current snapshot yet — review (the posting captures one)
 * Emergency never bypasses safety; here it only turns a missing paper reference into a review item,
 * which is the in-repo precedent ("proceed, then review" — assessCalloutBilling).
 */
export function commercialReadiness(g: GateInput): DispatchBlocker[] {
  const out: DispatchBlocker[] = [];
  const job = (code: string, label: string, severity: DispatchBlocker["severity"], overridable: boolean, overrideAuthority?: DispatchBlocker["overrideAuthority"]) => out.push({ code, label, severity, subject: "job", overridable, ...(overrideAuthority ? { overrideAuthority } : {}) });
  if (!g.account) { job("commercial_context_missing", "No customer is assigned to this job", "review", true, "dispatcher"); return out; }
  if (g.account.status === "on_hold") job("commercial_account_on_hold", `Customer is on billing hold${g.account.holdReason ? `: ${g.account.holdReason}` : ""}`, "blocking", true, "manager");
  if (g.account.status === "inactive" || g.account.archivedAt) job("commercial_account_inactive", "Customer account is inactive or archived", "blocking", true, "manager");
  if (g.contract) { const u = contractUsable(g.contract, g.at); if (!u.usable) job("commercial_contract_not_usable", `Contract cannot govern this job: ${u.reason}`, "blocking", true, "manager"); }
  const required = requiredReferenceKinds(g.account, g.contract);
  const present = new Set(g.references.filter(r => r.referenceValue.trim() !== "").map(r => r.referenceKind));
  const missing = required.filter(k => !present.has(k));
  if (missing.length) {
    const relaxed = g.waiver != null || g.emergency;
    job("commercial_reference_missing", `Required customer reference${missing.length > 1 ? "s" : ""} missing: ${missing.join(", ")}${relaxed ? (g.waiver ? ` — waived: ${g.waiver.reason}` : " — emergency dispatch; establish before billing") : ""}`, relaxed ? "review" : "blocking", true, "manager");
  }
  if (g.sheetChoice === "none") job("commercial_rate_sheet_unresolved", "No approved rate sheet version governs this job's date", "review", true, "dispatcher");
  if (g.sheetChoice === "conflict") job("commercial_rate_sheet_unresolved", "Two approved rate sheet versions cover this job's date — a person decides which governs", "review", true, "manager");
  if (!g.snapshot) job("commercial_snapshot_missing", "The job's commercial basis has not been snapshotted yet", "review", true, "dispatcher");
  return out;
}

/* ------------------------------------------------------------- the snapshot */

export type SnapshotDefinition = { definitionRef: string; version: number; serviceCode: string; lineKind: string | null; lineNo: number | null; label: string | null; pricingMethod: string; unit: string; rateMillis: number | null; flatCents: number | null; basisPoints: number | null; multiplierMillis: number | null; minimumQuantityMillis: number | null; minimumChargeCents: number | null; billingIncrementMillis: number | null; roundingMode: string; measurementBasis: string; conditionKey: string | null; applicabilityJson: string | null; scopeLevel: string; effectiveFrom: string; effectiveTo: string | null; sourceClause: string | null };
export type SnapshotContact = { contactRef: string; displayName: string; company: string | null; title: string | null; phone: string | null; mobile: string | null; email: string | null; roles: string[]; partyRole: PartyRole | null };
export type SnapshotParty = { partyRole: PartyRole; customerAccountRef: string | null; customerName: string | null; contactRef: string | null; contactName: string | null; orgRef: string | null; freeText: string | null; linked: boolean };
export type SnapshotPayload = {
  schema: "job-commercial-snapshot/1";
  job: { id: number; jobCode: string };
  customer: { accountRef: string; customerNumber: string | null; name: string; legalName: string | null; tradeName: string | null; customerType: string; status: string; taxStatus: string; gstNumber: string | null; billingAddress: unknown; physicalAddress: unknown; defaultCurrency: string; paymentTermsDays: number; requiresPurchaseOrder: boolean; requiresAfe: boolean; requiredReferenceKinds: string[] };
  billTo: { accountRef: string; name: string; billingAddress: unknown; paymentTermsDays: number } ;
  contract: { contractRef: string; contractNumber: string; title: string; contractType: string; version: number; status: string; effectiveFrom: string; effectiveTo: string | null; poRequirement: string; paymentTermsDays: number | null; billingInstructions: string | null; customerReferences: unknown } | null;
  terms: { termsRef: string; version: number; title: string; effectiveFrom: string; effectiveTo: string | null } | null;
  rateSheet: { rateSheetRef: string; name: string; sheetNumber: string | null; currency: string; versionRef: string; version: number; effectiveFrom: string; effectiveTo: string | null; contentHash: string | null; definitions: SnapshotDefinition[] } | null;
  purchaseOrder: { poRef: string; poNumber: string; afeNumber: string | null; authorizedCents: number; validFrom: string; validTo: string | null; status: string } | null;
  references: { referenceKind: string; referenceValue: string }[];
  parties: SnapshotParty[];
  contacts: SnapshotContact[];
  requiredReferenceKinds: string[];
  missingReferenceKinds: string[];
  waiver: { reason: string; byUserId: number; at: string } | null;
  effective: { paymentTermsDays: number; currency: string; poRequired: boolean; billingInstructions: string | null };
  capturedAt: string;
};
/** The hash covers the basis, not the clock: two captures of an unchanged basis hash the same, so a re-capture is a no-op rather than a new sequence. */
export const snapshotHash = (p: SnapshotPayload) => sha256(canonicalJson({ ...p, capturedAt: undefined }));

/**
 * What a field device may carry. No rate, no term, no credit figure — only what the driver
 * needs to do the work and get the paper signed: who the customer is, the job's references,
 * the contacts on site, and which references still have to be collected.
 */
export type FieldCommercialSubset = {
  jobId: number; jobCode: string; snapshotRef: string; snapshotHash: string;
  customer: { name: string; customerNumber: string | null };
  contractNumber: string | null;
  references: { referenceKind: string; referenceValue: string }[];
  requiredReferenceKinds: string[];
  missingReferenceKinds: string[];
  contacts: { displayName: string; company: string | null; title: string | null; phone: string | null; mobile: string | null; roles: string[]; partyRole: PartyRole | null }[];
  parties: { partyRole: PartyRole; name: string | null }[];
};
export function fieldSubsetOf(s: { snapshotRef: string; payloadHash: string; payload: SnapshotPayload }): FieldCommercialSubset {
  const p = s.payload;
  return {
    jobId: p.job.id, jobCode: p.job.jobCode, snapshotRef: s.snapshotRef, snapshotHash: s.payloadHash,
    customer: { name: p.customer.name, customerNumber: p.customer.customerNumber },
    contractNumber: p.contract?.contractNumber ?? null,
    references: p.references,
    requiredReferenceKinds: p.requiredReferenceKinds,
    missingReferenceKinds: p.missingReferenceKinds,
    contacts: p.contacts.filter(c => c.partyRole == null || CONTACT_PARTY_ROLES.includes(c.partyRole)).map(c => ({ displayName: c.displayName, company: c.company, title: c.title, phone: c.phone, mobile: c.mobile, roles: c.roles, partyRole: c.partyRole })),
    parties: p.parties.filter(x => !CONTACT_PARTY_ROLES.includes(x.partyRole)).map(x => ({ partyRole: x.partyRole, name: x.customerName ?? x.freeText ?? x.orgRef })),
  };
}

/**
 * The interface the Billing / AR checkpoint consumes. Everything comes from the CURRENT snapshot;
 * nothing is read from the live customer, contract or sheet — that is the whole point.
 */
export type BillableCommercialContext = {
  jobId: number; jobCode: string; snapshotRef: string; snapshotSequence: number; snapshotHash: string; capturedAt: string;
  billTo: SnapshotPayload["billTo"];
  customer: SnapshotPayload["customer"];
  contract: SnapshotPayload["contract"];
  terms: SnapshotPayload["terms"];
  rateSheet: SnapshotPayload["rateSheet"];
  applicableRates: SnapshotDefinition[];
  purchaseOrder: SnapshotPayload["purchaseOrder"];
  references: SnapshotPayload["references"];
  requiredReferenceKinds: string[];
  missingReferenceKinds: string[];
  paymentTermsDays: number; currency: string; poRequired: boolean; billingInstructions: string | null;
  supportingDocumentRequirements: string[];
  blockers: { code: string; detail: string }[];
};
export function billableContextOf(s: { jobId: number; snapshotRef: string; sequenceNo: number; payloadHash: string; capturedAt: Date; payload: SnapshotPayload }, supportingDocumentRequirements: string[]): BillableCommercialContext {
  const p = s.payload;
  const blockers: { code: string; detail: string }[] = [];
  if (!p.rateSheet) blockers.push({ code: "no_rate_sheet_version", detail: "The snapshot carries no governing rate sheet version; lines will price UNKNOWN RATE unless a company-level definition applies" });
  if (p.missingReferenceKinds.length) blockers.push({ code: "reference_missing", detail: `Required before billing: ${p.missingReferenceKinds.join(", ")}${p.waiver ? ` (dispatch waived: ${p.waiver.reason})` : ""}` });
  if (p.customer.status === "on_hold") blockers.push({ code: "account_on_hold", detail: "The customer was on billing hold when the job was activated" });
  return {
    jobId: s.jobId, jobCode: p.job.jobCode, snapshotRef: s.snapshotRef, snapshotSequence: s.sequenceNo, snapshotHash: s.payloadHash, capturedAt: s.capturedAt.toISOString(),
    billTo: p.billTo, customer: p.customer, contract: p.contract, terms: p.terms, rateSheet: p.rateSheet,
    applicableRates: p.rateSheet?.definitions ?? [], purchaseOrder: p.purchaseOrder, references: p.references,
    requiredReferenceKinds: p.requiredReferenceKinds, missingReferenceKinds: p.missingReferenceKinds,
    paymentTermsDays: p.effective.paymentTermsDays, currency: p.effective.currency, poRequired: p.effective.poRequired, billingInstructions: p.effective.billingInstructions,
    supportingDocumentRequirements, blockers,
  };
}

/** Optimistic concurrency: the row the caller read must be the row that is there. */
export function rowVersionCheck(expected: number | undefined, actual: number): { ok: true } | { ok: false; reason: string } {
  if (expected === undefined) return { ok: true };
  return expected === actual ? { ok: true } : { ok: false, reason: `changed since you loaded it (version ${actual}, you had ${expected}) — reload and try again` };
}
