/**
 * v22.20 (0095) — ready, not ready, and could not tell.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 18_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

const STARTS = new Date("2027-03-02T06:00:00Z");
const ENDS = new Date("2027-03-02T18:00:00Z");

async function operatorRow(userId: number, licenceExpires: Date | null) {
  await pool.execute("INSERT INTO operators (id, name, licenseClass, licenseExpiresAt, createdAt) VALUES (?,?,?,?,NOW())",
    [userId, `Op ${rnd()}`, "1", licenceExpires]);
}
async function ticket(userId: number, code: string, expiresAt: Date | null, state = "verified") {
  await pool.execute(
    `INSERT INTO workerQualifications (holdingRef, tenantId, userId, code, verificationState, expiresAt, recordedByUserId, recordedAt, verifiedByUserId, verifiedAt)
     VALUES (?,?,?,?,?,?,?,NOW(),?,?)`,
    // C1b-3: a legacy holding counts as verified only with a recorded verifier.
    [`WQ-${rnd()}${rnd()}`, "default", userId, code, state, expiresAt, 1, state === "verified" ? 1 : null, state === "verified" ? new Date() : null]);
}
const postShift = (dispatcher: number, quals: string[] = []) =>
  caller(dispatcher).shifts.post({ title: "Shift", startsAt: STARTS, endsAt: ENDS, requiredRole: "driver", requiredQualifications: quals });

d("could not tell is its own verdict", () => {
  it("is ready when licence, ticket, availability and crew all hold", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    await ticket(driver, "TDG", new Date("2028-01-01T00:00:00Z"));
    const crew = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    await caller(dispatcher).crews.addMember({ crewRef: crew.crewRef, userId: driver, joinedAt: STARTS });

    const p = await postShift(dispatcher, ["TDG"]);
    const r = await caller(driver).readiness.forShift({ postRef: p.postRef });
    expect(r.verdict).toBe("ready");
  });

  it("is incomplete, not not_ready, when a ticket is unverified", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    await ticket(driver, "TDG", new Date("2028-01-01T00:00:00Z"), "unverified");
    const p = await postShift(dispatcher, ["TDG"]);
    const r = await caller(driver).readiness.forShift({ postRef: p.postRef });
    expect(r.verdict).toBe("incomplete");
    expect(r.note).toContain("sends you to whoever can answer");
    expect(r.lines.join("\n")).toContain("nobody has checked it against the certificate");
  });

  it("is not_ready when something has actually expired", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    await ticket(driver, "TDG", new Date("2027-01-01T00:00:00Z"));
    const p = await postShift(dispatcher, ["TDG"]);
    const r = await caller(driver).readiness.forShift({ postRef: p.postRef });
    expect(r.verdict).toBe("not_ready");
  });

  it("treats a verified ticket with no expiry as unknown rather than permanent", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    await ticket(driver, "H2S", null);
    const p = await postShift(dispatcher, ["H2S"]);
    const r = await caller(driver).readiness.forShift({ postRef: p.postRef });
    expect(r.verdict).toBe("incomplete");
    expect(r.lines.join("\n")).toContain("currency cannot be established");
  });

  it("says so when there is no operator record at all", async () => {
    const dispatcher = await withRole("dispatcher");
    const ghost = await withRole("driver");
    const p = await postShift(dispatcher);
    const r = await caller(dispatcher).readiness.forShift({ postRef: p.postRef, userId: ghost });
    expect(r.verdict).toBe("incomplete");
    expect(r.lines.join("\n")).toContain("No operator record");
  });
});

d("approved leave contradicts a shift", () => {
  it("reports not_ready when the person is away that day", async () => {
    const dispatcher = await withRole("dispatcher");
    const manager = await withRole("management");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    const lr = await caller(driver).timeOff.request({ category: "vacation", from: new Date("2027-03-01T00:00:00Z"), to: new Date("2027-03-03T00:00:00Z") });
    await caller(manager).timeOff.decide({ requestRef: lr.requestRef, decision: "approve" });

    const p = await postShift(dispatcher);
    const r = await caller(driver).readiness.forShift({ postRef: p.postRef });
    expect(r.verdict).toBe("not_ready");
    expect(r.lines.join("\n")).toContain("Away that day on leave already recorded");
  });

  it("does not fail on leave that is only requested", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    await caller(driver).timeOff.request({ category: "vacation", from: new Date("2027-03-01T00:00:00Z"), to: new Date("2027-03-03T00:00:00Z") });
    const crew = await caller(dispatcher).crews.create({ name: `Crew ${rnd()}` });
    await caller(dispatcher).crews.addMember({ crewRef: crew.crewRef, userId: driver, joinedAt: STARTS });
    const p = await postShift(dispatcher);
    expect((await caller(driver).readiness.forShift({ postRef: p.postRef })).verdict).toBe("ready");
  });
});

d("routed to whoever can fix it", () => {
  it("sends a missing ticket to safety and an expired licence to the driver", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2027-01-01T00:00:00Z"));   // expired
    const p = await postShift(dispatcher, ["TDG"]);                 // nothing on record
    const r = await caller(dispatcher).readiness.forShift({ postRef: p.postRef, userId: driver });
    const owners = r.byOwner.map(g => g.owner);
    expect(owners).toContain("driver");
    expect(owners).toContain("safety");
    expect(r.byOwner.find(g => g.owner === "safety")!.items.some(i => i.label === "TDG")).toBe(true);
  });

  it("does not let an advisory check decide the verdict", async () => {
    const dispatcher = await withRole("dispatcher");
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    const p = await postShift(dispatcher);   // no crew membership: advisory only
    const r = await caller(driver).readiness.forShift({ postRef: p.postRef });
    expect(r.verdict).toBe("ready");
    expect(r.lines.join("\n")).toContain("Not currently on a crew");
  });
});

d("boundaries", () => {
  it("answers for a stated time when there is no post", async () => {
    const driver = await withRole("driver");
    await operatorRow(driver, new Date("2028-01-01T00:00:00Z"));
    const r = await caller(driver).readiness.forTime({ startsAt: STARTS, requiredQualifications: ["TDG"] });
    expect(r.verdict).toBe("incomplete");
    expect(r.note).toContain("unknown is not ready");
  });

  it("does not reach another organization's post", async () => {
    const dispatcher = await withRole("dispatcher");
    const p = await postShift(dispatcher);
    await pool.execute("UPDATE shiftPosts SET tenantId = 'ORG-ELSEWHERE' WHERE postRef = ?", [p.postRef]);
    await expect(caller(dispatcher).readiness.forShift({ postRef: p.postRef })).rejects.toThrow(/No such shift post/);
  });
});
