/**
 * Checkpoint 5 — who wrote it, by name, without a second name store.
 *
 * The Board showed `User 7`. The names already exist: `users.name` (what the person signed in as)
 * and `operators.name` (the workforce record, linked by `operators.userId`). This reads those two,
 * for a whole page of authors at once, and never anything else: no email, no phone, no licence, no
 * emergency contact. It invents no store and writes nothing.
 *
 * THE ORGANIZATION BOUNDARY. A name is shown only for a person the viewer's organization has a
 * membership row for — active, suspended or ended — or, for the historical single tenant, a person
 * with no active membership anywhere (the same rule `userInScope` applies). Anyone else is `User N`,
 * which is what an author reference already discloses. A person who has since left keeps their name,
 * marked `former`: they wrote it while a member, and a thread that renames its own history is harder
 * to read, not safer. A deleted account is `User N`, stably.
 *
 * An operator name is read only through `ownershipScopeWhere`, so another organization's workforce
 * record never names anyone here.
 */
import { and, inArray } from "drizzle-orm";
import { operators, organizationMemberships, users } from "../drizzle/schema";
import { ownershipScopeWhere, type TenantScope } from "./db";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import type { DbOrTx } from "./_core/dbTypes";

export type IdentityStanding = "member" | "former" | "unresolved";
export type DisplayIdentity = { userId: number; label: string; standing: IdentityStanding };

/** The largest page of authors resolved in one call; a board page is 100 messages. */
export const MAX_IDENTITIES = 500;

/**
 * The label, from what was found. A value that looks like an email address is not a display name:
 * some sign-in methods write one into `users.name`, and the Board is not where it gets published.
 */
export function displayLabel(userId: number, found: { userName?: string | null; operatorName?: string | null }): string {
  const usable = (v: string | null | undefined) => {
    const t = (v ?? "").trim().replace(/\s+/g, " ");
    return t && !t.includes("@") ? t.slice(0, 120) : null;
  };
  return usable(found.userName) ?? usable(found.operatorName) ?? `User ${userId}`;
}

/** Names for a set of people, as the scope may see them. Three batched reads, whatever the page size. */
export async function displayIdentities(d: DbOrTx, userIds: readonly number[], scope: TenantScope): Promise<Map<number, DisplayIdentity>> {
  const ids = Array.from(new Set(userIds.filter(n => Number.isInteger(n) && n > 0))).slice(0, MAX_IDENTITIES);
  const out = new Map<number, DisplayIdentity>();
  if (!ids.length) return out;

  const memberships = await d.select({ userId: organizationMemberships.userId, orgRef: organizationMemberships.orgRef, status: organizationMemberships.status })
    .from(organizationMemberships).where(inArray(organizationMemberships.userId, ids));
  const standingOf = (userId: number): IdentityStanding => {
    const mine = memberships.filter(m => m.userId === userId);
    if (scope.tenantId === SINGLE_TENANT_ID) {
      // The historical tenant: a person nobody else holds. One who now belongs to an organization is
      // that organization's to name.
      return mine.some(m => m.status === "active") ? "unresolved" : "member";
    }
    const here = mine.filter(m => m.orgRef === scope.tenantId);
    if (here.some(m => m.status === "active")) return "member";
    return here.length ? "former" : "unresolved";
  };

  const visible = ids.filter(id => standingOf(id) !== "unresolved");
  const userRows = visible.length ? await d.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, visible)) : [];
  const operatorRows = visible.length
    ? await d.select({ userId: operators.userId, name: operators.name }).from(operators)
      .where(and(inArray(operators.userId, visible), ownershipScopeWhere("operator", operators.id, scope)))
    : [];

  for (const id of ids) {
    const standing = standingOf(id);
    const account = userRows.find(u => u.id === id);
    if (standing === "unresolved" || !account) {
      out.set(id, { userId: id, label: `User ${id}`, standing: "unresolved" });
      continue;
    }
    const operator = operatorRows.find(o => o.userId === id);
    out.set(id, { userId: id, label: displayLabel(id, { userName: account.name, operatorName: operator?.name }), standing });
  }
  return out;
}

/** The label for one author, from a resolved map; `User N` when the map has nothing. */
export const labelOf = (identities: Map<number, DisplayIdentity>, userId: number | null | undefined): string =>
  userId == null ? "Unknown" : identities.get(userId)?.label ?? `User ${userId}`;
