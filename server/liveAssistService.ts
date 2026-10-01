/**
 * LA-1a — the Live Assist session spine against the database.
 *
 * Scope is the owner's LA-1a carve-out (docs/live-assist/LA1A_OWNER_RULING.md): sessions, their
 * lifecycle, policy, the lifecycle record and the purge. There is no model call, image, frame upload,
 * camera, screen, video, document or evidence path anywhere in this file, and
 * `server/liveAssistBoundary.test.ts` fails the build if one is imported.
 *
 * **Tenancy.** Every read and write carries the caller's `orgRef`, which the router resolves with
 * `resolveActingScope` and never takes from input. A session is found by its reference AND its owner
 * AND its organization; anything else is "not found", and a not-found session is never modified.
 *
 * **The server's clock and the server's deadlines.** `now` is passed in (the router passes the real
 * time; tests pass a fixed one). A client can ask for an operation; it cannot supply a state, a
 * deadline or an expiry.
 *
 * **Logs.** Nothing here logs. The worker wrapper logs counts only (`liveAssistSweepTicker`).
 */
import { randomBytes } from "crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  liveAssistEvents, liveAssistFrames, liveAssistObservations, liveAssistPolicies, liveAssistSessions, liveAssistTurns,
  type LiveAssistSessionRow,
} from "../drizzle/schema";
import type { DbOrTx } from "./_core/dbTypes";
import { affectedRows } from "./_core/enforcementCommit";
import {
  bindingVerdict, decideOperation, evaluateDeadlines, initialDeadlines, isOpen, isSessionRef, purgeAfterFor,
  refreshedIdleDeadline, sessionRefFromBytes,
  type Caller, type EndReason, type Operation, type SessionLimits, type SessionSource, type SessionState,
} from "./_core/liveAssist/session";
import {
  LEASEOS_HARD_LIMITS, resolvePolicy, validatePolicyInput,
  type EffectivePolicy, type PolicyInput, type PolicyViolation, type StoredPolicy,
} from "./_core/liveAssist/policy";

type Env = Record<string, string | undefined>;

/* ------------------------------------------------------------------ */
/* Refusals                                                              */
/* ------------------------------------------------------------------ */

export type RefusalCode =
  | "not_found"            // no such session for this caller in this organization
  | "disabled"             // kill switch, organization policy, or no spend ceiling
  | "source_not_allowed"
  | "open_session_exists"  // one open session per person per organization
  | "daily_limit"
  | "terminal"             // the session has ended or expired; it does not come back
  | "previous_still_open"
  | "policy_invalid"
  | "conflict";            // a concurrent change won; retry

export class LiveAssistRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly detail: { sessionRef?: string; state?: SessionState; violations?: PolicyViolation[]; disabledBecause?: EffectivePolicy["disabledBecause"] } = {},
  ) {
    super(message);
    this.name = "LiveAssistRefusal";
  }
}

/** InnoDB chose this transaction as a deadlock victim, or gave up waiting for a lock. It was rolled back whole. */
const isLockContention = (e: unknown): boolean => {
  for (let x = e as { code?: unknown; cause?: unknown } | null | undefined; x; x = x.cause as typeof x) {
    if (x.code === "ER_LOCK_DEADLOCK" || x.code === "ER_LOCK_WAIT_TIMEOUT") return true;
  }
  return false;
};

const isDuplicateKey = (e: unknown, index?: string): boolean => {
  for (let x = e as { code?: unknown; message?: unknown; cause?: unknown } | null | undefined; x; x = x.cause as typeof x) {
    if (x.code === "ER_DUP_ENTRY") return index ? String(x.message ?? "").includes(index) : true;
  }
  return false;
};

/* ------------------------------------------------------------------ */
/* Views                                                                 */
/* ------------------------------------------------------------------ */

/** What a caller may see of their own session. Metadata only. */
export type SessionView = {
  sessionRef: string;
  source: SessionSource;
  state: SessionState;
  startedAt: Date;
  idleDeadlineAt: Date;
  hardDeadlineAt: Date;
  endedAt: Date | null;
  endReason: EndReason | null;
  previousSessionRef: string | null;
};

function view(row: LiveAssistSessionRow): SessionView {
  return {
    sessionRef: row.sessionRef, source: row.source, state: row.state, startedAt: row.startedAt,
    idleDeadlineAt: row.idleDeadlineAt, hardDeadlineAt: row.hardDeadlineAt, endedAt: row.endedAt ?? null,
    endReason: row.endReason ?? null, previousSessionRef: row.previousSessionRef ?? null,
  };
}

const snapshotSchema = z.object({
  idleSeconds: z.number().int().positive(),
  maxSessionMinutes: z.number().int().positive(),
  retentionHours: z.number().int().positive(),
  maxFramesPerSession: z.number().int().nonnegative(),
  maxInferenceCallsPerSession: z.number().int().nonnegative(),
});

/** The limits a session started under. A damaged snapshot is read as LeaseOS's hard limits, never wider. */
function snapshotOf(row: Pick<LiveAssistSessionRow, "policySnapshotJson">): SessionLimits {
  try {
    const parsed = snapshotSchema.parse(JSON.parse(row.policySnapshotJson));
    return {
      idleSeconds: Math.min(parsed.idleSeconds, LEASEOS_HARD_LIMITS.idleSeconds),
      maxSessionMinutes: Math.min(parsed.maxSessionMinutes, LEASEOS_HARD_LIMITS.maxSessionMinutes),
      retentionHours: Math.min(parsed.retentionHours, LEASEOS_HARD_LIMITS.retentionHours),
      maxFramesPerSession: Math.min(parsed.maxFramesPerSession, LEASEOS_HARD_LIMITS.maxFramesPerSession),
      maxInferenceCallsPerSession: Math.min(parsed.maxInferenceCallsPerSession, LEASEOS_HARD_LIMITS.maxInferenceCallsPerSession),
    };
  } catch {
    const { idleSeconds, maxSessionMinutes, retentionHours, maxFramesPerSession, maxInferenceCallsPerSession } = LEASEOS_HARD_LIMITS;
    return { idleSeconds, maxSessionMinutes, retentionHours, maxFramesPerSession, maxInferenceCallsPerSession };
  }
}

/** The columns a stop writes, whatever stopped it. */
function stopFields(to: "ended" | "expired", reason: EndReason, now: Date, limits: SessionLimits) {
  return { state: to, openMarker: null, endedAt: now, endReason: reason, purgeAfter: purgeAfterFor(now, limits) };
}

async function recordEvent(
  db: DbOrTx,
  row: Pick<LiveAssistSessionRow, "id" | "orgRef">,
  eventType: (typeof liveAssistEvents.$inferInsert)["eventType"],
  actorUserId: number | null,
  now: Date,
  extra: { endReason?: EndReason; detail?: string } = {},
) {
  await db.insert(liveAssistEvents).values({
    sessionId: row.id, orgRef: row.orgRef, actorUserId, eventType,
    endReason: extra.endReason ?? null, detail: extra.detail ? extra.detail.slice(0, 200) : null, occurredAt: now,
  });
}

/* ------------------------------------------------------------------ */
/* Policy                                                                */
/* ------------------------------------------------------------------ */

async function currentPolicyRow(db: DbOrTx, orgRef: string) {
  return (await db.select().from(liveAssistPolicies)
    .where(and(eq(liveAssistPolicies.orgRef, orgRef), eq(liveAssistPolicies.currentMarker, 1))).limit(1))[0] ?? null;
}

function storedFrom(row: NonNullable<Awaited<ReturnType<typeof currentPolicyRow>>>): StoredPolicy {
  let sources: SessionSource[] = [];
  try {
    const parsed = z.array(z.enum(["photo", "camera", "screen", "video"])).parse(JSON.parse(row.sourcesAllowedJson));
    sources = parsed;
  } catch { sources = []; }
  return {
    enabled: row.enabled, sourcesAllowed: sources, idleSeconds: row.idleSeconds, maxSessionMinutes: row.maxSessionMinutes,
    retentionHours: row.retentionHours, maxSessionsPerUserPerDay: row.maxSessionsPerUserPerDay,
    dailySpendCeilingCents: row.dailySpendCeilingCents ?? null,
  };
}

export async function effectivePolicy(db: DbOrTx, orgRef: string, env: Env): Promise<EffectivePolicy> {
  const row = await currentPolicyRow(db, orgRef);
  return resolvePolicy(row ? storedFrom(row) : null, env);
}

export async function getPolicy(db: DbOrTx, caller: Caller, env: Env) {
  const row = await currentPolicyRow(db, caller.orgRef);
  const effective = resolvePolicy(row ? storedFrom(row) : null, env);
  return { effective, policyRef: row?.policyRef ?? null, setAt: row?.createdAt ?? null };
}

export async function setPolicy(db: DbOrTx, caller: Caller, input: PolicyInput, now: Date) {
  const violations = validatePolicyInput(input);
  if (violations.length) {
    throw new LiveAssistRefusal("policy_invalid", "This policy is outside what LeaseOS allows; nothing was changed.", { violations });
  }
  const policyRef = `LAP-${randomBytes(12).toString("base64url")}`;
  try {
    await db.transaction(async (tx) => {
      await tx.update(liveAssistPolicies)
        .set({ currentMarker: null, supersededAt: now })
        .where(and(eq(liveAssistPolicies.orgRef, caller.orgRef), eq(liveAssistPolicies.currentMarker, 1)));
      await tx.insert(liveAssistPolicies).values({
        policyRef, orgRef: caller.orgRef, enabled: input.enabled, sourcesAllowedJson: JSON.stringify(input.sourcesAllowed),
        idleSeconds: input.idleSeconds, maxSessionMinutes: input.maxSessionMinutes, retentionHours: input.retentionHours,
        maxSessionsPerUserPerDay: input.maxSessionsPerUserPerDay, dailySpendCeilingCents: input.dailySpendCeilingCents,
        setByUserId: caller.userId, currentMarker: 1, createdAt: now,
      });
    });
  } catch (e) {
    if (isDuplicateKey(e, "liveAssistPolicies_current_unique")) {
      throw new LiveAssistRefusal("conflict", "Another policy change for this organization completed first. Read the policy and try again.");
    }
    throw e;
  }
  return { policyRef };
}

/* ------------------------------------------------------------------ */
/* Start                                                                 */
/* ------------------------------------------------------------------ */

export type StartInput = { source: SessionSource; startKey: string; previousSessionRef?: string };

/**
 * Open a session.
 *
 * Idempotent on `startKey`: the same key from the same person in the same organization returns the
 * session it first created, whatever has happened to it since, and records nothing new. A different
 * key while a session is still open is refused and names the open session, which is the caller's own.
 */
export async function startSession(db: DbOrTx, caller: Caller, input: StartInput, now: Date, env: Env): Promise<{ session: SessionView; replayed: boolean }> {
  const policy = await effectivePolicy(db, caller.orgRef, env);
  if (!policy.enabled) {
    throw new LiveAssistRefusal("disabled", "Live Assist is not enabled for this organization.", { disabledBecause: policy.disabledBecause });
  }
  if (!policy.sourcesAllowed.includes(input.source)) {
    throw new LiveAssistRefusal("source_not_allowed", `Live Assist is not available for ${input.source} in this organization.`);
  }

  const replay = await findByStartKey(db, caller, input.startKey);
  if (replay) return { session: view(replay), replayed: true };

  if (input.previousSessionRef) {
    const prev = await ownedSession(db, caller, input.previousSessionRef);
    if (!prev) throw new LiveAssistRefusal("not_found", "No such previous Live Assist session.");
    if (isOpen(prev.state) && evaluateDeadlines(prev, now).kind === "within") {
      throw new LiveAssistRefusal("previous_still_open", "The previous session is still open; end it or resume it.", { sessionRef: prev.sessionRef, state: prev.state });
    }
  }

  // Concurrency is decided by the database's unique indexes, not by locks: (orgRef, userId, openMarker)
  // admits one open session per person and (orgRef, userId, startKey) one session per retry key. Start
  // takes no locking read, so racing starts do not queue on each other's gap locks; a loser's INSERT fails
  // on a unique index and is answered from what won. InnoDB can still pick a deadlock victim among
  // concurrent inserts on one unique key; that victim was rolled back whole, so it is retried after a short
  // pause, and contention that outlasts the retries is refused as `conflict`, never an internal error.
  for (let attempt = 0; ; attempt++) {
    try {
      return await startOnce(db, caller, input, now, policy);
    } catch (e) {
      if (!isLockContention(e)) throw e;
      if (attempt >= 3) throw new LiveAssistRefusal("conflict", "Another Live Assist start for your account was in progress. Try again.");
      await pause(20 * (attempt + 1));
    }
  }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Stop an open session whose deadline has passed, if it is still open. A conditional UPDATE: of any number
 * of callers racing to stop the same session (a start, a sweep, another worker), exactly one changes the
 * row, and only that one records the event.
 */
async function stopIfStillOpen(
  db: DbOrTx,
  s: LiveAssistSessionRow,
  verdict: { kind: "ended" | "expired"; reason: EndReason },
  now: Date,
  detail: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const applied = await tx.update(liveAssistSessions).set(stopFields(verdict.kind, verdict.reason, now, snapshotOf(s)))
      .where(and(eq(liveAssistSessions.id, s.id), eq(liveAssistSessions.orgRef, s.orgRef), eq(liveAssistSessions.openMarker, 1)));
    if (affectedRows(applied) !== 1) return false;
    await recordEvent(tx, s, verdict.kind === "ended" ? "session_ended" : "session_expired", null, now, { endReason: verdict.reason, detail });
    return true;
  });
}

async function startOnce(db: DbOrTx, caller: Caller, input: StartInput, now: Date, policy: EffectivePolicy): Promise<{ session: SessionView; replayed: boolean }> {
  // A retry of a start that already happened (a lost reply, or the loser of a race on the same key).
  const replay = await findByStartKey(db, caller, input.startKey);
  if (replay) return { session: view(replay), replayed: true };

  // A crashed tab leaves an open session behind. If its deadline has passed it stops here, as it would at
  // the next sweep; if not, it is still the caller's open session and this start is refused.
  const open = await db.select().from(liveAssistSessions)
    .where(and(eq(liveAssistSessions.orgRef, caller.orgRef), eq(liveAssistSessions.userId, caller.userId), eq(liveAssistSessions.openMarker, 1)));
  for (const o of open) {
    // The race's winner used this very key and committed between the two reads above: it is this start.
    if (o.startKey === input.startKey) return { session: view(o), replayed: true };
    const verdict = evaluateDeadlines(o, now);
    if (verdict.kind === "within") {
      throw new LiveAssistRefusal("open_session_exists", "You already have an open Live Assist session; end or resume it first.", { sessionRef: o.sessionRef, state: o.state });
    }
    await stopIfStillOpen(db, o, verdict, now, "deadline_observed_at_start");
  }

  // Not locked, and it need not be: only one of any set of racing starts can hold the open slot, so a race
  // cannot carry a person past the daily limit.
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(liveAssistSessions)
    .where(and(eq(liveAssistSessions.orgRef, caller.orgRef), eq(liveAssistSessions.userId, caller.userId), gte(liveAssistSessions.startedAt, since)));
  if (Number(n) >= policy.maxSessionsPerUserPerDay) {
    throw new LiveAssistRefusal("daily_limit", "The daily Live Assist session limit for your account has been reached.");
  }

  const limits = policy.limits;
  const sessionRef = sessionRefFromBytes(randomBytes(18));
  const { idleDeadlineAt, hardDeadlineAt } = initialDeadlines(now, limits);
  try {
    return await db.transaction(async (tx) => {
      await tx.insert(liveAssistSessions).values({
        sessionRef, orgRef: caller.orgRef, userId: caller.userId, startKey: input.startKey, source: input.source,
        state: "active", openMarker: 1, policySnapshotJson: JSON.stringify(limits),
        startedAt: now, lastHeartbeatAt: now, idleDeadlineAt, hardDeadlineAt,
        previousSessionRef: input.previousSessionRef ?? null,
      });
      const row = (await tx.select().from(liveAssistSessions).where(eq(liveAssistSessions.sessionRef, sessionRef)).limit(1))[0]!;
      await recordEvent(tx, row, "session_started", caller.userId, now, { detail: `source=${input.source}` });
      return { session: view(row), replayed: false };
    });
  } catch (e) {
    if (isDuplicateKey(e, "liveAssistSessions_startKey_unique") || isDuplicateKey(e, "liveAssistSessions_open_unique")) {
      const again = await findByStartKey(db, caller, input.startKey);
      if (again) return { session: view(again), replayed: true };
      if (isDuplicateKey(e, "liveAssistSessions_open_unique")) {
        throw new LiveAssistRefusal("open_session_exists", "You already have an open Live Assist session; end or resume it first.");
      }
    }
    throw e;
  }
}

async function findByStartKey(db: DbOrTx, caller: Caller, startKey: string) {
  return (await db.select().from(liveAssistSessions)
    .where(and(eq(liveAssistSessions.orgRef, caller.orgRef), eq(liveAssistSessions.userId, caller.userId), eq(liveAssistSessions.startKey, startKey)))
    .limit(1))[0] ?? null;
}

/** The caller's own session in the caller's organization, or null. Never a row belonging to anyone else. */
async function ownedSession(db: DbOrTx, caller: Caller, sessionRef: string, forUpdate = false) {
  if (!isSessionRef(sessionRef)) return null;
  const q = db.select().from(liveAssistSessions)
    .where(and(eq(liveAssistSessions.sessionRef, sessionRef), eq(liveAssistSessions.orgRef, caller.orgRef), eq(liveAssistSessions.userId, caller.userId)))
    .limit(1);
  const row = (await (forUpdate ? q.for("update") : q))[0] ?? null;
  // Belt and braces: the WHERE clause already binds owner and organization.
  return row && bindingVerdict(row, caller) === "owner" ? row : null;
}

/* ------------------------------------------------------------------ */
/* Heartbeat, pause, resume, end                                         */
/* ------------------------------------------------------------------ */

/**
 * Apply one requested operation to the caller's own session.
 *
 * Order matters and is fixed: find (owner + organization) → deadlines → kill switch → the operation.
 * A session whose deadline has passed stops with that reason before the operation is considered, so a
 * resume can never land on a session that had already run out. A session in an organization whose
 * Live Assist has been switched off stops with `policy_disabled`.
 *
 * A heartbeat on a stopped session is not an error: it returns the stopped state so the client learns
 * why and tears down. Pause and resume on a stopped session are refused (`terminal`). End on a stopped
 * session returns it unchanged.
 */
export async function applyOperation(db: DbOrTx, caller: Caller, sessionRef: string, op: Operation, now: Date, env: Env): Promise<SessionView> {
  if (!isSessionRef(sessionRef)) throw new LiveAssistRefusal("not_found", "No such Live Assist session.");
  const policy = await effectivePolicy(db, caller.orgRef, env);

  // A refusal decided AFTER a deadline or kill-switch stop is returned, not thrown, so the stop commits:
  // throwing inside the transaction would roll back the very record of why the session stopped.
  const outcome = await db.transaction(async (tx): Promise<{ view: SessionView } | { refusal: LiveAssistRefusal }> => {
    let row = await ownedSession(tx, caller, sessionRef, true);
    if (!row) throw new LiveAssistRefusal("not_found", "No such Live Assist session.");
    const limits = snapshotOf(row);

    const deadline = evaluateDeadlines(row, now);
    if (deadline.kind !== "within") {
      await tx.update(liveAssistSessions).set(stopFields(deadline.kind, deadline.reason, now, limits)).where(eq(liveAssistSessions.id, row.id));
      await recordEvent(tx, row, deadline.kind === "ended" ? "session_ended" : "session_expired", null, now, { endReason: deadline.reason, detail: `deadline_observed_at_${op}` });
      row = { ...row, ...stopFields(deadline.kind, deadline.reason, now, limits) };
    } else if (isOpen(row.state) && !policy.enabled) {
      await tx.update(liveAssistSessions).set(stopFields("ended", "policy_disabled", now, limits)).where(eq(liveAssistSessions.id, row.id));
      await recordEvent(tx, row, "session_ended", null, now, { endReason: "policy_disabled", detail: policy.disabledBecause.join(",") });
      row = { ...row, ...stopFields("ended", "policy_disabled", now, limits) };
    }

    const verdict = decideOperation(row.state, op);
    if (verdict.kind === "refuse") {
      if (op === "heartbeat") return { view: view(row) };
      return { refusal: new LiveAssistRefusal("terminal", "This Live Assist session has stopped and cannot be continued. Start a new one.", { sessionRef: row.sessionRef, state: row.state }) };
    }
    if (verdict.kind === "noop") {
      if (op === "heartbeat" || (op === "resume" && row.state === "active")) {
        const idleDeadlineAt = refreshedIdleDeadline(now, limits, row.hardDeadlineAt);
        await tx.update(liveAssistSessions).set({ lastHeartbeatAt: now, idleDeadlineAt }).where(eq(liveAssistSessions.id, row.id));
        row = { ...row, lastHeartbeatAt: now, idleDeadlineAt };
      }
      return { view: view(row) };
    }

    // A transition the rules permit.
    let fields: Partial<typeof liveAssistSessions.$inferInsert>;
    let eventType: (typeof liveAssistEvents.$inferInsert)["eventType"];
    if (verdict.to === "paused") {
      fields = { state: "paused", pausedAt: now, lastHeartbeatAt: now, idleDeadlineAt: refreshedIdleDeadline(now, limits, row.hardDeadlineAt) };
      eventType = "session_paused";
    } else if (verdict.to === "active") {
      fields = { state: "active", pausedAt: null, lastHeartbeatAt: now, idleDeadlineAt: refreshedIdleDeadline(now, limits, row.hardDeadlineAt) };
      eventType = "session_resumed";
    } else {
      fields = stopFields("ended", verdict.reason ?? "user_end", now, limits);
      eventType = "session_ended";
    }
    const applied = await tx.update(liveAssistSessions).set(fields)
      .where(and(eq(liveAssistSessions.id, row.id), eq(liveAssistSessions.state, row.state)));
    if (affectedRows(applied) !== 1) throw new LiveAssistRefusal("conflict", "The session changed while this request was in flight; read it and try again.");
    await recordEvent(tx, row, eventType, caller.userId, now, verdict.to === "ended" ? { endReason: verdict.reason ?? "user_end" } : {});
    return { view: view({ ...row, ...fields } as LiveAssistSessionRow) };
  });
  if ("refusal" in outcome) throw outcome.refusal;
  return outcome.view;
}

/* ------------------------------------------------------------------ */
/* Review                                                                */
/* ------------------------------------------------------------------ */

/**
 * The lifecycle of sessions in the caller's organization: who, when, which source, how it stopped.
 * Never a turn, a frame or an observation — the reviewer permission is for the record, not the content.
 */
export async function listLifecycle(db: DbOrTx, orgRef: string, filter: { from: Date; to: Date; userId?: number; limit: number }) {
  const where = and(
    eq(liveAssistSessions.orgRef, orgRef),
    gte(liveAssistSessions.startedAt, filter.from),
    lte(liveAssistSessions.startedAt, filter.to),
    filter.userId !== undefined ? eq(liveAssistSessions.userId, filter.userId) : undefined,
  );
  const sessions = await db.select({
    id: liveAssistSessions.id, sessionRef: liveAssistSessions.sessionRef, userId: liveAssistSessions.userId,
    source: liveAssistSessions.source, state: liveAssistSessions.state, startedAt: liveAssistSessions.startedAt,
    endedAt: liveAssistSessions.endedAt, endReason: liveAssistSessions.endReason, transientPurgedAt: liveAssistSessions.transientPurgedAt,
  }).from(liveAssistSessions).where(where).orderBy(desc(liveAssistSessions.startedAt)).limit(filter.limit);
  const ids = sessions.map(s => s.id);
  const events = ids.length
    ? await db.select({
        sessionId: liveAssistEvents.sessionId, eventType: liveAssistEvents.eventType, endReason: liveAssistEvents.endReason,
        actorUserId: liveAssistEvents.actorUserId, occurredAt: liveAssistEvents.occurredAt,
      }).from(liveAssistEvents)
        .where(and(eq(liveAssistEvents.orgRef, orgRef), inArray(liveAssistEvents.sessionId, ids)))
        .orderBy(asc(liveAssistEvents.id))
    : [];
  return sessions.map(({ id, ...s }) => ({ ...s, events: events.filter(e => e.sessionId === id).map(({ sessionId: _s, ...e }) => e) }));
}

/* ------------------------------------------------------------------ */
/* The purge                                                             */
/* ------------------------------------------------------------------ */

export type SweepLimits = { sessionsPerTick: number; rowsPerTick: number };
export const DEFAULT_SWEEP_LIMITS: SweepLimits = { sessionsPerTick: 100, rowsPerTick: 2_000 };

export type SweepResult = {
  expired: number;        // open sessions stopped because a server deadline passed
  purgedSessions: number; // sessions whose transient rows are now all gone
  rowsDeleted: number;    // turns + observations + unsaved frames removed
  failures: number;       // sessions skipped this tick because a statement failed; retried next tick
};

/**
 * One bounded pass. Safe to run from several workers at once and safe to repeat:
 *
 * - **Server state only.** Expiry reads `idleDeadlineAt`/`hardDeadlineAt`; purge reads `purgeAfter`. Both
 *   were written by the server. Nothing a client sent is consulted.
 * - **Bounded.** At most `sessionsPerTick` sessions are examined in each phase and at most `rowsPerTick`
 *   transient rows deleted, in id order, so a backlog drains over ticks without a long lock.
 * - **Idempotent and concurrent-safe.** Every stop is a conditional UPDATE (`openMarker = 1`), and only the
 *   worker whose UPDATE changed the row writes the event; the purge marker is set the same way. Two workers
 *   racing delete the same rows at most once between them and record one event.
 * - **Tenant-safe.** Every DELETE names the session AND its organization.
 * - **Evidence is out of reach.** The purge deletes only from `liveAssistTurns`, `liveAssistObservations`
 *   and `liveAssistFrames`, and from frames only where `savedEvidenceRecordId IS NULL`. It issues no
 *   statement against any evidence table, and never deletes a session or an event.
 * - **Failure is contained.** A failing session is counted and skipped; the pass continues and the next
 *   tick retries it. Nothing here throws to the caller except a failure to read the work list itself.
 */
export async function sweepLiveAssist(db: DbOrTx, now: Date, limits: SweepLimits = DEFAULT_SWEEP_LIMITS): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, purgedSessions: 0, rowsDeleted: 0, failures: 0 };

  // Phase 1: open sessions whose deadline has passed. `idleDeadlineAt <= hardDeadlineAt` always holds (see
  // `initialDeadlines`), so "idle deadline passed" finds every due session, through the (state,
  // idleDeadlineAt) index rather than a scan of a table that keeps every session's lifecycle row.
  const due = await db.select().from(liveAssistSessions)
    .where(and(inArray(liveAssistSessions.state, ["active", "paused"]), lte(liveAssistSessions.idleDeadlineAt, now)))
    .orderBy(asc(liveAssistSessions.idleDeadlineAt), asc(liveAssistSessions.id)).limit(limits.sessionsPerTick);
  for (const s of due) {
    const verdict = evaluateDeadlines(s, now);
    if (verdict.kind === "within") continue;
    try {
      if (await stopIfStillOpen(db, s, verdict, now, "sweep")) result.expired++;
    } catch { result.failures++; }
  }

  // Phase 2: stopped sessions whose retention has passed and whose transient rows remain.
  const purgeable = await db.select({ id: liveAssistSessions.id, orgRef: liveAssistSessions.orgRef }).from(liveAssistSessions)
    .where(and(
      isNull(liveAssistSessions.transientPurgedAt), isNotNull(liveAssistSessions.purgeAfter), lte(liveAssistSessions.purgeAfter, now),
      inArray(liveAssistSessions.state, ["ended", "expired"]),
    ))
    .orderBy(asc(liveAssistSessions.id)).limit(limits.sessionsPerTick);
  for (const s of purgeable) {
    const budget = limits.rowsPerTick - result.rowsDeleted;
    if (budget <= 0) break;
    try {
      const turns = affectedRows(await db.delete(liveAssistTurns)
        .where(and(eq(liveAssistTurns.sessionId, s.id), eq(liveAssistTurns.orgRef, s.orgRef)))
        .orderBy(asc(liveAssistTurns.id)).limit(budget));
      const obsBudget = budget - turns;
      const observations = obsBudget > 0 ? affectedRows(await db.delete(liveAssistObservations)
        .where(and(eq(liveAssistObservations.sessionId, s.id), eq(liveAssistObservations.orgRef, s.orgRef)))
        .orderBy(asc(liveAssistObservations.id)).limit(obsBudget)) : 0;
      const frameBudget = obsBudget - observations;
      const frames = frameBudget > 0 ? affectedRows(await db.delete(liveAssistFrames)
        .where(and(eq(liveAssistFrames.sessionId, s.id), eq(liveAssistFrames.orgRef, s.orgRef), isNull(liveAssistFrames.savedEvidenceRecordId)))
        .orderBy(asc(liveAssistFrames.id)).limit(frameBudget)) : 0;
      result.rowsDeleted += turns + observations + frames;
      // Drained only if every delete finished below its own limit; otherwise the next tick continues.
      const drained = turns < budget && observations < obsBudget && frames < frameBudget;
      if (!drained) break;
      await db.transaction(async (tx) => {
        const marked = await tx.update(liveAssistSessions).set({ transientPurgedAt: now })
          .where(and(eq(liveAssistSessions.id, s.id), eq(liveAssistSessions.orgRef, s.orgRef), isNull(liveAssistSessions.transientPurgedAt)));
        if (affectedRows(marked) === 1) {
          await recordEvent(tx, s, "session_transient_purged", null, now, { detail: `rows=${turns + observations + frames}` });
          result.purgedSessions++;
        }
      });
    } catch { result.failures++; }
  }
  return result;
}
