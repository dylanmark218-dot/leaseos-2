import { describe, expect, it } from "vitest";
import {
  bindingApplies, bindingProblem, requirementFromBinding,
  consolidateRequirements, credentialHistory, credentialType, dispatchView, evaluateDriverReadiness, expiryAlerts, expiryWarningTier,
  licenceClassCovers, orientationCode, shareLifetimeHours, sharedCredentialView, walletHeadlineAt, walletView, SHARE_MAX_HOURS,
  type DriverPortfolio, type DriverRequirement, type PortfolioCredential, type RequirementBinding,
} from "./driverPortfolio";

const NOW = new Date("2026-09-23T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

let nextId = 1;
const cred = (docType: string, over: Partial<PortfolioCredential> = {}): PortfolioCredential => ({
  id: nextId++, docType, title: docType, issuedAt: days(-400), expiresAt: days(365),
  verificationStatus: "verified", capturedAt: days(-400), identifier: `CERT-${nextId}`, verifiedAt: days(-399), ...over,
});

const portfolio = (credentials: PortfolioCredential[], over: Partial<DriverPortfolio> = {}): DriverPortfolio => ({
  operatorId: 7, name: "Dylan Hutchings", licenceClass: "1", credentials, equipment: [], ...over,
});

const must = (code: string, over: Partial<DriverRequirement> = {}): DriverRequirement =>
  ({ kind: "credential", code, enforcement: "mandatory", source: "company", sourceRef: "company", ...over });
const nice = (code: string, over: Partial<DriverRequirement> = {}): DriverRequirement => must(code, { enforcement: "informational", ...over });

describe("the catalogue", () => {
  it("knows the field tickets, accepts their aliases, and does not carry medical fitness", () => {
    expect(credentialType("H2S Alive")?.code).toBe("h2s_alive");
    expect(credentialType("first-aid-cpr")?.docTypes).toContain("first_aid");
    expect(credentialType("medical_fitness")).toBeNull();
    expect(credentialType("underwater_basket_weaving")).toBeNull();
  });

  it("names client and site orientations by shape, not by list", () => {
    const code = orientationCode("client", "Cenovus Energy");
    expect(code).toBe("orientation:client:cenovus_energy");
    expect(credentialType(code)).toMatchObject({ category: "orientation", docTypes: [code] });
    expect(credentialType("orientation:vendor:x")).toBeNull();
  });
});

describe("mandatory and informational", () => {
  it("blocks on an expired mandatory ticket, with no override, and names the date and the source", () => {
    const r = evaluateDriverReadiness({
      portfolio: portfolio([cred("h2s_alive", { expiresAt: new Date("2026-09-18T00:00:00Z") })]),
      requirements: [must("h2s_alive", { source: "customer", sourceRef: "Client ABC" })], at: NOW,
    });
    expect(r.verdict).toBe("blocked");
    expect(r.blockers).toHaveLength(1);
    expect(r.blockers[0]).toMatchObject({ code: "driver_credential_h2s_alive_expired", severity: "blocking", overridable: false, subject: "operator" });
    expect(r.blockers[0]!.label).toMatch(/expired 2026-09-18.*Client ABC/);
    expect(r.items[0]!.action).toMatch(/assign another qualified operator/);
  });

  it("never lets a missing informational certificate stop the truck", () => {
    const r = evaluateDriverReadiness({ portfolio: portfolio([]), requirements: [nice("confined_space")], at: NOW });
    expect(r.verdict).toBe("ready");
    expect(r.blockers).toEqual([]);
    expect(r.notices.map(n => n.state)).toEqual(["missing"]);
  });

  it("the strictest binding wins when two ask for the same ticket, and both are named", () => {
    const merged = consolidateRequirements([nice("H2S Alive", { sourceRef: "company" }), must("h2s_alive", { sourceRef: "Cenovus" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ enforcement: "mandatory", sources: ["company", "Cenovus"] });
  });
});

describe("unknown is never satisfied", () => {
  it("an unverified upload is unknown, overridable by a manager, not ready", () => {
    const r = evaluateDriverReadiness({ portfolio: portfolio([cred("first_aid", { verificationStatus: "needs_review" })]), requirements: [must("first_aid_cpr")], at: NOW });
    expect(r.verdict).toBe("unknown");
    expect(r.blockers[0]).toMatchObject({ severity: "unknown", overridable: true, overrideAuthority: "manager" });
  });

  it("a verified ticket with no expiry is unknown when the ticket type lapses, and fine when it does not", () => {
    const h2s = evaluateDriverReadiness({ portfolio: portfolio([cred("h2s_alive", { expiresAt: null })]), requirements: [must("h2s_alive")], at: NOW });
    expect(h2s.items[0]!.state).toBe("no_expiry_recorded");
    expect(h2s.verdict).toBe("unknown");
    const air = evaluateDriverReadiness({ portfolio: portfolio([cred("air_brake_endorsement", { expiresAt: null })]), requirements: [must("air_brake_endorsement")], at: NOW });
    expect(air.verdict).toBe("ready");
  });

  it("a rejected ticket blocks, and a requirement the catalogue cannot name is unknown", () => {
    const r = evaluateDriverReadiness({ portfolio: portfolio([cred("whmis", { verificationStatus: "rejected" })]), requirements: [must("whmis"), must("mystery_ticket")], at: NOW });
    expect(r.items.map(i => i.state)).toEqual(["rejected", "unknown_requirement"]);
    expect(r.verdict).toBe("blocked");
  });
});

describe("renewals and the length of the job", () => {
  it("a verified renewal replaces the lapsed ticket; an unverified one does not, but is named", () => {
    const old = cred("h2s_alive", { expiresAt: days(-5), capturedAt: days(-1000) });
    const pending = cred("h2s_alive", { verificationStatus: "needs_review", expiresAt: days(1090), capturedAt: days(-1) });
    const r1 = evaluateDriverReadiness({ portfolio: portfolio([old, pending]), requirements: [must("h2s_alive")], at: NOW });
    expect(r1.items[0]).toMatchObject({ state: "expired", pendingRenewal: true });
    expect(r1.items[0]!.detail).toMatch(/awaiting verification/);
    expect(r1.items[0]!.action).toMatch(/verify the renewal/);

    const renewed = { ...pending, verificationStatus: "verified" as const };
    const r2 = evaluateDriverReadiness({ portfolio: portfolio([old, renewed]), requirements: [must("h2s_alive")], at: NOW });
    expect(r2.verdict).toBe("ready");
    expect(r2.items[0]!.credentialId).toBe(renewed.id);
  });

  it("a ticket that lapses before the work ends does not cover the work", () => {
    const r = evaluateDriverReadiness({ portfolio: portfolio([cred("tdg_certificate", { expiresAt: days(3) })]), requirements: [must("tdg_certificate")], at: NOW, validThrough: days(10) });
    expect(r.items[0]!.state).toBe("expires_during_job");
    expect(r.blockers[0]).toMatchObject({ severity: "blocking", overridable: false });
  });

  it("warns at 90, 60, 30, 14 and 7 days, without blocking", () => {
    expect([120, 90, 61, 45, 30, 14, 8, 7, 0, -1].map(expiryWarningTier)).toEqual([null, 90, 90, 60, 30, 14, 14, 7, 7, "expired"]);
    const r = evaluateDriverReadiness({ portfolio: portfolio([cred("first_aid_cpr", { expiresAt: days(12) })]), requirements: [must("first_aid_cpr")], at: NOW });
    expect(r.verdict).toBe("ready");
    expect(r.items[0]).toMatchObject({ satisfied: true, warningTier: 14 });
    expect(r.items[0]!.action).toMatch(/^Renew First Aid/);
  });
});

describe("licence class and equipment", () => {
  it("reads the class hierarchy and never guesses an unknown class", () => {
    expect(licenceClassCovers("Class 1", "3")).toBe(true);
    expect(licenceClassCovers("3", "1")).toBe(false);
    expect(licenceClassCovers("4", "3")).toBe(false);
    expect(licenceClassCovers("CDL-A", "1")).toBe(false);
    const r = evaluateDriverReadiness({ portfolio: portfolio([], { licenceClass: null }), requirements: [{ kind: "licence_class", code: "1", enforcement: "mandatory", source: "job_type", sourceRef: "vac" }], at: NOW });
    expect(r.items[0]!.state).toBe("class_unknown");
    expect(r.verdict).toBe("unknown");
  });

  it("qualified, training required, suspended and not authorized are four different answers", () => {
    const equipment = [
      { equipmentType: "Tri-drive vac truck", status: "authorized" as const, expiresAt: null, authorizedAt: days(-100) },
      { equipmentType: "pressure_truck", status: "pending" as const, expiresAt: null, authorizedAt: null },
      { equipmentType: "hydrovac", status: "suspended" as const, expiresAt: null, authorizedAt: days(-50) },
      { equipmentType: "water_truck", status: "authorized" as const, expiresAt: days(-2), authorizedAt: days(-400) },
    ];
    const eq = (code: string): DriverRequirement => ({ kind: "equipment", code, enforcement: "mandatory", source: "equipment", sourceRef: code });
    const r = evaluateDriverReadiness({ portfolio: portfolio([], { equipment }), requirements: ["tri_drive_vac_truck", "pressure_truck", "hydrovac", "water_truck", "loader"].map(eq), at: NOW });
    expect(r.items.map(i => i.state)).toEqual(["satisfied", "training_required", "suspended", "expired", "not_authorized"]);
    expect(r.blockers.every(b => b.severity === "blocking" && !b.overridable)).toBe(true);
    expect(r.blockers).toHaveLength(4);
  });
});

describe("the wallet", () => {
  const baseline = [must("driver_licence"), must("h2s_alive"), must("company_orientation"), nice("defensive_driving")];

  it("says READY FOR WORK, and stops saying it when the first required ticket lapses", () => {
    const creds = [cred("driver_licence", { expiresAt: days(500) }), cred("h2s_alive", { expiresAt: days(5) }), cred("company_orientation", { expiresAt: null })];
    const w = walletView({ portfolio: portfolio(creds), baseline, at: NOW, offlineHours: 24 * 30 });
    expect(w.headline).toBe("READY FOR WORK");
    expect(w.validUntil.toISOString()).toBe(days(5).toISOString());
    expect(walletHeadlineAt(w, days(4))).toBe("READY FOR WORK");
    expect(walletHeadlineAt(w, days(5))).toBe("STALE");
    expect(w.freshness).toMatchObject({ limitedBy: "credential_expiry", limitingCredential: { code: "h2s_alive" } });
  });

  it("is bounded by the offline allowance even when nothing is lapsing", () => {
    const creds = [cred("driver_licence"), cred("h2s_alive"), cred("company_orientation")];
    const w = walletView({ portfolio: portfolio(creds), baseline, at: NOW });
    expect(w.validUntil.getTime() - NOW.getTime()).toBe(24 * 3_600_000);
  });

  it("shows missing required cards first, and tickets nobody required as optional; medical never appears", () => {
    const creds = [cred("driver_licence"), cred("company_orientation"), cred("fall_protection"), cred("medical_fitness", { privateDetail: true })];
    const w = walletView({ portfolio: portfolio(creds, { equipment: [{ equipmentType: "hydrovac", status: "authorized", expiresAt: null, authorizedAt: days(-3) }] }), baseline, at: NOW });
    expect(w.headline).toBe("NOT READY");
    expect(w.cards[0]).toMatchObject({ code: "h2s_alive", state: "missing", required: "mandatory" });
    expect(w.cards.find(c => c.code === "fall_protection")).toMatchObject({ required: "optional", satisfied: true });
    expect(w.cards.find(c => c.code === "hydrovac")).toMatchObject({ category: "equipment", satisfied: true });
    expect(w.cards.some(c => c.code.includes("medical"))).toBe(false);
    // A missing informational card does not change the headline.
    expect(w.cards.find(c => c.code === "defensive_driving")).toMatchObject({ required: "informational", satisfied: false });
  });

  it("an unverified required ticket is ACTION REQUIRED, not ready and not blocked", () => {
    const creds = [cred("driver_licence"), cred("h2s_alive", { verificationStatus: "needs_review" }), cred("company_orientation")];
    const w = walletView({ portfolio: portfolio(creds), baseline, at: NOW });
    expect(w.headline).toBe("ACTION REQUIRED");
    expect(w.cards[0]).toMatchObject({ code: "h2s_alive", verification: "awaiting_verification" });
  });
});

describe("the dispatch view", () => {
  it("is ticks and crosses with reasons, and carries no certificate number", () => {
    const r = evaluateDriverReadiness({
      portfolio: portfolio([cred("h2s_alive", { identifier: "H2S-99812" }), cred("first_aid_cpr", { identifier: "FA-1" })]),
      requirements: [must("h2s_alive"), must("first_aid_cpr"), must(orientationCode("client", "Client ABC"), { label: "Client ABC H2S Orientation" })], at: NOW,
    });
    const v = dispatchView(r);
    expect(v.verdict).toBe("blocked");
    expect(v.lines.map(l => [l.label, l.ok])).toEqual([["H2S Alive", true], ["First Aid / CPR", true], ["Client ABC H2S Orientation", false]]);
    expect(JSON.stringify(v)).not.toMatch(/H2S-99812|FA-1|CERT-/);
  });
});

describe("the expiry dashboard and the history", () => {
  it("lists what is lapsing across the fleet, soonest first, and not what was already renewed", () => {
    const a = portfolio([cred("h2s_alive", { expiresAt: days(20) }), cred("whmis", { expiresAt: days(200) })], { operatorId: 1, name: "A" });
    const b = portfolio([
      cred("first_aid_cpr", { expiresAt: days(-10), capturedAt: days(-900) }),
      cred("first_aid_cpr", { expiresAt: days(1000), capturedAt: days(-5) }),
      cred("tdg_certificate", { expiresAt: days(-3) }),
    ], { operatorId: 2, name: "B" });
    const alerts = expiryAlerts([a, b], NOW);
    expect(alerts.map(x => [x.name, x.code, x.tier])).toEqual([["B", "tdg_certificate", "expired"], ["A", "h2s_alive", 30]]);
  });

  it("keeps every certificate: the current one, and the rest with the reason each is no longer current", () => {
    const first = cred("h2s_alive", { expiresAt: days(-400), capturedAt: days(-1500) });
    const second = cred("h2s_alive", { expiresAt: days(600), capturedAt: days(-500) });
    const bad = cred("h2s_certificate", { verificationStatus: "rejected", capturedAt: days(-20) });
    const h = credentialHistory([first, second, bad], "h2s_alive", NOW);
    expect(h.current?.id).toBe(second.id);
    expect(h.history.map(x => [x.credential.id, x.reason])).toEqual([[bad.id, "rejected"], [first.id, "expired"]]);
    expect(h.history[0]!.credential.docType).toBe("h2s_certificate");
  });
});

describe("sharing one credential", () => {
  it("lasts a day by default and never more than seven", () => {
    expect(shareLifetimeHours(undefined)).toBe(24);
    expect(shareLifetimeHours(2)).toBe(2);
    expect(shareLifetimeHours(SHARE_MAX_HOURS)).toBe(168);
    expect(() => shareLifetimeHours(169)).toThrow(/at most 168/);
    expect(() => shareLifetimeHours(0)).toThrow(RangeError);
  });

  it("is evaluated when redeemed, not frozen when issued", () => {
    const c = cred("h2s_alive", { expiresAt: days(2) });
    expect(sharedCredentialView({ credentialId: c.id, code: "h2s_alive", holderName: "Dylan Hutchings", credentials: [c], at: NOW })).toMatchObject({ label: "H2S Alive", valid: true, identifier: c.identifier });
    expect(sharedCredentialView({ credentialId: c.id, code: "h2s_alive", holderName: "D", credentials: [c], at: days(3) })).toMatchObject({ valid: false, state: "expired" });
    const rejected = { ...c, verificationStatus: "rejected" as const };
    expect(sharedCredentialView({ credentialId: c.id, code: "h2s_alive", holderName: "D", credentials: [rejected], at: NOW })).toMatchObject({ valid: false, state: "rejected" });
  });

  it("stops representing a credential once a verified renewal has replaced it", () => {
    const old = cred("h2s_alive", { expiresAt: days(30), capturedAt: days(-900) });
    const renewal = cred("h2s_alive", { expiresAt: days(1000), capturedAt: days(-1) });
    expect(sharedCredentialView({ credentialId: old.id, code: "h2s_alive", holderName: "D", credentials: [old], at: NOW })?.valid).toBe(true);
    expect(sharedCredentialView({ credentialId: old.id, code: "h2s_alive", holderName: "D", credentials: [old, renewal], at: NOW })).toMatchObject({ state: "superseded", valid: false });
  });

  it("never shows a private credential, another type's row, or anything outside the catalogue", () => {
    const c = cred("h2s_alive");
    expect(sharedCredentialView({ credentialId: c.id, code: "h2s_alive", holderName: "D", credentials: [{ ...c, privateDetail: true }], at: NOW })).toBeNull();
    const other = cred("whmis");
    expect(sharedCredentialView({ credentialId: other.id, code: "h2s_alive", holderName: "D", credentials: [other], at: NOW })).toBeNull();
    const medical = cred("medical_fitness");
    expect(sharedCredentialView({ credentialId: medical.id, code: "medical_fitness", holderName: "D", credentials: [medical], at: NOW })).toBeNull();
  });
});

describe("requirement bindings", () => {
  const binding = (over: Partial<RequirementBinding> = {}): RequirementBinding => ({
    bindingRef: "DRB-1", orgRef: null, subjectType: "customer", subjectCode: "Cenovus", requirementKind: "credential", requirementCode: "h2s_alive",
    label: null, enforcement: "mandatory", active: true, effectiveAt: null, expiresAt: null, ...over,
  });
  const facts = { orgRef: null, customer: ["cenovus"], site: ["Christina Lake"], job_type: ["vac service", "hydrovac"], equipment: ["tri-drive vac"], job: ["26-10428"] };

  it("matches the job's own facts, whole, and a company binding matches everything", () => {
    expect(bindingApplies(binding(), facts, NOW)).toBe(true);
    expect(bindingApplies(binding({ subjectType: "site", subjectCode: "christina lake" }), facts, NOW)).toBe(true);
    expect(bindingApplies(binding({ subjectType: "site", subjectCode: "Christina" }), facts, NOW)).toBe(false);
    expect(bindingApplies(binding({ subjectType: "equipment", subjectCode: "Tri Drive Vac" }), facts, NOW)).toBe(true);
    expect(bindingApplies(binding({ subjectType: "company", subjectCode: "*" }), { orgRef: null, customer: [], site: [], job_type: [], equipment: [], job: [] }, NOW)).toBe(true);
  });

  it("belongs to one organization: another's work, or the single tenant's, is not bound by it", () => {
    expect(bindingApplies(binding({ orgRef: "ORG-A" }), { ...facts, orgRef: "ORG-A" }, NOW)).toBe(true);
    expect(bindingApplies(binding({ orgRef: "ORG-A" }), { ...facts, orgRef: "ORG-B" }, NOW)).toBe(false);
    expect(bindingApplies(binding({ orgRef: "ORG-A" }), facts, NOW)).toBe(false);
    expect(bindingApplies(binding({ orgRef: null, subjectType: "company", subjectCode: "*" }), { ...facts, orgRef: "ORG-A" }, NOW)).toBe(false);
  });

  it("does not apply when retired, not yet effective, or expired", () => {
    expect(bindingApplies(binding({ active: false }), facts, NOW)).toBe(false);
    expect(bindingApplies(binding({ effectiveAt: days(1) }), facts, NOW)).toBe(false);
    expect(bindingApplies(binding({ expiresAt: NOW }), facts, NOW)).toBe(false);
  });

  it("carries its source into the requirement, so the blocker can say who asked", () => {
    expect(requirementFromBinding(binding({ subjectType: "job_type", subjectCode: "hydrovac" }))).toMatchObject({ source: "job_type", sourceRef: "job type hydrovac" });
    expect(requirementFromBinding(binding({ subjectType: "company", subjectCode: "*" })).sourceRef).toBe("company");
  });

  it("refuses a binding that could only ever evaluate as unknown", () => {
    expect(bindingProblem(binding())).toBeNull();
    expect(bindingProblem(binding({ requirementCode: orientationCode("site", "Christina Lake") }))).toBeNull();
    expect(bindingProblem(binding({ requirementCode: "mystery" }))).toMatch(/not a known credential/);
    expect(bindingProblem(binding({ subjectType: "company", subjectCode: "Cenovus" }))).toMatch(/subject code is \*/);
    expect(bindingProblem(binding({ requirementKind: "licence_class", requirementCode: "Class 1" }))).toBeNull();
    expect(bindingProblem(binding({ requirementKind: "licence_class", requirementCode: "A" }))).toMatch(/1 to 6/);
  });
});

describe("the offline freshness rule the phone shares", () => {
  it("never lets a cached READY outlive validUntil, and never softens NOT READY", async () => {
    const { walletStatusAt } = await import("../../shared/driverWallet");
    const until = days(1);
    expect(walletStatusAt({ headline: "READY FOR WORK", validUntil: until }, NOW)).toBe("READY FOR WORK");
    expect(walletStatusAt({ headline: "READY FOR WORK", validUntil: until }, until)).toBe("STALE");
    expect(walletStatusAt({ headline: "READY FOR WORK", validUntil: until.toISOString() }, days(2))).toBe("STALE");
    expect(walletStatusAt({ headline: "ACTION REQUIRED", validUntil: until }, days(2))).toBe("STALE");
    expect(walletStatusAt({ headline: "NOT READY", validUntil: until }, days(2))).toBe("NOT READY");
    expect(walletStatusAt({ headline: "READY FOR WORK", validUntil: "not a date" }, NOW)).toBe("STALE");
  });
});

describe("the expiry dashboard names unverified uploads that are themselves lapsing", () => {
  it("reports verification state and the row", () => {
    const p = portfolio([cred("whmis", { verificationStatus: "needs_review", expiresAt: days(10) })]);
    const [a] = expiryAlerts([p], NOW);
    expect(a).toMatchObject({ code: "whmis", verification: "unverified", tier: 14 });
  });
});
