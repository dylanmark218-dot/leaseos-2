/**
 * 0205/0206 — the board's vocabulary, and the lines it must not cross.
 *
 * A badge is where a false claim comes back: "Delivered" on a message still on a tablet, ✓ on a
 * ticket nobody recorded, "Assigned" on an accepted offer. Each of those would let somebody act on
 * a word the screen is not entitled to say, so the words are tested here rather than styled.
 */
import { describe, expect, it } from "vitest";
import {
  BOARD_TABS, KNOWN_CHANNEL_TYPES, MARK_GLYPH, SYNC_STATES, TAB_LABELS, channelsForTab, presentOpenWork, presentResponse, presentSend, tabBadge, tabOfChannel,
  type BoardChannel, type PostForCard, type PreviewForCard,
} from "./boardModel";

describe("send state — nothing reads as delivered from the device", () => {
  it("covers all six sync states with distinct labels", () => {
    const labels = SYNC_STATES.map(s => presentSend(s).label);
    expect(new Set(labels).size).toBe(6);
  });

  it("claims the server has it only once it answered, and never claims delivery, reading or acknowledgement", () => {
    expect(SYNC_STATES.filter(s => presentSend(s).serverHasIt)).toEqual(["synchronized"]);
    for (const s of SYNC_STATES) expect(presentSend(s).label).not.toMatch(/deliver|read|opened|acknowledg/i);
  });

  it("uses the server's own word for what the server witnessed", () => {
    expect(presentSend("synchronized").label).toBe("Sent");
    expect(presentSend("syncing").label).toBe("Sending");
  });

  it("keeps everything the server has not accepted, and says so for a refusal", () => {
    expect(SYNC_STATES.filter(s => presentSend(s).retained)).toEqual(["saved_locally", "queued", "syncing", "failed", "conflict"]);
    expect(presentSend("failed").label).toContain("kept on this device");
  });
});

describe("tabs", () => {
  const ch = (type: string, unacknowledged = 0): BoardChannel => ({ channelRef: `CH-${type}`, type, name: type, unacknowledged });

  it("are the six the request drew, in order", () => {
    expect(BOARD_TABS.map(t => TAB_LABELS[t])).toEqual(["Inbox", "Dispatch", "My Jobs", "Open Work", "Company", "Safety"]);
  });

  it("place every channel type the server can hold today, and an unknown one under Company without guessing", () => {
    for (const t of ["direct", "group", "dispatch", "job", "safety", "emergency", "announcement", "general", "department", "unit", "shift"]) expect(KNOWN_CHANNEL_TYPES).toContain(t);
    expect(tabOfChannel("job")).toBe("my_jobs");
    expect(tabOfChannel("emergency")).toBe("safety");
    expect(tabOfChannel("teleported")).toBe("company");
  });

  it("puts a bulletin waiting on you in the inbox whatever channel carried it, and counts it once per tab", () => {
    const channels = [ch("direct"), ch("safety", 2), ch("general")];
    expect(channelsForTab("inbox", channels).map(c => c.type)).toEqual(["direct", "safety"]);
    expect(channelsForTab("safety", channels).map(c => c.type)).toEqual(["safety"]);
    expect(tabBadge("inbox", channels)).toBe(2);
    expect(tabBadge("company", channels)).toBe(0);
    expect(channelsForTab("open_work", channels)).toEqual([]);
  });
});

describe("the open-work card", () => {
  const post = (o: Partial<PostForCard> = {}): PostForCard => ({
    postRef: "OS-1", title: "Hydrovac operator", status: "open", requiredRole: "driver", requiredQualifications: ["H2S", "First Aid", "TDG"],
    requiredEquipmentClass: null, location: "Hinton area", regionCode: "HINTON", startsAt: new Date("2026-10-21T06:00:00Z"), endsAt: new Date("2026-10-21T18:00:00Z"),
    estimatedHours: 12, overtime: true, priority: "normal", ...o,
  });
  const me = (o: Partial<PreviewForCard> = {}): PreviewForCard => ({ verdict: "eligible", reasons: [], availability: "available", interestExpressed: false, readinessNotEvaluated: [], ...o });
  const marks = (c: ReturnType<typeof presentOpenWork>) => Object.fromEntries(c.requirements.map(r => [r.label, MARK_GLYPH[r.mark]]));

  it("shows the request's card — role, place, time, duration, overtime — and ✓ only for what is on record", () => {
    const c = presentOpenWork(post(), me(), null);
    expect(c.facts).toEqual(["driver", "Hinton area", "2026-10-21 06:00 UTC → 2026-10-21 18:00 UTC", "Estimated 12 h", "Overtime eligible"]);
    expect(marks(c)).toEqual({ "Driver licence": "✓", H2S: "✓", "First Aid": "✓", TDG: "✓" });
    expect(c.verdict.tone).toBe("ok");
    expect(c.canRespond).toBe(true);
  });

  it("marks a ticket nobody recorded ? and an expired one ✗ — never ✓", () => {
    const c = presentOpenWork(post(), me({ verdict: "unknown", reasons: [
      { code: "qualification_unknown", detail: "No First Aid on record — unknown is not satisfied" },
      { code: "qualification_expired", detail: "TDG expired 3 day(s) before this" },
    ] }), null);
    expect(marks(c)).toMatchObject({ H2S: "✓", "First Aid": "?", TDG: "✗" });
  });

  it("marks the licence ? for a person with no operator record, and everything ? for a card not yet checked", () => {
    // SPINE item 2: the one rule reports a missing operator record as no_licence_recorded.
    const none = presentOpenWork(post(), me({ verdict: "unknown", reasons: [{ code: "no_licence_recorded", detail: "No licence on record — this cannot be established as current" }] }), null);
    expect(none.requirements[0]).toMatchObject({ label: "Driver licence", mark: "unknown" });
    expect(none.canRespond).toBe(false);
    expect(none.canDecline).toBe(true);
    const unchecked = presentOpenWork(post(), null, null);
    expect(unchecked.requirements.every(r => r.mark === "unknown")).toBe(true);
    expect(unchecked.verdict.label).toBe("Not checked yet");
  });

  it("renders a capability the composer did not evaluate, and a required equipment class, as ? with the reason", () => {
    const c = presentOpenWork(post({ requiredEquipmentClass: "hydrovac" }), me({ readinessNotEvaluated: ["route restrictions"] }), null);
    expect(c.requirements.find(r => r.label === "route restrictions")).toMatchObject({ mark: "unknown", detail: expect.stringContaining("Not evaluated") });
    expect(c.requirements.find(r => r.label === "Equipment: hydrovac")?.mark).toBe("unknown");
  });

  it("lets an excluded person decline and not volunteer, and says which fact excludes them", () => {
    const c = presentOpenWork(post(), me({ verdict: "ineligible", reasons: [{ code: "on_approved_leave", detail: "Away that day on leave already recorded" }] }), null);
    expect(c.canRespond).toBe(false);
    expect(c.canDecline).toBe(true);
    expect(c.actionNote).toContain("Away that day");
    expect(c.requirements.find(r => r.label === "Not on leave")?.mark).toBe("missing");
  });

  it("takes no response on a post that is not open", () => {
    const c = presentOpenWork(post({ status: "filled" }), me(), null);
    expect(c.canRespond).toBe(false);
    expect(c.canDecline).toBe(false);
    expect(c.actionNote).toContain("filled");
  });

  it("never says a person has the work on interest or an accepted offer", () => {
    for (const status of ["offered", "accepted", "declined", "withdrawn", "expired", "not_selected"]) {
      const c = presentOpenWork(post(), me({ interestExpressed: true }), { offerRef: "OFF-1", status, expiresAt: null });
      expect(c.offer!.label, status).not.toMatch(/^Given to you|assigned|dispatched|awarded/i);
    }
    expect(presentOpenWork(post(), me(), { offerRef: "OFF-1", status: "accepted", expiresAt: null }).offer!.label).toContain("not given until dispatch awards it");
    expect(presentOpenWork(post(), me(), { offerRef: "OFF-1", status: "awarded", expiresAt: null }).offer!.label).toContain("pre-departure check");
    expect(presentOpenWork(post(), me(), { offerRef: "OFF-1", status: "offered", expiresAt: null }).offer!.answerable).toBe(true);
    expect(presentOpenWork(post(), me(), { offerRef: "OFF-1", status: "accepted", expiresAt: null }).offer!.answerable).toBe(false);
    expect(presentResponse("request_assignment")).toBe("You asked to be given this work");
  });
});
