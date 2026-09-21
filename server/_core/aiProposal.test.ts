import { describe, expect, it } from "vitest";
import {
  acknowledgeReadBack,
  answerField,
  buildProposal,
  checkCommit,
  commitProposal,
  detectGaps,
  detectOverreach,
  FORMS,
  generateReadBack,
  minimumQuestions,
  rejectProposal,
  setFieldStatus,
  type ExtractedValue,
} from "./aiProposal";

const NOW = new Date(Date.UTC(2026, 7, 31, 11, 0));
const UNLOAD = FORMS.unload_stop;
const TARGET = "TRIP-2026-004821 unload stop";

/** What the model returns for: "got to the pit around ten, waited about eight
 *  minutes for the scale, started quarter after, finished about twenty to." */
const SPOKEN: ExtractedValue[] = [
  {
    key: "arrivedAt",
    value: "10:00",
    source: "driver_voice",
    confidence: "medium",
    sourceUtterance: "around ten",
  },
  {
    key: "waitMinutes",
    value: 8,
    source: "driver_voice",
    confidence: "high",
    sourceUtterance: "about eight minutes",
  },
  {
    key: "delayReason",
    value: "Scale delay",
    source: "system_inferred",
    confidence: "medium",
    sourceUtterance: "waiting for the scale",
  },
  {
    key: "operationStartedAt",
    value: "10:15",
    precision: "exact",
    source: "driver_voice",
    confidence: "high",
    sourceUtterance: "quarter after",
  },
  {
    key: "operationCompletedAt",
    value: "10:40",
    source: "driver_voice",
    confidence: "medium",
    sourceUtterance: "about twenty to",
  },
];

const full = () => {
  let p = buildProposal(UNLOAD, TARGET, SPOKEN);
  p = answerField(p, UNLOAD, "arrivedAt", "10:00", "approximate");
  p = answerField(p, UNLOAD, "waitMinutes", 8, "exact");
  p = answerField(p, UNLOAD, "operationCompletedAt", "10:40", "exact");
  p = answerField(p, UNLOAD, "quantity", 8000, "exact");
  p = answerField(p, UNLOAD, "measurementMethod", "Meter");
  return p;
};

describe("precision is never silently upgraded", () => {
  it("marks a voice value approximate unless told otherwise", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    expect(p.fields.find(f => f.key === "arrivedAt")?.precision).toBe(
      "approximate"
    );
  });

  it("keeps 'around ten' as 10:00 flagged approximate, not 10:00:00 exact", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    const arrived = p.fields.find(f => f.key === "arrivedAt")!;
    expect(arrived.value).toBe("10:00");
    expect(arrived.precision).toBe("approximate");
    expect(arrived.sourceUtterance).toBe("around ten");
  });

  it("honours an explicit exact precision from extraction", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    expect(p.fields.find(f => f.key === "operationStartedAt")?.precision).toBe(
      "exact"
    );
  });

  it("raises a precision question for an approximate billing-relevant value", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    const gap = p.gaps.find(g => g.key === "operationCompletedAt");
    expect(gap?.kind).toBe("precision_unresolved");
    expect(gap?.question).toContain("about twenty to");
  });

  it("raises a precision question for wait time because it can become billable time", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    const gap = p.gaps.find(g => g.key === "waitMinutes");
    expect(gap?.kind).toBe("precision_unresolved");
    expect(gap?.question).toContain("about eight minutes");
  });
});

describe("proposal identity", () => {
  it("does not collapse different captured values onto the same fallback id", () => {
    const a = buildProposal(FORMS.defect_report, "VAC-27", [
      { key: "observation", value: "noise A", source: "driver_typed", confidence: "high" },
    ]);
    const b = buildProposal(FORMS.defect_report, "VAC-27", [
      { key: "observation", value: "noise B", source: "driver_typed", confidence: "high" },
    ]);
    expect(a.proposalId).not.toBe(b.proposalId);
    expect(buildProposal(UNLOAD, TARGET, [], "P-capture-id").proposalId).toBe("P-capture-id");
  });
});

describe("schema constrains extraction", () => {
  it("drops values the model produced outside the form", () => {
    const p = buildProposal(UNLOAD, TARGET, [
      ...SPOKEN,
      {
        key: "driverMood",
        value: "tired",
        source: "driver_voice",
        confidence: "low",
      },
    ]);
    expect(p.fields.find(f => f.key === "driverMood")).toBeUndefined();
  });
});

describe("gap detection and minimum questions", () => {
  it("finds required fields that were never mentioned", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    const keys = p.gaps
      .filter(g => g.kind === "missing_required")
      .map(g => g.key);
    expect(keys).toEqual(
      expect.arrayContaining(["quantity", "measurementMethod"])
    );
  });

  it("asks required questions before precision questions", () => {
    const gaps = detectGaps(
      UNLOAD,
      buildProposal(UNLOAD, TARGET, SPOKEN).fields
    );
    const qs = minimumQuestions(gaps, 10);
    const firstPrecision = gaps.findIndex(
      g => g.kind === "precision_unresolved"
    );
    expect(qs.length).toBeGreaterThan(0);
    expect(firstPrecision).toBeGreaterThanOrEqual(0);
    expect(qs[0]).toContain("How much");
  });

  it("caps the questions asked at once", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    expect(p.questions.length).toBeLessThanOrEqual(3);
  });

  it("clears a gap once the field is answered", () => {
    let p = buildProposal(UNLOAD, TARGET, SPOKEN);
    expect(p.gaps.some(g => g.key === "quantity")).toBe(true);
    p = answerField(p, UNLOAD, "quantity", 8000, "exact");
    expect(p.gaps.some(g => g.key === "quantity")).toBe(false);
  });

  it("records what a corrected value used to be", () => {
    let p = buildProposal(UNLOAD, TARGET, SPOKEN);
    p = answerField(p, UNLOAD, "operationCompletedAt", "10:37", "exact");
    const f = p.fields.find(x => x.key === "operationCompletedAt")!;
    expect(f.correctedFrom).toBe("10:40");
    expect(f.source).toBe("human_corrected");
    expect(f.status).toBe("corrected");
  });

  it("treats a rejected required field as missing again", () => {
    let p = full();
    p = setFieldStatus(p, UNLOAD, "quantity", "rejected");
    expect(
      p.gaps.some(g => g.key === "quantity" && g.kind === "missing_required")
    ).toBe(true);
  });
});

describe("read-back", () => {
  it("speaks approximations as approximations", () => {
    let p = full();
    p = generateReadBack(p);
    expect(p.readBack).toContain("arrived about 10:00");
    expect(p.readBack).toContain("unloading complete 10:40");
    expect(p.readBack).toContain("Is that right?");
  });

  it("names the record it would change", () => {
    const p = generateReadBack(full());
    expect(p.readBack).toContain("TRIP-2026-004821 unload stop");
  });

  it("is invalidated by any later edit", () => {
    let p = generateReadBack(full());
    p = acknowledgeReadBack(p);
    expect(p.readBackAcknowledged).toBe(true);
    p = answerField(p, UNLOAD, "waitMinutes", 12);
    expect(p.readBack).toBeNull();
    expect(p.readBackAcknowledged).toBe(false);
  });

  it("will not acknowledge a read-back that was never generated", () => {
    const p = acknowledgeReadBack(full());
    expect(p.readBackAcknowledged).toBe(false);
  });
});

describe("commit gate", () => {
  it("refuses while a required field is missing", () => {
    const c = checkCommit(buildProposal(UNLOAD, TARGET, SPOKEN), UNLOAD);
    expect(c.canCommit).toBe(false);
    expect(c.refusals.join(" ")).toContain("Quantity is required");
  });

  it("refuses while a precision-sensitive value is still approximate", () => {
    const p = buildProposal(UNLOAD, TARGET, SPOKEN);
    expect(checkCommit(p, UNLOAD).refusals.join(" ")).toContain(
      "still marked approximate"
    );
  });

  it("refuses before the read-back has been generated", () => {
    const c = checkCommit(full(), UNLOAD);
    expect(c.canCommit).toBe(false);
    expect(c.refusals).toContain("Read-back has not been generated");
  });

  it("refuses when the read-back was generated but not confirmed", () => {
    const c = checkCommit(generateReadBack(full()), UNLOAD);
    expect(c.canCommit).toBe(false);
    expect(c.refusals).toContain("Read-back has not been confirmed");
  });

  it("permits commit once everything is answered and confirmed", () => {
    const p = acknowledgeReadBack(generateReadBack(full()));
    expect(checkCommit(p, UNLOAD).canCommit).toBe(true);
  });

  it("names every refusal rather than reporting a count", () => {
    const c = checkCommit(buildProposal(UNLOAD, TARGET, SPOKEN), UNLOAD);
    expect(c.refusals.length).toBeGreaterThan(2);
    expect(c.refusals.every(r => r.length > 10)).toBe(true);
  });
});

describe("commitProposal", () => {
  it("carries provenance onto every committed field", () => {
    const p = acknowledgeReadBack(generateReadBack(full()));
    const r = commitProposal(p, UNLOAD, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const arrived = r.fields.find(f => f.key === "arrivedAt")!;
      expect(arrived.precision).toBe("approximate");
      expect(arrived.committedAt).toEqual(NOW);
      expect(r.fields.every(f => f.source && f.confidence)).toBe(true);
    }
  });

  it("never writes a rejected field to the record", () => {
    let p = full();
    p = setFieldStatus(p, UNLOAD, "delayReason", "rejected");
    p = acknowledgeReadBack(generateReadBack(p));
    const r = commitProposal(p, UNLOAD, NOW);
    if (r.ok)
      expect(r.fields.find(f => f.key === "delayReason")).toBeUndefined();
  });

  it("refuses to commit an unconfirmed proposal", () => {
    const r = commitProposal(full(), UNLOAD, NOW);
    expect(r.ok).toBe(false);
  });

  it("refuses to commit a rejected proposal", () => {
    const p = rejectProposal(acknowledgeReadBack(generateReadBack(full())));
    const r = commitProposal(p, UNLOAD, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toContain("Proposal was rejected");
  });
});

describe("defect reports record observations, not diagnoses", () => {
  it("keeps the driver's own words in a required field", () => {
    const p = buildProposal(FORMS.defect_report, "VAC-27", [
      {
        key: "unitNumber",
        value: "VAC-27",
        source: "system_inferred",
        confidence: "high",
      },
      {
        key: "system",
        value: "Pump / PTO",
        source: "system_inferred",
        confidence: "medium",
      },
      {
        key: "observation",
        value: "Grinding when I first started it",
        source: "driver_voice",
        confidence: "high",
        sourceUtterance: "grinding when I first started it",
      },
      {
        key: "isNew",
        value: false,
        source: "driver_voice",
        confidence: "high",
      },
    ]);
    expect(p.gaps).toEqual([]);
    expect(p.fields.find(f => f.key === "observation")?.value).toBe(
      "Grinding when I first started it"
    );
  });

  it("has no field in which a cause could be recorded", () => {
    const keys = FORMS.defect_report.fields.map(f => f.key);
    expect(keys).not.toContain("diagnosis");
    expect(keys).not.toContain("cause");
    expect(keys).toContain("observation");
  });
});

describe("detectOverreach", () => {
  it("flags the assistant asserting a safety or legal conclusion", () => {
    expect(detectOverreach("The unit is safe to dispatch").overreaches).toBe(
      true
    );
    expect(
      detectOverreach("You may legally depart on this route").overreaches
    ).toBe(true);
    expect(detectOverreach("This load is compliant").overreaches).toBe(true);
  });

  it("flags the assistant diagnosing a fault", () => {
    expect(detectOverreach("The problem is a worn bearing").overreaches).toBe(
      true
    );
    expect(
      detectOverreach("My diagnosis is a seized caliper").overreaches
    ).toBe(true);
  });

  it("allows recording and proposing", () => {
    expect(
      detectOverreach("I've recorded a grinding noise on start-up").overreaches
    ).toBe(false);
    expect(
      detectOverreach("I can add 8 minutes waiting — scale delay. Confirm?")
        .overreaches
    ).toBe(false);
    expect(
      detectOverreach("Two items still need your confirmation").overreaches
    ).toBe(false);
  });
});
