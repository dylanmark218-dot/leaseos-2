/**
 * v22.20 — time off, and what dispatch is not told.
 */
import { describe, expect, it } from "vitest";
import {
  briefForApprover, disclose, isAbsent, onApprovedLeave, partialAbsences,
  recordCallOff, schedulingView, SENSITIVE_CATEGORIES, type LeaveRequest,
} from "./_core/timeOff";

const AT = new Date("2026-10-14T09:00:00Z");
const request = (o: Partial<LeaveRequest> = {}): LeaveRequest => ({
  requestRef: "LR-1", userId: 7, category: "vacation", urgency: "planned",
  from: new Date("2026-10-18T00:00:00Z"), to: new Date("2026-10-19T00:00:00Z"),
  partialDay: null, privateNote: null, requestedAt: AT, status: "requested",
  decidedByUserId: null, decidedAt: null, decisionNote: null, ...o,
});

describe("dispatch is told the time is gone, not why", () => {
  const medical = request({
    category: "medical_appointment", status: "approved",
    privateNote: "MRI follow-up, third one this year",
    partialDay: { fromTime: "13:00", toTime: "16:00" },
  });

  it("reduces a sensitive category to a neutral phrase and flags that it did", () => {
    const v = schedulingView(medical);
    expect(v.label).toBe("Unavailable — approved leave");
    expect(v.categoryWithheld).toBe(true);
  });

  it("has nowhere to put the private note — the type has no field for it", () => {
    const v = schedulingView(medical);
    expect(Object.keys(v)).not.toContain("privateNote");
    expect(Object.keys(v)).not.toContain("category");
    expect(JSON.stringify(v)).not.toContain("MRI");
  });

  it("still gives scheduling the window, because hiding it would read as available", () => {
    const v = schedulingView(medical);
    expect(v.partialDay).toEqual({ fromTime: "13:00", toTime: "16:00" });
    expect(v.from).toEqual(medical.from);
  });

  it("names an ordinary category plainly — withholding everything helps nobody", () => {
    const v = schedulingView(request({ category: "vacation", status: "approved" }));
    expect(v.label).toBe("Vacation");
    expect(v.categoryWithheld).toBe(false);
  });

  it("distinguishes a requested sensitive absence from an approved one", () => {
    expect(schedulingView(request({ category: "sick" })).label).toBe("Unavailable — leave requested");
  });

  it("names which categories are treated as sensitive rather than deciding case by case", () => {
    expect([...SENSITIVE_CATEGORIES]).toContain("medical_appointment");
    expect([...SENSITIVE_CATEGORIES]).not.toContain("vacation");
  });
});

describe("who may see the whole thing", () => {
  const r = request({ privateNote: "private", category: "sick", status: "approved" });

  it("gives the employee their own request in full and refuses somebody else's", () => {
    const mine = disclose(r, "self", 7)!;
    expect(mine.audience).toBe("self");
    expect((mine.request as LeaveRequest).privateNote).toBe("private");
    expect(disclose(r, "self", 8)).toBeNull();
  });

  it("gives HR the full record and scheduling only the view", () => {
    expect((disclose(r, "hr")!.request as LeaveRequest).privateNote).toBe("private");
    const sched = disclose(r, "scheduling")!.request;
    expect(JSON.stringify(sched)).not.toContain("private");
  });
});

describe("a request is not an absence", () => {
  const day = new Date("2026-10-18T00:00:00Z");

  it("removes somebody only once approved", () => {
    expect(onApprovedLeave([request({ status: "requested" })], 7, day)).toBe(false);
    expect(onApprovedLeave([request({ status: "approved" })], 7, day)).toBe(true);
    expect(onApprovedLeave([request({ status: "declined" })], 7, day)).toBe(false);
  });

  it("leaves a partial-day absence available for the rest of the shift", () => {
    const partial = request({ status: "approved", partialDay: { fromTime: "13:00", toTime: "16:00" } });
    expect(onApprovedLeave([partial], 7, day)).toBe(false);
    expect(partialAbsences([partial], day)).toEqual([{ userId: 7, fromTime: "13:00", toTime: "16:00", label: "Vacation" }]);
  });

  it("counts an approved leave and a recorded call-off alike as absent", () => {
    expect(isAbsent(request({ status: "approved" }))).toBe(true);
    expect(isAbsent(request({ status: "recorded" }))).toBe(true);
    expect(isAbsent(request({ status: "requested" }))).toBe(false);
  });
});

describe("the approver is informed, not replaced", () => {
  const day = new Date("2026-10-18T00:00:00Z");

  it("reports a shortage without deciding anything", () => {
    const b = briefForApprover(request(), [{ day, availableAfter: 11, needed: 14, shortfall: 3, qualificationsLost: [] }]);
    expect(b.advisory).toBe("creates_shortage");
    expect(b.decided).toBe(false);
    expect(b.lines[0]).toContain("would leave 11 of 14 — short 3");
  });

  it("puts a lost qualification above a headcount shortage, because it is the harder gap", () => {
    const b = briefForApprover(request(), [{ day, availableAfter: 13, needed: 14, shortfall: 1, qualificationsLost: ["CLIENT_ORIENTATION"] }]);
    expect(b.advisory).toBe("loses_qualification");
    expect(b.lines[0]).toContain("nobody holding CLIENT_ORIENTATION");
  });

  it("says tight when it would leave exactly enough", () => {
    const b = briefForApprover(request(), [{ day, availableAfter: 14, needed: 14, shortfall: 0, qualificationsLost: [] }]);
    expect(b.advisory).toBe("leaves_tight");
    expect(b.lines[0]).toContain("no margin");
  });

  it("says no impact rather than staying silent", () => {
    const b = briefForApprover(request(), [{ day, availableAfter: 18, needed: 14, shortfall: 0, qualificationsLost: [] }]);
    expect(b.advisory).toBe("no_impact");
    expect(b.lines[0]).toContain("no impact");
  });
});

describe("calling in sick is not a request", () => {
  it("is recorded rather than queued for approval, and reaches dispatch immediately", () => {
    const c = recordCallOff({ requestRef: "LR-9", userId: 7, category: "sick", from: AT, to: AT, at: AT });
    expect(c.request.status).toBe("recorded");
    expect(c.request.urgency).toBe("same_day");
    expect(c.routedTo).toEqual(["dispatch", "supervisor"]);
    expect(c.note).toContain("not queued for approval");
  });

  it("keeps the reason private even though it went straight to dispatch", () => {
    const c = recordCallOff({ requestRef: "LR-9", userId: 7, category: "sick", from: AT, to: AT, privateNote: "food poisoning", at: AT });
    const v = schedulingView(c.request);
    expect(JSON.stringify(v)).not.toContain("food poisoning");
    expect(v.label).toContain("Unavailable");
  });

  it("carries a source so the calendar event is traceable like every other", () => {
    const c = recordCallOff({ requestRef: "LR-9", userId: 7, category: "sick", from: AT, to: AT, at: AT });
    expect(c.source).toMatchObject({ sourceType: "leaveRequest", sourceRef: "LR-9" });
  });
});
