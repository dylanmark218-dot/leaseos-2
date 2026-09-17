/**
 * B28 — the role vocabulary bridge.
 *
 * The widget engine grew up branchless and names roles the way its scratch
 * shim did: `DRIVER`, `DISPATCHER`, `SAFETY_COMPLIANCE`, `BILLING_ACCOUNTING`.
 * The branch names them `driver`, `dispatcher`, `safety`, `bookkeeper`. Layouts
 * are stored under the engine key, `suggestedFor` is matched against it, and the
 * permission lookup runs against the branch role. One table, both directions,
 * and anything not in it round-trips through upper/lower case so a new branch
 * role never silently loses its board.
 */
import type { DomainRole } from "./recordsAuthorization";

const ENGINE_BY_BRANCH: Readonly<Record<string, string>> = {
  driver: "DRIVER",
  dispatcher: "DISPATCHER",
  mechanic: "MECHANIC",
  shop_lead: "MECHANIC",          // one board vocabulary for the shop; the branch role still governs permissions
  safety: "SAFETY_COMPLIANCE",
  bookkeeper: "BILLING_ACCOUNTING",
  office: "OFFICE",
  controller: "BILLING_ACCOUNTING",
  management: "MANAGEMENT",
  administrator: "ADMINISTRATOR",
};

/** Branch role → engine role key. */
export function engineRoleKey(branchRole: DomainRole | string): string {
  return ENGINE_BY_BRANCH[branchRole] ?? branchRole.toUpperCase();
}

/**
 * Engine role key → the branch roles it may stand for. More than one when two
 * branch roles share a board vocabulary (shop_lead and mechanic; controller and
 * bookkeeper). The caller intersects with the roles the user actually holds.
 */
export function branchRolesFor(engineKey: string): readonly string[] {
  const direct = Object.entries(ENGINE_BY_BRANCH).filter(([, e]) => e === engineKey).map(([b]) => b);
  return direct.length ? direct : [engineKey.toLowerCase()];
}
