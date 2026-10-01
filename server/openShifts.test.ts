/**
 * v22.20 — open shifts, and the gap between wanting one and having it.
 */
import { describe, expect, it } from "vitest";
import {
  candidatesFor, expressInterest, intendToAssign, NotEligible, shiftEligibility, summarize,
  type Candidate, type PersonFacts, type ShiftPost,
} from "./_core/openShifts";
import type { LeaveRequest } from "./_core/timeOff";

const START = new Date("2026-10-19T06:00:00Z");
const rotation = { onDays: 7, offDays: 7, anchor: new Date("2026-10-19T00:00:00Z"), label: "7/7" };

const post = (o: Partial<ShiftPost> = {}): ShiftPost => ({
  postRef: "OS-492", title: "Vac truck operator", startsAt: START,
  endsAt: new Date(START.getTime() + 12 * 3_600_000), location: "Fox Creek",
  requiredRole: "driver", requiredQualifications: ["CLASS1", "TDG"], seats: 1, kind: "open", ...o,
});

const held = (...codes: string[]) => codes.map(code => ({ code, held: true, notHeld: null, reason: `${code} in force` }));

const member = (name: string, o: Partial<PersonFacts> = {}): PersonFacts => ({
  userId: name.charCodeAt(0), name, inOrganization: true, roles: ["driver"],
  rosters: [{ rotation }], leave: [], commitments: [],
  licence: { kind: "recorded", expiresAt: new Date("2027-06-01T00:00:00Z") },
  qualifications: held("CLASS1", "TDG"), ...o,
});

const leave = (userId: number, o: Partial<LeaveRequest> = {}): LeaveRequest => ({
  requestRef: "LR-1", userId, category: "vacation", urgency: "planned",
  from: new Date("2026-10-18T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z"),
  partialDay: null, privateNote: null, requestedAt: START, status: "approved",
  decidedByUserId: 1, decidedAt: START, decisionNote: null, ...o,
});

describe("who could take it, and why the rest could not", () => {
  it("passes somebody with the role, the tickets, the roster and no clash", () => {
    const [c] = candidatesFor({ post: post(), people: [member("Ann")] });
    expect(c.eligible).toBe(true);
    expect(c.reasons).toEqual([]);
  });

  it("names the missing qualification rather than saying not eligible", () => {
    const [c] = candidatesFor({ post: post(), people: [member("Bob", { qualifications: held("CLASS1") })] });
    expect(c.eligible).toBe(false);
    expect(c.reasons).toEqual([{ code: "qualification_unknown", detail: "No TDG on record — unknown is not satisfied" }]);
  });

  it("treats a qualification nobody recorded exactly like an expired one", () => {
    const [c] = candidatesFor({ post: post(), people: [member("Cal", { qualifications: [] })] });
    expect(c.reasons.map(r => r.code)).toEqual(["qualification_unknown", "qualification_unknown"]);
    const [x] = candidatesFor({ post: post(), people: [member("Cy", { qualifications: [...held("CLASS1"), { code: "TDG", held: false, notHeld: "expired", reason: "TDG expired 2026-09-01" }] })] });
    expect(x.reasons).toEqual([{ code: "qualification_expired", detail: "TDG expired 2026-09-01" }]);
    const [u] = candidatesFor({ post: post(), people: [member("Cu", { qualifications: [...held("CLASS1"), { code: "TDG", held: false, notHeld: "unverified", reason: "TDG uploaded, not verified" }] })] });
    expect(u.reasons.map(r => r.code)).toEqual(["qualification_unverified"]);
  });

  it("collects every reason rather than stopping at the first", () => {
    const [c] = candidatesFor({
      post: post(),
      people: [member("Dee", { roles: ["swamper"], qualifications: [], rosters: [], licence: { kind: "none" } })],
    });
    expect(c.reasons.map(r => r.code).sort()).toEqual(["no_licence_recorded", "not_rostered", "qualification_unknown", "qualification_unknown", "wrong_role"]);
  });

  it("excludes somebody on approved leave and says so", () => {
    const m = member("Eve");
    const [c] = candidatesFor({ post: post(), people: [{ ...m, leave: [leave(m.userId)] }] });
    expect(c.reasons[0]).toMatchObject({ code: "on_approved_leave" });
  });

  it("does not exclude somebody whose leave is only requested", () => {
    const m = member("Fay");
    const [c] = candidatesFor({ post: post(), people: [{ ...m, leave: [leave(m.userId, { status: "requested" })] }] });
    expect(c.eligible).toBe(true);
  });

  it("excludes an overlapping assignment and names it", () => {
    const clash = { assignmentRef: "J-8217", startsAt: START, endsAt: new Date(START.getTime() + 3_600_000) };
    const [c] = candidatesFor({ post: post(), people: [member("Gus", { commitments: [clash] })] });
    expect(c.reasons[0].detail).toContain("Already on J-8217");
  });

  it("excludes somebody off-hitch", () => {
    const [c] = candidatesFor({ post: post({ startsAt: new Date("2026-10-27T06:00:00Z"), endsAt: new Date("2026-10-27T18:00:00Z") }), people: [member("Hal")] });
    expect(c.reasons).toEqual([{ code: "not_rostered", detail: "Off-hitch on this date" }]);
  });
});

describe("the rules the router used to hold alone are the engine's now", () => {
  it("refuses no licence, an ambiguous operator record, a blank expiry and a licence expiring before the shift", () => {
    const codes = (licence: PersonFacts["licence"]) => shiftEligibility(post(), member("Lee", { licence })).reasons.map(r => r.code);
    expect(codes({ kind: "none" })).toEqual(["no_licence_recorded"]);
    expect(codes({ kind: "ambiguous" })).toEqual(["no_licence_recorded"]);
    expect(codes({ kind: "recorded", expiresAt: null })).toEqual(["no_licence_recorded"]);
    expect(codes({ kind: "recorded", expiresAt: new Date("2026-10-01T00:00:00Z") })).toEqual(["licence_expired"]);
    expect(codes({ kind: "recorded", expiresAt: new Date("2027-06-01T00:00:00Z") })).toEqual([]);
  });

  it("says nothing about a person outside the organization beyond that", () => {
    const c = shiftEligibility(post(), member("Out", { inOrganization: false, roles: ["driver"] }));
    expect(c).toMatchObject({ eligible: false, reasons: [{ code: "not_in_organization" }] });
    expect(c.reasons).toHaveLength(1);
  });

  it("does not take somebody with no roster at all as rostered — absence refuses", () => {
    expect(shiftEligibility(post(), member("Ned", { rosters: [] })).reasons).toEqual([{ code: "not_rostered", detail: "Not on this organization's roster" }]);
    expect(shiftEligibility(post(), member("Pat", { rosters: [{ rotation: null }] })).eligible).toBe(true);
  });
});

describe("the summary is actionable, not a count", () => {
  const people = [
    member("Ann"),
    member("Bob", { qualifications: held("CLASS1") }),
    member("Cal", { qualifications: held("CLASS1") }),
    member("Dee", { roles: ["swamper"] }),
  ];

  it("ranks the barriers so the largest is named", () => {
    const s = summarize(post({ seats: 3 }), candidatesFor({ post: post({ seats: 3 }), people }));
    expect(s.eligible).toHaveLength(1);
    expect(s.barriers[0]).toMatchObject({ code: "qualification_unknown", count: 2 });
    expect(s.line).toContain("1 eligible for 3 seat(s) — short 2");
    expect(s.line).toContain("Largest barrier: qualification_unknown (2)");
  });

  it("says nothing about shortfall when the seats are covered", () => {
    const s = summarize(post({ seats: 1 }), candidatesFor({ post: post(), people }));
    expect(s.line).toBe("OS-492: 1 eligible for 1 seat(s)");
  });
});

describe("interest is not assignment", () => {
  const eligible = (): Candidate => candidatesFor({ post: post(), people: [member("Ann")] })[0];

  it("records interest and says plainly that it assigns nothing", () => {
    const i = expressInterest({ post: post(), candidate: eligible(), at: START });
    expect(i.assigns).toBe(false);
    expect(i.note).toContain("Dispatch assigns the shift");
    expect(i.note).toContain("says nothing about a certificate expiring tomorrow");
  });

  it("refuses interest from somebody who cannot do the work", () => {
    const notQualified = candidatesFor({ post: post(), people: [member("Bob", { qualifications: [] })] })[0];
    expect(() => expressInterest({ post: post(), candidate: notQualified, at: START })).toThrow(NotEligible);
    expect(() => expressInterest({ post: post(), candidate: notQualified, at: START })).toThrow(/No CLASS1 on record/);
  });

  it("refuses interest on a post that is no longer open", () => {
    expect(() => expressInterest({ post: post({ status: "filled" }), candidate: eligible(), at: START })).toThrow(/only an open post takes interest/);
  });

  it("refuses interest on an assigned post, which is not filled that way", () => {
    expect(() => expressInterest({ post: post({ kind: "assigned" }), candidate: eligible(), at: START }))
      .toThrow(/interest is not how it is filled/);
  });
});

describe("dispatch decides, and the readiness gate still runs", () => {
  const ann = () => candidatesFor({ post: post(), people: [member("Ann")] })[0];

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
    const bob = candidatesFor({ post: post(), people: [member("Bob", { qualifications: [] })] })[0];
    expect(() => intendToAssign({ post: post(), candidate: bob, interests: [] })).toThrow(NotEligible);
  });
});
