/**
 * v22.20 — what a truck with no signal may do, and what it may only record.
 *
 * SPINE item 3: the policy itself now lives in `shared/offlinePolicy.ts`, because the field client
 * must run it offline and the server must run the same rule when the work arrives. This file is the
 * server's adapter over it — the gateway-bound types, and the two things only the server can do:
 * read an item's operation from the seal the server computed, and fold the policy's answer into the
 * sync verdicts. It holds no second algorithm.
 *
 * Its caller is `server/deviceRouter.ts` (`sync.receivePackage`), the boundary where queued field
 * work becomes authoritative. The policy never authorizes: admission, acting scope and the hash
 * checks run first and are not overridden by it.
 */

import type { CapabilityDefinition } from "./actionGateway";
import type { ItemVerdict } from "./fieldDevice";
import { revalidatePackagedOperation, type OfflineClass } from "../../shared/offlinePolicy";

export {
  ClassRiskMismatch, DeviceAuthorityRefused, actionable, classRiskDisagreements, envelopeFor, freshnessOf,
  offlineOutcome, validateCapability,
  type Freshness, type LocalAnswer, type LocalRecord, type OfflineClass, type OfflineOutcome, type SyncEnvelope,
} from "../../shared/offlinePolicy";

/** A gateway capability with the offline class it declares. Validated by the shared `validateCapability`. */
export type FieldCapability = CapabilityDefinition & { offlineClass: OfflineClass };

/**
 * The operation an item was sealed as, read from the server's own seal manifest.
 *
 * `canonicalManifest` is the JSON the server built and hashed at seal time (`evidenceSeal.ts`), so
 * the kind is the server's record of the seal, not a field of the package being judged. Anything
 * unreadable is null, and null is refused by the policy.
 */
export function recordTypeOfSealManifest(canonicalManifest: string | null | undefined): string | null {
  if (typeof canonicalManifest !== "string") return null;
  try {
    const parsed = JSON.parse(canonicalManifest) as { recordType?: unknown };
    return typeof parsed?.recordType === "string" && parsed.recordType.length > 0 ? parsed.recordType : null;
  } catch {
    return null;
  }
}

/**
 * Apply the offline policy to verdicts the hash checks already produced.
 *
 * A hash rejection stays exactly as it was. A verified item whose operation the policy refuses
 * becomes rejected, with the policy's reason. Nothing is ever promoted to verified here.
 */
export function revalidatePackageItems(args: {
  verdicts: readonly ItemVerdict[];
  recordTypeById: ReadonlyMap<number, string | null>;
}): { packageOutcome: "hash_verified" | "failed"; verdicts: ItemVerdict[] } {
  const verdicts = args.verdicts.map((v): ItemVerdict => {
    if (v.outcome !== "verified") return v;
    const policy = revalidatePackagedOperation(args.recordTypeById.get(v.evidenceRecordId) ?? null);
    return policy.accepted ? v : { evidenceRecordId: v.evidenceRecordId, outcome: "rejected", reason: `Refused by the offline field policy: ${policy.reason}` };
  });
  return { packageOutcome: verdicts.every(v => v.outcome === "verified") ? "hash_verified" : "failed", verdicts };
}
