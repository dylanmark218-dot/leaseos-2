/**
 * v22.20 — the crew chat, and what it does not open up.
 */
import { describe, expect, it } from "vitest";
import {
  ChannelClosed, closeWithJob, CREW_PERMISSIONS, crewPermissions, effectivePermissions,
  isCurrentMember, mayPost, mayReadMessage, membershipFrom, mentionReaches,
  type Crew, type CrewMember,
} from "./_core/crewChannels";

const AT = new Date("2026-10-20T06:00:00Z");
const later = (h: number) => new Date(AT.getTime() + h * 3_600_000);

const crew = (o: Partial<Crew> = {}): Crew => ({
  crewRef: "CREW-A", name: "Vac Crew A", type: "permanent",
  supervisorUserId: 1, jobRef: null, state: "active", ...o,
});
const member = (userId: number, o: Partial<CrewMember> = {}): CrewMember => ({
  crewRef: "CREW-A", userId, crewRole: "driver", source: "dispatch",
  joinedAt: AT, leftAt: null, ...o,
});

describe("crew membership grants crew things and nothing else", () => {
  it("confers only permissions from the enumerated crew set, for every role", () => {
    for (const role of ["supervisor", "driver", "operator", "labourer", "mechanic", "safety", "dispatch", "other"] as const) {
      for (const p of crewPermissions(role)) {
        expect(CREW_PERMISSIONS).toContain(p);
      }
    }
  });

  it("never confers payroll, another crew, management or financial access", () => {
    const granted = new Set(["supervisor", "driver", "dispatch"].flatMap(r => crewPermissions(r as "driver")));
    for (const forbidden of ["payroll.read", "crew.other.read", "management.read", "finance.read", "client.private.read"]) {
      expect(granted.has(forbidden as never)).toBe(false);
    }
    // Every crew permission is namespaced to the crew, by construction.
    expect(CREW_PERMISSIONS.every(p => p.startsWith("crew."))).toBe(true);
  });

  it("adds crew permissions to what somebody already had, and takes nothing away", () => {
    const effective = effectivePermissions(["payroll.read"], [{ crewRole: "driver", active: true }]);
    expect(effective).toContain("payroll.read");
    expect(effective).toContain("crew.post");
    expect(effective.filter(p => !p.startsWith("crew.") && p !== "payroll.read")).toEqual([]);
  });

  it("confers nothing from a membership that has ended", () => {
    expect(effectivePermissions([], [{ crewRole: "supervisor", active: false }])).toEqual([]);
  });

  it("cannot be widened by a caller mutating the result", () => {
    const first = crewPermissions("labourer");
    first.push("crew.members.manage");
    expect(crewPermissions("labourer")).not.toContain("crew.members.manage");
  });

  it("gives a supervisor the broadcast and a driver not", () => {
    expect(crewPermissions("supervisor")).toContain("crew.broadcast");
    expect(crewPermissions("driver")).not.toContain("crew.broadcast");
    expect(crewPermissions("driver")).not.toContain("crew.members.manage");
  });
});

describe("membership follows the assignment; history does not follow the member", () => {
  it("adds somebody from a dispatch assignment", () => {
    const m = membershipFrom([{ userId: 7, crewRef: "CREW-A", crewRole: "driver", from: AT, to: null }], []);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ userId: 7, source: "dispatch", leftAt: null });
  });

  it("ends the membership without removing the row", () => {
    const existing = [member(7)];
    const m = membershipFrom([{ userId: 7, crewRef: "CREW-A", crewRole: "driver", from: AT, to: later(12) }], existing);
    expect(m).toHaveLength(1);
    // Deleting it would make their messages authored by somebody never there.
    expect(m[0].leftAt).toEqual(later(12));
  });

  it("does not double-add somebody already current", () => {
    const m = membershipFrom([{ userId: 7, crewRef: "CREW-A", crewRole: "driver", from: AT, to: null }], [member(7)]);
    expect(m).toHaveLength(1);
  });

  it("knows who is current at a moment", () => {
    const left = member(7, { leftAt: later(12) });
    expect(isCurrentMember(left, later(6))).toBe(true);
    expect(isCurrentMember(left, later(18))).toBe(false);
    expect(isCurrentMember(member(7, { joinedAt: later(6) }), AT)).toBe(false);
  });
});

describe("a former member reads what they were there for", () => {
  const left = member(7, { joinedAt: later(2), leftAt: later(10) });

  it("allows what was posted while they were a member", () => {
    expect(mayReadMessage(left, later(5)).allowed).toBe(true);
    expect(mayReadMessage(left, later(5)).reason).toContain("while they were a member");
  });

  it("refuses what came before they joined and after they left", () => {
    expect(mayReadMessage(left, later(1))).toMatchObject({ allowed: false });
    expect(mayReadMessage(left, later(1)).reason).toContain("before this person joined");
    expect(mayReadMessage(left, later(11)).reason).toContain("after this person left");
  });

  it("refuses somebody who was never a member", () => {
    expect(mayReadMessage(undefined, later(5))).toMatchObject({ allowed: false });
  });
});

describe("a closed job room keeps everything and takes nothing", () => {
  it("stops accepting once the job closes", () => {
    const job = crew({ type: "job", jobRef: "JOB-4928" });
    const closed = closeWithJob(job);
    expect(closed.state).toBe("read_only");
    const r = mayPost(closed, member(7), later(1));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("part of the job record now");
  });

  it("refuses to close a permanent crew with a job", () => {
    expect(() => closeWithJob(crew({ type: "permanent" }))).toThrow(ChannelClosed);
  });

  it("refuses a post from somebody who has left, and allows a current member", () => {
    expect(mayPost(crew(), member(7, { leftAt: later(2) }), later(5)).allowed).toBe(false);
    expect(mayPost(crew(), member(7), later(5)).allowed).toBe(true);
  });

  it("refuses a post from a role that may only read", () => {
    const r = mayPost(crew(), member(7, { crewRole: "other" }), later(5));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("may read and not post");
  });
});

describe("a mention reaches its scope and stops", () => {
  const members = [
    member(1, { crewRole: "supervisor" }),
    member(2, { crewRole: "driver" }),
    member(3, { crewRole: "driver" }),
    member(4, { crewRole: "mechanic" }),
    member(5, { crewRole: "driver", leftAt: later(1) }),
  ];

  it("reaches the whole current crew for @crew, excluding somebody who left", () => {
    expect(mentionReaches("crew", members, later(5))).toEqual([1, 2, 3, 4]);
  });

  it("reaches only drivers for @drivers", () => {
    // Reaching everybody is how a crew learns to ignore mentions.
    expect(mentionReaches("driver", members, later(5))).toEqual([2, 3]);
    expect(mentionReaches("mechanic", members, later(5))).toEqual([4]);
  });

  it("reaches one person, and one unit's operator", () => {
    expect(mentionReaches({ userId: 3 }, members, later(5))).toEqual([3]);
    const unitOf = (u: number) => (u === 2 ? "UNIT-218" : null);
    expect(mentionReaches({ unitRef: "UNIT-218" }, members, later(5), unitOf)).toEqual([2]);
  });

  it("reaches nobody for a unit nobody is on", () => {
    expect(mentionReaches({ unitRef: "UNIT-999" }, members, later(5), () => null)).toEqual([]);
  });
});
