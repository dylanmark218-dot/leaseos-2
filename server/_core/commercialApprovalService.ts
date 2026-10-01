/**
 * P7.4 — recording an approval against the ledger, for any money subject.
 *
 * `decide()` is the one door: it resolves the ladder for the acting book, refuses
 * by name (mayApprove), appends the signature, recomputes progress from the
 * rows, and reports whether the requirement is now satisfied. The caller flips
 * its subject's status only on `satisfied`. Nothing here edits the subject.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { commercialApprovalPolicies, commercialApprovalSignatures, commercialApprovals, userRoleAssignments } from "../../drizzle/schema";
import { resolveActingScope, SINGLE_TENANT_ID } from "./actingScope";
import { grantsInOrganization, type RoleGrant } from "./recordsAuthorization";
import { ledgerProgress, mayApprove, type LedgerApproval } from "./commercialApprovals";
import { approvalRequirementFor, type ApprovalPolicyRow, type ApprovalRequirement } from "./commercialPolicy";

type Db = MySql2Database<Record<string, unknown>>;
const jsonArray = <T,>(v: unknown): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : Array.isArray(v) ? (v as T[]) : []);
const parseReq = (v: unknown): ApprovalRequirement => (typeof v === "string" ? JSON.parse(v) : v) as ApprovalRequirement;
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export type DecideResult =
  | { outcome: "satisfied"; approvalRef: string; approvals: number; required: number }
  | { outcome: "awaiting"; approvalRef: string; approvals: number; required: number; awaiting: string }
  | { outcome: "refused"; approvalRef: string }
  | { outcome: "blocked"; approvalRef: string | null; reason: string };

export async function decide(db: Db, args: { actorUserId: number; category: string; subjectType: string; subjectRef: string; amountCents: number; preparedByUserId: number | null; decision: "approved" | "refused"; note?: string }): Promise<DecideResult> {
  const scope = await resolveActingScope(db as never, args.actorUserId);
  const bookOrgRef = scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId;
  // B23.1 — the roles that authorize an approval in THIS company, and only the
  // ones still in force. This read previously filtered neither: it returned
  // every row for the user, revoked grants included, across every organization
  // they had ever held a role in. A commercial approval is a financial act, so
  // it is the last place either should have been true.
  const roles = grantsInOrganization(
    (await db
      .select({ role: userRoleAssignments.role, scopeType: userRoleAssignments.scopeType, orgRef: userRoleAssignments.orgRef, scopeRef: userRoleAssignments.scopeRef })
      .from(userRoleAssignments)
      .where(and(eq(userRoleAssignments.userId, args.actorUserId), isNull(userRoleAssignments.revokedAt)))
    ).map(r => ({ role: r.role as string, scopeType: r.scopeType as RoleGrant["scopeType"], orgRef: r.orgRef ?? null, scopeRef: r.scopeRef ?? null })),
    scope.tenantId,
  ).map(g => g.role);

  // The ledger row for this subject, created on first contact with the requirement snapshotted.
  //
  // F1 — the approval's identity is book + subject type + subject. The ledger's unique key is
  // (subjectType, subjectRef), so a row for the same subject identifier in ANOTHER book is found here —
  // and is never reused: signatures gathered in one company's book cannot satisfy another's. Such a
  // collision is refused rather than resolved (a new row would violate the key, and silently picking
  // either book is the bug). Subject refs are system-issued, so this is a guard, not a normal path.
  let row = (await db.select().from(commercialApprovals).where(and(eq(commercialApprovals.subjectType, args.subjectType), eq(commercialApprovals.subjectRef, args.subjectRef))).limit(1))[0];
  if (row && (row.bookOrgRef ?? null) !== bookOrgRef) {
    return { outcome: "blocked", approvalRef: null, reason: `The approval ledger for ${args.subjectType} ${args.subjectRef} belongs to another book — an approval recorded there does not count here` };
  }
  if (!row) {
    const policies = (await db.select().from(commercialApprovalPolicies)) as ApprovalPolicyRow[];
    const scoped = policies.filter(p => p.bookOrgRef === null || p.bookOrgRef === bookOrgRef).map(p => ({ ...p, maxAmountCents: p.maxAmountCents === null ? null : Number(p.maxAmountCents) }));
    const requirement = approvalRequirementFor(scoped, { bookOrgRef, category: args.category, amountCents: args.amountCents });
    const approvalRef = ref("APPR");
    await db.insert(commercialApprovals).values({ approvalRef, bookOrgRef, category: args.category, subjectType: args.subjectType, subjectRef: args.subjectRef, amountCents: args.amountCents, preparedByUserId: args.preparedByUserId, requirement, status: requirement.state === "UNKNOWN" ? "review" : "awaiting" });
    row = (await db.select().from(commercialApprovals).where(eq(commercialApprovals.approvalRef, approvalRef)).limit(1))[0]!;
  }
  if (row.status === "satisfied" || row.status === "refused") return { outcome: "blocked", approvalRef: row.approvalRef, reason: `Already ${row.status}` };
  const requirement = parseReq(row.requirement);
  const sigs = await db.select().from(commercialApprovalSignatures).where(eq(commercialApprovalSignatures.commercialApprovalId, row.id)).orderBy(commercialApprovalSignatures.sequence);
  const prior: LedgerApproval[] = sigs.filter(s => s.decision === "approved").map(s => ({ userId: s.userId, roles: jsonArray<string>(s.rolesAtApproval), at: s.at }));

  if (args.decision === "refused") {
    // A refusal needs the same standing as an approval (and never from the preparer).
    const may = mayApprove(requirement, [], { userId: args.actorUserId, roles }, args.preparedByUserId);
    if (!may.allowed && !may.reason.startsWith("REVIEW")) return { outcome: "blocked", approvalRef: row.approvalRef, reason: may.reason };
    await db.insert(commercialApprovalSignatures).values({ commercialApprovalId: row.id, sequence: sigs.length + 1, userId: args.actorUserId, rolesAtApproval: roles, decision: "refused", note: args.note ?? null });
    await db.update(commercialApprovals).set({ status: "refused" }).where(eq(commercialApprovals.id, row.id));
    return { outcome: "refused", approvalRef: row.approvalRef };
  }
  const may = mayApprove(requirement, prior, { userId: args.actorUserId, roles }, args.preparedByUserId);
  if (!may.allowed) return { outcome: "blocked", approvalRef: row.approvalRef, reason: may.reason };
  await db.insert(commercialApprovalSignatures).values({ commercialApprovalId: row.id, sequence: sigs.length + 1, userId: args.actorUserId, rolesAtApproval: roles, decision: "approved", note: args.note ?? null });
  const progress = ledgerProgress(requirement, [...prior, { userId: args.actorUserId, roles, at: new Date() }]);
  if (progress.state === "SATISFIED") {
    await db.update(commercialApprovals).set({ status: "satisfied", satisfiedAt: new Date() }).where(eq(commercialApprovals.id, row.id));
    return { outcome: "satisfied", approvalRef: row.approvalRef, approvals: progress.approvals, required: progress.required };
  }
  if (progress.state === "AWAITING") return { outcome: "awaiting", approvalRef: row.approvalRef, approvals: progress.approvals, required: progress.required, awaiting: progress.awaiting };
  return { outcome: "blocked", approvalRef: row.approvalRef, reason: `REVIEW — ${progress.reason}` };
}
