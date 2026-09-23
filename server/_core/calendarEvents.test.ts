/**
 * 0170 — the events the calendar owns, expanded; and the availability read that has nowhere to
 * put a title.
 */
import { describe, expect, it } from "vitest";
import { actionable, availabilityFor, filterForView, fromProjection, toEntries, type PersistedEvent } from "./calendarEvents";
import { project, visibleTo } from "./calendarProjection";
import { zonedToUtc } from "./recurrence";

const TZ = "America/Edmonton";
const local = (y: number, m: number, d: number, hh: number, mm = 0) => zonedToUtc({ year: y, month: m, day: d, hour: hh, minute: mm, second: 0 }, TZ);
const NOW = local(2027, 4, 10, 9);
const FROM = local(2027, 4, 10, 0);
const TO = local(2027, 4, 17, 0);

const event = (over: Partial<PersistedEvent> = {}): PersistedEvent => ({
  eventRef: "CAL-1", kind: "personal", category: "personal", state: "confirmed", visibility: "private", ownerUserId: 7,
  title: "Dentist", detail: "Root canal, Dr. Singh", location: null, startsAt: local(2027, 4, 12, 13), endsAt: local(2027, 4, 12, 15), allDay: false, timezone: TZ,
  requiresAcknowledgement: false, acknowledged: false, taskRef: null, sourceType: null, sourceRef: null, recurrence: null, ...over,
});

describe("a stored event becomes entries that name their record", () => {
  it("carries its own reference as its source, and a deep link derived from it", () => {
    const [e] = toEntries(event(), FROM, TO, NOW);
    expect(e!.source).toEqual({ sourceType: "calendarEvent", sourceRef: "CAL-1", generatedBy: "personal_event" });
    expect(e!.deepLink).toBe("/calendarEvent/CAL-1");
    expect(e!.basis).toBe("record");
    expect(e!.state).toBe("confirmed");
  });

  it("expands a recurring event into one entry per occurrence, each with its own key", () => {
    const meeting = event({ eventRef: "CAL-2", kind: "company", category: "safety", visibility: "operational", title: "Tailgate", startsAt: local(2027, 4, 12, 7), endsAt: local(2027, 4, 12, 7, 30), recurrence: { frequency: "weekdays", timezone: TZ, anchorAt: local(2027, 4, 12, 7) } });
    const entries = toEntries(meeting, FROM, TO, NOW);
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map(e => e.eventKey)).size).toBe(5);
    expect(entries.every(e => e.source.sourceRef === "CAL-2" && e.endsAt!.getTime() - e.at.getTime() === 30 * 60_000)).toBe(true);
  });

  it("a required event nobody acknowledged is due, then overdue; a cancelled one is present and says so", () => {
    const standDown = event({ kind: "company", category: "safety", visibility: "operational", state: "required", requiresAcknowledgement: true, title: "Safety stand-down" });
    expect(toEntries(standDown, FROM, TO, NOW)[0]!.severity).toBe("due");
    expect(toEntries(standDown, FROM, TO, local(2027, 4, 13, 9))[0]!.severity).toBe("overdue");
    expect(toEntries({ ...standDown, acknowledged: true }, FROM, TO, NOW)[0]!.severity).toBe("informational");
    const cancelled = toEntries(event({ state: "cancelled" }), FROM, TO, NOW)[0]!;
    expect(cancelled.title).toBe("Cancelled — Dentist");
    expect(cancelled.state).toBe("cancelled");
  });

  it("an all-day event in Edmonton on the 12th stays on the 12th, on both sides of midnight UTC", () => {
    // 2027-04-12 00:00 Edmonton is 06:00Z; a window that starts at 00:00Z on the 12th and a window
    // that starts at 00:00 Edmonton both contain it, and a window that ends at 00:00Z on the 12th does not.
    const allDay = event({ allDay: true, startsAt: local(2027, 4, 12, 0), endsAt: local(2027, 4, 13, 0) });
    expect(toEntries(allDay, new Date("2027-04-12T00:00:00Z"), new Date("2027-04-13T00:00:00Z"), NOW)).toHaveLength(1);
    expect(toEntries(allDay, local(2027, 4, 12, 0), local(2027, 4, 13, 0), NOW)).toHaveLength(1);
    expect(toEntries(allDay, new Date("2027-04-11T00:00:00Z"), new Date("2027-04-12T00:00:00Z"), NOW)).toHaveLength(0);
  });
});

describe("views", () => {
  it("the fleet view shows equipment and compliance and nothing personal", () => {
    const entries = [
      toEntries(event(), FROM, TO, NOW)[0]!,
      toEntries(event({ eventRef: "CAL-3", kind: "company", category: "maintenance", visibility: "operational", title: "CVIP" }), FROM, TO, NOW)[0]!,
    ];
    expect(filterForView(entries, "fleet").map(e => e.source.sourceRef)).toEqual(["CAL-3"]);
    expect(filterForView(entries, "my")).toHaveLength(2);
  });

  it("actionable lists the non-informational, worst first", () => {
    const entries = [
      toEntries(event({ eventRef: "A", kind: "company", category: "safety", visibility: "operational", state: "required", startsAt: local(2027, 4, 9, 7) }), local(2027, 4, 8, 0), TO, NOW)[0]!,
      toEntries(event({ eventRef: "B" }), FROM, TO, NOW)[0]!,
      toEntries(event({ eventRef: "C", kind: "company", category: "safety", visibility: "operational", state: "required", startsAt: local(2027, 4, 14, 7) }), FROM, TO, NOW)[0]!,
    ];
    expect(actionable(entries).map(e => e.source.sourceRef)).toEqual(["A", "C"]);
  });
});

describe("availability shows the window and never the words", () => {
  const dentist = toEntries(event(), FROM, TO, NOW)[0]!;
  const leave = fromProjection(project({ layer: "shift", title: "Leave — vacation", detail: null, at: local(2027, 4, 14, 0), endsAt: local(2027, 4, 15, 0), allDay: true, severity: "informational", visibility: "operational", ownerUserId: 7, source: { sourceType: "leaveRequest", sourceRef: "LR-1", generatedBy: "leave_projection" } }));

  it("redacts a private appointment for a scheduler and reports UNAVAILABLE for its window, without its title", () => {
    const forDispatch = visibleTo([dentist, leave], { kind: "operational", userId: 3 });
    const a = availabilityFor({ userId: 7, from: FROM, to: TO, entries: forDispatch, rotationOn: true });
    expect(a.status).toBe("UNAVAILABLE");
    expect(a.windows.map(w => [w.status, w.basis])).toEqual([["UNAVAILABLE", "calendarEvent"], ["UNAVAILABLE", "leaveRequest"]]);
    expect(a.windows[0]!.from.toISOString()).toBe(local(2027, 4, 12, 13).toISOString());
    const text = JSON.stringify(a);
    expect(text).not.toContain("Dentist");
    expect(text).not.toContain("Root canal");
    expect(text).not.toContain("Dr. Singh");
    expect(Object.keys(a.windows[0]!).sort()).toEqual(["basis", "from", "status", "to"]);
  });

  it("is UNKNOWN with nothing to go on, not AVAILABLE", () => {
    expect(availabilityFor({ userId: 7, from: FROM, to: TO, entries: [] }).status).toBe("UNKNOWN");
    expect(availabilityFor({ userId: 7, from: FROM, to: TO, entries: [], rotationOn: true }).status).toBe("AVAILABLE");
    expect(availabilityFor({ userId: 7, from: FROM, to: TO, entries: [], rotationOn: false }).status).toBe("OFF_DUTY");
    expect(availabilityFor({ userId: 7, from: FROM, to: TO, entries: [], dutyStatus: "on_duty" }).status).toBe("ON_DUTY");
  });

  it("a dispatch booking reads ASSIGNED and ranks below UNAVAILABLE", () => {
    const booked = availabilityFor({ userId: 7, from: FROM, to: TO, entries: [], rotationOn: true, assignments: [{ from: local(2027, 4, 11, 6), to: local(2027, 4, 11, 18), ref: "RB-1" }] });
    expect(booked.status).toBe("ASSIGNED");
    expect(booked.windows[0]!.basis).toBe("resourceBooking");
    const both = availabilityFor({ userId: 7, from: FROM, to: TO, entries: visibleTo([dentist], { kind: "operational", userId: 3 }), assignments: [{ from: local(2027, 4, 11, 6), to: local(2027, 4, 11, 18), ref: "RB-1" }] });
    expect(both.status).toBe("UNAVAILABLE");
  });

  it("an entry outside the window does not count", () => {
    const far = toEntries(event({ startsAt: local(2027, 5, 12, 13), endsAt: local(2027, 5, 12, 15) }), local(2027, 5, 1, 0), local(2027, 6, 1, 0), NOW)[0]!;
    expect(availabilityFor({ userId: 7, from: FROM, to: TO, entries: [far], rotationOn: true }).status).toBe("AVAILABLE");
  });
});
