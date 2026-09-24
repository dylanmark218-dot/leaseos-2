/**
 * 0183 — Open Work: the reads and resolvers the router composes, over rules that already decide.
 *
 * `_core/openShifts.ts` owns the marketplace rules (who could take a post, what interest is, the
 * post's and the offer's life). `readinessComposer` owns readiness. `timeOff` owns absence and
 * `crewCoverage` owns rotation. This file re-decides none of them; it reads the records each rule
 * needs and hands them over, which is what the SPINE plan calls a resolver.
 *
 * **The board reads no credential store.** Whether a person holds H2S is answered by the two
 * canonical authorities D-05 named — `academyQualifications` (a grant) and `complianceDocuments`
 * (a verified document) — and by nothing else. A code neither holds is `unknown`, and unknown is
 * not satisfied. The inline read of `workerQualifications` this replaces was reading a table
 * nothing in production writes, which made every ticket-requiring post permanently unknown while
 * looking like a check.
 *
 * **Readiness is a preview here.** `composeReadiness` is called for the post's start instant and
 * its verdict is shown with its blocker codes; nothing is stored, and nothing here is an award.
 * The stored, fingerprinted check the award consumes is `dispatch.evaluate`'s, made by a dispatcher
 * for the exact slot. A person with no operator record previews `unknown`, never `eligible`.
 */
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  academyQualifications, complianceDocuments, crewMembers, crews, leaveRequests, operators, shiftInterests, shiftOffers,
  shiftPostEvents, shiftPosts, workerAvailability,
} from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import { SINGLE_TENANT_ID, type ActingScope } from "./_core/actingScope";
import { isAbsent, type LeaveRequest } from "./_core/timeOff";
import { type CrewMember } from "./_core/crewCoverage";
import {
  availabilityReasons, candidatesFor, declaredStateAt, effectiveOfferStatus, effectivePostStatus,
  type AvailabilityDeclaration, type AvailabilityPreferences, type AvailabilityState, type Candidate, type Ineligibility, type PostStatus, type ShiftPost,
} from "./_core/openShifts";
import { composeReadiness } from "./readinessComposer";
import { missingFrom, type NotHeldCode, type QualificationHolding } from "./_core/qualificationValidity";
import { listActiveUserRoleNames, operatorInScope, orgScopeWhere } from "./db";

export type ShiftPostRow = typeof shiftPosts.$inferSelect;

export const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** The engine's view of a stored post. */
export function toShiftPost(row: ShiftPostRow): ShiftPost {
  return {
    postRef: row.postRef, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, location: row.location,
    requiredRole: row.requiredRole, requiredQualifications: JSON.parse(row.requiredQualificationsJson) as string[],
    seats: row.seats, kind: row.kind,
  };
}

/** A leave row as the engine wants it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const toLeave = (l: any): LeaveRequest => ({
  requestRef: l.requestRef, userId: l.userId, category: l.category, urgency: l.urgency,
  from: l.fromDate, to: l.toDate,
  partialDay: l.partialFromTime && l.partialToTime ? { fromTime: l.partialFromTime, toTime: l.partialToTime } : null,
  privateNote: null, requestedAt: l.requestedAt, status: l.status,
  decidedByUserId: l.decidedByUserId, decidedAt: l.decidedAt, decisionNote: l.decisionNote,
});

/** The post's status as of `now`, expiry derived on read. */
export function statusNow(row: ShiftPostRow, now: Date): PostStatus {
  return effectivePostStatus({ status: row.status as PostStatus, closesAt: row.closesAt }, now);
}

/* ------------------------------------------------------------------ */
/* Availability                                                         */
/* ------------------------------------------------------------------ */

export function parsePreferences(json: string | null): AvailabilityPreferences | null {
  if (!json) return null;
  try { return JSON.parse(json) as AvailabilityPreferences; } catch { return null; }
}

/** Live declarations for one person, newest first. */
export async function declarationsFor(d: DbOrTx, userId: number, scope: { tenantId: string }): Promise<(AvailabilityDeclaration & { availabilityRef: string })[]> {
  const rows = await d.select().from(workerAvailability).where(and(
    eq(workerAvailability.userId, userId), isNull(workerAvailability.supersededAt), orgScopeWhere(workerAvailability, scope),
  )).orderBy(desc(workerAvailability.declaredAt)).limit(50);
  return rows.map(r => ({
    availabilityRef: r.availabilityRef, state: r.state as AvailabilityState, windowStartsAt: r.windowStartsAt, windowEndsAt: r.windowEndsAt,
    preferences: parsePreferences(r.preferencesJson), declaredAt: r.declaredAt,
  }));
}

/** Everybody in the organization with a live declaration that covers an instant. The "Offer Me Work" pool. */
export async function declarersCovering(d: DbOrTx, scope: { tenantId: string }, at: Date): Promise<number[]> {
  const rows = await d.select({ userId: workerAvailability.userId, windowStartsAt: workerAvailability.windowStartsAt, windowEndsAt: workerAvailability.windowEndsAt, state: workerAvailability.state })
    .from(workerAvailability)
    .where(and(isNull(workerAvailability.supersededAt), orgScopeWhere(workerAvailability, scope), inArray(workerAvailability.state, ["available", "on_call", "available_for_overtime"])))
    .limit(2000);
  const out = new Set<number>();
  for (const r of rows) {
    if (r.windowStartsAt && r.windowStartsAt.getTime() > at.getTime()) continue;
    if (r.windowEndsAt && r.windowEndsAt.getTime() <= at.getTime()) continue;
    out.add(r.userId);
  }
  return Array.from(out);
}

/* ------------------------------------------------------------------ */
/* Qualifications — the canonical pair, and nothing else               */
/* ------------------------------------------------------------------ */

export type QualificationVerdict = { code: string; held: boolean; why: NotHeldCode | null; reason: string };

/**
 * An Academy grant presented to the shared rule as the holding it is: a `current` grant is a
 * verified holding, `pending` is an extraction nobody has asserted, `revoked`/`rejected` are
 * rejected. `validFrom`/`expiresAt` are what they say; `createdAt` orders competing grants.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const grantAsHolding = (g: any): QualificationHolding => ({
  holdingRef: g.qualificationRef, code: g.qualificationCode,
  verificationState: g.status === "current" || g.status === "expired" ? "verified" : g.status === "pending" ? "extracted" : "rejected",
  issuedAt: g.validFrom ?? null, expiresAt: g.expiresAt ?? null, recordedAt: g.createdAt,
});

/** A compliance document presented the same way: `needs_review` is unverified, `capturedAt` orders versions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const documentAsHolding = (x: any, code: string): QualificationHolding => ({
  holdingRef: `CD-${x.id}`, code,
  verificationState: x.verificationStatus === "verified" ? "verified" : x.verificationStatus === "rejected" ? "rejected" : "unverified",
  issuedAt: null, expiresAt: x.expiresAt ?? null, recordedAt: x.capturedAt ?? x.createdAt,
});

/**
 * Whether a person holds each required code at an instant, from the two canonical authorities
 * (D-05), decided by the one shared rule — `qualificationValidity.missingFrom`, the same adapter
 * the readiness and crew routers reach — never by reading columns here. Classified by the rule's
 * returned code, never by its prose.
 */
export async function qualificationVerdicts(d: DbOrTx, args: { userId: number; operatorId: number | null; codes: readonly string[]; at: Date }): Promise<QualificationVerdict[]> {
  if (!args.codes.length) return [];
  const grants = await d.select().from(academyQualifications).where(eq(academyQualifications.userId, args.userId)).limit(200);
  const docs = args.operatorId
    ? await d.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, "operator"), eq(complianceDocuments.ownerId, args.operatorId))).limit(200)
    : [];
  const holdings: QualificationHolding[] = [];
  for (const code of args.codes) {
    const key = code.toLowerCase();
    for (const g of grants) if (g.qualificationCode.toLowerCase() === key) holdings.push({ ...grantAsHolding(g), code });
    for (const x of docs) if (x.docType.toLowerCase() === key || x.docType.toLowerCase() === `${key}_certificate`) holdings.push(documentAsHolding(x, code));
  }
  const gaps = missingFrom(holdings, args.codes, args.at);
  return args.codes.map(code => {
    const gap = gaps.find(g => g.code === code);
    return gap ? { code, held: false, why: gap.why, reason: gap.reason } : { code, held: true, why: null, reason: `${code}: verified and current` };
  });
}

/* ------------------------------------------------------------------ */
/* The preview                                                          */
/* ------------------------------------------------------------------ */

export type PreviewReason = { code: string; detail: string };

export type Preview = {
  userId: number;
  verdict: "eligible" | "ineligible" | "unknown";
  reasons: PreviewReason[];
  /** The readiness composer's own answer for the post's start, or null when nothing could be composed. */
  readiness: { verdict: string; blockerCodes: string[]; notEvaluated: string[] } | null;
  availability: AvailabilityState | "undeclared";
  interestExpressed: boolean;
};

/** Reason codes that make the preview `ineligible` rather than `unknown`. */
const HARD: ReadonlySet<string> = new Set(["on_approved_leave", "not_rostered", "wrong_role", "overlaps_existing", "declared_unavailable", "licence_expired", "qualification_expired", "readiness_blocked"]);

/**
 * The engine's candidate for one person: role, leave, rotation, overlap — the four things the
 * engine decides. Qualifications are passed as none here and answered by the canonical read, so
 * one question has one answer.
 */
async function engineCandidate(d: DbOrTx, args: { post: ShiftPost; userId: number; name: string; roles: readonly string[] }): Promise<Candidate> {
  const leave = (await d.select().from(leaveRequests).where(eq(leaveRequests.userId, args.userId)).limit(100)).map(toLeave);
  const memberships = await d.select().from(crewMembers).where(and(eq(crewMembers.userId, args.userId), isNull(crewMembers.leftAt))).limit(20);
  const rotated = memberships.find(m => m.rotationOnDays && m.rotationAnchor);
  const member: CrewMember = {
    userId: args.userId, name: args.name, roles: args.roles, currentQualifications: [], existingAssignments: [],
    rotation: rotated ? { onDays: rotated.rotationOnDays!, offDays: rotated.rotationOffDays ?? 0, anchor: rotated.rotationAnchor!, label: `${rotated.rotationOnDays}/${rotated.rotationOffDays ?? 0}` } : null,
    awayOn: leave.filter(l => isAbsent(l) && !l.partialDay && l.from <= args.post.startsAt && args.post.startsAt <= l.to).map(() => args.post.startsAt),
  };
  const [candidate] = candidatesFor({ post: { ...args.post, requiredQualifications: [] }, crew: [member], leave });
  return candidate!;
}

/**
 * Could this person take this post, from what is on record — and what could not be established.
 *
 * Every reason is collected. `unknown` is a verdict of its own, not a soft `eligible`: a person
 * with no operator record, or a required ticket nobody has recorded, is shown as unknown with the
 * code that says why. `ineligible` is reserved for a fact that excludes them.
 */
export async function previewFor(d: DbOrTx, args: { post: ShiftPostRow; userId: number; scope: ActingScope; now: Date }): Promise<Preview> {
  const post = toShiftPost(args.post);
  const roles = await listActiveUserRoleNames(args.userId);
  const op = (await d.select().from(operators).where(eq(operators.userId, args.userId)).limit(1))[0] ?? null;
  const operatorInScopeRow = op ? await operatorInScope(op.id, { tenantId: args.scope.tenantId }) : null;
  const reasons: PreviewReason[] = [];

  const candidate = await engineCandidate(d, { post, userId: args.userId, name: op?.name ?? `user ${args.userId}`, roles });
  for (const r of candidate.reasons) reasons.push({ code: r.code, detail: r.detail });

  const declarations = await declarationsFor(d, args.userId, args.scope);
  const availability = declaredStateAt(declarations, post.startsAt);
  const inForce = declarations.find(x => declaredStateAt([x], post.startsAt) !== "undeclared") ?? null;
  for (const r of availabilityReasons({ state: availability, preferences: inForce?.preferences ?? null, post: { overtime: args.post.overtime, regionCode: args.post.regionCode } })) {
    if (r.code === "undeclared") continue;   // reported as `availability`, not as a reason: silence is neither yes nor no
    reasons.push(r);
  }

  for (const gap of await qualificationVerdicts(d, { userId: args.userId, operatorId: operatorInScopeRow ? op!.id : null, codes: post.requiredQualifications, at: post.startsAt })) {
    if (gap.held) continue;
    // From the structured verdict, not by reading its prose.
    reasons.push({
      code: gap.why === "expired" ? "qualification_expired" : gap.why === "unverified" ? "qualification_unverified" : "qualification_unknown",
      detail: gap.reason,
    });
  }

  let readiness: Preview["readiness"] = null;
  if (!op || !operatorInScopeRow) {
    reasons.push({ code: "no_operator_record", detail: "No operator record is linked to this person — nothing about their licence, hours or tickets can be established" });
  } else {
    try {
      const r = await composeReadiness({ operatorId: op.id, unitId: args.post.unitId ?? null, trailerId: null, jobId: null, postingId: args.post.dispatchPostingId ?? null }, post.startsAt);
      readiness = {
        verdict: r.eligibility.verdict, blockerCodes: r.eligibility.blockers.map(b => b.code),
        notEvaluated: r.capabilities.filter(c => c.status === "NOT_EVALUATED").map(c => c.capability),
      };
      for (const b of r.eligibility.blockers) {
        // The board's own vocabulary for the licence findings it has always named. Every other
        // BLOCKING finding ABOUT THE PERSON is carried under the composer's code, unrenamed, and
        // makes them ineligible here too. A truck, job or route finding is not about the candidate
        // — a post with no unit yet reads "inspection not on file" for a truck nobody has named —
        // and a `review` or `unknown` finding is dispatch's question, answered by the stored check
        // at award. Both stay on the readiness axis beside this verdict, never folded into it: the
        // same rule the dispatcher board applies to staffing and readiness.
        if (b.subject !== "operator") continue;
        if (b.code === "operator_licence_missing" || b.code === "operator_licence_unknown") reasons.push({ code: "no_licence_recorded", detail: "No licence expiry on record — this cannot be established as current" });
        else if (b.code === "operator_licence_expired") reasons.push({ code: "licence_expired", detail: b.label });
        else if (b.severity === "blocking") reasons.push({ code: `readiness_blocked:${b.code}`, detail: b.label });
      }
    } catch (e) {
      reasons.push({ code: "readiness_unavailable", detail: `Readiness could not be composed: ${(e as Error).message}` });
    }
  }

  const interest = (await d.select({ id: shiftInterests.id, response: shiftInterests.response }).from(shiftInterests).where(and(
    eq(shiftInterests.postRef, args.post.postRef), eq(shiftInterests.userId, args.userId), isNull(shiftInterests.withdrawnAt),
  )).limit(1))[0];

  const hard = reasons.some(r => HARD.has(r.code) || r.code.startsWith("readiness_blocked"));
  const verdict: Preview["verdict"] = hard ? "ineligible" : reasons.length ? "unknown" : "eligible";
  return { userId: args.userId, verdict, reasons, readiness, availability, interestExpressed: !!interest && interest.response !== "declined" };
}

/** The reasons that exclude a person from being offered or recorded as interested: facts, not unknowns. */
export function hardReasons(preview: Preview): Ineligibility[] {
  return preview.reasons.filter(r => HARD.has(r.code)).map(r => ({ code: r.code as Ineligibility["code"], detail: r.detail }));
}

/* ------------------------------------------------------------------ */
/* Audit                                                                */
/* ------------------------------------------------------------------ */

export async function postEvent(d: DbOrTx, args: {
  postRef: string; eventType: typeof shiftPostEvents.$inferInsert["eventType"]; actorUserId: number; actorRole: string;
  subjectUserId?: number | null; detail?: string | null; at: Date; deviceAt?: Date | null;
}) {
  await d.insert(shiftPostEvents).values({
    eventRef: ref("SPE"), postRef: args.postRef, eventType: args.eventType, actorUserId: args.actorUserId, actorRole: args.actorRole,
    subjectUserId: args.subjectUserId ?? null, detail: args.detail ?? null, occurredAt: args.at, deviceOccurredAt: args.deviceAt ?? null,
  });
}

/** Live offers on a post, expiry derived on read. */
export async function liveOffersFor(d: DbOrTx, postRef: string, now: Date) {
  const rows = await d.select().from(shiftOffers).where(and(eq(shiftOffers.postRef, postRef), inArray(shiftOffers.status, ["offered", "accepted"]))).limit(200);
  return rows.map(r => ({ ...r, effectiveStatus: effectiveOfferStatus({ status: r.status, expiresAt: r.expiresAt }, now) }));
}

/** Crews of this organization a person is currently on — context for the candidate card. */
export async function crewsOf(d: DbOrTx, userId: number, scope: { tenantId: string }): Promise<string[]> {
  const rows = await d.select({ crewRef: crewMembers.crewRef }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt))).limit(20);
  if (!rows.length) return [];
  const own = await d.select({ crewRef: crews.crewRef, name: crews.name }).from(crews).where(and(inArray(crews.crewRef, rows.map(r => r.crewRef)), scope.tenantId === SINGLE_TENANT_ID ? or(isNull(crews.tenantId), eq(crews.tenantId, SINGLE_TENANT_ID)) : eq(crews.tenantId, scope.tenantId))).limit(20);
  return own.map(c => c.name);
}
