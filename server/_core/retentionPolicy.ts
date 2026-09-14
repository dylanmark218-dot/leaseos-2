/**
 * Retention & legal hold.
 *
 * Two retention clocks run on every record and they are not the same clock:
 *
 *   device  — how long the operator's device must keep a local copy so the
 *             record can be produced at a roadside or scale inspection
 *   office  — how long the company archive keeps it for audit
 *
 * A deliberate correction to the way this is usually stated: the Canadian
 * "current day plus previous 14 days" figure is an ELD roadside-production
 * requirement for hours-of-service records. It is not a blanket legal rule that
 * every field document must live on a phone for 14 days. Carrier HOS retention
 * and dangerous-goods shipping-document retention are separate requirements
 * with different periods again.
 *
 * So 14 days on device and 10 years at the office are configured here as
 * COMPANY policy that is intended to meet or exceed applicable minimums — not
 * asserted as the statutory rule itself. Statutory minimums stay null and
 * `unverified` until an authoritative source is actually loaded, and this engine
 * will not claim statutory compliance it cannot evidence. Invariant #10:
 * regulatory information is data, not code.
 */

export type RetentionPolicy = {
  policyKey: string;
  recordType: string;
  jurisdiction?: string | null;
  /** Null until an authoritative source has been loaded and verified. */
  statutoryMinimumMonths?: number | null;
  statutorySourceStatus: "unverified" | "verified" | "not_applicable";
  companyRetentionMonths: number;
  contractRetentionMonths?: number | null;
  deviceRetentionDays?: number | null;
  deletionRequiresOfficeReceipt: boolean;
  legalHoldOverridesDeletion: boolean;
};

/** Company defaults. Policy, not law — and labelled as such. */
export const COMPANY_DEFAULT_DEVICE_RETENTION_DAYS = 14;
export const COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS = 120; // 10 years

export type EffectiveRetention = {
  months: number;
  /** Which input won. Never collapsed into an unexplained number. */
  basis:
    | "statutory"
    | "company"
    | "contract"
    | "legal_hold_indefinite";
  /** True when a statutory minimum exists AND its source has been verified. */
  statutoryBackingVerified: boolean;
  /**
   * Set when a statutory minimum is recorded but unverified. The company period
   * still applies; we simply cannot claim it is statute-backed.
   */
  caveat?: string;
  officeRetainUntil: Date | null;
  deviceRetainUntil: Date | null;
};

function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Effective retention is the MAX of every applicable requirement. Retention
 * requirements stack upward; the longest wins. A legal hold is not a period at
 * all — it suspends expiry entirely.
 */
export function computeEffectiveRetention(args: {
  policy: RetentionPolicy;
  sealedAt: Date;
  underLegalHold: boolean;
}): EffectiveRetention {
  const { policy, sealedAt, underLegalHold } = args;

  const deviceDays =
    policy.deviceRetentionDays ?? COMPANY_DEFAULT_DEVICE_RETENTION_DAYS;
  const deviceRetainUntil = addDays(sealedAt, deviceDays);

  if (underLegalHold && policy.legalHoldOverridesDeletion) {
    return {
      months: Number.POSITIVE_INFINITY,
      basis: "legal_hold_indefinite",
      statutoryBackingVerified: policy.statutorySourceStatus === "verified",
      officeRetainUntil: null, // no expiry while held
      deviceRetainUntil,
    };
  }

  const statutoryVerified =
    policy.statutorySourceStatus === "verified" &&
    typeof policy.statutoryMinimumMonths === "number";

  const candidates: Array<{ months: number; basis: EffectiveRetention["basis"] }> =
    [{ months: policy.companyRetentionMonths, basis: "company" }];

  if (typeof policy.contractRetentionMonths === "number") {
    candidates.push({
      months: policy.contractRetentionMonths,
      basis: "contract",
    });
  }
  if (statutoryVerified) {
    candidates.push({
      months: policy.statutoryMinimumMonths as number,
      basis: "statutory",
    });
  }

  const winner = candidates.reduce((a, b) => (b.months > a.months ? b : a));

  const caveat =
    typeof policy.statutoryMinimumMonths === "number" && !statutoryVerified
      ? `Statutory minimum of ${policy.statutoryMinimumMonths} months is recorded but its source is ${policy.statutorySourceStatus} — company policy applied, statutory compliance not asserted`
      : policy.statutoryMinimumMonths == null &&
          policy.statutorySourceStatus === "unverified"
        ? "No verified statutory minimum loaded for this record type — company policy applied, statutory compliance not asserted"
        : undefined;

  return {
    months: winner.months,
    basis: winner.basis,
    statutoryBackingVerified: statutoryVerified,
    caveat,
    officeRetainUntil: addMonths(sealedAt, winner.months),
    deviceRetainUntil,
  };
}

export type DeviceDeletionBlocker = {
  code:
    | "not_sealed"
    | "device_retention_active"
    | "office_not_received"
    | "office_integrity_unverified"
    | "legal_hold";
  label: string;
  clearsAt?: Date;
};

export type DeviceDeletionDecision = {
  allowed: boolean;
  blockers: DeviceDeletionBlocker[];
};

/**
 * Whether the operator may delete their local copy.
 *
 * Deleting locally never deletes the office record — but it must not be
 * possible before the office provably has it. "The server said 200 OK" is not
 * proof; a verified hash is. Named blockers, not "Not ready" (invariant #14).
 */
export function evaluateDeviceDeletion(args: {
  sealed: boolean;
  now: Date;
  deviceRetainUntil: Date | null;
  officeReceivedAt: Date | null;
  officeIntegrityVerifiedAt: Date | null;
  underLegalHold: boolean;
  policy: Pick<
    RetentionPolicy,
    "deletionRequiresOfficeReceipt" | "legalHoldOverridesDeletion"
  >;
}): DeviceDeletionDecision {
  const blockers: DeviceDeletionBlocker[] = [];

  if (!args.sealed) {
    blockers.push({
      code: "not_sealed",
      label: "Record is not sealed yet",
    });
  }

  if (args.underLegalHold && args.policy.legalHoldOverridesDeletion) {
    blockers.push({
      code: "legal_hold",
      label: "Under legal hold — deletion suspended",
    });
  }

  if (args.deviceRetainUntil && args.now < args.deviceRetainUntil) {
    blockers.push({
      code: "device_retention_active",
      label: "Field retention period has not elapsed",
      clearsAt: args.deviceRetainUntil,
    });
  }

  if (args.policy.deletionRequiresOfficeReceipt) {
    if (!args.officeReceivedAt) {
      blockers.push({
        code: "office_not_received",
        label: "Office has not received this record",
      });
    } else if (!args.officeIntegrityVerifiedAt) {
      blockers.push({
        code: "office_integrity_unverified",
        label: "Office received it but integrity is not verified",
      });
    }
  }

  return { allowed: blockers.length === 0, blockers };
}

/**
 * Whether a record may actually be disposed of at the office. Separate from
 * device deletion and deliberately stricter: an expired period is a
 * precondition for disposition, never an instruction to perform one.
 */
export function evaluateOfficeDisposition(args: {
  now: Date;
  officeRetainUntil: Date | null;
  underLegalHold: boolean;
}): { eligible: boolean; reason: string } {
  if (args.underLegalHold) {
    return {
      eligible: false,
      reason: "Under legal hold — retention does not expire while the hold stands",
    };
  }
  if (!args.officeRetainUntil) {
    return {
      eligible: false,
      reason: "No retention expiry computed — record is retained",
    };
  }
  if (args.now < args.officeRetainUntil) {
    return {
      eligible: false,
      reason: `Retained until ${args.officeRetainUntil.toISOString().slice(0, 10)}`,
    };
  }
  return {
    eligible: true,
    reason: "Retention period elapsed — eligible for authorized disposition",
  };
}

/**
 * Storage pressure on the device. Mandatory evidence is never the thing that
 * gets sacrificed — cached map regions are.
 */
export type StorageReliefStep = {
  order: number;
  target: "map_cache" | "released_local_copies" | "queued_uploads" | "none";
  label: string;
  safeToDrop: boolean;
};

export function storageReliefPlan(): StorageReliefStep[] {
  return [
    {
      order: 1,
      target: "map_cache",
      label: "Remove cached map regions",
      safeToDrop: true,
    },
    {
      order: 2,
      target: "released_local_copies",
      label: "Remove local copies already released by retention and verified at office",
      safeToDrop: true,
    },
    {
      order: 3,
      target: "queued_uploads",
      label: "Upload queued records to free space — send, do not delete",
      safeToDrop: false,
    },
    {
      order: 4,
      target: "none",
      label: "Mandatory retention records are never dropped for storage",
      safeToDrop: false,
    },
  ];
}
