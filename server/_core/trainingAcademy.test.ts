import { describe, expect, it } from "vitest";
import { trainingDispatchDecision, type TrainingRequirement } from "./trainingAcademy";


/**
 * P0.6 — the two findings the proposed academy bridge was right about.
 *
 * The bridge itself is not ported: the composer already routes per-requirement enforcement into
 * separate blocking and review channels, and already treats a null validity as non-expiring, so
 * porting it would be a second implementation of a working one. But two of its four arguments
 * described real gaps in the live path, and those are fixed here rather than argued with.
 */
describe("a training finding says which state it is, and carries a stable code", () => {
  const req = (over: Partial<TrainingRequirement> = {}): TrainingRequirement =>
    ({ code: "REG-TDG-V1", title: "TDG certification", qualificationCode: "TDG", enforcement: "block", recoveryPath: "book the TDG course", ...over } as TrainingRequirement);
  const NOW = new Date("2026-09-18T00:00:00Z");

  it("distinguishes a revoked certificate from one that was never held", () => {
    // Same sentence for both was the finding: one is paperwork to chase, the other is a decision
    // somebody made about this person.
    const never = trainingDispatchDecision([req()], [], NOW);
    const revoked = trainingDispatchDecision([req()], [{ code: "TDG", status: "revoked" }], NOW);
    expect(never.blocking[0]!.state).toBe("never held");
    expect(never.blockers[0]).toMatch(/no qualification on file/);
    expect(revoked.blocking[0]!.state).toBe("revoked");
    expect(revoked.blockers[0]).toMatch(/revoked/);
    expect(revoked.blockers[0]).not.toBe(never.blockers[0]);
  });

  it("names pending, rejected and expired as themselves", () => {
    const pending = trainingDispatchDecision([req()], [{ code: "TDG", status: "pending" }], NOW);
    expect(pending.blockers[0]).toMatch(/issued but awaiting signature/);
    const rejected = trainingDispatchDecision([req()], [{ code: "TDG", status: "rejected" }], NOW);
    expect(rejected.blocking[0]!.state).toBe("rejected");
    const expired = trainingDispatchDecision([req()], [{ code: "TDG", status: "current", expiresAt: new Date("2026-01-01T00:00:00Z") }], NOW);
    expect(expired.blocking[0]!.state).toBe("expired");
    expect(expired.blockers[0]).toMatch(/expired 2026-01-01/);
  });

  it("keys the finding on the requirement's own code, not on its title", () => {
    // A code derived from label text changes the moment somebody edits the wording, and every
    // override, exception and report keyed to the old one silently stops matching.
    const before = trainingDispatchDecision([req()], [], NOW);
    const after = trainingDispatchDecision([req({ title: "Transportation of Dangerous Goods — certification" })], [], NOW);
    expect(after.blocking[0]!.code).toBe(before.blocking[0]!.code);
    expect(after.blocking[0]!.code).toBe("REG-TDG-V1");
    expect(after.blocking[0]!.detail).not.toBe(before.blocking[0]!.detail);   // the wording did change
  });

  it("still treats a requirement with no expiry as satisfied, not as expiry-unknown", () => {
    // The bridge's third point, already right here: a deliberately non-expiring qualification must
    // not raise a finding on every dispatch forever — a false positive that trains people to
    // override is worse than no check at all.
    const d = trainingDispatchDecision([req({ code: "REG-WHMIS-EMPLOYER-V1", qualificationCode: "WHMIS" })], [{ code: "WHMIS", status: "current" }], NOW);
    expect(d.status).toBe("ready");
    expect(d.satisfied).toEqual(["REG-WHMIS-EMPLOYER-V1"]);
  });

  it("keeps review findings separate from blocking ones, per requirement", () => {
    const d = trainingDispatchDecision([req({ code: "A" }), req({ code: "B", enforcement: "review" })], [], NOW);
    expect(d.blocking.map(b => b.code)).toEqual(["A"]);
    expect(d.reviewing.map(b => b.code)).toEqual(["B"]);
    expect(d.status).toBe("blocked");
  });
});
