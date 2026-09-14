/**
 * v22.20 — the calendar, and the three things it must not do.
 */
import { describe, expect, it } from "vitest";
import {
  beforeCutoff, forAudience, isOnShift, MissingProvenance, project, rotationDays,
  severityOf, visibleTo, type Outstanding, type ProjectedEvent,
} from "./_core/calendarProjection";

const NOW = new Date("2026-09-18T08:00:00Z");
const source = { sourceType: "workerQualification", sourceRef: "TDG-8821", generatedBy: "qualification_engine" };
const event = (o: Partial<Parameters<typeof project>[0]> = {}): ProjectedEvent => project({
  layer: "compliance", title: "TDG expires", detail: "Transportation of dangerous goods",
  at: new Date("2026-11-14T00:00:00Z"), endsAt: null, allDay: true,
  severity: "due", visibility: "operational", ownerUserId: 7, source, ...o,
});

describe("an event knows which record it came from", () => {
  it("refuses to project a bare string with no source", () => {
    expect(() => project({
      layer: "compliance", title: "TDG expires soon", detail: null, at: NOW, endsAt: null,
      allDay: true, severity: "due", visibility: "operational", ownerUserId: 7,
      source: { sourceType: "", sourceRef: "", generatedBy: "" },
    })).toThrow(MissingProvenance);
  });

  it("carries the source and a link derived from it, not typed by hand", () => {
    const e = event();
    expect(e.source).toMatchObject({ sourceType: "workerQualification", sourceRef: "TDG-8821" });
    expect(e.deepLink).toBe("/workerQualification/TDG-8821");
    expect(e.eventKey).toContain("TDG-8821");
  });

  it("gives the same record on the same day the same key, so a reprojection does not duplicate", () => {
    expect(event().eventKey).toBe(event().eventKey);
  });
});

describe("dispatch learns the time is taken, not what it is taken for", () => {
  const personal = event({ layer: "personal", title: "Dentist", detail: "Molar, 45 minutes", visibility: "private" });

  it("shows the owner everything", () => {
    const seen = forAudience(personal, { kind: "self", userId: 7 })!;
    expect(seen.title).toBe("Dentist");
    expect(seen.redacted).toBe(false);
  });

  it("shows dispatch Unavailable with no detail — hiding it would read as free", () => {
    const seen = forAudience(personal, { kind: "operational", userId: 99 })!;
    expect(seen.title).toBe("Unavailable");
    expect(seen.detail).toBeNull();
    expect(seen.redacted).toBe(true);
    // Still present: an absent event would show the person as available.
    expect(seen.at).toEqual(personal.at);
  });

  it("keeps an administrative event away from dispatch and shows it to payroll", () => {
    const pay = event({ layer: "payroll", title: "Garnishment review", visibility: "administrative" });
    expect(forAudience(pay, { kind: "operational", userId: 99 })).toBeNull();
    expect(forAudience(pay, { kind: "administrative", userId: 99 })!.redacted).toBe(false);
  });

  it("never gives anything to a client, and never gives one worker another's calendar", () => {
    expect(forAudience(event(), { kind: "client" })).toBeNull();
    expect(forAudience(event(), { kind: "self", userId: 8 })).toBeNull();
  });

  it("filters a whole day at once", () => {
    const day = [event(), event({ layer: "personal", visibility: "private", title: "Appointment" })];
    const forDispatch = visibleTo(day, { kind: "operational", userId: 99 });
    expect(forDispatch).toHaveLength(2);
    expect(forDispatch.filter(e => e.redacted)).toHaveLength(1);
  });
});

describe("late is not the same as stopped", () => {
  it("grades a missing receipt overdue and an expired required qualification blocking", () => {
    const past = new Date("2026-09-01T00:00:00Z");
    expect(severityOf({ dueAt: past, now: NOW, blocksWork: false })).toBe("overdue");
    expect(severityOf({ dueAt: past, now: NOW, blocksWork: true })).toBe("blocking");
  });

  it("says due inside the notice window and informational beyond it", () => {
    expect(severityOf({ dueAt: new Date("2026-10-01T00:00:00Z"), now: NOW, blocksWork: true })).toBe("due");
    expect(severityOf({ dueAt: new Date("2027-06-01T00:00:00Z"), now: NOW, blocksWork: true })).toBe("informational");
  });

  it("is unknown, never fine, when nobody has established the date", () => {
    expect(severityOf({ dueAt: null, now: NOW, blocksWork: true })).toBe("unknown");
  });
});

describe("rotations", () => {
  const seven = { onDays: 7, offDays: 7, anchor: new Date("2026-09-14T00:00:00Z"), label: "7/7" };

  it("runs seven on then seven off from the anchor", () => {
    const days = rotationDays(seven, seven.anchor, 14);
    expect(days.slice(0, 7).every(d => d.on)).toBe(true);
    expect(days.slice(7, 14).every(d => !d.on)).toBe(true);
  });

  it("repeats across the cycle boundary", () => {
    expect(isOnShift(seven, new Date("2026-09-28T00:00:00Z"))).toBe(true);   // next on-hitch
    expect(isOnShift(seven, new Date("2026-10-05T00:00:00Z"))).toBe(false);
  });

  it("answers correctly before the anchor rather than going negative", () => {
    // A rotation set up today still has to describe last month.
    expect(isOnShift(seven, new Date("2026-08-31T00:00:00Z"))).toBe(true);
    expect(isOnShift(seven, new Date("2026-09-07T00:00:00Z"))).toBe(false);
  });

  it("handles an uneven rotation", () => {
    const fourteenSeven = { onDays: 14, offDays: 7, anchor: new Date("2026-09-01T00:00:00Z"), label: "14/7" };
    const days = rotationDays(fourteenSeven, fourteenSeven.anchor, 21);
    expect(days.filter(d => d.on)).toHaveLength(14);
  });
});

describe("what is owed before the cutoff", () => {
  const owed = (label: string, severity: Outstanding["severity"]): Outstanding => ({ label, severity, source });

  it("names the count and the cutoff rather than nudging vaguely", () => {
    const r = beforeCutoff({
      cutoffAt: new Date("2026-09-18T12:00:00Z"), now: NOW,
      items: [owed("Signed field ticket J-8821", "overdue"), owed("Disposal ticket DT-4412", "blocking"), owed("Meal receipt", "due")],
    });
    expect(r.line).toBe("3 item(s) required before the cutoff in 4 h — 1 of them blocking");
    expect(r.blocking).toHaveLength(1);
  });

  it("leaves informational items out of the count", () => {
    const r = beforeCutoff({ cutoffAt: new Date("2026-09-25T12:00:00Z"), now: NOW, items: [owed("T4 available in March", "informational")] });
    expect(r.outstanding).toHaveLength(0);
    expect(r.line).toContain("Nothing outstanding");
  });

  it("says the cutoff has passed rather than reporting a negative countdown", () => {
    const r = beforeCutoff({ cutoffAt: new Date("2026-09-17T12:00:00Z"), now: NOW, items: [owed("Late ticket", "overdue")] });
    expect(r.line).toContain("cutoff passed");
  });
});
