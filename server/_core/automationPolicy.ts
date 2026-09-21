/**
 * P8.2 — the automation policy resolver, per the owner decision of 2026-09-18.
 *
 * Two questions, kept apart on purpose, because collapsing them is the mistake the whole design
 * guards against:
 *
 *   1. **Is this capability available to this tenant for this use?**  (entitlement)
 *   2. **If it is, what governs how a record reaches confirmed?**    (automation mode)
 *
 * A missing *policy* and a missing *entitlement* are different failures and must not produce the
 * same answer. An unconfigured but entitled capability resolves to `MANUAL` — a person does the
 * work — and an unlicensed one has **no mode at all** and feeds P8.1 as `NOT_EVALUATED`. If those
 * were merged, one forgotten configuration row would either silently switch automation on or
 * falsely report that the customer never had the feature. Neither is recoverable after the fact.
 *
 * That is also why there is no fourth mode called `OFF`. "Off" is an entitlement answer wearing a
 * mode's clothes, and a capability with a mode is a capability someone may reason about.
 *
 * What the mode does **not** change: the committed record. `AUTO`, `HYBRID` and `MANUAL` govern how
 * a record reaches confirmed — engine self-commit, engine proposes and a person confirms, or a
 * person does it — and nothing else. The row, its evidence requirements, its provenance fields, its
 * hashes and its relationships are structurally identical in all three. Three parallel record types
 * would make "what mode were we in" unanswerable from the record, which is the opposite of the
 * point.
 */

/* ------------------------------------------------------------------ */
/* Modes and the ceiling                                               */
/* ------------------------------------------------------------------ */

export type AutomationMode = "AUTO" | "HYBRID" | "MANUAL";

/**
 * How much of the work the machine does. Higher is more automatic, so a *ceiling* is a maximum and
 * a *downgrade* moves toward MANUAL. Every comparison in this file goes through this one ordering;
 * an engine that invented its own would be the drift the structural guard exists to catch.
 */
export const AUTOMATION_LEVEL: Readonly<Record<AutomationMode, number>> = { MANUAL: 0, HYBRID: 1, AUTO: 2 };

export const isMoreManual = (a: AutomationMode, b: AutomationMode) => AUTOMATION_LEVEL[a] < AUTOMATION_LEVEL[b];

/** The scopes a policy may be written at, least specific first. */
export const SCOPE_ORDER = ["tenant", "role", "task", "customer"] as const;
export type PolicyScope = (typeof SCOPE_ORDER)[number];
export const SCOPE_RANK: Readonly<Record<PolicyScope, number>> = { tenant: 1, role: 2, task: 3, customer: 4 };

export type PolicyRow = {
  capability: string;
  scope: PolicyScope;
  /** Role name, task ref or customer ref; null for the tenant default. */
  scopeId: string | null;
  requestedMode: AutomationMode;
  /** The version this row belongs to, carried into the decision snapshot. */
  policyVersionId: string;
  /** Where the policy came from — an onboarding preset, a person, an import. */
  source: string;
};

/**
 * Entitlement is deliberately three-valued. "We have not been told" is not "no": an unresolved
 * entitlement feeds NOT_EVALUATED like an explicit absence, but it says so differently, so a
 * missing feed can be found and fixed rather than being indistinguishable from a customer who
 * genuinely did not buy the feature.
 */
export type Entitlement =
  | { state: "entitled"; reference?: string }
  | { state: "not_entitled"; reason: "unlicensed" | "disabled" | "not_in_product_set"; reference?: string }
  | { state: "unresolved"; reason: "entitlement_source_unavailable" };

/** The per-capability maximum. P8.2 supplies the mechanism; **P8.4 decides the list.** */
export type SafetyCeiling = { maxMode: AutomationMode; source: string } | null;

export type ResolveInput = {
  capability: string;
  entitlement: Entitlement;
  /** Null until P8.4 classifies the capability. Null means no ceiling, not "assume MANUAL". */
  ceiling: SafetyCeiling;
  /** Every policy row that applies to this decision, at any scope. */
  policies: readonly PolicyRow[];
};

export type ResolutionStep = { scope: PolicyScope; scopeId: string | null; mode: AutomationMode; policyVersionId: string; source: string };

export type Resolution =
  | {
      outcome: "resolved";
      capability: string;
      entitled: true;
      mode: AutomationMode;
      /** What each layer asked for, least specific first. */
      steps: readonly ResolutionStep[];
      /** The row that won, or null when nothing was configured. */
      winner: ResolutionStep | null;
      ceilingApplied: SafetyCeiling;
      /** True when the winning request was above the ceiling and was clamped. */
      clamped: boolean;
      /** "tenant=HYBRID → role=AUTO → customer=MANUAL → resolved=MANUAL" */
      trace: string;
      reason: string;
    }
  | {
      outcome: "not_evaluated";
      capability: string;
      entitled: false;
      /** Mirrors P8.1's vocabulary so the two contracts meet without translation. */
      notEvaluatedReason: "not_licensed" | "module_disabled" | "not_applicable" | "no_data_source_loaded";
      trace: string;
      reason: string;
    }
  | {
      outcome: "policy_error";
      capability: string;
      /** Equal-scope rows disagreeing. Never resolved by date, insertion order or row order. */
      conflict: { scope: PolicyScope; scopeId: string | null; modes: readonly AutomationMode[]; policyVersionIds: readonly string[] };
      trace: string;
      reason: string;
    };

/* ------------------------------------------------------------------ */
/* The resolver                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolve one capability for one decision.
 *
 * Order, and it is not negotiable: entitlement → safety ceiling → tenant → role → task → customer.
 * More specific replaces less specific, and nothing may exceed the ceiling. The whole trace is
 * returned, not only the answer, because "which row won and why" is the question asked six months
 * later and it cannot be reconstructed from a mode alone.
 */
export function resolveAutomation(input: ResolveInput): Resolution {
  const { capability, entitlement, ceiling } = input;

  /* 1. Entitlement. No mode exists for a capability the tenant does not have. */
  if (entitlement.state !== "entitled") {
    const notEvaluatedReason =
      entitlement.state === "unresolved" ? "no_data_source_loaded" as const
        : entitlement.reason === "disabled" ? "module_disabled" as const
        : entitlement.reason === "not_in_product_set" ? "not_licensed" as const
        : "not_licensed" as const;
    const why = entitlement.state === "unresolved"
      ? "entitlement could not be established, and an unresolved entitlement is not an entitlement"
      : `not entitled (${entitlement.reason})`;
    return {
      outcome: "not_evaluated", capability, entitled: false, notEvaluatedReason,
      trace: `entitlement=${entitlement.state} → no automation mode → NOT_EVALUATED`,
      reason: `${capability}: ${why}. A capability without entitlement has no automation mode; it reports NOT_EVALUATED to its consumers.`,
    };
  }

  /* 2. Equal-scope conflicts are a configuration error, not a tie to break. */
  const forCapability = input.policies.filter(p => p.capability === capability);
  for (const scope of SCOPE_ORDER) {
    const atScope = forCapability.filter(p => p.scope === scope);
    const byId = new Map<string, PolicyRow[]>();
    for (const p of atScope) {
      const key = p.scopeId ?? "";
      byId.set(key, [...(byId.get(key) ?? []), p]);
    }
    for (const [scopeId, rows] of Array.from(byId.entries())) {
      const modes: AutomationMode[] = Array.from(new Set(rows.map((r: PolicyRow) => r.requestedMode)));
      if (modes.length > 1) {
        return {
          outcome: "policy_error", capability,
          conflict: { scope, scopeId: scopeId || null, modes, policyVersionIds: rows.map((r: PolicyRow) => r.policyVersionId) },
          trace: `${scope}${scopeId ? `:${scopeId}` : ""}=${modes.join("|")} → conflict → POLICY ERROR`,
          reason: `${capability}: ${modes.length} policies at the same ${scope} scope ask for different modes (${modes.join(", ")}). Picking one by date or row order would make the effective mode depend on the database rather than on a decision, so this is surfaced for review instead.`,
        };
      }
    }
  }

  /* 3. Least specific first, each replacing the last. */
  const steps: ResolutionStep[] = [];
  for (const scope of SCOPE_ORDER) {
    const row = forCapability.find(p => p.scope === scope);
    if (row) steps.push({ scope, scopeId: row.scopeId, mode: row.requestedMode, policyVersionId: row.policyVersionId, source: row.source });
  }
  const winner = steps.length ? steps[steps.length - 1]! : null;

  /* 4. Entitled but unconfigured is MANUAL. Never AUTO — a forgotten row must not start a machine. */
  const requested: AutomationMode = winner?.mode ?? "MANUAL";

  /* 5. The ceiling clamps, and says that it did. */
  let mode = requested;
  let clamped = false;
  if (ceiling && AUTOMATION_LEVEL[requested] > AUTOMATION_LEVEL[ceiling.maxMode]) {
    mode = ceiling.maxMode;
    clamped = true;
  }

  const traceParts = steps.map(s => `${s.scope}${s.scopeId ? `:${s.scopeId}` : ""}=${s.mode}`);
  if (!steps.length) traceParts.push("no policy configured");
  if (clamped) traceParts.push(`ceiling=${ceiling!.maxMode}`);
  return {
    outcome: "resolved", capability, entitled: true, mode, steps, winner, ceilingApplied: ceiling, clamped,
    trace: `${traceParts.join(" → ")} → resolved=${mode}`,
    reason: !winner
      ? `${capability}: entitled, but no automation policy is configured at any scope, so it is MANUAL. A missing policy is not permission to automate.`
      : clamped
        ? `${capability}: ${winner.scope} policy asked for ${requested}, above the ${ceiling!.maxMode} safety ceiling (${ceiling!.source}), so it is clamped to ${mode}. The request is recorded as asked and as clamped — it is not treated as accepted.`
        : `${capability}: the ${winner.scope} policy (${winner.policyVersionId}) is the most specific and asks for ${mode}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Operational overrides — one task, one direction                     */
/* ------------------------------------------------------------------ */

export type OverrideRequest = { from: AutomationMode; to: AutomationMode; actorRole: string; scope: "one_task" | "one_trip" };

/**
 * A dispatcher, supervisor or operator may take a single task toward **more** human involvement
 * without management approval. They may never take it the other way.
 *
 * The asymmetry is the point: choosing to do something yourself needs no permission, and deciding a
 * machine may do it unwatched is a policy change. Collapsing them into one "override" permission is
 * how an operational convenience becomes an automation decision nobody signed off.
 */
export function evaluateOperationalOverride(req: OverrideRequest):
  | { allowed: true; mode: AutomationMode; reason: string }
  | { allowed: false; reason: string } {
  if (req.from === req.to) return { allowed: false, reason: "The task is already in that mode." };
  if (AUTOMATION_LEVEL[req.to] > AUTOMATION_LEVEL[req.from]) {
    return {
      allowed: false,
      reason: `An operational override may only move toward more human involvement. ${req.from} → ${req.to} increases automation, which is a policy change and needs automation.policy.manage.`,
    };
  }
  return {
    allowed: true, mode: req.to,
    reason: `${req.from} → ${req.to} for this ${req.scope.replace("_", " ")}: more human involvement, which any responsible operator may choose. The standing policy is unchanged.`,
  };
}

/* ------------------------------------------------------------------ */
/* The snapshot — 0152's lesson, applied to policy                     */
/* ------------------------------------------------------------------ */

/**
 * What a consequential decision keeps, so the decision can be explained under the policy that
 * actually governed it. Re-running today's resolver against yesterday's decision would answer with
 * today's configuration, which is worse than not answering because it would look like evidence.
 * This is the same reasoning that put the capability picture on `dispatchEligibilityChecks` in
 * `0152`, and it is applied here for the same reason.
 */
export type PolicySnapshot = {
  capability: string;
  entitled: boolean;
  entitlementReference: string | null;
  requestedByScope: { scope: PolicyScope; scopeId: string | null; mode: AutomationMode }[];
  winningPolicyVersionId: string | null;
  resolvedMode: AutomationMode | null;
  safetyCeiling: AutomationMode | null;
  clamped: boolean;
  trace: string;
  reason: string;
  actorUserId: number | null;
  engineProfileVersion: string | null;
  decidedAt: string;
};

export function snapshotOf(
  r: Resolution,
  meta: { actorUserId?: number | null; engineProfileVersion?: string | null; decidedAt?: Date; entitlementReference?: string | null },
): PolicySnapshot {
  const base = {
    capability: r.capability,
    entitlementReference: meta.entitlementReference ?? null,
    trace: r.trace,
    reason: r.reason,
    actorUserId: meta.actorUserId ?? null,
    engineProfileVersion: meta.engineProfileVersion ?? null,
    decidedAt: (meta.decidedAt ?? new Date()).toISOString(),
  };
  if (r.outcome === "resolved") {
    return {
      ...base, entitled: true,
      requestedByScope: r.steps.map(s => ({ scope: s.scope, scopeId: s.scopeId, mode: s.mode })),
      winningPolicyVersionId: r.winner?.policyVersionId ?? null,
      resolvedMode: r.mode,
      safetyCeiling: r.ceilingApplied?.maxMode ?? null,
      clamped: r.clamped,
    };
  }
  return {
    ...base, entitled: false, requestedByScope: [], winningPolicyVersionId: null,
    resolvedMode: null, safetyCeiling: null, clamped: false,
  };
}

/* ------------------------------------------------------------------ */
/* The only normal source of an effective mode                         */
/* ------------------------------------------------------------------ */

/**
 * The live rows, shaped for the resolver. An engine that wants to know a capability's mode asks
 * here and nowhere else — `automationPolicy.structure.test.ts` fails if a mode is decided anywhere
 * but this file, because a second precedence order is the failure that makes the trace a lie.
 *
 * An **absent** entitlement row is `unresolved`, not `not_entitled`. A customer who never bought a
 * feature and a feed that never arrived both fail closed, and both should — but they need different
 * fixes, and a system that cannot tell them apart will fix neither.
 */
export type PolicyStore = {
  entitlementFor(orgRef: string | null, capability: string): Promise<Entitlement>;
  policiesFor(orgRef: string | null, capability: string, scopeIds: { role?: string | null; task?: string | null; customer?: string | null }): Promise<PolicyRow[]>;
  /** P8.4's classification. Null until a capability has been classified — never inferred from its name. */
  ceilingFor(capability: string): SafetyCeiling;
};

export async function resolveFromStore(
  store: PolicyStore,
  orgRef: string | null,
  capability: string,
  scopeIds: { role?: string | null; task?: string | null; customer?: string | null } = {},
): Promise<Resolution> {
  const entitlement = await store.entitlementFor(orgRef, capability);
  // Policies are not even read when the capability is not entitled: there is no mode to resolve,
  // and reading them would invite a later edit that lets a policy row imply entitlement.
  if (entitlement.state !== "entitled") {
    return resolveAutomation({ capability, entitlement, ceiling: null, policies: [] });
  }
  return resolveAutomation({
    capability, entitlement,
    ceiling: store.ceilingFor(capability),
    policies: await store.policiesFor(orgRef, capability, scopeIds),
  });
}

/**
 * P8.1 meets P8.2 here. A capability that is not entitled reports NOT_EVALUATED with the reason the
 * resolver derived; an entitled one is evaluated through whichever workflow its mode names, and the
 * mode does not change whether it is evaluated — only how the record reaches confirmed.
 */
export function entitlementToEvaluation(r: Resolution): { evaluated: true; mode: AutomationMode } | { evaluated: false; reason: "not_licensed" | "module_disabled" | "not_applicable" | "no_data_source_loaded"; detail: string } {
  if (r.outcome === "not_evaluated") return { evaluated: false, reason: r.notEvaluatedReason, detail: r.reason };
  if (r.outcome === "policy_error") {
    // A configuration error is not an entitlement answer. It fails closed as unevaluated and is
    // surfaced for review, rather than quietly resolving to MANUAL and looking like a choice.
    return { evaluated: false, reason: "no_data_source_loaded", detail: r.reason };
  }
  return { evaluated: true, mode: r.mode };
}

/* ------------------------------------------------------------------ */
/* The mode governs how a record is confirmed, never what it looks like */
/* ------------------------------------------------------------------ */

/**
 * The provenance a committed record carries, whichever mode produced it.
 *
 * This is the owner's rule made checkable: `AUTO`, `HYBRID` and `MANUAL` govern **how** a record
 * reaches confirmed, and nothing else. The committed row, its evidence requirements, its provenance
 * fields, its hashes and its relationships are structurally identical in all three.
 *
 * The temptation is obvious and the cost is delayed. A manually entered record has no engine
 * confidence, so it is tempting to leave the field off; an automatic one has no confirming person,
 * so it is tempting to leave that off too. Do it twice and there are three record shapes, queries
 * that work on some rows, and no answer at all to "what mode were we in when this was made" —
 * because the evidence for it was the field somebody dropped as redundant.
 *
 * So every mode fills every field. What differs is the **values**: who acted, and what kind of
 * thing they were.
 */
export const REQUIRED_PROVENANCE_FIELDS = [
  "source",           // what produced the value
  "confidence",       // how far it can be relied on
  "verification",     // whether a person has stood behind it
  "confirmedByKind",  // engine or person — never absent, even when obvious
  "confirmedAt",
  "automationMode",   // the mode in force, so the question is answerable from the row
] as const;

export type CommittedProvenance = {
  source: "engine_proposed" | "person_entered";
  confidence: "measured" | "asserted";
  verification: "self_committed" | "person_confirmed";
  confirmedByKind: "engine" | "person";
  confirmedAt: string;
  automationMode: AutomationMode;
};

/**
 * The provenance for a commit in a given mode.
 *
 * `HYBRID` and `MANUAL` both end with a person confirming, and they are still different records:
 * in HYBRID an engine proposed the value and a person agreed with it; in MANUAL the person supplied
 * it. `source` keeps that apart, which matters when someone later asks whether a figure was the
 * machine's or the operator's.
 */
export function committedProvenance(
  mode: AutomationMode,
  at: Date,
): CommittedProvenance {
  const confirmedAt = at.toISOString();
  if (mode === "AUTO") {
    return { source: "engine_proposed", confidence: "measured", verification: "self_committed", confirmedByKind: "engine", confirmedAt, automationMode: mode };
  }
  if (mode === "HYBRID") {
    return { source: "engine_proposed", confidence: "measured", verification: "person_confirmed", confirmedByKind: "person", confirmedAt, automationMode: mode };
  }
  return { source: "person_entered", confidence: "asserted", verification: "person_confirmed", confirmedByKind: "person", confirmedAt, automationMode: mode };
}
