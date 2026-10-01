/**
 * v22.20 (0093) — a forecast from records, not from arguments.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("changing a crew is sensitive; reading a forecast is not", () => {
  it("fails closed on management only", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("crews.manage");
    expect(SENSITIVE_PERMISSIONS).not.toContain("crews.read");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 16_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const FROM = new Date("2026-12-01T00:00:00Z");
const ANCHOR = new Date("2026-12-01T00:00:00Z");
const day = (n: number) => new Date(FROM.getTime() + n * 86_400_000);

async function person(name: string) {
  const id = seq++;
  await pool.execute("INSERT INTO operators (id, name, licenseClass, createdAt) VALUES (?,?,?,NOW())", [id, name, "1"]);
  return id;
}
async function verifiedTicket(userId: number, code: string, expiresAt: Date | null = new Date("2027-12-01T00:00:00Z"), state = "verified") {
  await pool.execute(
    `INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,NOW(),?,?)`,
    // C1b-3: a legacy holding counts as verified only with a recorded verifier.
    [`WQ-${rnd()}${rnd()}`, "default", userId, code, state, expiresAt, 1, state === "verified" ? 1 : null, state === "verified" ? new Date() : null]);
}

d("the forecast reads rotation, leave and verified tickets", () => {
  async function crewOfThree(dispatcher: number, opts: { ticketHolders?: number } = {}) {
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await person(`Member ${rnd()}`);
      ids.push(id);
      await caller(dispatcher).crews.addMember({
        crewRef: c.crewRef, userId: id, crewRole: "driver",
        rotation: { onDays: 7, offDays: 7, anchor: ANCHOR }, joinedAt: FROM,
      });
      if (i < (opts.ticketHolders ?? 0)) await verifiedTicket(id, "TDG");
    }
    return { crewRef: c.crewRef, ids };
  }

  it("counts everybody on-hitch and nobody off-hitch", async () => {
    const dispatcher = await withRole("dispatcher");
    const { crewRef } = await crewOfThree(dispatcher);
    const f = await caller(dispatcher).crews.forecast({ crewRef, from: FROM, days: 14, neededPerDay: 2 });
    expect(f.days[0].available).toBe(3);
    expect(f.days[7].available).toBe(0);
    expect(f.days[7].state).toBe("short_people");
  });

  it("says tight rather than covered when exactly enough", async () => {
    const dispatcher = await withRole("dispatcher");
    const { crewRef } = await crewOfThree(dispatcher);
    const f = await caller(dispatcher).crews.forecast({ crewRef, from: FROM, days: 1, neededPerDay: 3 });
    expect(f.days[0].state).toBe("tight");
  });

  it("removes somebody on approved leave from the available count", async () => {
    const dispatcher = await withRole("dispatcher");
    const manager = await withRole("management");
    const { crewRef, ids } = await crewOfThree(dispatcher);

    const before = await caller(dispatcher).crews.forecast({ crewRef, from: FROM, days: 1, neededPerDay: 3 });
    expect(before.days[0].available).toBe(3);

    // A real request, approved by a different person.
    const leaveCaller = caller(ids[0]);
    await grantUserRole({ userId: ids[0], role: "driver", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
    const lr = await leaveCaller.timeOff.request({ category: "vacation", from: FROM, to: day(1) });
    await caller(manager).timeOff.decide({ requestRef: lr.requestRef, decision: "approve" });

    const after = await caller(dispatcher).crews.forecast({ crewRef, from: FROM, days: 1, neededPerDay: 3 });
    expect(after.days[0].available).toBe(2);
    expect(after.days[0].state).toBe("short_people");
  });

  it("is full on headcount and short on a ticket — the case this exists for", async () => {
    const dispatcher = await withRole("dispatcher");
    const { crewRef } = await crewOfThree(dispatcher, { ticketHolders: 1 });
    const f = await caller(dispatcher).crews.forecast({
      crewRef, from: FROM, days: 1, neededPerDay: 2,
      requirements: [{ qualification: "TDG", neededHolders: 2 }],
    });
    expect(f.days[0].available).toBe(3);
    expect(f.days[0].state).toBe("short_qualification");
    expect(f.days[0].line).toContain("short on TDG (1/2)");
    expect(f.warnings[0].qualification).toBe("TDG");
  });

  it("does not count an unverified certificate as a ticket", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const id = await person(`Member ${rnd()}`);
    await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: id, rotation: { onDays: 7, offDays: 7, anchor: ANCHOR }, joinedAt: FROM });
    await verifiedTicket(id, "TDG", new Date("2027-12-01T00:00:00Z"), "unverified");

    const f = await caller(dispatcher).crews.forecast({
      crewRef: c.crewRef, from: FROM, days: 1, neededPerDay: 1,
      requirements: [{ qualification: "TDG", neededHolders: 1 }],
    });
    expect(f.days[0].state).toBe("short_qualification");
    expect(f.note).toContain("an uploaded certificate is not a ticket");
  });

  it("does not count a ticket that expires before the window", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const id = await person(`Member ${rnd()}`);
    await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: id, rotation: { onDays: 7, offDays: 7, anchor: ANCHOR }, joinedAt: FROM });
    await verifiedTicket(id, "TDG", new Date("2026-11-01T00:00:00Z"));
    const f = await caller(dispatcher).crews.forecast({
      crewRef: c.crewRef, from: FROM, days: 1, neededPerDay: 1,
      requirements: [{ qualification: "TDG", neededHolders: 1 }],
    });
    expect(f.days[0].state).toBe("short_qualification");
  });

  it("counts somebody with no rotation as working", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const id = await person(`Supervisor ${rnd()}`);
    await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: id, crewRole: "supervisor", joinedAt: FROM });
    const f = await caller(dispatcher).crews.forecast({ crewRef: c.crewRef, from: FROM, days: 14, neededPerDay: 1 });
    expect(f.days[9].available).toBe(1);
  });
});

d("membership and boundaries", () => {
  it("ends a membership without deleting the row", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const id = await person(`Member ${rnd()}`);
    await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: id, joinedAt: FROM });
    const r = await caller(dispatcher).crews.removeMember({ crewRef: c.crewRef, userId: id });
    expect(r.note).toContain("The record stays");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT leftAt FROM crewMembers WHERE crewRef = ? AND userId = ?", [c.crewRef, id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].leftAt).toBeTruthy();
  });

  it("does not add the same current member twice", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    const id = await person(`Member ${rnd()}`);
    await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: id, joinedAt: FROM });
    expect((await caller(dispatcher).crews.addMember({ crewRef: c.crewRef, userId: id, joinedAt: FROM })).added).toBe(false);
  });

  it("refuses a driver the crew management and allows the forecast", async () => {
    const driver = await withRole("driver");
    await expect(caller(driver).crews.create({ name: "mine" })).rejects.toThrow();
  });

  it("does not reach another organization's crew", async () => {
    const dispatcher = await withRole("dispatcher");
    const c = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    await pool.execute("UPDATE crews SET tenantId = 'ORG-ELSEWHERE' WHERE crewRef = ?", [c.crewRef]);
    await expect(caller(dispatcher).crews.forecast({ crewRef: c.crewRef, from: FROM, days: 1, neededPerDay: 1 }))
      .rejects.toThrow(/No such crew/);
  });
});
