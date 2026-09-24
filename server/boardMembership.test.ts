/**
 * 0182 — the board with membership: who opens an explicit channel, who publishes, what an audience is.
 *
 * Pure. The router's `openChannel` asks these and decides nothing itself.
 */
import { describe, expect, it } from "vitest";
import {
  announcementAudienceRefusal, defaultMembershipMode, directChannelKey, EXPLICIT_ONLY_TYPES, MAX_ANNOUNCEMENT_AUDIENCE, mayOpen, mayOpenExplicit,
  memberMayPost, memberStanding, requiresPublishAuthority,
  type ChannelMember, type ChannelType, type Priority,
} from "./_core/messageBoard";

const AT = new Date("2026-10-20T14:00:00Z");
const member = (o: Partial<ChannelMember> = {}): ChannelMember => ({ channelRef: "CH-1", userId: 7, memberRole: "member", joinedAt: new Date("2026-10-01T00:00:00Z"), leftAt: null, ...o });

describe("four standings, not two", () => {
  it("is current while in force, historical after leaving, future-only before joining, never with no row", () => {
    expect(memberStanding([member()], AT).standing).toBe("current");
    expect(memberStanding([member({ leftAt: new Date("2026-10-10T00:00:00Z") })], AT).standing).toBe("historical");
    expect(memberStanding([member({ joinedAt: new Date("2026-11-01T00:00:00Z") })], AT).standing).toBe("future_only");
    expect(memberStanding([], AT).standing).toBe("never");
  });

  it("admits current and historical members and refuses the other two with the reason", () => {
    expect(mayOpenExplicit("current").allowed).toBe(true);
    expect(mayOpenExplicit("historical").allowed).toBe(true);
    expect(mayOpenExplicit("future_only")).toMatchObject({ allowed: false });
    expect(mayOpenExplicit("never").reason).toContain("Being an internal user is not being in this conversation");
  });

  it("does not admit management to an explicit channel through the open rule — the open rule is not consulted for it", () => {
    // `mayOpen` is the OPEN rule. For a direct channel the router asks `mayOpenExplicit` with the
    // caller's standing; a management viewer with no row is `never`, and never is refused.
    const viewer = { userId: 99, internal: true, clientRef: null, roles: ["management"] };
    expect(mayOpen({ channelRef: "CH-D", type: "direct", name: "Direct", jobRef: null, clientRef: null, archived: false }, viewer).allowed).toBe(true);
    expect(mayOpenExplicit(memberStanding([], AT).standing).allowed).toBe(false);
  });

  it("lets every channel role post but read-only", () => {
    expect(memberMayPost("member")).toBe(true);
    expect(memberMayPost("moderator")).toBe(true);
    expect(memberMayPost("read_only")).toBe(false);
  });
});

describe("publishing is not posting", () => {
  it("needs the publish authority for an emergency anywhere, and for anything in an announcement or emergency channel", () => {
    expect(requiresPublishAuthority("dispatch", "emergency")).toBe(true);
    expect(requiresPublishAuthority("announcement", "normal")).toBe(true);
    expect(requiresPublishAuthority("emergency", "normal")).toBe(true);
    expect(requiresPublishAuthority("dispatch", "urgent")).toBe(false);
    expect(requiresPublishAuthority("direct", "important")).toBe(false);
  });

  it("refuses an announcement with no audience and one beyond the bound, and lets every other channel be silent", () => {
    expect(announcementAudienceRefusal("announcement", 0)).toMatch(/no roll-call/);
    expect(announcementAudienceRefusal("announcement", MAX_ANNOUNCEMENT_AUDIENCE + 1)).toMatch(/branch channel/);
    expect(announcementAudienceRefusal("announcement", 12)).toBeNull();
    expect(announcementAudienceRefusal("dispatch", 0)).toBeNull();
  });
});

describe("the mode a channel takes", () => {
  it("is explicit for direct and group, crew when a crew is named, open otherwise", () => {
    for (const t of EXPLICIT_ONLY_TYPES) expect(defaultMembershipMode(t, null)).toBe("explicit");
    expect(defaultMembershipMode("field_operations", "CREW-1")).toBe("crew");
    for (const t of ["general", "dispatch", "safety", "job", "department", "unit", "shift", "announcement"] as ChannelType[]) expect(defaultMembershipMode(t, null)).toBe("open");
  });

  it("names the one direct channel two people share, whichever of them asks", () => {
    expect(directChannelKey(4, 9)).toBe(directChannelKey(9, 4));
    expect(directChannelKey(4, 9)).not.toBe(directChannelKey(4, 10));
  });

  it("keeps the derived acknowledgement rule untouched by the publish rule", () => {
    const p: Priority[] = ["normal", "important", "urgent", "emergency"];
    expect(p.filter(x => requiresPublishAuthority("general", x))).toEqual(["emergency"]);
  });
});
