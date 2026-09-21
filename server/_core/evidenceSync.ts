/**
 * Sending sealed records to the office.
 *
 * The operator presses SEAL & SEND once. Everything after that is the system's
 * problem: if there is no service the package waits, and when service returns
 * it transmits without the operator doing anything. "Waiting for service" is a
 * normal resting state, not an error, and must never be presented as one — a
 * driver 80 km out of coverage has not failed at anything.
 *
 * Transmission is a state machine rather than a `sent` boolean because the
 * interesting states are the ones between: received-but-unverified is not the
 * same as accepted, and neither releases the device copy.
 */

export type SyncState =
  | "queued"
  | "waiting_for_service"
  | "transmitting"
  | "server_received"
  | "hash_verified"
  | "office_accepted"
  | "failed"
  | "rejected";

/** Legal transitions. Anything absent here is refused, loudly. */
const TRANSITIONS: Record<SyncState, SyncState[]> = {
  queued: ["waiting_for_service", "transmitting", "failed"],
  waiting_for_service: ["transmitting", "failed"],
  transmitting: ["server_received", "waiting_for_service", "failed"],
  server_received: ["hash_verified", "rejected"],
  hash_verified: ["office_accepted", "rejected"],
  office_accepted: [],
  failed: ["queued", "waiting_for_service", "transmitting"],
  rejected: ["queued"],
};

export type TransitionOutcome =
  | { ok: true; state: SyncState }
  | { ok: false; state: SyncState; reason: string };

export function canTransition(from: SyncState, to: SyncState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: SyncState, to: SyncState): TransitionOutcome {
  if (!canTransition(from, to)) {
    return {
      ok: false,
      state: from,
      reason: `Illegal sync transition ${from} → ${to}`,
    };
  }
  return { ok: true, state: to };
}

/** Terminal success. The only state in which the office provably holds it. */
export function isAccepted(state: SyncState): boolean {
  return state === "office_accepted";
}

/**
 * Whether the device copy may be released on sync grounds alone. Note this is
 * necessary but not sufficient — retention and legal hold are separate gates
 * evaluated in retentionPolicy.
 */
export function syncPermitsDeviceRelease(state: SyncState): boolean {
  return state === "office_accepted";
}

/** Waiting for service is not a failure and is never surfaced as one. */
export function isOperatorActionable(state: SyncState): boolean {
  return state === "rejected";
}

export function operatorFacingStatus(state: SyncState): {
  label: string;
  tone: "ok" | "pending" | "attention";
  actionRequired: boolean;
} {
  switch (state) {
    case "queued":
      return { label: "Sealed — queued to send", tone: "pending", actionRequired: false };
    case "waiting_for_service":
      return {
        label: "Sealed — waiting for service. Stored securely on this device.",
        tone: "pending",
        actionRequired: false,
      };
    case "transmitting":
      return { label: "Sending…", tone: "pending", actionRequired: false };
    case "server_received":
      return { label: "Received — verifying", tone: "pending", actionRequired: false };
    case "hash_verified":
      return { label: "Verified — awaiting office", tone: "pending", actionRequired: false };
    case "office_accepted":
      return { label: "Office received", tone: "ok", actionRequired: false };
    case "failed":
      return {
        label: "Send interrupted — will retry automatically",
        tone: "pending",
        actionRequired: false,
      };
    case "rejected":
      return {
        label: "Integrity error — local copy retained, office alerted",
        tone: "attention",
        actionRequired: true,
      };
  }
}

/**
 * Backoff for retry. Bounded, and it never gives up quietly — after the cap the
 * package keeps waiting rather than transitioning to a dead state, because a
 * record that stops trying to reach the office is a record that is lost.
 */
export function retryDelaySeconds(attemptCount: number): number {
  const capped = Math.min(Math.max(attemptCount, 0), 8);
  return Math.min(30 * 2 ** capped, 3600);
}

export type PackagePlan = {
  packageRef: string;
  itemCount: number;
  /** Sealed records only. A draft has not been confirmed by the operator. */
  rejected: Array<{ trackingNumber: string; reason: string }>;
};

/**
 * Build a send package. Unsealed records are excluded rather than swept along:
 * sending a draft would transmit something the operator never confirmed.
 */
export function planSendPackage(args: {
  packageRef: string;
  records: Array<{
    trackingNumber: string;
    sealState: "draft" | "sealed" | "amended" | "superseded";
    contentHash?: string | null;
    manifestHash?: string | null;
  }>;
}): PackagePlan {
  const rejected: PackagePlan["rejected"] = [];
  let itemCount = 0;

  for (const r of args.records) {
    if (r.sealState === "draft") {
      rejected.push({
        trackingNumber: r.trackingNumber,
        reason: "Not sealed — operator has not confirmed it",
      });
      continue;
    }
    if (r.sealState === "superseded") {
      rejected.push({
        trackingNumber: r.trackingNumber,
        reason: "Superseded by a later version",
      });
      continue;
    }
    if (!r.contentHash || !r.manifestHash) {
      rejected.push({
        trackingNumber: r.trackingNumber,
        reason: "Missing seal hashes — cannot be verified on receipt",
      });
      continue;
    }
    itemCount += 1;
  }

  return { packageRef: args.packageRef, itemCount, rejected };
}
