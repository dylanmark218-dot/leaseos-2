/**
 * v23.28 — how long a scanned document must be kept, asked of the engine that owns the question.
 *
 * This is an adapter and nothing more. `retentionPolicy.computeEffectiveRetention` already decides
 * retention, already stacks company, contract and statutory periods upward, and already refuses to
 * claim statutory backing it cannot evidence. `shared/paperworkGuidance` already carries the
 * CANDIDATE statutory figure for each kind of paperwork, with the citation and the verification
 * state. Neither of them knows about the other, and this file is the twenty lines that introduce
 * them.
 *
 * Writing the periods out again here — "a disposal ticket is two years" — would be the second
 * answer this codebase keeps finding in post-mortems. The figure lives in one place, the arithmetic
 * lives in another, and this file does no arithmetic at all.
 *
 * ## Why every policy this produces is unverified
 *
 * `statutorySourceStatus` is derived from the guidance's own `verification` field rather than set
 * here. Nothing in the seed is verified, so every policy this builds is unverified, so
 * `computeEffectiveRetention` applies COMPANY policy and attaches its caveat rather than asserting
 * statutory compliance. That is the fail-closed answer: the company's ten years is longer than the
 * two years the report cites anyway, so nothing is under-retained while nobody has read the
 * regulation — and the day somebody verifies the clause, the same flag turns the statutory figure
 * on without anybody editing this file.
 */

import {
  COMPANY_DEFAULT_DEVICE_RETENTION_DAYS, COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS,
  type RetentionPolicy,
} from "./retentionPolicy";
import { guidanceFor, type GuidanceContext, type PaperworkKind } from "@shared/paperworkGuidance";

/**
 * Build the retention policy for one kind of scanned paperwork.
 *
 * `companyRetentionMonths` and the two optional overrides are the caller's, because they are
 * company and contract facts rather than regulatory ones. Everything regulatory comes from the
 * guidance registry, unverified.
 */
export function retentionPolicyFor(args: {
  kind: PaperworkKind | string;
  context?: GuidanceContext;
  companyRetentionMonths?: number;
  contractRetentionMonths?: number | null;
  deviceRetentionDays?: number | null;
}): RetentionPolicy {
  const g = guidanceFor(args.kind, args.context ?? {});
  const statutory = g.statutoryRetention;

  return {
    policyKey: `paperwork:${g.kind}`,
    recordType: g.kind,
    jurisdiction: args.context?.jurisdiction ?? null,
    statutoryMinimumMonths: statutory.months,
    // Derived, never asserted. The guidance seed is unverified, so this is unverified, so the
    // statutory figure does not count towards the period and the caveat is attached.
    statutorySourceStatus: g.verification === "verified" ? "verified" : "unverified",
    companyRetentionMonths: args.companyRetentionMonths ?? COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS,
    contractRetentionMonths: args.contractRetentionMonths ?? null,
    deviceRetentionDays: args.deviceRetentionDays ?? COMPANY_DEFAULT_DEVICE_RETENTION_DAYS,
    // A scan is evidence. The device does not get to forget it because the disk filled up, and a
    // legal hold outranks every period — both are the vault's existing rules, restated as the
    // inputs this engine expects rather than re-decided.
    deletionRequiresOfficeReceipt: true,
    legalHoldOverridesDeletion: true,
  };
}
