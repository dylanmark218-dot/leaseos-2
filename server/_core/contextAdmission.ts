/**
 * v22.20 — only a resolver may make data model-readable.
 *
 * Pure. The resolvers it drives touch the database; this module does not.
 *
 * `contextAssembly` proved that a context cannot mix organizations. That is
 * necessary and it is not sufficient: within one organization a dispatcher and
 * a payroll manager have radically different authority, and nothing so far
 * stopped arbitrary text becoming a block merely by carrying a matching
 * tenant id.
 *
 * So the boundary moves one step earlier. Nothing becomes model-readable
 * because somebody constructed an object that looks right — it becomes
 * model-readable because a named resolver proved the tenant, proved the
 * principal may read the object, and projected the fields they are entitled
 * to. The admitted block carries that proof.
 *
 * **There is deliberately no generic `admit()`.** A function taking kind,
 * tenant and text recreates the weakness one layer down: whoever can pass those
 * three values can manufacture authority. Kind comes from the resolver, never
 * from a caller.
 *
 * **Tenant proof is stated, not assumed.** This system is mid-migration from a
 * single-tenant shape and several tables still carry no organization column.
 * A resolver says how it knows, and `legacy_single_tenant` is refusable — so
 * today's honest limitation cannot quietly become tomorrow's cross-tenant leak
 * when a second organization arrives.
 */

import type { BlockKind } from "./contextAssembly";

/** Nothing outside this module can produce this symbol, so nothing can forge a block. */
declare const admitted: unique symbol;

export type Admission = {
  principalUserId: number | null;
  tenantId: string | null;
  /** Which resolver vouched for this, so an audit can ask it why. */
  resolverKey: string;
  permission: string | null;
  proof: TenantProof;
  admittedAt: Date;
};

export type AdmittedContextBlock = {
  readonly [admitted]: true;
  blockRef: string;
  kind: BlockKind;
  tenantId: string | null;
  text: string;
  sourceRef: string | null;
  admission: Admission;
};

/**
 * How a resolver knows which organization owns a row.
 *
 * Writing this down is the point. "It must be ours, we only have one company"
 * is true until it isn't, and the migration that makes it false will not
 * revisit every AI read path.
 */
export type TenantProof =
  | { kind: "row"; tenantId: string }
  | { kind: "parent"; parentType: string; parentRef: string; tenantId: string }
  | { kind: "legacy_single_tenant"; tenantId: string }
  | { kind: "system" };

export type AdmissionRefusal =
  | { reason: "not_found"; message: string }
  | { reason: "unsupported_kind"; message: string }
  | { reason: "no_tenant_proof"; message: string }
  | { reason: "missing_source"; message: string };

export class AdmissionRefused extends Error {
  constructor(readonly refusal: AdmissionRefusal) { super(refusal.message); }
}

export type ActingContext = {
  userId: number;
  tenantId: string;
  heldPermissions: readonly string[];
  /** True once this deployment serves more than one organization. */
  multiTenant: boolean;
};

/**
 * What a resolver returns.
 *
 * `text` is produced last, from a projection — see `project` below. A resolver
 * that loads the whole row and trims it afterwards is one refactor away from
 * serialising a pay rate.
 */
export type ResolvedSource = {
  sourceRef: string;
  kind: BlockKind;
  proof: TenantProof;
  permission: string | null;
  text: string;
};

export type ContextResolver = {
  resolverKey: string;
  /** Resolves and authorizes in one step, scoped by the acting tenant. */
  resolve: (sourceRef: string, acting: ActingContext) => Promise<ResolvedSource | null>;
};

const tenantOf = (proof: TenantProof): string | null =>
  proof.kind === "system" ? null : proof.tenantId;

/**
 * Admit one source.
 *
 * Refuses with the same words for a record that does not exist and one the
 * principal may not read. A caller holding a real reference from another
 * organization must learn exactly what a caller holding a made-up one learns.
 */
export async function admitSource(args: {
  resolvers: ReadonlyMap<string, ContextResolver>;
  sourceKind: string;
  sourceRef: string;
  acting: ActingContext;
  at: Date;
  blockRef: string;
}): Promise<AdmittedContextBlock> {
  const resolver = args.resolvers.get(args.sourceKind);
  if (!resolver) {
    throw new AdmissionRefused({
      reason: "unsupported_kind",
      message: `No context resolver for ${args.sourceKind}. An unresolvable source is refused rather than loaded on trust.`,
    });
  }

  const resolved = await resolver.resolve(args.sourceRef, args.acting);
  // One answer for absent, foreign, and forbidden. Distinguishing them would
  // turn a reference into an existence oracle.
  if (!resolved) throw new AdmissionRefused({ reason: "not_found", message: `No such ${args.sourceKind}` });

  if (resolved.proof.kind === "legacy_single_tenant" && args.acting.multiTenant) {
    throw new AdmissionRefused({
      reason: "no_tenant_proof",
      message: `${args.sourceKind} ${args.sourceRef} is owned only by the single-tenant assumption, and this deployment serves more than one organization. AI context is not where unfinished multi-tenancy gets completed.`,
    });
  }

  const owner = tenantOf(resolved.proof);
  if (owner != null && owner !== args.acting.tenantId) {
    throw new AdmissionRefused({ reason: "not_found", message: `No such ${args.sourceKind}` });
  }

  /* The permission the resolver declared, actually checked.
   *
   * This module recorded it in the admission receipt and admitted the block
   * regardless — so a resolver could say "requires payroll.read" and a
   * dispatcher would read it anyway. The receipt looked like evidence of a
   * check that never happened, which is worse than no receipt: an audit would
   * have shown the permission beside the admission and concluded it was
   * enforced.
   *
   * Refused in the same words as absent and foreign, so holding a real
   * reference to something you may not read teaches you nothing. */
  if (resolved.permission && !args.acting.heldPermissions.includes(resolved.permission)) {
    throw new AdmissionRefused({ reason: "not_found", message: `No such ${args.sourceKind}` });
  }

  // A statement with no source cannot later answer "where did this come from
  // and who was entitled to retrieve it".
  const needsSource = resolved.kind !== "system_prompt" && resolved.kind !== "user_message";
  if (needsSource && !resolved.sourceRef) {
    throw new AdmissionRefused({
      reason: "missing_source",
      message: `A ${resolved.kind} block must name its source; an unattributed statement cannot be traced afterwards.`,
    });
  }

  return {
    blockRef: args.blockRef,
    kind: resolved.kind,
    tenantId: owner,
    text: resolved.text,
    sourceRef: resolved.sourceRef,
    admission: {
      principalUserId: args.acting.userId,
      tenantId: owner,
      resolverKey: resolver.resolverKey,
      permission: resolved.permission,
      proof: resolved.proof,
      admittedAt: args.at,
    },
  } as AdmittedContextBlock;
}

/* ------------------------------------------------------------------ */
/* The two blocks that come from us, not from a record                  */
/* ------------------------------------------------------------------ */

/** Our own prompt. The only block entitled to carry no organization. */
export const systemPromptBlock = (args: { blockRef: string; text: string; at: Date }): AdmittedContextBlock => ({
  blockRef: args.blockRef, kind: "system_prompt", tenantId: null, text: args.text, sourceRef: null,
  admission: {
    principalUserId: null, tenantId: null, resolverKey: "system",
    permission: null, proof: { kind: "system" }, admittedAt: args.at,
  },
} as AdmittedContextBlock);

/**
 * What the person actually typed.
 *
 * Their organization comes from their session, never from the message — the
 * request says what they asked, not who they are.
 */
export const authenticatedUserBlock = (args: { blockRef: string; text: string; acting: ActingContext; at: Date }): AdmittedContextBlock => ({
  blockRef: args.blockRef, kind: "user_message", tenantId: args.acting.tenantId, text: args.text, sourceRef: null,
  admission: {
    principalUserId: args.acting.userId, tenantId: args.acting.tenantId, resolverKey: "session",
    permission: null, proof: { kind: "row", tenantId: args.acting.tenantId }, admittedAt: args.at,
  },
} as AdmittedContextBlock);

/* ------------------------------------------------------------------ */
/* Projection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the text of a block from named fields only.
 *
 * The alternative — load the row, delete the sensitive keys — leaves every
 * future column opted in by default. Here a field absent from the list is
 * absent from the model, and a new column added next year is absent too.
 */
export function project<T extends Record<string, unknown>>(row: T, fields: readonly (keyof T)[]): string {
  return fields
    .filter(f => row[f] !== undefined && row[f] !== null)
    .map(f => `${String(f)}: ${String(row[f])}`)
    .join("\n");
}

/** Whether a projection leaked anything it was not asked for. */
export const projectionOmits = (text: string, forbidden: readonly string[]): boolean =>
  !forbidden.some(f => text.includes(f));
