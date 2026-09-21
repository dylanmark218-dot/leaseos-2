/**
 * The vault's consequential operations are in the fail-closed sets.
 *
 * `roleProcedure` and `externalProcedure` both refuse a SENSITIVE action when its
 * authorization row cannot be written, on a policy their own comment states: granting
 * a role or releasing a legal hold with no record of who authorized it is worse than
 * refusing. Membership of those sets is what makes the policy reach a given procedure,
 * and membership is a list — so it is a thing that can be true for years and then quietly
 * stop being true.
 *
 * `restricted.read` reads like an ordinary read and is not one. It gates break-glass
 * grant creation, the revocation of another person's grant, and the decision that opens
 * an internal investigation. `portal.invitation.accept` activates an external identity
 * and mints a 90-day bearer token — the most consequential thing the portal gate does,
 * and the one credential operation that was outside the set while `portal.credential.manage`,
 * governing the lesser token rotation, was inside it.
 *
 * The negative cases matter as much: a set that grows until it contains everything stops
 * distinguishing anything, and fail-closed on an ordinary read means an audit hiccup takes
 * the records vault offline.
 */
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SENSITIVE_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  externalPermissionForProcedure,
  isSensitivePermission,
  permissionForProcedure,
} from "./recordsAuthorization";

describe("vault operations fail closed when they cannot be recorded", () => {
  it("treats restricted.read as sensitive", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("restricted.read");
    expect(isSensitivePermission("restricted.read" as never)).toBe(true);
  });

  it("covers every vault procedure that changes something", () => {
    // Named individually rather than by pattern: each is a decision about that
    // procedure, and a pattern would silently adopt the next one added.
    for (const proc of [
      "restrictedVault.breakGlass",
      "restrictedVault.grantRevoke",
      "restrictedVault.investigationDecide",
      "restrictedVault.restrictedRead",
    ]) {
      // permissionForProcedure, not a direct map read: the vault's entries live in
      // the operational map rather than the records one, and this is the accessor
      // roleProcedure itself calls, so the test asks the question the gate asks.
      const permission = permissionForProcedure(proc);
      expect(permission, `${proc} must be mapped to a permission`).toBeDefined();
      expect(
        isSensitivePermission(permission as never),
        `${proc} changes or discloses restricted material and must fail closed when unrecorded`
      ).toBe(true);
    }
  });

  it("does not make ordinary reads fail closed", () => {
    // The cost of over-inclusion, stated: an audit hiccup would take the records
    // vault offline for reads that disclose nothing sensitive.
    expect(SENSITIVE_PERMISSIONS).not.toContain("incident.read");
    expect(SENSITIVE_PERMISSIONS).not.toContain("records.read");
  });
});

describe("the portal gate fails closed on issuing a credential", () => {
  it("treats invitation acceptance as sensitive", () => {
    expect(EXTERNAL_SENSITIVE_PERMISSIONS).toContain("portal.invitation.accept");
  });

  it("maps invitationAccept to that permission", () => {
    expect(externalPermissionForProcedure("portal.invitationAccept")).toBe(
      "portal.invitation.accept"
    );
  });

  it("keeps token rotation sensitive too, so the pair stays consistent", () => {
    // These two both hand out a credential; if one is sensitive and the other is
    // not, the reason is an oversight rather than a decision.
    expect(EXTERNAL_SENSITIVE_PERMISSIONS).toContain("portal.credential.manage");
  });

  it("does not make every portal read sensitive", () => {
    expect(EXTERNAL_SENSITIVE_PERMISSIONS).not.toContain("portal.customer.read");
  });
});
