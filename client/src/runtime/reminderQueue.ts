/**
 * 0170 — the device's half of the reminder engine.
 *
 * The rule, the same one the evidence outbox runs on: no signal stops synchronization, not the
 * worker. While the phone can reach the server it pulls the schedule (`work.deviceSchedule`);
 * from then on this module answers "what is due now" from the copy it holds, records what the
 * person did (acknowledge, snooze, complete) with a reference minted once per tap, and replays
 * the record when service returns (`work.deviceActionsApply`). The server applies each reference
 * exactly once, so a replay that was cut off halfway is simply sent again.
 *
 * What the device does NOT do: decide. A compliance reminder tapped Done on the phone is a
 * report that a person tapped Done at a time; the server records who and when and whether the
 * work was actually verified. And nothing here promises to wake the phone: a local notification
 * is scheduled under the operating system's own rules, and the entry says so.
 */

import type { Clock, LocalStore } from "./contracts";

export type ScheduleEntry = {
  reminderRef: string;
  version: number;
  fireAt: string;
  title: string;
  body: string | null;
  level: "normal" | "important" | "alarm" | "compliance";
  requiresAcknowledgement: boolean;
  deepLink: string | null;
  localNotification: boolean;
  snoozeChoices: readonly string[];
};

export type LocalSnoozeChoice =
  | { kind: "preset"; preset: "5m" | "15m" | "30m" | "1h" }
  | { kind: "tonight" } | { kind: "tomorrow" } | { kind: "custom"; at: string };

export type PendingAction = {
  actionRef: string;
  reminderRef: string;
  action: "acknowledged" | "snoozed" | "completed";
  occurredAt: string;
  snoozeChoice?: LocalSnoozeChoice | null;
  /** What the phone believes the reminder's time became, so a snooze re-arms locally before the server confirms. */
  localFireAt?: string | null;
  attempts: number;
  lastError: string | null;
};

export type ReplayResult = { actionRef: string; outcome: "applied" | "duplicate" | "refused"; reason?: string };

export type ReplayTransport = {
  applyDeviceActions(input: { deviceRef: string | null; actions: PendingAction[] }): Promise<{ results: ReplayResult[] }>;
};

const SCHEDULE_KEY = "reminders.schedule";
const PENDING_KEY = "reminders.pending";
const uid = () => `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Presets the phone can resolve on its own. "Tonight" and "tomorrow" need the zone and are left to the server's confirmation. */
const PRESET_MINUTES: Record<"5m" | "15m" | "30m" | "1h", number> = { "5m": 5, "15m": 15, "30m": 30, "1h": 60 };

export class ReminderQueue {
  constructor(private store: LocalStore, private clock: Clock, private deviceRef: string | null = null) {}

  /** The server's schedule replaces the copy. Pending actions are kept: they are the device's own record. */
  async replaceSchedule(entries: readonly ScheduleEntry[], fetchedAt: Date): Promise<void> {
    await this.store.setMeta(SCHEDULE_KEY, JSON.stringify({ fetchedAt: fetchedAt.toISOString(), entries }));
  }

  async schedule(): Promise<{ fetchedAt: string | null; entries: ScheduleEntry[] }> {
    const raw = await this.store.getMeta(SCHEDULE_KEY);
    if (!raw) return { fetchedAt: null, entries: [] };
    const parsed = JSON.parse(raw) as { fetchedAt: string; entries: ScheduleEntry[] };
    return { fetchedAt: parsed.fetchedAt, entries: parsed.entries };
  }

  async pending(): Promise<PendingAction[]> {
    const raw = await this.store.getMeta(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingAction[]) : [];
  }

  private async savePending(list: PendingAction[]): Promise<void> {
    await this.store.setMeta(PENDING_KEY, JSON.stringify(list));
  }

  /**
   * What should ring now: entries whose time has come, whose local record does not already say
   * the person dealt with them. A snooze the phone recorded re-arms the entry at the snoozed time
   * before the server has confirmed it, because the person is standing there.
   */
  async due(now: Date = this.clock.now()): Promise<ScheduleEntry[]> {
    const { entries } = await this.schedule();
    const pending = await this.pending();
    const out: ScheduleEntry[] = [];
    for (const e of entries) {
      const mine = pending.filter(p => p.reminderRef === e.reminderRef).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
      const last = mine[mine.length - 1];
      if (last && (last.action === "acknowledged" || last.action === "completed")) continue;
      const fireAt = last?.action === "snoozed" && last.localFireAt ? last.localFireAt : e.fireAt;
      if (new Date(fireAt).getTime() <= now.getTime()) out.push({ ...e, fireAt });
    }
    return out.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }

  /** The person tapped something. Recorded once, locally, with its own reference. */
  async record(input: { reminderRef: string; action: "acknowledged" | "snoozed" | "completed"; snoozeChoice?: LocalSnoozeChoice | null; at?: Date }): Promise<PendingAction> {
    const at = input.at ?? this.clock.now();
    if (input.action === "snoozed" && !input.snoozeChoice) throw new Error("A snooze names its choice");
    let localFireAt: string | null = null;
    if (input.action === "snoozed" && input.snoozeChoice) {
      if (input.snoozeChoice.kind === "preset") localFireAt = new Date(at.getTime() + PRESET_MINUTES[input.snoozeChoice.preset] * 60_000).toISOString();
      else if (input.snoozeChoice.kind === "custom") localFireAt = input.snoozeChoice.at;
      // tonight / tomorrow: the zone decides; the phone waits for the server's answer and does not ring meanwhile.
      else localFireAt = new Date(at.getTime() + 12 * 3_600_000).toISOString();
    }
    const action: PendingAction = { actionRef: uid(), reminderRef: input.reminderRef, action: input.action, occurredAt: at.toISOString(), snoozeChoice: input.snoozeChoice ?? null, localFireAt, attempts: 0, lastError: null };
    const list = await this.pending();
    list.push(action);
    await this.savePending(list);
    return action;
  }

  /**
   * Send the record. Applied and duplicate both mean the server has it and the entry is dropped
   * here; refused is kept with its reason for the person to see, and never retried blindly — the
   * reason is the server's and retrying does not change it. A transport failure keeps everything.
   */
  async replay(transport: ReplayTransport): Promise<{ sent: number; applied: number; duplicates: number; refused: PendingAction[]; kept: number }> {
    const list = await this.pending();
    const toSend = list.filter(p => p.lastError === null || p.attempts < 5);
    if (!toSend.length) return { sent: 0, applied: 0, duplicates: 0, refused: [], kept: list.length };
    let results: ReplayResult[];
    try {
      results = (await transport.applyDeviceActions({ deviceRef: this.deviceRef, actions: toSend })).results;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const p of toSend) { p.attempts++; p.lastError = msg; }
      await this.savePending(list);
      return { sent: toSend.length, applied: 0, duplicates: 0, refused: [], kept: list.length };
    }
    const byRef = new Map(results.map(r => [r.actionRef, r]));
    const refused: PendingAction[] = [];
    const remaining: PendingAction[] = [];
    let applied = 0, duplicates = 0;
    for (const p of list) {
      const r = byRef.get(p.actionRef);
      if (!r) { remaining.push(p); continue; }
      if (r.outcome === "applied") applied++;
      else if (r.outcome === "duplicate") duplicates++;
      else { p.attempts = 5; p.lastError = r.reason ?? "refused"; refused.push(p); remaining.push(p); }
    }
    await this.savePending(remaining);
    return { sent: toSend.length, applied, duplicates, refused, kept: remaining.length };
  }

  /** What the UI shows beside the bell. */
  async status(now: Date = this.clock.now()): Promise<{ scheduled: number; dueNow: number; pendingReplay: number; refused: number; fetchedAt: string | null; stale: boolean }> {
    const { entries, fetchedAt } = await this.schedule();
    const pending = await this.pending();
    const due = await this.due(now);
    return {
      scheduled: entries.length, dueNow: due.length, pendingReplay: pending.filter(p => p.attempts < 5).length, refused: pending.filter(p => p.attempts >= 5).length, fetchedAt,
      // A copy older than a day is a copy that may be missing a reminder somebody set this morning.
      stale: !fetchedAt || now.getTime() - new Date(fetchedAt).getTime() > 86_400_000,
    };
  }
}
