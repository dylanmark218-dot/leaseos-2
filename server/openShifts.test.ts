/**
 * v22.20 — open shifts, and the gap between wanting one and having it.
 */
import { describe, expect, it } from "vitest";
import {
  candidatesFor, expressInterest, intendToAssign, NotEligible, summarize,
  type Candidate, type ShiftPost,
} from "./_core/openShifts";
import type { CrewMember } from "./_core/crewCoverage";
import type { LeaveRequest } from "./_core/timeOff";

const START = new Date("2026-10-19T06:00:00Z");
const rotation = { onDays: 7, offDays: 7, anchor: new Date("2026-10-19T00:00:00Z"), label: "7/7" };

const post = (o: Partial<ShiftPost> = {}): ShiftPost => ({
  postRef: "OS-492", title: "Vac truck operator", startsAt: START,
  endsAt: new Date(START.getTime() + 12 * 3_600_000), location: "Fox Creek",
  requiredRole: "driver", requiredQualifications: ["CLASS1", "TDG"], seats: 1, kind: "open", ...o,
});

const member = (name: string, o: Partial<CrewMember> = {}): CrewMember => ({
  userId: name.charCodeAt(0), name, roles: ["driver"],
  currentQualifications: ["CLASS1", "TDG"], existingAssignments: [],
  rotation, awayOn: [], ...o,
});

const leave = (userId: number, o: Partial<LeaveRequest> = {}): LeaveRequest => ({
  requestRef: "LR-1", userId, category: "vacation", urgency: "planned",
  from: new Date("2026-10-18T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z"),
  partialDay: null, privateNote: null, requestedAt: START, status: "approved",
  decidedByUserId: 1, decidedAt: START, decisionNote: null, ...o,
});

describe("who could take it, and why the rest could not", () => {
  it("passes somebody with the role, the tickets, the roster and no clash", () => {
    const [c] = candidatesFor({ post: post(), crew: [member("Ann")], leave: [] });
    expect(c.eligible).toBe(true);
    expect(c.reasons).toEqual([]);
  });

  it("names the missing qualification rather than saying not eligible", () => {
    const [c] = candidatesFor({ post: post(), crew: [member("Bob", { currentQualifications: ["CLASS1"] })], leave: [] });
    expect(c.eligible).toBe(false);
    expect(c.reasons[0]).toMatchObject({ code: "missing_qualification" });
    expect(c.reasons[0].detail).toBe("No current TDG");
  });

  it("treats a qualification nobody recorded exactly like an expired one", () => {
    const [c] = candidatesFor({ post: post(), crew: [member("Cal", { currentQualifications: [] })], leave: [] });
    expect(c.reasons[0].detail).toBe("No current CLASS1, TDG");
  });

  it("collects every reason rather than stopping at the first", () => {
    const [c] = candidatesFor({
      post: post(),
      crew: [member("Dee", { roles: ["swamper"], currentQualifications: [], awayOn: [START] })],
      leave: [],
    });
    expect(c.reasons.map(r => r.code).sort()).toEqual(["missing_qualification", "not_rostered", "wrong_role"]);
  });

  it("excludes somebody on approved leave and says so", () => {
    const m = member("Eve");
    const [c] = candidatesFor({ post: post(), crew: [m], leave: [leave(m.userId)] });
    expect(c.reasons[0]).toMatchObject({ code: "on_approved_leave" });
  });

  it("does not exclude somebody whose leave is only requested", () => {
    const m = member("Fay");
    const [c] = candidatesFor({ post: post(), crew: [m], leave: [leave(m.userId, { status: "requested" })] });
    expect(c.eligible).toBe(true);
  });

  it("excludes an overlapping assignment and names it", () => {
    const clash = { assignmentRef: "J-8217", startsAt: START, endsAt: new Date(START.getTime() + 3_600_000), requiredQualifications: [], requiredRole: "driver" };
    const [c] = candidatesFor({ post: post(), crew: [member("Gus", { existingAssignments: [clash] })], leave: [] });
    expect(c.reasons[0].detail).toContain("Already on J-8217");
  });

  it("excludes somebody off-hitch", () => {
    const [c] = candidatesFor({ post: post({ startsAt: new Date("2026-10-27T06:00:00Z") }), crew: [member("Hal")], leave: [] });
    expect(c.reasons.some(r => r.code === "not_rostered")).toBe(true);
  });
});

describe("the summary is actionable, not a count", () => {
  const crew = [
    member("Ann"),
    member("Bob", { currentQualifications: ["CLASS1"] }),
    member("Cal", { currentQualifications: ["CLASS1"] }),
    member("Dee", { roles: ["swamper"] }),
  ];

  it("ranks the barriers so the largest is named", () => {
    const s = summarize(post({ seats: 3 }), candidatesFor({ post: post({ seats: 3 }), crew, leave: [] }));
    expect(s.eligible).toHaveLength(1);
    expect(s.barriers[0]).toMatchObject({ code: "missing_qualification", count: 2 });
    expect(s.line).toContain("1 eligible for 3 seat(s) — short 2");
    expect(s.line).toContain("Largest barrier: missing_qualification (2)");
  });

  it("says nothing about shortfall when the seats are covered", () => {
    const s = summarize(post({ seats: 1 }), candidatesFor({ post: post(), crew, leave: [] }));
    expect(s.line).toBe("OS-492: 1 eligible for 1 seat(s)");
  });
});

describe("interest is not assignment", () => {
  const eligible = (): Candidate => candidatesFor({ post: post(), crew: [member("Ann")], leave: [] })[0];

  it("records interest and says plainly that it assigns nothing", () => {
    const i = expressInterest({ post: post(), candidate: eligible(), at: START });
    expect(i.assigns).toBe(false);
    expect(i.note).toContain("Dispatch assigns the shift");
    expect(i.note).toContain("says nothing about a certificate expiring tomorrow");
  });

  it("refuses interest from somebody who cannot do the work", () => {
    const notQualified = candidatesFor({ post: post(), crew: [member("Bob", { currentQualifications: [] })], leave: [] })[0];
    expect(() => expressInterest({ post: post(), candidate: notQualified, at: START })).toThrow(NotEligible);
    expect(() => expressInterest({ post: post(), candidate: notQualified, at: START })).toThrow(/No current CLASS1, TDG/);
  });

  it("refuses interest on an assigned post, which is not filled that way", () => {
    expect(() => expressInterest({ post: post({ kind: "assigned" }), candidate: eligible(), at: START }))
      .toThrow(/interest is not how it is filled/);
  });
});

describe("dispatch decides, and the readiness gate still runs", () => {
  const ann = () => candidatesFor({ post: post(), crew: [member("Ann")], leave: [] })[0];

  it("produces an intent that still requires the readiness check", () => {
    const intent = intendToAssign({ post: post(), candidate: ann(), interests: [] });
    expect(intent.requiresReadinessCheck).toBe(true);
    expect(intent.basis).toBe("dispatch_decision");
    expect(intent.note).toContain("Interest is context and confers no claim");
  });

  it("assigns somebody who never expressed interest, and gives an interested person no claim", () => {
    const noInterest = intendToAssign({ post: post(), candidate: ann(), interests: [] });
    expect(noInterest.interestExpressed).toBe(false);

    const withInterest = intendToAssign({
      post: post(), candidate: ann(),
      interests: [{ postRef: "OS-492", userId: ann().userId, expressedAt: START, assigns: false, note: "" }],
    });
    expect(withInterest.interestExpressed).toBe(true);
    // Recorded as context; the outcome is identical either way.
    expect(withInterest.basis).toBe(noInterest.basis);
  });

  it("refuses to intend an assignment for somebody ineligible", () => {
    const bob = candidatesFor({ post: post(), crew: [member("Bob", { currentQualifications: [] })], leave: [] })[0];
    expect(() => intendToAssign({ post: post(), candidate: bob, interests: [] })).toThrow(NotEligible);
  });
});
