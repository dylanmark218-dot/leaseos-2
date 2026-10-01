/**
 * A branch-confined grant must not become a global one on the way out of the database.
 *
 * `authorize()` already rules on this: when the caller cannot resolve the resource's
 * branch — which is every consumer of the role-name projection — a branch-confined
 * grant "does not apply; only a global grant passes". The rule was correct and the
 * projection undid it. `listActiveUserRoleNames` returned the names of confined
 * grants, `normalizeGrants` turned each name into `{ role, scopeRef: null }`, and
 * `permissionsFor()` has no scope axis at all, so a role held in one branch decided
 * questions about every branch.
 *
 * That gap is invisible to the gate-level checks this repo already runs. Every
 * affected procedure IS behind a `roleProcedure`; the widening happens inside the
 * handler, after the gate has passed, so "0 bare protectedProcedure" stays true
 * while the answer is wrong.
 *
 * The first two cases pin the asymmetry in `authorize` itself — they are the reason
 * the projection has to filter, and they pass with or without the fix. The rest
 * pin the projection, and the db-backed one fails without it.
 */
import { describe, expect, it } from "vitest";
import { SINGLE_TENANT_ID } from "./actingScope";
import { authorize, permissionsFor } from "./recordsAuthorization";
import type { RoleGrant } from "./recordsAuthorization";
import { grantUserRole, listActiveUserRoleNames, listRoleNamesAnyScope } from "../db";

const PERMISSION = "incident.review";

describe("authorize treats a name and a confined grant differently", () => {
  it("refuses a branch-confined grant when no resource branch was resolved", () => {
    const grants: RoleGrant[] = [{ role: "safety", scopeRef: "YEG" }];
    const decision = authorize({ userId: 1, grants, permission: PERMISSION as never });
    expect(decision.allowed, "a confined grant cannot be judged, so it must not pass").toBe(false);
  });

  it("allows the same role given as a bare name — which is why the projection must filter", () => {
    const decision = authorize({ userId: 1, roles: ["safety"], permission: PERMISSION as never });
    expect(
      decision.allowed,
      "a bare name is read as a global grant; this is the behaviour the projection must not feed"
    ).toBe(true);
  });

  it("permissionsFor has no scope axis at all", () => {
    // Stated because it is the reason a name cannot carry confinement: there is
    // nowhere in this answer for a branch to live.
    expect(permissionsFor(["safety"]).length).toBeGreaterThan(0);
  });
});

const DB = process.env.DATABASE_URL;
const d = DB ? describe : describe.skip;

d("the projection does not launder a confined grant", () => {
  const newUserId = () => 900_000 + Math.floor(Number(process.hrtime.bigint() % 90_000n));

  it("omits a branch-confined role from the authorization projection, and keeps it for training", async () => {
    const userId = newUserId();
    const now = new Date();
    await grantUserRole({
      // B23.1A (0170): a branch grant names its organization — branch ids are
      // bare strings with no owner, so the constraint requires both.
      userId, role: "safety", scopeType: "branch", orgRef: SINGLE_TENANT_ID, scopeRef: "YEG",
      grantedByUserId: 1, grantedAt: now,
    });

    expect(
      await listActiveUserRoleNames(userId),
      "a confined grant must not appear in the projection that feeds authorize()"
    ).toEqual([]);

    expect(
      await listRoleNamesAnyScope(userId),
      "but it is still a role the person holds — training bindings must still see it"
    ).toEqual(["safety"]);
  });

  it("still reports a global grant", async () => {
    const userId = newUserId() + 1;
    const now = new Date();
    await grantUserRole({
      userId, role: "safety", scopeType: "global",
      grantedByUserId: 1, grantedAt: now,
    });
    expect(await listActiveUserRoleNames(userId)).toEqual(["safety"]);
  });
});
