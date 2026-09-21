/**
 * v22.20 — the local safety latch.
 *
 * Pure. No network, no database.
 *
 * A tablet that has recorded a confirmed out-of-service order must stop the
 * vehicle before the server has heard a word about it. The device is not
 * pretending to hold server authority: it holds credible locally confirmed
 * evidence that a subject is prohibited, and that is enough to refuse.
 *
 * The rule this exists to protect:
 *
 *     syncSuccess !== clearLatch
 *
 * Synchronizing adds server identity to a latch. It does not lift it. Only
 * receiving the authoritative `released` or `rescinded` state for that order
 * lifts it — because the office learning about a prohibition is not the same
 * event as an inspector lifting one, and a device that confused the two would
 * put a prohibited truck back on the road the moment it found signal.
 */

export type LatchSubjectType = "driver" | "vehicle" | "trailer" | "cargo" | "carrier";

export type LocalSafetyLatch = {
  latchRef: string;
  subjectType: LatchSubjectType;
  subjectRef: string;
  source: "confirmed_oos_capture";
  capturedAt: string;
  captureLocalId: string;
  state: "blocking" | "lifted";
  /** Filled in when the server acknowledges the capture. Adds identity, not permission. */
  serverEventRef: string | null;
  serverOrderRef: string | null;
  synchronized: boolean;
  /** Only ever set from an authoritative server state. */
  liftedBecause: "released" | "rescinded" | null;
  liftedAt: string | null;
};

export type LocalRestriction =
  | { state: "prohibited"; subjectType: LatchSubjectType; subjectRef: string; reason: string; synchronized: boolean; latchRefs: string[] }
  | { state: "clear"; reason: string };

/** What this device will let happen, from what it holds. */
export function localRestriction(latches: readonly LocalSafetyLatch[], subjectType: LatchSubjectType, subjectRef: string): LocalRestriction {
  const blocking = latches.filter(l => l.state === "blocking" && l.subjectType === subjectType && l.subjectRef === subjectRef);
  if (!blocking.length) return { state: "clear", reason: "This device holds no blocking out-of-service capture for this subject" };
  const unsynced = blocking.filter(l => !l.synchronized).length;
  return {
    state: "prohibited",
    subjectType, subjectRef,
    synchronized: unsynced === 0,
    latchRefs: blocking.map(l => l.latchRef),
    reason: unsynced
      ? `Prohibited by ${blocking.length} out-of-service capture(s) on this device, ${unsynced} not yet synchronized. Do not move.`
      : `Prohibited by ${blocking.length} out-of-service capture(s), synchronized with the office. Do not move.`,
  };
}

/**
 * The server has accepted the capture. Record its identity and change nothing
 * else — this is the function most likely to be "helpfully" extended into
 * clearing the latch, so it returns a latch that is still blocking.
 */
export function onSynchronized(latch: LocalSafetyLatch, server: { eventRef: string; orderRef: string | null }): LocalSafetyLatch {
  return { ...latch, synchronized: true, serverEventRef: server.eventRef, serverOrderRef: server.orderRef, state: latch.state };
}

/**
 * The authoritative state of the order arrived. This is the only thing that
 * lifts a latch, and only for the order it names.
 */
export function onAuthoritativeOrderState(
  latch: LocalSafetyLatch,
  order: { orderRef: string; status: "active" | "released" | "rescinded" },
  at: string,
): LocalSafetyLatch {
  if (latch.serverOrderRef !== order.orderRef) return latch;
  if (order.status === "active") return latch;
  return { ...latch, state: "lifted", liftedBecause: order.status, liftedAt: at };
}

/* ------------------------------------------------------------------ */
/* Capture truth is history, not current state                          */
/* ------------------------------------------------------------------ */

export type CaptureAuthorizationClaim = "authorized" | "unauthorized" | "unknown";

/**
 * What the device claimed about its own authorization at the moment of capture,
 * after synchronization.
 *
 * It returns its input. That is the entire function, and it looks silly on
 * purpose: the simpler this is, the harder it is for somebody to later add a
 * line that upgrades an offline capture to `authorized` because the upload
 * eventually worked. A successful sync says the record arrived. It says nothing
 * about whether the device was authorized when it was made.
 */
export function reconcileCaptureAuthorization(
  captured: CaptureAuthorizationClaim,
  _serverSyncSucceeded: boolean,
): CaptureAuthorizationClaim {
  return captured;
}
