/**
 * v22.20 — routing and reminders, composed over the one readiness module.
 *
 * There is no second readiness verdict here. `readyForShift` decides; this
 * decides who hears about it and when.
 */
import { describe, expect, it } from "vitest";
import { readyForShift, type ReadinessCheck } from "./_core/shiftReadiness";
import { nextReminder, routeByOwner, type Owner } from "./_core/readinessRouting";

const START = new Date("2026-09-18T06:00:00Z");
const check = (o: Partial<ReadinessCheck> = {}): ReadinessCheck => ({
  key: "unit", label: "Unit 127 assigned", state: "satisfied", blocksShift: true, reason: null, ...o,
});

const OWNERS: Record<string, Owner> = {
  permit: "office", orientation: "driver", cvip: "shop", route: "dispatch", medical: "safety",
};
const ownerOf = (c: ReadinessCheck): Owner | null => OWNERS[c.key] ?? null;

describe("the person who can fix it is the one who is told", () => {
  const mixed = [
    check(),
    check({ key: "permit", state: "failed", blocksShift: true, reason: "job permit has not been uploaded" }),
    check({ key: "orientation", state: "failed", blocksShift: false, reason: "client orientation expires tomorrow" }),
    check({ key: "cvip", state: "unknown", blocksShift: true, reason: "no verified inspection record" }),
  ];

  it("groups outstanding work by owner and leaves satisfied checks out of everybody's list", () => {
    const r = routeByOwner(readyForShift({ shiftStartsAt: START, checks: mixed }), ownerOf);
    expect(r.byOwner.map(g => g.owner)).toEqual(["driver", "office", "shop"]);
    expect(r.byOwner.flatMap(g => g.items).some(i => i.state === "satisfied")).toBe(false);
  });

  it("counts only real blocking failures per owner, not unknowns", () => {
    const r = routeByOwner(readyForShift({ shiftStartsAt: START, checks: mixed }), ownerOf);
    expect(r.byOwner.find(g => g.owner === "office")!.blocking).toBe(1);
    // The CVIP is blocking-if-failed but its state is unknown, which is a
    // different problem and a different person's next move.
    expect(r.byOwner.find(g => g.owner === "shop")!.blocking).toBe(0);
  });

  it("lists a check nobody owns rather than dropping it", () => {
    const orphan = [check({ key: "mystery", state: "failed", blocksShift: true, reason: "nobody is assigned this" })];
    const r = routeByOwner(readyForShift({ shiftStartsAt: START, checks: orphan }), ownerOf);
    expect(r.unrouted).toHaveLength(1);
    expect(r.headline).toContain("1 unassigned");
  });

  it("says so plainly when nothing is outstanding, and carries the one verdict through", () => {
    const r = routeByOwner(readyForShift({ shiftStartsAt: START, checks: [check(), check({ key: "route" })] }), ownerOf);
    expect(r.headline).toBe("Nothing outstanding for anyone");
    expect(r.byOwner).toEqual([]);
    expect(r.verdict).toBe("ready");
  });

  it("does not invent a verdict — it reports the one readyForShift reached", () => {
    const incomplete = readyForShift({ shiftStartsAt: START, checks: [check({ key: "cvip", state: "unknown", reason: "no record" })] });
    expect(routeByOwner(incomplete, ownerOf).verdict).toBe(incomplete.verdict);
  });
});

describe("reminders climb rather than repeat", () => {
  const cutoff = new Date("2026-09-18T12:00:00Z");
  const at = (h: number) => new Date(cutoff.getTime() - h * 3_600_000);

  it("stays silent in the first hour", () => {
    expect(nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(19.5), severity: "due" }).stage).toBeNull();
  });

  it("tells the worker, then a supervisor once it has sat", () => {
    expect(nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(17), severity: "due" })).toMatchObject({ stage: "worker", audience: ["driver"] });
    expect(nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(6), severity: "due" })).toMatchObject({ stage: "supervisor", audience: ["dispatch"] });
  });

  it("warns before the cutoff and raises an exception after it", () => {
    expect(nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(2), severity: "due" }).reason).toContain("Cutoff in 2 h");
    const missed = nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(-3), severity: "due" });
    expect(missed).toMatchObject({ stage: "exception", audience: ["office", "dispatch"] });
    expect(missed.reason).toContain("passed 3 h ago");
  });

  it("separates late from blocking at the same stage", () => {
    const receipt = nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(2), severity: "overdue" });
    const ticket = nextReminder({ outstandingSince: at(20), cutoffAt: cutoff, now: at(2), severity: "blocking" });
    expect(receipt.stage).toBe(ticket.stage);
    expect(receipt.blocksBilling).toBe(false);
    expect(ticket.blocksBilling).toBe(true);
  });
});

describe("there is one readiness module", () => {
  it("does not define a second verdict vocabulary", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    // The duplicate this file replaced.
    expect(existsSync("server/_core/readyForTomorrow.ts")).toBe(false);
    const routing = readFileSync("server/_core/readinessRouting.ts", "utf8");
    expect(routing).not.toContain("export function readyFor");
    expect(routing).toContain('from "./shiftReadiness"');
  });
});
