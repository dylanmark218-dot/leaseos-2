/**
 * Dispatch enforcement — the legacy assignment path under the gate.
 *
 *   off       assign as always
 *   advisory  assign, and raise an exception when it happened without a
 *             check or against a blocked or unknown one
 *   enforced  assign only on a fresh, fact-valid check whose blockers are
 *             resolved or covered by a granted override — the award's rule
 *
 * The setting is append-only; the current mode is the latest row for the
 * scope. Every assignment records the mode in force when it was made.
 */

import { assessEligibilityValidity, type EligibilityFacts, type GrantedOverride, type StoredEligibilityCheck } from "./dispatchAward";

export type EnforcementMode = "off" | "advisory" | "enforced";

export type EnforcementRow = { id?: number; financialEntityId: number | null; mode: EnforcementMode; setAt: Date };

/**
 * Latest row for the entity wins; otherwise latest global; otherwise off.
 * `setAt` has second precision in the database, so two settings written in
 * the same second tie on time; the higher id is the later one. Without the
 * tiebreak, "advisory then enforced" in one second read back as advisory.
 */
export function currentMode(rows: readonly EnforcementRow[], financialEntityId: number | null): { mode: EnforcementMode; source: "entity" | "global" | "default" } {
  const latest = (xs: EnforcementRow[]) => [...xs].sort((a, b) => b.setAt.getTime() - a.setAt.getTime() || (b.id ?? 0) - (a.id ?? 0))[0];
  const ent = financialEntityId != null ? latest(rows.filter(r => r.financialEntityId === financialEntityId)) : undefined;
  if (ent) return { mode: ent.mode, source: "entity" };
  const glob = latest(rows.filter(r => r.financialEntityId == null));
  if (glob) return { mode: glob.mode, source: "global" };
  return { mode: "off", source: "default" };
}

export type LegacyAssignmentDecision =
  | { allowed: true; mode: EnforcementMode; exceptions: string[]; checkId: number | null }
  | { allowed: false; mode: "enforced"; refusals: string[] };

/**
 * The award's rule, without a posting or a bid: freshness, fingerprint, and
 * every non-eligible blocker resolved or covered by an override on an
 * overridable blocker. In advisory mode the same findings become exceptions
 * instead of refusals.
 */
export function decideLegacyAssignment(args: {
  mode: EnforcementMode;
  check: StoredEligibilityCheck | null;
  currentFacts: EligibilityFacts | null;
  grantedOverrides: readonly GrantedOverride[];
  subject: { operatorId: number; unitId: number | null; jobId: number };
  now: Date;
  maxAgeMinutes?: number;
}): LegacyAssignmentDecision {
  if (args.mode === "off") return { allowed: true, mode: "off", exceptions: [], checkId: args.check?.checkId ?? null };

  const findings: string[] = [];
  if (!args.check) {
    findings.push("Assignment made without a readiness check");
  } else {
    const c = args.check;
    if (c.operatorId !== args.subject.operatorId) findings.push(`Check ${c.checkId} is for a different operator`);
    if (args.currentFacts) {
      const v = assessEligibilityValidity(c, args.currentFacts, args.now, args.maxAgeMinutes ?? 30);
      if (!v.valid) findings.push(v.reason);
    }
    for (const b of c.blockers) {
      if (b.severity === "blocking") { findings.push(`BLOCKED — ${b.label}`); continue; }
      const covered = b.overridable && args.grantedOverrides.some(o => o.blockerCode === b.code);
      if (!covered) findings.push(`${b.severity === "unknown" ? "UNKNOWN" : "REVIEW"} — ${b.label} (no authorised override)`);
    }
    for (const o of args.grantedOverrides) {
      const b = c.blockers.find(x => x.code === o.blockerCode);
      if (b && !b.overridable) findings.push(`Override of ${b.code} is not permitted for any role`);
    }
  }

  if (args.mode === "advisory") return { allowed: true, mode: "advisory", exceptions: findings, checkId: args.check?.checkId ?? null };
  return findings.length === 0
    ? { allowed: true, mode: "enforced", exceptions: [], checkId: args.check!.checkId }
    : { allowed: false, mode: "enforced", refusals: findings };
}
