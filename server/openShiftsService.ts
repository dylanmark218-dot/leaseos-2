/**
 * 0206 — Open Work: the reads and resolvers the router composes, over rules that already decide.
 *
 * `_core/openShifts.ts` owns the marketplace rules (who could take a post, what interest is, the
 * post's and the offer's life). `readinessComposer` owns readiness. `timeOff` owns absence and
 * `crewCoverage` owns rotation. This file re-decides none of them; it reads the records each rule
 * needs and hands them over, which is what the SPINE plan calls a resolver.
 *
 * **The board reads no credential store of its own.** Whether a person holds H2S is answered by
 * the D-05 qualification read adapter (`qualificationReads.effectiveQualifications`, C1b-3): the
 * Academy grant decides, the compliance document it rests on is read as its evidence, and a legacy
 * holding is only a marked fallback where no grant exists — all of that inside the adapter. A code nothing holds
 * is `unknown`, and unknown is not satisfied. This is the same read readiness, crews and the
 * calendar use; reconciling with main retired the board's own version of it.
 *
 * **One rule decides who may take a post** (SPINE item 2, owner's ruling): `shiftEligibility` in
 * `_core/openShifts.ts`, over `personFacts` — the records it reads, moved here from the router
 * unchanged so the router and the Open Work preview read the same facts. The preview's verdict IS
 * that rule's verdict. Declared availability and dispatch readiness are shown beside it as their own
 * axes and never added to it: a second list of refusals would be a second rule.
 *
 * **Readiness is a preview here.** `composeReadiness` is called for the post's start instant and
 * its verdict is shown with its blocker codes; nothing is stored, and nothing here is an award.
 * The stored, fingerprinted check the award consumes is `dispatch.evaluate`'s, made by a dispatcher
 * for the exact slot, and the award refuses without it — readiness is enforced there, fail closed.
 */
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import {
  crewMembers, crews, leaveRequests, resourceBookings, shiftInterests, shiftOffers,
  shiftPostEvents, shiftPosts, workerAvailability,
} from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import { SINGLE_TENANT_ID, type ActingScope } from "./_core/actingScope";
import type { LeaveRequest } from "./_core/timeOff";
import { grantsInOrganization } from "./_core/recordsAuthorization";
import {
  availabilityReasons, declaredStateAt, effectiveOfferStatus, effectivePostStatus, shiftEligibility,
  type AvailabilityDeclaration, type AvailabilityPreferences, type AvailabilityState, type Candidate, type IneligibilityCode, type PersonFacts, type PostStatus, type ShiftPost,
} from "./_core/openShifts";
import { composeReadiness } from "./readinessComposer";
import { effectiveQualifications } from "./qualificationReads";
import { driverLicenceStanding } from "./licenceReads";
import { conflictingBookingsWhere } from "./_core/bookingConflict";
import { listActiveUserRoles, operatorForUserInScope, orgScopeWhere, userInScope } from "./db";

export type ShiftPostRow = typeof shiftPosts.$inferSelect;

export const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

/** The engine's view of a stored post. */
export function toShiftPost(row: ShiftPostRow): ShiftPost {
  return {
    postRef: row.postRef, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, location: row.location,
    requiredRole: row.requiredRole, requiredQualifications: JSON.parse(row.requiredQualificationsJson) as string[],
    seats: row.seats, kind: row.kind, status: row.status as PostStatus,
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
/* The facts, and the preview                                           */
/* ------------------------------------------------------------------ */

/**
 * The records `shiftEligibility` reads about one person, in the post's organization. Reads only;
 * every judgement is the engine's. Someone outside the organization is not read at all.
 */
export async function personFacts(d: DbOrTx, tenantId: string, post: ShiftPost, userId: number): Promise<PersonFacts> {
  const scope = { tenantId };
  const none: PersonFacts = { userId, name: `user ${userId}`, inOrganization: false, roles: [], rosters: [], leave: [], commitments: [], licence: { kind: "none" }, qualifications: [] };
  if (!(await userInScope(userId, scope))) return none;

  const roles = grantsInOrganization(await listActiveUserRoles(userId), tenantId).map(g => g.role);

  const rosterRows = await d.select({ on: crewMembers.rotationOnDays, off: crewMembers.rotationOffDays, anchor: crewMembers.rotationAnchor })
    .from(crewMembers).innerJoin(crews, eq(crews.crewRef, crewMembers.crewRef))
    .where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt), eq(crews.state, "active"),
      tenantId === SINGLE_TENANT_ID ? or(isNull(crews.tenantId), eq(crews.tenantId, SINGLE_TENANT_ID)) : eq(crews.tenantId, tenantId)))
    .limit(50);
  const rosters = rosterRows.map(r => ({ rotation: r.on && r.anchor ? { onDays: r.on, offDays: r.off ?? 0, anchor: r.anchor, label: `${r.on}/${r.off ?? 0}` } : null }));

  const leaveRows = await d.select().from(leaveRequests).where(and(
    eq(leaveRequests.userId, userId), lte(leaveRequests.fromDate, post.startsAt), gte(leaveRequests.toDate, post.startsAt),
  )).limit(50);
  const leave: LeaveRequest[] = leaveRows.map(l => ({
    requestRef: l.requestRef, userId: l.userId, category: l.category, urgency: l.urgency,
    from: l.fromDate, to: l.toDate,
    partialDay: l.partialFromTime && l.partialToTime ? { fromTime: l.partialFromTime, toTime: l.partialToTime } : null,
    privateNote: null, requestedAt: l.requestedAt, status: l.status,
    decidedByUserId: l.decidedByUserId, decidedAt: l.decidedAt, decisionNote: l.decisionNote,
  } as LeaveRequest));

  // The person's own operator record (operators.userId, owned by this organization). Two is a refusal, not a choice.
  const op = await operatorForUserInScope(userId, scope);
  // The licence at the shift, through the licence read adapter over the canonical verdict
  // (documents first, the legacy date only as an unverified claim) — never judged here.
  const licence = await driverLicenceStanding(d, op, post.startsAt);
  let commitments: PersonFacts["commitments"] = [];
  if (op.kind === "resolved") {
    // The one booking-conflict rule (_core/bookingConflict.ts), the same one the award re-checks.
    const booked = await d.select().from(resourceBookings)
      .where(conflictingBookingsWhere({ type: "operator", ref: String(op.operatorId) }, post)).limit(20);
    commitments = booked.map(b => ({ assignmentRef: `booking ${b.id}${b.postingId != null ? ` (posting ${b.postingId})` : ""}`, startsAt: b.startsAt, endsAt: b.endsAt }));
  }

  const qualifications = post.requiredQualifications.length
    ? (await effectiveQualifications(d, { tenantId, userId, at: post.startsAt, codes: post.requiredQualifications }))
      .map(q => ({ code: q.code, held: q.held, notHeld: q.notHeld, reason: q.reason }))
    : [];

  return { userId, name: `user ${userId}`, inOrganization: true, roles, rosters, leave, commitments, licence, qualifications };
}

export type PreviewReason = { code: string; detail: string };

export type Preview = {
  userId: number;
  /** The one rule's answer (`shiftEligibility`): whether this person may take the post. */
  eligible: boolean;
  /**
   * The same answer for a screen: `ineligible` when a recorded fact excludes them, `unknown` when
   * every reason is something that could not be established. Both are "no" — unknown refuses
   * exactly as a failed check does — the difference is only what the person can do about it.
   */
  verdict: "eligible" | "ineligible" | "unknown";
  /** The rule's reasons, unrenamed. */
  reasons: PreviewReason[];
  /** The readiness composer's own answer for the post's start, or null when nothing could be composed. Its own axis. */
  readiness: { verdict: string; blockerCodes: string[]; notEvaluated: string[]; operatorBlockers: PreviewReason[] } | null;
  /** Declared availability at the post's start. Its own axis: a statement of willingness, never a refusal. */
  availability: AvailabilityState | "undeclared";
  /** What the declaration says about this post (declines overtime, outside region, unavailable). */
  availabilityNotes: PreviewReason[];
  interestExpressed: boolean;
};

/** Codes of the rule that mean "could not be established" rather than "established and excluding". */
const UNESTABLISHED: ReadonlySet<IneligibilityCode> = new Set<IneligibilityCode>(["no_licence_recorded", "licence_not_established", "qualification_unknown", "qualification_unverified"]);

/** The rule's verdict for one person, from their records. Nothing in it is the caller's to supply. */
export async function eligibilityOf(d: DbOrTx, args: { post: ShiftPostRow; userId: number; scope: ActingScope }): Promise<Candidate> {
  const post = toShiftPost(args.post);
  return shiftEligibility(post, await personFacts(d, args.scope.tenantId, post, args.userId));
}

/**
 * Could this person take this post — the one rule — and, beside it, what they declared and what the
 * readiness composer would say. Every reason is collected; nothing on the two side axes changes the
 * verdict.
 */
export async function previewFor(d: DbOrTx, args: { post: ShiftPostRow; userId: number; scope: ActingScope; now: Date }): Promise<Preview> {
  const post = toShiftPost(args.post);
  const candidate = await eligibilityOf(d, args);
  const reasons = candidate.reasons.map(r => ({ code: r.code, detail: r.detail }));
  const verdict: Preview["verdict"] = candidate.eligible ? "eligible"
    : candidate.reasons.every(r => UNESTABLISHED.has(r.code)) ? "unknown" : "ineligible";

  const declarations = await declarationsFor(d, args.userId, args.scope);
  const availability = declaredStateAt(declarations, post.startsAt);
  const inForce = declarations.find(x => declaredStateAt([x], post.startsAt) !== "undeclared") ?? null;
  const availabilityNotes = availabilityReasons({ state: availability, preferences: inForce?.preferences ?? null, post: { overtime: args.post.overtime, regionCode: args.post.regionCode } })
    .filter(r => r.code !== "undeclared");   // silence is reported as `availability`, neither yes nor no

  let readiness: Preview["readiness"] = null;
  const op = candidate.reasons.length && !candidate.eligible && candidate.reasons[0]!.code === "not_in_organization"
    ? null : await operatorForUserInScope(args.userId, { tenantId: args.scope.tenantId });
  if (op?.kind === "resolved") {
    try {
      const r = await composeReadiness({ operatorId: op.operatorId, unitId: args.post.unitId ?? null, trailerId: null, jobId: null, postingId: args.post.dispatchPostingId ?? null }, post.startsAt);
      readiness = {
        verdict: r.eligibility.verdict, blockerCodes: r.eligibility.blockers.map(b => b.code),
        notEvaluated: r.capabilities.filter(c => c.status === "NOT_EVALUATED").map(c => c.capability),
        // Findings about the person, for the card. A truck, job or route finding is not about the
        // candidate; and none of these is a refusal here — the award's stored check is where they bind.
        operatorBlockers: r.eligibility.blockers.filter(b => b.subject === "operator" && b.severity === "blocking").map(b => ({ code: b.code, detail: b.label })),
      };
    } catch {
      readiness = null;
    }
  }

  const interest = (await d.select({ id: shiftInterests.id, response: shiftInterests.response }).from(shiftInterests).where(and(
    eq(shiftInterests.postRef, args.post.postRef), eq(shiftInterests.userId, args.userId), isNull(shiftInterests.withdrawnAt),
  )).limit(1))[0];

  return { userId: args.userId, eligible: candidate.eligible, verdict, reasons, readiness, availability, availabilityNotes, interestExpressed: !!interest && interest.response !== "declined" };
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
