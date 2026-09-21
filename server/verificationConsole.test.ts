/**
 * 0092 — the two safety pieces behind the verification console.
 */
import { describe, expect, it } from "vitest";
import { OFFICIAL_DOMAINS, checkCitation, isOfficialHost } from "./_core/knowledge/citationGuard";
import {
  NEXT_ACTION, RULE_DISPLAY_STATES, RULE_STATE_TEXT, describe as describeState,
  displayStateOf, evaluationStateOf,
} from "./_core/knowledge/evaluationState";
import { validateEvidence, type PromotionEvidence } from "./_core/knowledge/promotionLedger";

const NOW = new Date("2026-09-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("no determination is not the same as undetermined", () => {
  it("reports an ambiguous schedule as no determination, with its candidates", () => {
    const s = evaluationStateOf(
      { outcome: "conflict", reasons: ["4 profiles apply equally to this operation — a person decides which governs"], candidates: ["A", "B", "C", "D"] },
      { verdict: "unknown", determinations: [], unknownCount: 0 });

    expect(s.kind).toBe("NO_DETERMINATION");
    if (s.kind !== "NO_DETERMINATION") return;
    expect(s.reason).toBe("AMBIGUOUS_PROFILE");
    // The exact state I misread in 0091 as "everything known".
    expect(s.candidates).toHaveLength(4);
  });

  it("reports a selected schedule with unverified figures as a determination of unknown", () => {
    const s = evaluationStateOf(
      { outcome: "selected" },
      { verdict: "unknown", unknownCount: 3,
        determinations: [
          { limitKey: "a", result: "within" }, { limitKey: "b", result: "unknown" },
          { limitKey: "c", result: "unknown" }, { limitKey: "d", result: "unknown" },
        ] });

    expect(s.kind).toBe("DETERMINATION");
    if (s.kind !== "DETERMINATION") return;
    expect(s.result).toBe("UNKNOWN");
    expect(s.determined).toBe(1);
    expect(s.undetermined).toBe(3);
  });

  it("gives the two a different next action", () => {
    const ambiguous = evaluationStateOf({ outcome: "conflict" }, { verdict: "unknown", determinations: [], unknownCount: 0 });
    const undetermined = evaluationStateOf({ outcome: "selected" },
      { verdict: "unknown", unknownCount: 1, determinations: [{ limitKey: "a", result: "unknown" }] });

    // One is fixed by choosing a schedule, the other by verifying figures.
    expect(describeState(ambiguous)).toContain("a person decides which governs");
    expect(describeState(undetermined)).toContain("verify them against the instrument");
    expect(describeState(ambiguous)).not.toBe(describeState(undetermined));
  });

  it("treats a selected schedule carrying no limits as no determination", () => {
    const s = evaluationStateOf({ outcome: "selected" }, { verdict: "unknown", determinations: [], unknownCount: 0 });
    expect(s.kind).toBe("NO_DETERMINATION");
  });

  it("never renders a bare unknown", () => {
    for (const outcome of ["conflict", "none", "insufficient_context"]) {
      const line = describeState(evaluationStateOf({ outcome }, { verdict: "unknown", determinations: [], unknownCount: 0 }));
      expect(line.length).toBeGreaterThan(20);
      expect(line.toLowerCase()).not.toBe("unknown");
    }
  });

  it("names every no-determination reason with an action", () => {
    for (const r of ["NO_APPLICABLE_PROFILE", "AMBIGUOUS_PROFILE", "MISSING_OPERATION_CONTEXT"] as const) {
      expect(NEXT_ACTION[r].length).toBeGreaterThan(20);
    }
  });
});

describe("the seven display states", () => {
  it("keeps all seven distinct, each stated in words", () => {
    expect(RULE_DISPLAY_STATES).toHaveLength(7);
    const texts = new Set(RULE_DISPLAY_STATES.map((s) => RULE_STATE_TEXT[s]));
    expect(texts.size).toBe(7);
  });

  it("separates corrected from superseded", () => {
    // Replaced because the rule changed, versus replaced because it was wrong.
    expect(displayStateOf({ status: "SUPERSEDED" }, false)).toBe("SUPERSEDED");
    expect(displayStateOf({ status: "SUPERSEDED" }, true)).toBe("CORRECTED");
    expect(RULE_STATE_TEXT.CORRECTED).toContain("corrected");
    expect(RULE_STATE_TEXT.SUPERSEDED).not.toContain("corrected");
  });

  it("shows a future rule as verified but not in force", () => {
    expect(displayStateOf({ status: "FUTURE" }, false)).toBe("FUTURE");
    expect(RULE_STATE_TEXT.FUTURE).toContain("not yet in force");
  });
});

describe("the citation guard", () => {
  const evidence = (o: Partial<PromotionEvidence> = {}): PromotionEvidence => ({
    profileKey: "P", limitKey: "daily_drive_minutes", value: 780, unit: "minutes",
    jurisdiction: "CA-FEDERAL", authorityType: "law",
    instrumentTitle: "Fixture instrument", issuingAuthority: "Fixture",
    sourceSection: "s. 1",
    citationUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
    verificationMethod: "OFFICIAL_WEB", verifiedByUserId: 7, verifiedAt: daysAgo(1), ...o,
  });

  it("accepts a publisher's own domain", () => {
    const r = checkCitation("https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/", "OFFICIAL_WEB");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched).toBe("laws-lois.justice.gc.ca");
  });

  it("refuses a summary site when the method claims the official publication", () => {
    const r = checkCitation("https://truckinglawblog.example.com/hos-summary", "OFFICIAL_WEB");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNRECOGNIZED_AUTHORITY_DOMAIN");
      expect(r.reason).toContain("do not point OFFICIAL_WEB at a summary");
    }
  });

  it("refuses a lookalike host", () => {
    // Suffix matching on a label boundary, so this cannot pass.
    expect(isOfficialHost("notjustice.gc.ca.attacker.example")).toBeNull();
    expect(isOfficialHost("laws-lois.justice.gc.ca")).toBe("laws-lois.justice.gc.ca");
    expect(isOfficialHost("qp.alberta.ca")).toBe("qp.alberta.ca");
  });

  it("allows the deliberate exceptions off-domain", () => {
    for (const method of ["REGULATOR_CONFIRMATION", "LEGAL_COUNSEL", "OFFICIAL_PRINT"] as const) {
      const r = checkCitation("https://mail.example.com/thread/8812", method);
      expect(r.ok, method).toBe(true);
      if (r.ok) expect(r.note).toContain("the verifier is the evidence");
    }
  });

  it("refuses a citation that is not a URL at all", () => {
    const r = checkCitation("see the binder in the office", "OFFICIAL_WEB");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MALFORMED_CITATION_URL");
  });

  it("does not claim the figure is correct", () => {
    const r = checkCitation("https://canada.ca/x", "OFFICIAL_WEB");
    expect(r.ok).toBe(true);
    // The guard's own words. A figure on an official page can still be wrong.
    if (r.ok) expect(r.note).toContain("does not establish that the figure is correct");
  });

  it("blocks promotion at validation, not only at the UI", () => {
    const r = validateEvidence(evidence({ citationUrl: "https://someblog.example.com/hos" }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNRECOGNIZED_AUTHORITY_DOMAIN");
  });

  it("lets a regulator confirmation through the same validation", () => {
    const r = validateEvidence(evidence({
      citationUrl: "https://mail.example.com/thread/8812", verificationMethod: "REGULATOR_CONFIRMATION",
    }), NOW);
    expect(r.ok).toBe(true);
  });

  it("registers official domains additively, not loosely", () => {
    // Short and explicit. A verifier meeting an unrecognised official source
    // gets it added rather than the guard relaxed.
    expect(OFFICIAL_DOMAINS.length).toBeLessThan(60);
    expect(OFFICIAL_DOMAINS).toContain("ecfr.gov");
    expect(OFFICIAL_DOMAINS).toContain("qp.alberta.ca");
  });
});
