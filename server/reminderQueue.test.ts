/**
 * 0170 — the device's reminder queue: what rings with no service, and what replays once.
 *
 * Runs the client module in Node against the memory adapters, the way fieldRuntime.test.ts runs
 * the evidence outbox. Every instant is explicit.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore, SettableClock } from "../client/src/runtime/adapters/memory";
import { ReminderQueue, type ReplayTransport, type ScheduleEntry } from "../client/src/runtime/reminderQueue";

const T0 = new Date("2027-04-11T05:00:00Z");
const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  reminderRef: "RMD-1", version: 1, fireAt: "2027-04-11T06:00:00.000Z", title: "Bring respirator", body: null, level: "alarm", requiresAcknowledgement: false,
  deepLink: null, localNotification: true, snoozeChoices: ["5m", "15m", "30m", "1h", "tonight", "tomorrow", "custom"], ...over,
});
function rig(at = T0) {
  const clock = new SettableClock(at);
  const store = new MemoryStore();
  return { clock, store, queue: new ReminderQueue(store, clock, "DEV-1") };
}
const at = (iso: string) => new Date(iso);

describe("what rings with no service", () => {
  it("is what the cached schedule says is due, and nothing before its time", async () => {
    const { queue, clock } = rig();
    await queue.replaceSchedule([entry(), entry({ reminderRef: "RMD-2", fireAt: "2027-04-11T09:00:00.000Z" })], T0);
    expect(await queue.due(at("2027-04-11T05:59:00Z"))).toEqual([]);
    expect((await queue.due(at("2027-04-11T06:00:00Z"))).map(e => e.reminderRef)).toEqual(["RMD-1"]);
    clock.set(at("2027-04-11T09:30:00Z"));
    expect((await queue.due()).map(e => e.reminderRef)).toEqual(["RMD-1", "RMD-2"]);
  });

  it("stops ringing once the person answered locally, and re-arms after a local snooze", async () => {
    const { queue } = rig();
    await queue.replaceSchedule([entry()], T0);
    await queue.record({ reminderRef: "RMD-1", action: "snoozed", snoozeChoice: { kind: "preset", preset: "15m" }, at: at("2027-04-11T06:01:00Z") });
    expect(await queue.due(at("2027-04-11T06:10:00Z"))).toEqual([]);
    expect((await queue.due(at("2027-04-11T06:16:00Z"))).map(e => e.fireAt)).toEqual(["2027-04-11T06:16:00.000Z"]);
    await queue.record({ reminderRef: "RMD-1", action: "acknowledged", at: at("2027-04-11T06:17:00Z") });
    expect(await queue.due(at("2027-04-11T07:00:00Z"))).toEqual([]);
  });

  it("a snooze without a choice is refused on the device, before anything is recorded", async () => {
    const { queue } = rig();
    await expect(queue.record({ reminderRef: "RMD-1", action: "snoozed" })).rejects.toThrow(/names its choice/);
    expect(await queue.pending()).toEqual([]);
  });

  it("a fresh schedule replaces the copy and keeps the device's own record of what it did", async () => {
    const { queue } = rig();
    await queue.replaceSchedule([entry()], T0);
    await queue.record({ reminderRef: "RMD-1", action: "acknowledged", at: at("2027-04-11T06:05:00Z") });
    await queue.replaceSchedule([entry({ version: 2 })], at("2027-04-11T06:06:00Z"));
    expect((await queue.schedule()).entries[0]!.version).toBe(2);
    expect(await queue.pending()).toHaveLength(1);
  });
});

describe("replay, once", () => {
  const transport = (impl: (actions: { actionRef: string }[]) => { actionRef: string; outcome: "applied" | "duplicate" | "refused"; reason?: string }[]): ReplayTransport & { calls: number } => {
    const t = { calls: 0, applyDeviceActions: async (input: { actions: { actionRef: string }[] }) => { t.calls++; return { results: impl(input.actions) }; } };
    return t;
  };

  it("sends the pending record, drops what the server applied or already had, keeps what it refused with the reason", async () => {
    const { queue } = rig();
    await queue.replaceSchedule([entry(), entry({ reminderRef: "RMD-2" })], T0);
    const a = await queue.record({ reminderRef: "RMD-1", action: "acknowledged", at: at("2027-04-11T06:05:00Z") });
    const b = await queue.record({ reminderRef: "RMD-2", action: "completed", at: at("2027-04-11T06:06:00Z") });
    const c = await queue.record({ reminderRef: "RMD-2", action: "acknowledged", at: at("2027-04-11T06:07:00Z") });
    const server = transport(actions => actions.map(x => x.actionRef === a.actionRef ? { actionRef: x.actionRef, outcome: "applied" as const } : x.actionRef === b.actionRef ? { actionRef: x.actionRef, outcome: "duplicate" as const } : { actionRef: x.actionRef, outcome: "refused" as const, reason: "already completed" }));
    const r = await queue.replay(server);
    expect(r).toMatchObject({ sent: 3, applied: 1, duplicates: 1, kept: 1 });
    expect(r.refused.map(x => x.actionRef)).toEqual([c.actionRef]);
    const left = await queue.pending();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ actionRef: c.actionRef, lastError: "already completed" });
    // A refusal is the server's answer; it is not sent again.
    const again = await queue.replay(server);
    expect(again.sent).toBe(0);
    expect(server.calls).toBe(1);
  });

  it("a transport failure keeps everything and counts the attempt, so nothing is lost and nothing is invented", async () => {
    const { queue } = rig();
    await queue.replaceSchedule([entry()], T0);
    const a = await queue.record({ reminderRef: "RMD-1", action: "acknowledged", at: at("2027-04-11T06:05:00Z") });
    const dead: ReplayTransport = { applyDeviceActions: async () => { throw new Error("no service"); } };
    const r = await queue.replay(dead);
    expect(r).toMatchObject({ sent: 1, applied: 0, kept: 1 });
    expect((await queue.pending())[0]).toMatchObject({ actionRef: a.actionRef, attempts: 1, lastError: "no service" });
    // The same reference goes out on the retry — which is what lets the server say "duplicate" instead of acting twice.
    const alive = transport(actions => actions.map(x => ({ actionRef: x.actionRef, outcome: "applied" as const })));
    await queue.replay(alive);
    expect(await queue.pending()).toEqual([]);
  });

  it("status says what the bell should show, and calls a day-old copy stale", async () => {
    const { queue } = rig();
    await queue.replaceSchedule([entry()], T0);
    expect(await queue.status(at("2027-04-11T06:30:00Z"))).toMatchObject({ scheduled: 1, dueNow: 1, pendingReplay: 0, refused: 0, stale: false });
    expect((await queue.status(at("2027-04-12T06:30:00Z"))).stale).toBe(true);
  });
});
