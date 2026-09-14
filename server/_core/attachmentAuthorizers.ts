/**
 * v22.20 (0099) — who may attach what, and who may later see it.
 *
 * The pure engine in `_core/attachmentAuthorization.ts` holds the rule; this is
 * the async bridge to real records, because the pure `ObjectAuthorizer` is
 * synchronous and a database is not. Faking a lookup inside a synchronous
 * boolean would have meant either a cache pretending to be authority or a pure
 * engine that is no longer pure.
 *
 * **One resolver per kind, and no default.** An unknown kind is refused. The
 * tempting shape here is `heldPermissions.includes(kind + ".read")` — one line,
 * covers every kind, and makes object-level authorization into string
 * concatenation. A caller who can name a kind could then name a permission.
 *
 * **What is shippable is what has an evidenced access path.** This schema's
 * `jobs`, `maintenanceDefects` and `units` exist and can be resolved; they do
 * not carry an organization column, so their scope is the deployment's single
 * tenant and that is stated rather than implied. `invoices` exists too and is
 * deliberately not shipped: a financial record wants a real row-level rule, not
 * an existence check wearing one.
 */
import { eq } from "drizzle-orm";
import { jobs, maintenanceDefects, units } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import { NEVER_ATTACHABLE, type ObjectKind } from "./attachmentAuthorization";

/** How well this deployment can actually answer "may this person open it". */
export type AuthorizerClass = "confirmed" | "partial" | "none" | "never_attachable";

export type AttachmentAuthorizer = {
  kind: ObjectKind;
  authorizerClass: AuthorizerClass;
  /** Permission the viewer must hold, declared rather than derived from the kind. */
  requiredPermission: string;
  /** Resolves existence. Returns false for anything this deployment cannot see. */
  exists: (d: DbOrTx, objectRef: string) => Promise<boolean>;
  /** Why this kind is scoped the way it is, for the reader of an audit. */
  scopeNote: string;
};

const numeric = (ref: string): number | null => (/^\d+$/.test(ref) ? Number(ref) : null);

/**
 * The registry. Adding a kind means adding a resolver that can actually answer
 * for it — not adding a name to a union.
 */
export const MESSAGE_ATTACHMENT_AUTHORIZERS: ReadonlyMap<string, AttachmentAuthorizer> = new Map<string, AttachmentAuthorizer>([
  ["job", {
    kind: "job", authorizerClass: "partial", requiredPermission: "job.read",
    scopeNote: "jobs carries no organization column; scope is this deployment's tenant",
    exists: async (d, ref) => {
      const id = numeric(ref);
      if (id == null) return false;
      return (await d.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1)).length > 0;
    },
  }],
  ["defect", {
    kind: "defect", authorizerClass: "partial", requiredPermission: "maintenance.read",
    scopeNote: "maintenanceDefects carries no organization column; scope is this deployment's tenant",
    exists: async (d, ref) => {
      const id = numeric(ref);
      if (id == null) return false;
      return (await d.select({ id: maintenanceDefects.id }).from(maintenanceDefects).where(eq(maintenanceDefects.id, id)).limit(1)).length > 0;
    },
  }],
  ["unit", {
    kind: "unit", authorizerClass: "partial", requiredPermission: "fleet.read",
    scopeNote: "units carries no organization column; scope is this deployment's tenant",
    exists: async (d, ref) => {
      const id = numeric(ref);
      if (id == null) return false;
      return (await d.select({ id: units.id }).from(units).where(eq(units.id, id)).limit(1)).length > 0;
    },
  }],
]);

export type AttachmentRefusal =
  | { reason: "never_attachable"; message: string }
  | { reason: "unsupported_kind"; message: string }
  | { reason: "not_found"; message: string }
  | { reason: "not_permitted"; message: string };

export type AttachmentCheck =
  | { ok: true; authorizer: AttachmentAuthorizer }
  | { ok: false; refusal: AttachmentRefusal };

/**
 * May this person attach this object.
 *
 * A missing record and one belonging elsewhere answer identically, because
 * existence is itself information: "you may not attach Organization B's job"
 * tells the caller Organization B has that job.
 */
export async function mayAttach(d: DbOrTx, args: {
  kind: string; objectRef: string; heldPermissions: readonly string[];
}): Promise<AttachmentCheck> {
  if ((NEVER_ATTACHABLE as readonly string[]).includes(args.kind)) {
    return {
      ok: false,
      refusal: {
        reason: "never_attachable",
        message: `A ${args.kind} is not attached to a conversation. Attaching means showing it to the room, and that is not how this record is shared.`,
      },
    };
  }
  const authorizer = MESSAGE_ATTACHMENT_AUTHORIZERS.get(args.kind);
  if (!authorizer) {
    return { ok: false, refusal: { reason: "unsupported_kind", message: `No attachment authorizer for ${args.kind}. Object access is not string construction, so an unresolvable kind is refused.` } };
  }
  if (!(await authorizer.exists(d, args.objectRef))) {
    return { ok: false, refusal: { reason: "not_found", message: `No such ${args.kind}` } };
  }
  if (!args.heldPermissions.includes(authorizer.requiredPermission)) {
    // Same words as a missing record: whether it exists is not disclosed to
    // somebody who may not open it.
    return { ok: false, refusal: { reason: "not_found", message: `No such ${args.kind}` } };
  }
  return { ok: true, authorizer };
}

/**
 * What one reader sees, evaluated now rather than when it was attached.
 *
 * A permission revoked yesterday closes the attachment today, which a stored
 * copy could never do.
 */
export async function viewFor(d: DbOrTx, args: {
  kind: string; objectRef: string; heldPermissions: readonly string[];
}): Promise<{ visible: boolean; kind: string; objectRef?: string; deepLink?: string; note?: string }> {
  const check = await mayAttach(d, args);
  if (check.ok) {
    return { visible: true, kind: args.kind, objectRef: args.objectRef, deepLink: `/${args.kind}/${encodeURIComponent(args.objectRef)}` };
  }
  return {
    visible: false, kind: args.kind,
    // Names that something is attached without naming which record, so the
    // conversation still reads while the reference stays closed.
    note: `A ${args.kind} is attached to this message and is not visible to you.`,
  };
}

/** Kinds this deployment can actually serve, for an honest capability answer. */
export const supportedKinds = (): string[] => {
  const out: string[] = [];
  MESSAGE_ATTACHMENT_AUTHORIZERS.forEach((_, k) => out.push(k));
  return out;
};
