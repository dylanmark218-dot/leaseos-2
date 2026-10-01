/**
 * LA-1a — the Live Assist session lifecycle, as rules and nothing else.
 *
 * Pure. No database, no network, no clock of its own: every function is given `now`.
 *
 * A Live Assist session is a unit of work a person opened on purpose. It is NOT a login session:
 * who the caller is comes from `sessionFamilies` and `ctx.user`, and what organization they act for
 * comes from `resolveActingScope`, on every call. This module never learns either from the client.
 *
 * What this checkpoint deliberately does not contain: any image, frame, model call, camera, screen or
 * evidence path. The owner's LA-1a ruling (docs/live-assist/LA1A_OWNER_RULING.md) carves out the
 * session spine and nothing more.
 *
 * **The state is the server's.** A client can ask to pause, resume or end; it cannot set a state,
 * move a deadline or claim an expiry. Deadlines are computed here from the server's clock and the
 * policy snapshot taken when the session started.
 *
 * **Terminal means terminal.** `ended` and `expired` have no way out. A person who wants to carry on
 * starts a new session and may cite the old one; the old reference never comes back to life, which
 * is what makes a leaked or stale reference useless.
 */

export const SESSION_STATES = ["active", "paused", "ended", "expired"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const OPEN_STATES: readonly SessionState[] = ["active", "paused"];
export const TERMINAL_STATES: readonly SessionState[] = ["ended", "expired"];

/** Why a session stopped. `expired` is only ever `idle_timeout`; everything else is `ended`. */
export const END_REASONS = ["user_end", "idle_timeout", "budget_spent", "policy_disabled"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Sources a session may be opened for. LA-1a's hard limits admit only `photo`; see policy.ts. */
export const SESSION_SOURCES = ["photo", "camera", "screen", "video"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

/** The transitions LeaseOS permits. Anything else is refused. */
export const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  active: ["paused", "ended", "expired"],
  paused: ["active", "ended", "expired"],
  ended: [],
  expired: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isOpen(state: SessionState): boolean {
  return OPEN_STATES.includes(state);
}

/* ------------------------------------------------------------------ */
/* References                                                           */
/* ------------------------------------------------------------------ */

/**
 * `LAS-` followed by 24 base64url characters (18 random bytes). Anything else is malformed and is
 * refused before a query is made.
 */
export const SESSION_REF_PATTERN = /^LAS-[A-Za-z0-9_-]{24}$/;

/** A client's retry key for `start`. Scoped to (organization, user) in the database, never global. */
export const START_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isSessionRef(value: string): boolean {
  return SESSION_REF_PATTERN.test(value);
}

/** Build a reference from 18 random bytes. The caller supplies the bytes so this stays pure. */
export function sessionRefFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 18) throw new Error("a session reference needs exactly 18 random bytes");
  return `LAS-${Buffer.from(bytes).toString("base64url")}`;
}

/* ------------------------------------------------------------------ */
/* Deadlines                                                            */
/* ------------------------------------------------------------------ */

/** The part of the policy a session is bound to when it starts. Later policy changes do not widen it. */
export type SessionLimits = {
  idleSeconds: number;
  maxSessionMinutes: number;
  retentionHours: number;
  maxFramesPerSession: number;
  maxInferenceCallsPerSession: number;
};

export type Deadlines = { idleDeadlineAt: Date; hardDeadlineAt: Date };

/**
 * Invariant: `idleDeadlineAt <= hardDeadlineAt`, always. It is established here and kept by
 * `refreshedIdleDeadline`. It is what lets the purge find every due session through one index on
 * (state, idleDeadlineAt): a session past its hard deadline is necessarily past its idle deadline too.
 */
export function initialDeadlines(now: Date, limits: SessionLimits): Deadlines {
  const hardDeadlineAt = new Date(now.getTime() + limits.maxSessionMinutes * 60_000);
  const idle = now.getTime() + limits.idleSeconds * 1000;
  return { idleDeadlineAt: new Date(Math.min(idle, hardDeadlineAt.getTime())), hardDeadlineAt };
}

/**
 * A heartbeat moves the idle deadline forward from the SERVER's now. It never moves the hard deadline:
 * a session that is kept alive is still a session that ends.
 */
export function refreshedIdleDeadline(now: Date, limits: SessionLimits, hardDeadlineAt: Date): Date {
  const next = now.getTime() + limits.idleSeconds * 1000;
  return new Date(Math.min(next, hardDeadlineAt.getTime()));
}

export type DeadlineVerdict =
  | { kind: "within" }
  | { kind: "ended"; reason: "budget_spent" }
  | { kind: "expired"; reason: "idle_timeout" };

/**
 * Has this open session run out? The hard deadline is checked first: a session that is both idle and
 * over its duration ended because of its duration, and the record says so.
 */
export function evaluateDeadlines(
  session: { state: SessionState; idleDeadlineAt: Date; hardDeadlineAt: Date },
  now: Date,
): DeadlineVerdict {
  if (!isOpen(session.state)) return { kind: "within" };
  if (now.getTime() >= session.hardDeadlineAt.getTime()) return { kind: "ended", reason: "budget_spent" };
  if (now.getTime() >= session.idleDeadlineAt.getTime()) return { kind: "expired", reason: "idle_timeout" };
  return { kind: "within" };
}

/** When the transient rows of a stopped session may be removed. Derived, never supplied. */
export function purgeAfterFor(endedAt: Date, limits: Pick<SessionLimits, "retentionHours">): Date {
  return new Date(endedAt.getTime() + limits.retentionHours * 3_600_000);
}

/* ------------------------------------------------------------------ */
/* Requested operations                                                  */
/* ------------------------------------------------------------------ */

export type Operation = "heartbeat" | "pause" | "resume" | "end";

/**
 * What a requested operation does to a session in `state`, once deadlines and policy have already
 * been applied.
 *
 * - `transition`: move to `to`, and record it.
 * - `noop`: nothing changes and nothing is recorded (a retried pause, end, resume). This is the
 *   lifecycle's idempotency: a request repeated after a lost reply lands on the state it produced.
 * - `refuse`: the operation is not available from here. `resume` of a terminal session is the case
 *   that matters: terminated sessions do not silently reactivate.
 */
export type OperationVerdict =
  | { kind: "transition"; to: SessionState; reason?: EndReason }
  | { kind: "noop" }
  | { kind: "refuse"; code: "terminal" };

export function decideOperation(state: SessionState, op: Operation): OperationVerdict {
  switch (op) {
    case "heartbeat":
      return isOpen(state) ? { kind: "noop" } : { kind: "refuse", code: "terminal" };
    case "pause":
      if (state === "active") return { kind: "transition", to: "paused" };
      if (state === "paused") return { kind: "noop" };
      return { kind: "refuse", code: "terminal" };
    case "resume":
      if (state === "paused") return { kind: "transition", to: "active" };
      if (state === "active") return { kind: "noop" };
      return { kind: "refuse", code: "terminal" };
    case "end":
      if (isOpen(state)) return { kind: "transition", to: "ended", reason: "user_end" };
      return { kind: "noop" };
  }
}

/* ------------------------------------------------------------------ */
/* Binding                                                               */
/* ------------------------------------------------------------------ */

export type Caller = { userId: number; orgRef: string };

/**
 * May this caller touch this session at all?
 *
 * Owner AND acting organization, both. A session found under the caller's user but a different
 * organization is `not_found` and is NOT modified: the owner's ruling forbids a request acting for
 * one organization from terminating, resuming or otherwise changing another organization's session,
 * even the same person's. It stops by its own server deadline.
 */
export function bindingVerdict(
  session: { userId: number; orgRef: string },
  caller: Caller,
): "owner" | "not_found" {
  return session.userId === caller.userId && session.orgRef === caller.orgRef ? "owner" : "not_found";
}

/* ------------------------------------------------------------------ */
/* Budgets                                                               */
/* ------------------------------------------------------------------ */

export type SessionCounters = { framesSubmitted: number; inferenceCalls: number };

/**
 * Per-session work budgets. LA-1a writes neither counter (no frames, no inference exist yet); the rule
 * is here so that the checkpoint that first increments them cannot do so without it. The counters are
 * server columns: nothing a client sends can raise a limit or lower a count.
 */
export function budgetVerdict(
  counters: SessionCounters,
  limits: Pick<SessionLimits, "maxFramesPerSession" | "maxInferenceCallsPerSession">,
  request: { frames: number; inferenceCalls: number },
): { allowed: true } | { allowed: false; exhausted: "frames" | "inference_calls" } {
  if (counters.framesSubmitted + request.frames > limits.maxFramesPerSession) return { allowed: false, exhausted: "frames" };
  if (counters.inferenceCalls + request.inferenceCalls > limits.maxInferenceCallsPerSession) {
    return { allowed: false, exhausted: "inference_calls" };
  }
  return { allowed: true };
}
