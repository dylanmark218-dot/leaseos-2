import { describe, it, expect } from "vitest";
import {
  INSPECTOR_RESPONSE_DAYS, responseDeadline, assembleInspectorPackage,
  inspectorRequestSummary, type InspectorRequest, type AvailableEvidence,
} from "./_core/inspectorRequest";

const req = (o: Partial<InspectorRequest> = {}): InspectorRequest => ({
  requestRef: "INSP-2026-0031",
  requestDatedAt: new Date("2026-09-01T00:00:00Z"),
  requestReceivedAt: null,
  subjectUserId: 1,
  certificateRef: "CERT-1",
  ...o,
});
const ev = (o: Partial<AvailableEvidence> = {}): AvailableEvidence => ({
  certificatePresent: true, recordOfTrainingPresent: true, statementOfExperiencePresent: false,
  contentBlockCount: 12, courseVersionPresent: true, predatesRetentionGuards: false, ...o,
});

describe("the 15-day clock", () => {
  it("runs 15 days from the request date when receipt is unknown", () => {
    const d = responseDeadline(req(), new Date("2026-09-01T00:00:00Z"));
    expect(d.dueAt.toISOString().slice(0, 10)).toBe("2026-09-16");
    expect(d.daysRemaining).toBe(INSPECTOR_RESPONSE_DAYS);
    expect(d.anchoredOn).toBe("dated");
  });
  it("runs from receipt when that is later", () => {
    const d = responseDeadline(req({ requestReceivedAt: new Date("2026-09-04T00:00:00Z") }), new Date("2026-09-04T00:00:00Z"));
    expect(d.dueAt.toISOString().slice(0, 10)).toBe("2026-09-19");
    expect(d.anchoredOn).toBe("received");
  });
  it("does not let an earlier receipt date extend the window", () => {
    // Receipt before the request date is a data error; taking the later of the
    // two keeps the tighter deadline rather than quietly gaining days.
    const d = responseDeadline(req({ requestReceivedAt: new Date("2026-08-20T00:00:00Z") }), new Date("2026-09-01T00:00:00Z"));
    expect(d.dueAt.toISOString().slice(0, 10)).toBe("2026-09-16");
    expect(d.anchoredOn).toBe("dated");
  });
  it("crosses a month boundary correctly", () => {
    const d = responseDeadline(req({ requestDatedAt: new Date("2026-09-25T00:00:00Z") }), new Date("2026-09-25T00:00:00Z"));
    expect(d.dueAt.toISOString().slice(0, 10)).toBe("2026-10-10");
  });
  it("reports overdue rather than negative days left", () => {
    const d = responseDeadline(req(), new Date("2026-09-20T00:00:00Z"));
    expect(d.overdue).toBe(true);
    expect(d.urgent).toBe(true);
  });
  it("becomes urgent five days out, not before", () => {
    expect(responseDeadline(req(), new Date("2026-09-11T00:00:00Z")).urgent).toBe(true);
    expect(responseDeadline(req(), new Date("2026-09-10T00:00:00Z")).urgent).toBe(false);
  });
});

describe("package assembly", () => {
  it("is complete with certificate, record and material", () => {
    const p = assembleInspectorPackage(ev());
    expect(p.complete).toBe(true);
    expect(p.parts.length).toBe(3);
  });
  it("accepts a statement of experience in place of a training record", () => {
    const p = assembleInspectorPackage(ev({ recordOfTrainingPresent: false, statementOfExperiencePresent: true }));
    expect(p.complete).toBe(true);
  });
  it("refuses when neither the record nor the statement is on file", () => {
    const p = assembleInspectorPackage(ev({ recordOfTrainingPresent: false, statementOfExperiencePresent: false }));
    expect(p.complete).toBe(false);
    expect(p.missing[0]!.code).toBe("INSPECTOR_PACKAGE_NO_TRAINING_RECORD");
  });
  it("includes both when both exist", () => {
    expect(assembleInspectorPackage(ev({ statementOfExperiencePresent: true })).parts.length).toBe(4);
  });
  it("distinguishes a missing course version from empty content", () => {
    expect(assembleInspectorPackage(ev({ contentBlockCount: 0 })).missing[0]!.code).toBe("INSPECTOR_PACKAGE_NO_TRAINING_MATERIAL");
    expect(assembleInspectorPackage(ev({ courseVersionPresent: false })).missing[0]!.code).toBe("INSPECTOR_PACKAGE_NO_COURSE_VERSION");
  });
  it("has no alternative to the certificate itself", () => {
    const p = assembleInspectorPackage(ev({ certificatePresent: false }));
    expect(p.missing[0]!.message).toContain("no alternative");
  });
  // A partial package that looks whole is the failure this guards against.
  it("never reports complete while anything is missing", () => {
    for (const o of [{ certificatePresent: false }, { contentBlockCount: 0 }, { courseVersionPresent: false },
                     { recordOfTrainingPresent: false, statementOfExperiencePresent: false }]) {
      expect(assembleInspectorPackage(ev(o)).complete).toBe(false);
    }
  });
});

describe("evidence lost before the guards existed", () => {
  it("marks material loss on an old certificate as irrecoverable", () => {
    const p = assembleInspectorPackage(ev({ contentBlockCount: 0, predatesRetentionGuards: true }));
    expect(p.irrecoverable).toBe(true);
  });
  it("does not mark a recent certificate irrecoverable — that is a bug to chase", () => {
    expect(assembleInspectorPackage(ev({ contentBlockCount: 0, predatesRetentionGuards: false })).irrecoverable).toBe(false);
  });
  it("is not irrecoverable when only the training record is missing", () => {
    // A statement of experience can still be written; the material cannot be rebuilt.
    expect(assembleInspectorPackage(ev({ recordOfTrainingPresent: false, predatesRetentionGuards: true })).irrecoverable).toBe(false);
  });
});

describe("exception centre line", () => {
  it("names the deadline when ready", () => {
    const s = inspectorRequestSummary(req(), ev(), new Date("2026-09-10T00:00:00Z"));
    expect(s).toContain("package ready");
    expect(s).toContain("2026-09-16");
  });
  it("names the missing codes when not", () => {
    expect(inspectorRequestSummary(req(), ev({ contentBlockCount: 0 }), new Date("2026-09-10T00:00:00Z")))
      .toContain("INSPECTOR_PACKAGE_NO_TRAINING_MATERIAL");
  });
  it("says overdue by how much", () => {
    expect(inspectorRequestSummary(req(), ev(), new Date("2026-09-18T00:00:00Z"))).toContain("overdue by 2 days");
  });
  it("gets singular days right", () => {
    expect(inspectorRequestSummary(req(), ev(), new Date("2026-09-15T00:00:00Z"))).toContain("1 day left");
  });
});
