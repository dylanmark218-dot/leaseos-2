/**
 * Integration Hub — conflict decisions.
 *
 * A conflict is two authorities asserting different values for the same field.
 * The contract declares the policy; the machine applies only the policies that
 * are safe to apply without a person, and it records both values either way.
 */
import { FAIL_CLOSED_ENTITIES } from "./contracts";

export type ConflictPolicy = "reject_review" | "source_wins" | "leaseos_wins" | "newest_wins" | "manual";
export type ConflictDecision = "pending" | "source_applied" | "leaseos_kept" | "newest_applied" | "rejected";

export function decideConflict(args: {
  policy: ConflictPolicy; entityType: string; dataOwnership: "external" | "leaseos" | "shared";
  source: { value: unknown; revisedAt: Date | null }; leaseos: { value: unknown; revisedAt: Date | null };
}): { decision: ConflictDecision; applied: unknown; reason: string } {
  const sensitive = FAIL_CLOSED_ENTITIES.some(k => args.entityType.toLowerCase().includes(k));
  if (sensitive && args.dataOwnership !== "leaseos" && !["reject_review", "manual"].includes(args.policy)) {
    return { decision: "pending", applied: args.leaseos.value, reason: `${args.entityType} is fail-closed data with ${args.dataOwnership} ownership; held for manual review regardless of the ${args.policy} policy` };
  }
  switch (args.policy) {
    case "source_wins": return { decision: "source_applied", applied: args.source.value, reason: "contract policy: source wins" };
    case "leaseos_wins": return { decision: "leaseos_kept", applied: args.leaseos.value, reason: "contract policy: LeaseOS wins" };
    case "newest_wins": {
      if (!args.source.revisedAt || !args.leaseos.revisedAt) return { decision: "pending", applied: args.leaseos.value, reason: "newest-wins needs both revision times; one is missing, so a person decides" };
      return args.source.revisedAt.getTime() > args.leaseos.revisedAt.getTime()
        ? { decision: "newest_applied", applied: args.source.value, reason: "source revision is newer" }
        : { decision: "newest_applied", applied: args.leaseos.value, reason: "LeaseOS revision is newer or equal" };
    }
    case "reject_review": return { decision: "pending", applied: args.leaseos.value, reason: "contract policy: reject and review" };
    case "manual": return { decision: "pending", applied: args.leaseos.value, reason: "contract policy: manual resolution" };
  }
}
