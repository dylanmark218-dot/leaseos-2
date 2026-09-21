/**
 * v22.20 — choosing which model answers, and refusing the ones we may not ship.
 *
 * Pure. No network, no database, no model.
 *
 * Two jobs, and the second is the one worth writing down.
 *
 * **Models are replaceable.** LeaseOS asks for a task — reason, code,
 * transcribe, speak — and this decides which provider serves it. Nothing above
 * this layer names a model, so swapping one is configuration rather than a
 * rewrite. The field moves monthly; anything that hard-codes a model name will
 * be wrong by the next release.
 *
 * **A licence is a deployment fact, not a memo.** The strongest open speech
 * model available today ships under CC BY-NC: excellent, free, and illegal to
 * put in a product you sell. That is not a mistake anybody makes on purpose —
 * it is one somebody makes eighteen months later, when the person who read the
 * licence has moved on and the model is just a name in a config file. So the
 * licence travels with the provider and the gate refuses at routing time.
 *
 * **An unstated licence is refused**, like every other unknown in this system.
 * "We think it's Apache" is the sentence that precedes the problem.
 */

/** What LeaseOS asks for. Deliberately tasks, never model names. */
export type ModelTask =
  | "reason"      // general assistant work
  | "code"        // repository-scale programming
  | "fast_chat"   // short answers where a large model is waste
  | "verify"      // second opinion on a claim, never the same call that made it
  | "transcribe"  // speech in
  | "speak"       // speech out
  | "embed"       // retrieval
  | "extract";    // documents to structure

/**
 * How a licence bears on shipping a commercial product.
 *
 * `permissive` is Apache-2.0/MIT-shaped. `conditional` covers licences that
 * allow commercial use with a threshold or an acceptable-use policy attached —
 * usable, but somebody has to have read it. `non_commercial` is the trap.
 */
export type LicenceClass = "permissive" | "conditional" | "non_commercial" | "unstated";

export type ModelProvider = {
  providerKey: string;
  /** The model as deployed, so an artifact can say what answered. */
  modelRef: string;
  tasks: readonly ModelTask[];
  licence: string;
  licenceClass: LicenceClass;
  /** Anything a conditional licence actually requires, in words. */
  licenceNote: string | null;
  /** Whether it can serve with no network at all. */
  runsOffline: boolean;
  /** Rough resident cost, for deciding what can share a box. */
  vramGb: number | null;
};

export type Deployment = {
  /** A product sold to customers cannot use non-commercial weights. */
  commercial: boolean;
  /** A truck with no signal. */
  offline: boolean;
  /** Licence classes this company has decided it will accept. */
  acceptedLicenceClasses: readonly LicenceClass[];
};

export class NoEligibleProvider extends Error {}

export type RoutingRefusal = {
  providerKey: string;
  reason: "licence_non_commercial" | "licence_unstated" | "licence_not_accepted" | "requires_network" | "task_unsupported";
  detail: string;
};

export type Routing =
  | { routed: true; provider: ModelProvider; considered: number; refused: RoutingRefusal[] }
  | { routed: false; refused: RoutingRefusal[]; detail: string };

/**
 * Why a provider cannot serve this deployment, or null if it can.
 *
 * Licence is checked before anything else: a model we may not ship is not a
 * model whose latency or memory is interesting.
 */
export function refusalFor(provider: ModelProvider, task: ModelTask, deployment: Deployment): RoutingRefusal | null {
  if (!provider.tasks.includes(task)) {
    return { providerKey: provider.providerKey, reason: "task_unsupported", detail: `${provider.modelRef} does not serve ${task}` };
  }
  if (provider.licenceClass === "unstated") {
    return {
      providerKey: provider.providerKey, reason: "licence_unstated",
      detail: `${provider.modelRef} has no stated licence. An unread licence is not a permissive one.`,
    };
  }
  if (deployment.commercial && provider.licenceClass === "non_commercial") {
    return {
      providerKey: provider.providerKey, reason: "licence_non_commercial",
      detail: `${provider.modelRef} is ${provider.licence}, which does not permit the commercial use this deployment makes of it`,
    };
  }
  if (!deployment.acceptedLicenceClasses.includes(provider.licenceClass)) {
    return {
      providerKey: provider.providerKey, reason: "licence_not_accepted",
      detail: `${provider.modelRef} is ${provider.licence} (${provider.licenceClass}); this deployment accepts ${deployment.acceptedLicenceClasses.join(", ")}`,
    };
  }
  if (deployment.offline && !provider.runsOffline) {
    return {
      providerKey: provider.providerKey, reason: "requires_network",
      detail: `${provider.modelRef} needs the network, and this deployment has none`,
    };
  }
  return null;
}

/**
 * Pick a provider for a task.
 *
 * Registration order is preference order — the caller decides what it prefers,
 * and this decides what it may have. Every refusal is returned rather than
 * swallowed, because "no model available" is unhelpful and "the one you wanted
 * is non-commercial" is not.
 */
export function route(args: { task: ModelTask; providers: readonly ModelProvider[]; deployment: Deployment }): Routing {
  const refused: RoutingRefusal[] = [];
  for (const provider of args.providers) {
    const refusal = refusalFor(provider, args.task, args.deployment);
    if (!refusal) return { routed: true, provider, considered: args.providers.length, refused };
    // A provider that simply does not do this task is not a refusal worth
    // reporting; it was never a candidate.
    if (refusal.reason !== "task_unsupported") refused.push(refusal);
  }
  return {
    routed: false, refused,
    detail: refused.length
      ? `No provider may serve ${args.task} here: ${refused.map(r => r.detail).join("; ")}`
      : `No provider serves ${args.task}`,
  };
}

/** Throwing form, for call sites where no model means no answer. */
export function routeOrThrow(args: Parameters<typeof route>[0]): ModelProvider {
  const r = route(args);
  if (!r.routed) throw new NoEligibleProvider(r.detail);
  return r.provider;
}

/* ------------------------------------------------------------------ */
/* What answered                                                        */
/* ------------------------------------------------------------------ */

export type ModelAttribution = {
  task: ModelTask;
  providerKey: string;
  modelRef: string;
  licence: string;
  at: Date;
};

/**
 * Record which model produced an answer.
 *
 * The verifier needs this to avoid asking the same model to check its own work,
 * and an audit needs it to answer "what said that" a year later — by which time
 * the config has changed twice.
 */
export const attribute = (provider: ModelProvider, task: ModelTask, at: Date): ModelAttribution => ({
  task, providerKey: provider.providerKey, modelRef: provider.modelRef, licence: provider.licence, at,
});

export class SameModelVerification extends Error {}

/**
 * A second opinion has to come from somewhere else.
 *
 * A model asked whether its own answer is right will usually say yes. If the
 * only verifier available is the model that answered, that is not a weaker
 * check — it is no check, and reporting it as verified would be worse than
 * reporting it unverified.
 */
export function verifierFor(args: { answeredBy: ModelAttribution; providers: readonly ModelProvider[]; deployment: Deployment }): ModelProvider {
  const others = args.providers.filter(p => p.providerKey !== args.answeredBy.providerKey);
  const r = route({ task: "verify", providers: others, deployment: args.deployment });
  if (!r.routed) {
    throw new SameModelVerification(
      `No verifier other than ${args.answeredBy.modelRef} is available. A model checking its own answer is not a second opinion; report this unverified rather than verified.`,
    );
  }
  return r.provider;
}

/* ------------------------------------------------------------------ */
/* What a box can hold                                                  */
/* ------------------------------------------------------------------ */

/**
 * Whether a set of providers fits resident together.
 *
 * Mixture-of-experts models mislead here: the active-parameter figure describes
 * speed, and every expert still has to be in memory. A plan built on the active
 * count will be short by tens of gigabytes.
 */
export function fitsResident(providers: readonly ModelProvider[], availableVramGb: number): { fits: boolean; requiredGb: number; unknown: string[] } {
  const unknown = providers.filter(p => p.vramGb == null).map(p => p.modelRef);
  const requiredGb = providers.reduce((sum, p) => sum + (p.vramGb ?? 0), 0);
  return { fits: unknown.length === 0 && requiredGb <= availableVramGb, requiredGb, unknown };
}
