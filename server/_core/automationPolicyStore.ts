/**
 * P8.2 — the live policy store.
 *
 * Reads the current (non-superseded) entitlement and policy rows and hands them to the pure
 * resolver. It decides nothing: precedence, defaults, clamping and conflict detection all live in
 * `automationPolicy.ts`, which is what makes "the resolver is the single source of effective mode"
 * a checkable claim rather than an intention.
 *
 * One rule this file is careful about: an **absent** entitlement row is `unresolved`, not
 * `not_entitled`. Both fail closed, but a customer who never bought a feature and an entitlement
 * feed that never arrived need different fixes, and a store that flattened them would hide the
 * second behind the first forever.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../db";
import { automationPolicies, capabilityEntitlements } from "../../drizzle/schema";
import {
  resolveFromStore, type Entitlement, type PolicyRow, type PolicyStore, type Resolution, type SafetyCeiling,
} from "./automationPolicy";

/**
 * P8.4's classification, and it is **empty on purpose**.
 *
 * The owner decision is explicit: P8.2 supplies the mechanism, P8.4 decides the list, and until a
 * capability has been classified it must not be treated as prohibited from AUTO merely because its
 * name sounds safety-related. Guessing here would be deciding P8.4 by inference, and the guess
 * would then be indistinguishable from a decision in every record it touched.
 *
 * The one rule already named by the owner is reserved for P8.4 and is not written here either:
 * critical mechanic-release decisions are not to be silently made AUTO.
 */
export const SAFETY_CEILINGS: Readonly<Record<string, SafetyCeiling>> = {};

export const ceilingFor = (capability: string): SafetyCeiling => SAFETY_CEILINGS[capability] ?? null;

export function makePolicyStore(): PolicyStore {
  return {
    async entitlementFor(orgRef, capability): Promise<Entitlement> {
      const db = await getDb();
      if (!db) return { state: "unresolved", reason: "entitlement_source_unavailable" };
      const rows = await db.select().from(capabilityEntitlements).where(and(
        eq(capabilityEntitlements.capability, capability),
        orgRef == null ? isNull(capabilityEntitlements.orgRef) : eq(capabilityEntitlements.orgRef, orgRef),
        isNull(capabilityEntitlements.supersededAt),
      )).limit(1);
      const row = rows[0];
      // No row at all: nobody has said yes and nobody has said no.
      if (!row) return { state: "unresolved", reason: "entitlement_source_unavailable" };
      if (row.state === "entitled") return { state: "entitled", reference: row.reference ?? undefined };
      return { state: "not_entitled", reason: row.reason ?? "unlicensed", reference: row.reference ?? undefined };
    },

    async policiesFor(orgRef, capability, scopeIds): Promise<PolicyRow[]> {
      const db = await getDb();
      if (!db) return [];
      const rows = await db.select().from(automationPolicies).where(and(
        eq(automationPolicies.capability, capability),
        orgRef == null ? isNull(automationPolicies.orgRef) : eq(automationPolicies.orgRef, orgRef),
        isNull(automationPolicies.supersededAt),
      ));
      /*
       * Only the rows that apply to THIS decision. A role policy for a dispatcher says nothing about
       * a mechanic's decision, and letting it through would make the trace describe a row that had
       * no business in the answer. Tenant rows always apply; the rest must match their scope id.
       */
      return rows
        .filter(r => {
          if (r.scope === "tenant") return true;
          if (r.scope === "role") return scopeIds.role != null && r.scopeId === scopeIds.role;
          if (r.scope === "task") return scopeIds.task != null && r.scopeId === scopeIds.task;
          return scopeIds.customer != null && r.scopeId === scopeIds.customer;
        })
        .map(r => ({
          capability: r.capability, scope: r.scope, scopeId: r.scopeId,
          requestedMode: r.requestedMode, policyVersionId: r.policyVersionId, source: r.source,
        }));
    },

    ceilingFor,
  };
}

/** Resolve one capability against the live rows. */
export const resolveCapability = (
  orgRef: string | null,
  capability: string,
  scopeIds?: { role?: string | null; task?: string | null; customer?: string | null },
): Promise<Resolution> => resolveFromStore(makePolicyStore(), orgRef, capability, scopeIds);

/** Resolve several at once, for an engine composing a decision over many capabilities. */
export async function resolveCapabilities(
  orgRef: string | null,
  capabilities: readonly string[],
  scopeIds?: { role?: string | null; task?: string | null; customer?: string | null },
): Promise<Record<string, Resolution>> {
  const store = makePolicyStore();
  const out: Record<string, Resolution> = {};
  for (const c of capabilities) out[c] = await resolveFromStore(store, orgRef, c, scopeIds);
  return out;
}

/* ------------------------------------------------------------------ */
/* Writing policy: append-only, superseded, never rewritten            */
/* ------------------------------------------------------------------ */

export type PolicyWrite = {
  orgRef: string | null;
  capability: string;
  scope: PolicyRow["scope"];
  scopeId: string | null;
  requestedMode: PolicyRow["requestedMode"];
  source: string;
  reason: string;
  actorUserId: number;
};

/**
 * Supersede whatever governed this scope and write the new version beside it. The old row keeps its
 * own version id and its effective window, so a decision made yesterday still resolves under the
 * policy that governed it — that is the whole reason this is not an UPDATE.
 *
 * The requested mode is stored **as requested**, with the ceiling in force recorded beside it. A row
 * that silently stored the clamped value would report a decision the person never made.
 */
export async function writePolicy(w: PolicyWrite): Promise<{ policyVersionId: string; supersededVersionIds: string[] }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const policyVersionId = `PV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const current = await db.select().from(automationPolicies).where(and(
    eq(automationPolicies.capability, w.capability),
    eq(automationPolicies.scope, w.scope),
    w.scopeId == null ? isNull(automationPolicies.scopeId) : eq(automationPolicies.scopeId, w.scopeId),
    w.orgRef == null ? isNull(automationPolicies.orgRef) : eq(automationPolicies.orgRef, w.orgRef),
    isNull(automationPolicies.supersededAt),
  ));
  const now = new Date();
  if (current.length) {
    await db.update(automationPolicies)
      .set({ supersededAt: now, supersededByVersionId: policyVersionId })
      .where(inArray(automationPolicies.id, current.map(r => r.id)));
  }
  const ceiling = ceilingFor(w.capability);
  await db.insert(automationPolicies).values({
    policyVersionId, orgRef: w.orgRef, capability: w.capability, scope: w.scope, scopeId: w.scopeId,
    requestedMode: w.requestedMode, safetyCeilingApplied: ceiling?.maxMode ?? null,
    source: w.source, reason: w.reason, actorUserId: w.actorUserId, effectiveFrom: now,
  });
  return { policyVersionId, supersededVersionIds: current.map(r => r.policyVersionId) };
}

/** Set or change an entitlement, superseding rather than rewriting, for the same reason. */
export async function writeEntitlement(w: {
  orgRef: string | null; capability: string; state: "entitled" | "not_entitled";
  reason?: "unlicensed" | "disabled" | "not_in_product_set" | null; reference?: string | null; setByUserId: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const now = new Date();
  await db.update(capabilityEntitlements).set({ supersededAt: now }).where(and(
    eq(capabilityEntitlements.capability, w.capability),
    w.orgRef == null ? isNull(capabilityEntitlements.orgRef) : eq(capabilityEntitlements.orgRef, w.orgRef),
    isNull(capabilityEntitlements.supersededAt),
  ));
  await db.insert(capabilityEntitlements).values({
    orgRef: w.orgRef, capability: w.capability, state: w.state,
    reason: w.state === "not_entitled" ? (w.reason ?? "unlicensed") : null,
    reference: w.reference ?? null, setByUserId: w.setByUserId, effectiveFrom: now,
  });
}

export { or };
