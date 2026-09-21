import { describe, expect, it } from "vitest";
import {
  composeMyDayView, composeOfficeView, contextRibbon, defaultPortal, exceptionIndicator, greeting, quickCaptureActions,
  searchGroups, switcherModel, syncIndicator, type ExceptionItem, type InboxItem, type MyDay,
} from "../client/src/portal/viewModels";

const link = { portal: "dispatch_operations", route: "/x" };
const ex = (over: Partial<ExceptionItem> & { key: string }): ExceptionItem => ({ category: "dispatch", severity: "medium", title: over.key, reason: "r", action: "a", deepLink: link, dueAt: null, ...over });
const inbox = (over: Partial<InboxItem> & { ref: string }): InboxItem => ({ kind: "task", title: over.ref, detail: null, dueAt: null, since: "2026-09-10T05:00:00Z", deepLink: link, ...over });
const day = (over: Partial<MyDay> = {}): MyDay => ({ portals: ["field_workforce"], attention: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {}, headline: "Nothing needs your attention" }, toDo: { count: 0, items: [] }, waitingFor: { count: 0, items: [] }, next: null, ...over });

describe("which portal opens first", () => {
  it("opens the most operational portal the person holds, and lists only those", () => {
    expect(defaultPortal(["executive", "management", "dispatch_operations"])).toBe("dispatch_operations");
    expect(defaultPortal(["worker_self_service", "field_workforce"])).toBe("field_workforce");
    expect(defaultPortal(["incident_emergency", "field_workforce"])).toBe("incident_emergency");
    expect(defaultPortal([])).toBeNull();
    expect(switcherModel(["executive", "finance_billing"], "finance_billing").map(s => [s.label, s.current])).toEqual([["Finance", true], ["Executive", false]]);
  });
});

describe("the driver's first screen", () => {
  it("greets by the hour and first name, shows the assignment, three attention items worst first, the next action, and six capture buttons", () => {
    const view = composeMyDayView({
      portal: "field_workforce", now: new Date("2026-09-10T06:30:00"), displayName: "Dylan Reid",
      myDay: day({ attention: { total: 5, bySeverity: { critical: 1, high: 1, medium: 3, low: 0 }, byCategory: {}, headline: "1 critical" }, toDo: { count: 1, items: [inbox({ ref: "JOB-24198", title: "JOB-24198 — Unit 142", detail: "Water haul, Acme 12-01" })] }, waitingFor: { count: 1, items: [inbox({ ref: "P", kind: "ai_proposal", title: "Confirm your fuel receipt" })] }, next: { kind: "exception", title: "Drive to Disposal Facility", action: "Navigate", deepLink: link } }),
      exceptions: [ex({ key: "a", severity: "medium", title: "Fuel receipt needs review" }), ex({ key: "b", severity: "critical", title: "Disposal ticket needs verification" }), ex({ key: "c", severity: "low", title: "TDG certificate expires in 21 days" }), ex({ key: "d", severity: "high", title: "Odometer missing on Trip 9" }), ex({ key: "e", severity: "medium", title: "Another" })],
    });
    expect(view.greeting).toBe("GOOD MORNING, DYLAN");
    expect(view.assignment).toEqual({ title: "JOB-24198 — Unit 142", detail: "Water haul, Acme 12-01", deepLink: link });
    expect(view.attention.headline).toBe("5 things need attention");
    expect(view.attention.items.map(i => i.title)).toEqual(["Disposal ticket needs verification", "Odometer missing on Trip 9", "Fuel receipt needs review"]);
    expect(view.attention.more).toBe(2);
    expect(view.next).toEqual({ title: "Drive to Disposal Facility", action: "Navigate", deepLink: link });
    expect(view.waitingFor).toEqual({ count: 1, first: "Confirm your fuel receipt" });
    expect(view.quickCapture.map(a => a.label)).toEqual(["Receipt", "Ticket", "Photo", "Defect", "Incident", "Voice"]);
  });

  it("says so when there is nothing, and singularizes one thing", () => {
    const quiet = composeMyDayView({ portal: "field_workforce", now: new Date("2026-09-10T19:00:00"), displayName: null, myDay: day(), exceptions: [] });
    expect(quiet.greeting).toBe("GOOD EVENING");
    expect(quiet.assignment).toBeNull();
    expect(quiet.attention.headline).toBe("Nothing needs your attention");
    const one = composeMyDayView({ portal: "field_workforce", now: new Date(), displayName: null, myDay: day({ attention: { total: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0 }, byCategory: {}, headline: "" } }), exceptions: [ex({ key: "x", severity: "high" })] });
    expect(one.attention.headline).toBe("1 thing needs attention");
  });

  it("greets correctly around the clock", () => {
    expect(greeting(new Date("2026-09-10T03:00:00"), "A")).toBe("GOOD NIGHT, A");
    expect(greeting(new Date("2026-09-10T13:00:00"), "A B")).toBe("GOOD AFTERNOON, A");
  });
});

describe("the office's first screen is the same backend, read as counts", () => {
  it("rows every category, zeros included, in the order the office reads them", () => {
    const view = composeOfficeView(
      [ex({ key: "1", severity: "critical", category: "critical" }), ex({ key: "2", category: "billing" }), ex({ key: "3", category: "finance", severity: "high" }), ex({ key: "4", category: "fleet" }), ex({ key: "5", category: "workforce" })],
      [inbox({ ref: "q", kind: "ai_question" }), inbox({ ref: "t" })],
    );
    expect(view.rows.map(r => [r.label, r.count])).toEqual([["Critical", 1], ["Needs review", 4], ["Waiting on field", 1], ["Billing", 2], ["Dispatch", 1], ["Fleet", 1], ["Workforce", 1]]);
  });
});

describe("quick capture is for people who capture", () => {
  it("gives the yard photo, defect and voice; the office bills and receipts; the executive nothing", () => {
    expect(quickCaptureActions("fleet_maintenance").map(a => a.key)).toEqual(["photo", "defect", "voice"]);
    expect(quickCaptureActions("finance_billing").map(a => a.key)).toEqual(["bill", "receipt"]);
    expect(quickCaptureActions("executive")).toEqual([]);
    expect(quickCaptureActions("auditor_regulator")).toEqual([]);
  });
  it("maps a capture to the server form where one exists, and to pure evidence where none does", () => {
    const byKey = Object.fromEntries(quickCaptureActions("field_workforce").map(a => [a.key, a]));
    expect(byKey.receipt.formKey).toBe("fuel_receipt");
    expect(byKey.ticket.formKey).toBe("disposal_ticket");
    expect(byKey.defect.formKey).toBe("defect_report");
    expect(byKey.photo.formKey).toBeNull();
    expect(byKey.voice.needsVoice).toBe(true);
  });
});

describe("the indicators", () => {
  it("badges the critical count when there is one, else the total, and hides at zero", () => {
    expect(exceptionIndicator({ total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {}, headline: "" })).toEqual({ badge: null, tone: "quiet" });
    expect(exceptionIndicator({ total: 7, bySeverity: { critical: 2, high: 1, medium: 4, low: 0 }, byCategory: {}, headline: "" })).toEqual({ badge: "2", tone: "critical" });
    expect(exceptionIndicator({ total: 3, bySeverity: { critical: 0, high: 1, medium: 2, low: 0 }, byCategory: {}, headline: "" })).toEqual({ badge: "3", tone: "high" });
  });

  it("says what the outbox is doing in the words a worker reads", () => {
    const counts = (o: Partial<Record<string, number>>) => ({ saved_locally: 0, queued: 0, syncing: 0, synchronized: 0, failed: 0, conflict: 0, ...o }) as never;
    expect(syncIndicator(null, false)).toEqual({ label: "Offline", tone: "offline" });
    expect(syncIndicator({ counts: counts({ synchronized: 4 }), oldestUnsyncedCaptureMinutes: null }, true)).toEqual({ label: "All synchronized", tone: "ok" });
    expect(syncIndicator({ counts: counts({ queued: 3 }), oldestUnsyncedCaptureMinutes: 450 }, false)).toEqual({ label: "Offline · 3 queued · oldest 8h", tone: "offline" });
    expect(syncIndicator({ counts: counts({ queued: 1, syncing: 1 }), oldestUnsyncedCaptureMinutes: 7 }, true)).toEqual({ label: "2 pending · oldest 7m", tone: "pending" });
    expect(syncIndicator({ counts: counts({ failed: 1, queued: 2 }), oldestUnsyncedCaptureMinutes: 30 }, true)).toEqual({ label: "1 needs attention · 2 pending", tone: "attention" });
  });

  it("puts the portal, the assignment and the offline or revoked state on the ribbon", () => {
    expect(contextRibbon({ portal: "field_workforce", assignment: { title: "JOB-1", detail: null, deepLink: link }, online: false, deviceStatus: "active" })).toEqual(["Field", "JOB-1", "Working offline"]);
    expect(contextRibbon({ portal: "office_administration", assignment: null, online: true, deviceStatus: "revoked" })).toEqual(["Office", "Device revoked — recapture on an enrolled device"]);
  });
});

describe("search groups by what was found", () => {
  it("groups hits by entity, largest group first, with readable labels", () => {
    const g = searchGroups([
      { entityType: "vendorBill", entityId: 1, label: "BILL-1", status: "mismatch", deepLink: link },
      { entityType: "unit", entityId: 1, label: "Unit 142", status: null, deepLink: link },
      { entityType: "unit", entityId: 2, label: "Unit 1420", status: null, deepLink: link },
    ]);
    expect(g.map(x => [x.label, x.hits.length])).toEqual([["Units", 2], ["Vendor bills", 1]]);
  });
});
