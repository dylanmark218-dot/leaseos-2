/**
 * v22.20 (0090) — time off through the API, and the reason that never reaches
 * a scheduler.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("approving leave is sensitive", () => {
  it("fails closed on the decision and not on asking", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("timeOff.decide");
    expect(SENSITIVE_PERMISSIONS).not.toContain("timeOff.request");
    expect(SENSITIVE_PERMISSIONS).not.toContain("timeOff.schedulingRead");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 13_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

const FROM = new Date("2026-11-02T00:00:00Z");
const TO = new Date("2026-11-04T00:00:00Z");

d("the reason is stored and not read by scheduling", () => {
  it("keeps the private note out of the scheduling query entirely", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    const r = await caller(driver).timeOff.request({
      category: "medical_appointment", from: FROM, to: TO,
      privateNote: "MRI follow-up, third this year",
    });

    // It is on the record.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT privateNote FROM leaveRequests WHERE requestRef = ?", [r.requestRef]);
    expect(rows[0].privateNote).toContain("MRI");

    // And nowhere in what a scheduler receives.
    const window = await caller(dispatcher).timeOff.schedulingWindow({ from: FROM, to: TO });
    const serialized = JSON.stringify(window);
    expect(serialized).not.toContain("MRI");
    expect(serialized).not.toContain("medical_appointment");
    expect(window.absences.some(a => a.label === "Unavailable — leave requested")).toBe(true);
  });

  it("gives the employee their own note back", async () => {
    const driver = await withRole("driver");
    await caller(driver).timeOff.request({ category: "sick", from: FROM, to: TO, privateNote: "flu" });
    const mine = await caller(driver).timeOff.mine({});
    expect(mine.requests[0].privateNote).toBe("flu");
  });

  it("names an ordinary category plainly to a scheduler", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    await caller(driver).timeOff.request({ category: "vacation", from: FROM, to: TO });
    const w = await caller(dispatcher).timeOff.schedulingWindow({ from: FROM, to: TO });
    expect(w.absences.some(a => a.label === "Vacation")).toBe(true);
  });
});

d("nobody approves their own leave", () => {
  it("refuses the requester and accepts a different person", async () => {
    const driver = await withRole("driver");
    const manager = await withRole("management");
    const r = await caller(driver).timeOff.request({ category: "vacation", from: FROM, to: TO });

    // Even with the authority, not your own.
    const selfApprover = await withRole("management");
    const own = await caller(selfApprover).timeOff.request({ category: "vacation", from: FROM, to: TO });
    await expect(caller(selfApprover).timeOff.decide({ requestRef: own.requestRef, decision: "approve" }))
      .rejects.toThrow(/Nobody approves their own leave/);

    const ok = await caller(manager).timeOff.decide({ requestRef: r.requestRef, decision: "approve" });
    expect(ok.status).toBe("approved");
    expect(ok.note).toContain("out of the available pool");
  });

  it("refuses a dispatcher the decision and allows them the schedule", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    const r = await caller(driver).timeOff.request({ category: "vacation", from: FROM, to: TO });
    await expect(caller(dispatcher).timeOff.decide({ requestRef: r.requestRef, decision: "approve" })).rejects.toThrow();
    await expect(caller(dispatcher).timeOff.schedulingWindow({ from: FROM, to: TO })).resolves.toBeTruthy();
  });

  it("will not decide twice", async () => {
    const driver = await withRole("driver");
    const manager = await withRole("management");
    const r = await caller(driver).timeOff.request({ category: "vacation", from: FROM, to: TO });
    await caller(manager).timeOff.decide({ requestRef: r.requestRef, decision: "decline" });
    await expect(caller(manager).timeOff.decide({ requestRef: r.requestRef, decision: "approve" })).rejects.toThrow(/is declined/);
  });

  it("refuses a window that ends before it begins", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).timeOff.request({ category: "vacation", from: TO, to: FROM })).rejects.toThrow(/ends before it begins/);
  });
});

d("calling in sick is recorded, not requested", () => {
  it("stores it as recorded and routes it straight out", async () => {
    const driver = await withRole("driver");
    const c = await caller(driver).timeOff.callOff({ category: "sick", from: FROM, to: FROM, privateNote: "food poisoning" });
    expect(c.status).toBe("recorded");
    expect(c.routedTo).toEqual(["dispatch", "supervisor"]);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, urgency FROM leaveRequests WHERE requestRef = ?", [c.requestRef]);
    expect(rows[0]).toMatchObject({ status: "recorded", urgency: "same_day" });
  });

  it("appears to a scheduler without the reason", async () => {
    const driver = await withRole("driver");
    const dispatcher = await withRole("dispatcher");
    await caller(driver).timeOff.callOff({ category: "sick", from: FROM, to: FROM, privateNote: "food poisoning" });
    const w = await caller(dispatcher).timeOff.schedulingWindow({ from: FROM, to: TO });
    expect(JSON.stringify(w)).not.toContain("food poisoning");
    expect(w.absences.some(a => a.label.startsWith("Unavailable"))).toBe(true);
  });

  it("cannot be decided, because nobody approves somebody being unwell", async () => {
    const driver = await withRole("driver");
    const manager = await withRole("management");
    const c = await caller(driver).timeOff.callOff({ category: "sick", from: FROM, to: FROM });
    await expect(caller(manager).timeOff.decide({ requestRef: c.requestRef, decision: "approve" })).rejects.toThrow(/is recorded/);
  });
});
