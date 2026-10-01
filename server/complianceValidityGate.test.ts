/**
 * SPINE item 2 — the dispatch gate maps the canonical document verdict; it does not re-decide it.
 *
 * `credentialBlocker` receives the verdict `complianceDocumentValidity` reached (via the composer)
 * and turns it into one of the gate's three existing codes. These cases pin that table, and the
 * one rule layered on it: evidence of expiry still blocks when the verdict is only unverified or
 * incomplete — an unchecked document whose own date has passed is not a softer case.
 */
import { describe, expect, it } from "vitest";
import { evaluateDispatchReadiness, type CredentialState, type ReadinessInput } from "./_core/dispatchReadiness";
import type { ValidityState } from "./_core/documentValidity";

const NOW = new Date("2026-10-01T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const fine = (label: string): CredentialState => ({ label, expiresAt: days(300), present: true });

function withLicence(licence: CredentialState): ReadinessInput {
  return {
    evaluatedAt: NOW,
    operator: { operatorId: 1, name: "x", licence, requiredCredentials: [], hoursAvailableMinutes: 600, projectedJobMinutes: 300, availabilityDeclared: true },
    truck: { unitNumber: "U", inspection: fine("i"), registration: fine("r"), insurance: fine("n"), maintenanceOverdue: false, criticalDefectOpen: false, mechanicReleaseRequired: false, mechanicReleaseGiven: false },
    job: { classificationComplete: true, dangerousGoods: false, tdgDocumentPrepared: true, requiredDocumentsPresent: true, permitRequired: false, permitOnFile: null, destinationAcceptanceVerified: null, emergencyPlanOnFile: true },
    route: { corridorState: "pass", restrictionDataFresh: true },
  } as never;
}
const judged = (state: ValidityState, expiresAt: Date | null, reason = "because"): CredentialState =>
  ({ label: "Driver licence", expiresAt, present: state !== "none" && state !== "rejected", validity: { state, reason } });
const licenceBlockers = (licence: CredentialState) =>
  evaluateDispatchReadiness(withLicence(licence)).blockers.filter(b => b.code.startsWith("operator_licence"));

describe("the gate maps the canonical verdict onto its existing codes", () => {
  it.each([
    ["none", null, "operator_licence_missing", "blocking", false],
    ["rejected", null, "operator_licence_missing", "blocking", false],
    ["not_yet_effective", days(400), "operator_licence_missing", "blocking", false],
    ["expired", days(-3), "operator_licence_expired", "blocking", false],
    ["unverified", days(400), "operator_licence_unknown", "unknown", true],
    ["incomplete", null, "operator_licence_unknown", "unknown", true],
  ] as const)("%s → %s", (state, expiresAt, code, severity, overridable) => {
    const [b, ...rest] = licenceBlockers(judged(state, expiresAt));
    expect(rest).toEqual([]);
    expect(b).toMatchObject({ code, severity, overridable });
    if (overridable) expect(b!.overrideAuthority).toBe("manager");
  });

  it.each(["in_force", "expiring"] as const)("%s clears", state => {
    expect(licenceBlockers(judged(state, days(state === "expiring" ? 10 : 300)))).toEqual([]);
  });

  it("says which unknown it is: not verified, or no expiry recorded", () => {
    expect(licenceBlockers(judged("unverified", days(400), "Version 1 is uploaded"))[0]!.label).toContain("not verified");
    expect(licenceBlockers(judged("incomplete", null))[0]!.label).toContain("expiry unknown");
  });

  it("names why nothing is in force when the verdict is not yet effective", () => {
    expect(licenceBlockers(judged("not_yet_effective", days(400), "Version 1 is verified but not in force until 2026-10-15"))[0]!.label)
      .toContain("not in force until 2026-10-15");
  });
});

describe("evidence of expiry still blocks", () => {
  it("an unverified document whose own date has passed is a hard block, not an overridable one", () => {
    expect(licenceBlockers(judged("unverified", days(-2)))[0]).toMatchObject({ code: "operator_licence_expired", severity: "blocking", overridable: false });
  });

  it("a document in force at composition but expired by the evaluation instant blocks", () => {
    // The composer judges at its `now`; the gate evaluates at `evaluatedAt`. The later instant wins.
    expect(licenceBlockers(judged("in_force", days(-1)))[0]).toMatchObject({ code: "operator_licence_expired" });
  });
});

describe("a credential built without a verdict keeps the date-only reading", () => {
  it("present with a future date clears; no date is unknown; a past date is expired", () => {
    expect(licenceBlockers({ label: "Driver licence", expiresAt: days(300), present: true })).toEqual([]);
    expect(licenceBlockers({ label: "Driver licence", expiresAt: null, present: true })[0]).toMatchObject({ code: "operator_licence_unknown" });
    expect(licenceBlockers({ label: "Driver licence", expiresAt: days(-1), present: true })[0]).toMatchObject({ code: "operator_licence_expired" });
  });
});
