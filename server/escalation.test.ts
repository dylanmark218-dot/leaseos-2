/**
 * v22.20 — tests 14 to 18: somebody has to actually have it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_POLICY, escalationOutcome, mayOptOut, type NotificationState } from "./_core/escalation";
import { confirmEnforcementEvent, type ConfirmInput } from "./_core/enforcementCommit";
import { getDb } from "./db";
import type { ViolationFacts } from "./_core/enforcement";

const OCCURRED = new Date("2026-09-11T08:42:00Z");
const after = (min: number) => new Date(OCCURRED.getTime() + min * 60_000);
const note = (o: Partial<NotificationState> = {}): NotificationState => ({
  notificationKey: `N-${Math.random().toString(36).slice(2, 7)}`, recipientRole: "dispatcher", recipientUserId: 1,
  channel: "in_app", status: "delivered", sentAt: after(0), viewedAt: null, acknowledgedAt: null, ...o,
});
const outcome = (notifications: NotificationState[], now: Date) =>
  escalationOutcome({ occurredAt: OCCURRED, notifications, policy: DEFAULT_CRITICAL_POLICY, now });

describe("viewed is not acknowledged", () => {
  it("keeps escalating for a notification somebody looked at and did not accept", () => {
    const r = outcome([note({ status: "viewed", viewedAt: after(1) })], after(6));
    expect(r.acknowledged).toBe(false);
    expect(r.dueLevel).toBe(1);
    expect(r.toNotify).toContain("maintenance_manager");
    expect(r.reasons.join(" ")).toContain("viewing is not acceptance");
  });

  it("stops the moment anybody acknowledges, and names who", () => {
    const r = outcome([note({ status: "viewed", viewedAt: after(1) }), note({ recipientRole: "safety", recipientUserId: 7, status: "acknowledged", acknowledgedAt: after(3) })], after(30));
    expect(r.acknowledged).toBe(true);
    expect(r.acknowledgedBy).toMatchObject({ role: "safety", userId: 7 });
    expect(r.toNotify).toEqual([]);
    expect(r.reasons[0]).toContain("escalation stops here");
  });
});

describe("the ladder climbs on time, not on delivery", () => {
  it("names nobody before the first level is due, and level 0 immediately", () => {
    expect(outcome([], new Date(OCCURRED.getTime() - 1)).dueLevel).toBe(-1);
    const immediate = outcome([], after(0));
    expect(immediate.dueLevel).toBe(0);
    expect(immediate.toNotify).toEqual(["dispatcher", "office", "safety", "shop_lead"]);
  });

  it("adds each level as its time passes and never re-tells somebody already told", () => {
    const told = [note({ recipientRole: "dispatcher" }), note({ recipientRole: "office" }), note({ recipientRole: "safety" }), note({ recipientRole: "shop_lead" })];
    expect(outcome(told, after(6)).toNotify).toEqual(["maintenance_manager"]);
    expect(outcome(told, after(12)).toNotify).toEqual(["maintenance_manager", "management"]);
    expect(outcome(told, after(25)).toNotify).toEqual(["maintenance_manager", "management", "administrator"]);
  });

  it("measures from when the event happened, not from when a message got sent", () => {
    // A notification that sat in a queue for four minutes buys no grace.
    const late = [note({ sentAt: after(4) })];
    expect(outcome(late, after(6)).dueLevel).toBe(1);
  });

  it("says plainly when everyone has been told and nobody has answered", () => {
    const everyone = DEFAULT_CRITICAL_POLICY.levels.flatMap(l => l.roles).map(r => note({ recipientRole: r }));
    const r = outcome(everyone, after(40));
    expect(r.toNotify).toEqual([]);
    expect(r.reasons[0]).toContain("nobody has acknowledged");
    expect(r.awaiting.length).toBe(everyone.length);
  });
});

describe("a failed channel is not a delivered notification", () => {
  it("keeps the event outstanding when the push failed, and names the channel", () => {
    const r = outcome([note({ channel: "push", status: "failed" })], after(6));
    expect(r.acknowledged).toBe(false);
    expect(r.failedChannels).toEqual([{ role: "dispatcher", channel: "push" }]);
    expect(r.reasons.join(" ")).toContain("the in-app notification remains outstanding");
    // And it still escalates.
    expect(r.toNotify).toContain("maintenance_manager");
  });

  it("stops counting a failed channel once that person acknowledges another way", () => {
    const r = outcome([note({ channel: "push", status: "failed" }), note({ channel: "in_app", status: "acknowledged", acknowledgedAt: after(2) })], after(30));
    expect(r.acknowledged).toBe(true);
    expect(r.failedChannels).toEqual([]);
  });
});

describe("roles in the critical policy cannot opt out", () => {
  it("refuses opt-out for a named role and permits it for others", () => {
    expect(mayOptOut("dispatcher", DEFAULT_CRITICAL_POLICY).allowed).toBe(false);
    expect(mayOptOut("safety", DEFAULT_CRITICAL_POLICY).reason).toContain("cannot opt out");
    expect(mayOptOut("driver", DEFAULT_CRITICAL_POLICY).allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
beforeAll(async () => { if (!URL) return; db = await getDb(); });

let n = 0;
const violation = (o: Partial<ViolationFacts> = {}): ViolationFacts => ({
  violationRef: `V-${++n}`, system: "brakes", ownCode: "LEASEOS.BRAKES.CHAMBER", sourceReference: null,
  citationIssued: false, outOfService: false, oosScope: null, defectRequired: false, repairRequired: false, courtAction: false, ...o,
});
const input = (over: Partial<ConfirmInput> = {}): ConfirmInput => ({
  extractionRef: null, eventType: "roadside_inspection", jurisdiction: "CA-AB",
  agency: `agency-${Math.random().toString(36).slice(2, 8)}`, occurredAt: OCCURRED,
  inspectionReportNumber: `INSP-${Math.random().toString(36).slice(2, 8)}`, inspectionLevel: "I",
  inspectionResult: "out_of_service", operatorId: 221, unitId: 127, trailerId: 52,
  subjectRefFor: s => (s === "vehicle" ? "UNIT-127" : s === "driver" ? "D-221" : null),
  violations: [], confirmedByUserId: 9, ...over,
});

d("the alert is enqueued in the same transaction as the order", () => {
  it("enqueues critical for a prohibition, urgent for a repair, routine for neither", async () => {
    const seen: { severity: string; orderRefs: string[] }[] = [];
    const enqueue = async (_tx: unknown, e: { severity: string; orderRefs: string[] }) => { seen.push({ severity: e.severity, orderRefs: e.orderRefs }); };

    await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({ enqueue, violations: [violation({ outOfService: true, oosScope: "vehicle" })] })));
    await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({ enqueue, inspectionResult: "requires_attention", violations: [violation({ repairRequired: true })] })));
    await db.transaction((tx: never) => confirmEnforcementEvent(tx, input({ enqueue, inspectionResult: "pass", violations: [violation({ citationIssued: true })] })));

    expect(seen.map(s => s.severity)).toEqual(["critical", "urgent", "routine"]);
    expect(seen[0].orderRefs).toHaveLength(1);
  });

  it("writes nothing at all when the enqueue throws — the alert and the order stand or fall together", async () => {
    const i = input({
      enqueue: async () => { throw new Error("outbox unavailable"); },
      violations: [violation({ outOfService: true, oosScope: "vehicle" })],
    });
    await expect(db.transaction((tx: never) => confirmEnforcementEvent(tx, i))).rejects.toThrow("outbox unavailable");

    // The transaction rolled back, so confirming again is a first confirmation.
    const seen: string[] = [];
    const retry = await db.transaction((tx: never) => confirmEnforcementEvent(tx, { ...i, enqueue: async (_t: unknown, e: { severity: string }) => { seen.push(e.severity); } }));
    expect(retry.created).toBe(true);
    expect(seen).toEqual(["critical"]);
  });

  it("does not re-enqueue when the same stop is confirmed twice", async () => {
    const seen: string[] = [];
    const i = input({ enqueue: async (_t: unknown, e: { severity: string }) => { seen.push(e.severity); }, violations: [violation({ outOfService: true, oosScope: "vehicle" })] });
    await db.transaction((tx: never) => confirmEnforcementEvent(tx, i));
    await db.transaction((tx: never) => confirmEnforcementEvent(tx, i));
    expect(seen).toEqual(["critical"]);
  });
});
