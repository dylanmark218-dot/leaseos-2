import { describe, it, expect } from "vitest";
import {
  parseTopicCodes, normalizeTopicCodes, coverageFingerprint, reconcileCoverage,
  canStudyFromCoverage, canIssueCertificateFromCoverage, type CoverageRow,
} from "./_core/tdgTopicCoverage";
import type { Tdg62TopicCode } from "./_core/tdgCertificateContents";

const BASE = ["classification","shipping_names","schedules","documentation","marks",
  "containment","erap","reporting","safe_handling","equipment","emergency_measures"] as Tdg62TopicCode[];

function row(o: Partial<CoverageRow> = {}): CoverageRow {
  const declared = o.declaredTopicCodesJson ?? BASE;
  return {
    courseVersionRef: "CV-TDG-ROAD-2026.1",
    tdgMode: "road",
    declaredTopicCodesJson: declared,
    reviewStatus: "approved",
    reviewedHash: coverageFingerprint("road", BASE),
    moduleTopicCodesJson: [BASE],
    ...o,
  };
}

describe("canonical vocabulary", () => {
  it("accepts the s.6.2 codes", () => { expect(parseTopicCodes(BASE).ok).toBe(true); });
  it("parses a JSON string as stored", () => { expect(parseTopicCodes(JSON.stringify(BASE)).ok).toBe(true); });
  it("rejects a code outside the vocabulary", () => {
    const r = parseTopicCodes(["classification","freeform_topic"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not in the s.6.2 vocabulary");
  });
  it("rejects duplicates", () => {
    const r = parseTopicCodes(["marks","marks"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("duplicate");
  });
  it("rejects empty, non-array, malformed JSON and non-strings", () => {
    expect(parseTopicCodes([]).ok).toBe(false);
    expect(parseTopicCodes({}).ok).toBe(false);
    expect(parseTopicCodes("{not json").ok).toBe(false);
    expect(parseTopicCodes([1, 2]).ok).toBe(false);
  });
});

describe("approval fingerprint binds to the exact mapping", () => {
  it("is order-independent — reordering is not a change", () => {
    expect(coverageFingerprint("road", ["marks","classification"] as Tdg62TopicCode[]))
      .toBe(coverageFingerprint("road", ["classification","marks"] as Tdg62TopicCode[]));
  });
  it("changes when a topic is added or removed", () => {
    const a = coverageFingerprint("road", BASE);
    expect(coverageFingerprint("road", BASE.slice(0, -1))).not.toBe(a);
    expect(coverageFingerprint("road", [...BASE, "air"] as Tdg62TopicCode[])).not.toBe(a);
  });
  it("changes when the mode changes", () => {
    expect(coverageFingerprint("air", BASE)).not.toBe(coverageFingerprint("road", BASE));
  });
  it("normalizes by sorting and deduplicating", () => {
    expect(normalizeTopicCodes(["marks","classification","marks"] as Tdg62TopicCode[]))
      .toEqual(["classification","marks"]);
  });
});

describe("module union is the authored truth", () => {
  it("reconciles when declaration matches the module union", () => {
    expect(reconcileCoverage(row()).ok).toBe(true);
  });
  it("refuses a version claiming a topic no module teaches", () => {
    const r = reconcileCoverage(row({ declaredTopicCodesJson: [...BASE, "air"], moduleTopicCodesJson: [BASE] }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("TDG_TOPIC_COVERAGE_DIVERGENCE"); expect(r.message).toContain("no module teaches"); }
  });
  it("refuses a stale declaration missing a topic the modules teach", () => {
    const r = reconcileCoverage(row({ declaredTopicCodesJson: BASE.slice(0, 5), moduleTopicCodesJson: [BASE] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("not declared");
  });
  it("unions across several modules", () => {
    const r = reconcileCoverage(row({ moduleTopicCodesJson: [BASE.slice(0,5), BASE.slice(5)] }));
    expect(r.ok).toBe(true);
  });
  it("tolerates a module that teaches no TDG topic", () => {
    expect(reconcileCoverage(row({ moduleTopicCodesJson: [BASE, null] })).ok).toBe(true);
  });
  it("distinguishes unmapped from invalid", () => {
    const unmapped = reconcileCoverage(row({ declaredTopicCodesJson: null, reviewStatus: "unmapped" }));
    const invalid = reconcileCoverage(row({ declaredTopicCodesJson: ["nonsense"], reviewStatus: "draft" }));
    if (!unmapped.ok) expect(unmapped.code).toBe("TDG_TOPIC_COVERAGE_UNMAPPED");
    if (!invalid.ok) expect(invalid.code).toBe("TDG_TOPIC_COVERAGE_INVALID");
  });
});

describe("study and issuance are separate gates", () => {
  it("allows study from draft coverage", () => {
    expect(canStudyFromCoverage(row({ reviewStatus: "draft" }))).toBe(true);
  });
  it("does not allow study from unmapped coverage", () => {
    expect(canStudyFromCoverage(row({ declaredTopicCodesJson: null, reviewStatus: "unmapped" }))).toBe(false);
  });
  it("refuses issuance from draft coverage that study would allow", () => {
    const r = canIssueCertificateFromCoverage(row({ reviewStatus: "draft" }), "road");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TDG_TOPIC_COVERAGE_UNREVIEWED");
  });
});

describe("issuance gate", () => {
  it("issues from approved, reconciled, fingerprint-matching coverage", () => {
    const r = canIssueCertificateFromCoverage(row(), "road");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.topicCodes.length).toBe(11);
  });
  it("refuses when the mapping changed after approval", () => {
    // The whole reason approval binds to a fingerprint rather than a status.
    const edited = row({ declaredTopicCodesJson: BASE.slice(0, 10), moduleTopicCodesJson: [BASE.slice(0, 10)] });
    const r = canIssueCertificateFromCoverage(edited, "road");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("TDG_TOPIC_REVIEW_STALE"); expect(r.message).toContain("reviewed again"); }
  });
  it("refuses a mode the version is not mapped for", () => {
    const r = canIssueCertificateFromCoverage(row(), "air");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TDG_MODE_MISMATCH");
  });
  it("refuses when no mode is set at all", () => {
    const r = canIssueCertificateFromCoverage(row({ tdgMode: null }), "road");
    if (!r.ok) expect(r.code).toBe("TDG_MODE_UNSET");
  });
  it("refuses unmapped coverage before it reaches the review check", () => {
    const r = canIssueCertificateFromCoverage(row({ declaredTopicCodesJson: null, reviewStatus: "unmapped" }), "road");
    if (!r.ok) expect(r.code).toBe("TDG_TOPIC_COVERAGE_UNMAPPED");
  });
  it("gives every refusal its own code — no generic invalid", () => {
    const codes = new Set<string>();
    for (const r of [
      canIssueCertificateFromCoverage(row({ tdgMode: null }), "road"),
      canIssueCertificateFromCoverage(row(), "air"),
      canIssueCertificateFromCoverage(row({ declaredTopicCodesJson: null, reviewStatus: "unmapped" }), "road"),
      canIssueCertificateFromCoverage(row({ declaredTopicCodesJson: ["nope"], reviewStatus: "draft" }), "road"),
      canIssueCertificateFromCoverage(row({ declaredTopicCodesJson: [...BASE, "air"] }), "road"),
      canIssueCertificateFromCoverage(row({ reviewStatus: "in_review" }), "road"),
      canIssueCertificateFromCoverage(row({ reviewedHash: "0000000000000000" }), "road"),
    ]) if (!r.ok) codes.add(r.code);
    expect(codes.size).toBe(7);
  });
});
