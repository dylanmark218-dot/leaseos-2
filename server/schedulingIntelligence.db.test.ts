/**
 * B23.2 — Scheduling Intelligence through the product: `work.scheduleAssess` against a real database.
 *
 * What is proved here is composition, not re-decision: the private appointment arrives as a window,
 * the HOS line is the one `hos.status` gives (UNKNOWN until a person verifies a figure), the unit's
 * line is the readiness composer's own, and the gate stays with dispatch. Every instant is explicit.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { zonedToUtc } from "./_core/recurrence";

const URL = process.env.DATABASE_URL;
describe("scheduling intelligence — preconditions", () => {
  it("runs against a real database", () => { expect(URL, "DATABASE_URL must be set").toBeTruthy(); });
});
const d = URL ? describe : describe.skip;

let pool: mysql.Pool;
let seq = 33_000_000 + Math.floor(Math.random() * 60_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

const TZ = "America/Edmonton";
const local = (y: number, m: number, day: number, hh: number, mm = 0) => zonedToUtc({ year: y, month: m, day, hour: hh, minute: mm, second: 0 }, TZ);
const NOW = local(2027, 4, 11, 20);
const FROM = local(2027, 4, 12, 6), TO = local(2027, 4, 12, 18);

async function person(role: DomainRole): Promise<number> {
  const id = seq++;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date("2026-01-01T00:00:00Z") });
  return id;
}
async function operatorFor(userId: number, name: string): Promise<number> {
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (userId, name, licenseExpiresAt) VALUES (?, ?, ?)", [userId, name, local(2028, 1, 1, 0)]);
  return Number(r.insertId);
}
async function unit(): Promise<{ id: number; unitNumber: string }> {
  const unitNumber = `U${rnd()}`.slice(0, 12);
  const [r] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType, company, maintenanceStatus) VALUES (?, 'vacuum_truck', 'ABC', 'clear')", [unitNumber]);
  return { id: Number(r.insertId), unitNumber };
}

d("one answer for dispatch, composed and cited", () => {
  it("a driver with a private appointment reads as free from after it, with no words; HOS is UNKNOWN until a figure is verified; the unit's line is the composer's", async () => {
    const dispatcher = await person("dispatcher");
    const driver = await person("driver");
    const opId = await operatorFor(driver, "Dylan");
    const u = await unit();
    await caller(driver).work.eventCreate({ title: "Dentist", detail: "Root canal with Dr. Singh", startsAt: local(2027, 4, 12, 6), endsAt: local(2027, 4, 12, 8), timezone: TZ, at: NOW });
    await pool.execute("INSERT INTO dutyRecords (operatorId, dutyStatus, startedAt, endedAt, createdAt) VALUES (?, 'off_duty', ?, ?, NOW())", [opId, local(2027, 4, 11, 18), local(2027, 4, 12, 5)]);

    const r = await caller(dispatcher).work.scheduleAssess({ userIds: [driver], from: FROM, to: TO, estimatedDurationMinutes: 4 * 60, estimatedDriveMinutes: 120, unitId: u.id, hos: { carrierAuthority: "federal", jurisdiction: "CA", latitude: 53.5 }, now: NOW });
    expect(r.ranked).toHaveLength(1);
    const a = r.ranked[0]!;
    expect(a.candidate).toEqual({ userId: driver, label: "Dylan" });
    expect(a.unit).toEqual({ unitId: u.id, label: `Unit ${u.unitNumber}` });
    // The appointment narrows the window and is cited by its record type only.
    expect(a.availableFrom!.toISOString()).toBe(local(2027, 4, 12, 8).toISOString());
    expect(a.findings[0]).toMatchObject({ engine: "calendar", state: "review", line: expect.stringMatching(/^Unavailable .*\(calendarEvent\); what for is not part of this answer\.$/) });
    expect(JSON.stringify(r)).not.toMatch(/Dentist|Root canal|Singh/);
    // P9: no HOS figure is verified, so the HOS line is UNKNOWN in the engine's words, and the composite is UNKNOWN — never feasible.
    const hos = a.findings.filter(f => f.engine === "hos");
    expect(hos[0]).toMatchObject({ state: "unknown", line: expect.stringMatching(/^Hours of service: /), ref: `hos.status:${opId}@${FROM.toISOString()}` });
    // The unit's line comes from the readiness composer, under its own reference; a fresh unit with no documents is not "ready".
    const ready = a.findings.find(f => f.engine === "readiness")!;
    expect(ready.ref).toBe(`dispatch.readiness:${opId}/${u.id}`);
    expect(["block", "unknown", "review"]).toContain(ready.state);
    // The composite is whatever the engines said: blocked by the composer when it blocks, otherwise UNKNOWN on the HOS line — never feasible.
    expect(a.verdict).toBe(ready.state === "block" ? "NOT_FEASIBLE" : "UNKNOWN");
    expect(a.summary).toMatch(ready.state === "block" ? /^Dylan and Unit .* but unit .* blocked/ : /^Dylan and Unit .*: cannot say — /);
    expect(r.note).toMatch(/Dispatch assigns/);
  });

  it("ranks candidates: a person with no operator record reads UNKNOWN, a person booked across the window is NOT_FEASIBLE, and the gate is untouched", async () => {
    const dispatcher = await person("dispatcher");
    const unbooked = await person("driver");
    const booked = await person("driver");
    const noRecord = await person("driver");
    const bookedOp = await operatorFor(booked, "Priya");
    await operatorFor(unbooked, "Sam");
    await pool.execute("INSERT INTO resourceBookings (resourceType, resourceRef, jobId, startsAt, endsAt, bookingState) VALUES ('operator', ?, NULL, ?, ?, 'confirmed')", [String(bookedOp), local(2027, 4, 12, 5), local(2027, 4, 12, 19)]);

    const r = await caller(dispatcher).work.scheduleAssess({ userIds: [booked, noRecord, unbooked], from: FROM, to: TO, estimatedDurationMinutes: 60, now: NOW });
    const byUser = new Map(r.ranked.map(a => [a.candidate.userId, a]));
    expect(byUser.get(booked)!.verdict).toBe("NOT_FEASIBLE");
    expect(byUser.get(booked)!.findings.some(f => f.engine === "dispatch" && /Already booked/.test(f.line))).toBe(true);
    expect(byUser.get(noRecord)!.findings[0]).toMatchObject({ state: "unknown", line: expect.stringMatching(/No operator record/) });
    expect(byUser.get(noRecord)!.verdict).toBe("UNKNOWN");
    expect(byUser.get(unbooked)!.verdict).toBe("UNKNOWN");   // nothing rostered, no verified HOS figure: cannot say
    // Not feasible sorts last; nothing was assigned or booked by asking.
    expect(r.ranked[r.ranked.length - 1]!.candidate.userId).toBe(booked);
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM resourceBookings WHERE resourceType='operator' AND resourceRef IN (?, ?)", [String(bookedOp), "none"]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("is a scheduler's read: a driver may not ask it, and a window that ends before it begins is refused", async () => {
    const driver = await person("driver");
    const dispatcher = await person("dispatcher");
    await expect(caller(driver).work.scheduleAssess({ userIds: [driver], from: FROM, to: TO, estimatedDurationMinutes: 60, now: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(dispatcher).work.scheduleAssess({ userIds: [driver], from: TO, to: FROM, estimatedDurationMinutes: 60, now: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller(dispatcher).work.scheduleAssess({ userIds: [driver], from: FROM, to: TO, estimatedDurationMinutes: 60, unitId: 999_999_999, now: NOW })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("B23.3 — asked by operator and job: the window is the job's booking, the unit's own booking is taken for the unit, and every finding carries its link", async () => {
    const dispatcher = await person("dispatcher");
    const driver = await person("driver");
    const opId = await operatorFor(driver, "Dylan");
    const u = await unit();
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0)", [`JOB-${rnd()}`.slice(0, 40)]);
    const jobId = Number(job.insertId);
    await pool.execute("INSERT INTO resourceBookings (resourceType, resourceRef, jobId, startsAt, endsAt, bookingState) VALUES ('operator', ?, ?, ?, ?, 'confirmed')", [String(opId), jobId, local(2027, 4, 12, 6), local(2027, 4, 12, 14)]);
    // Another job holds the unit for the first three hours of that window.
    await pool.execute("INSERT INTO resourceBookings (resourceType, resourceRef, jobId, startsAt, endsAt, bookingState) VALUES ('unit', ?, NULL, ?, ?, 'confirmed')", [String(u.id), local(2027, 4, 12, 6), local(2027, 4, 12, 9)]);

    const r = await caller(dispatcher).work.scheduleAssess({ operatorIds: [opId], unitId: u.id, jobId, now: NOW });
    expect(r.basis).toBe(`window from job ${jobId}'s 1 booking(s); the duration is the booking's length`);
    expect(r.from.toISOString()).toBe(local(2027, 4, 12, 6).toISOString());
    expect(r.to.toISOString()).toBe(local(2027, 4, 12, 14).toISOString());
    const a = r.ranked[0]!;
    expect(a.candidate.userId).toBe(driver);
    const unitSpan = a.findings.find(f => /is already booked/.test(f.line))!;
    expect(unitSpan).toMatchObject({ engine: "dispatch", state: "review", deepLink: "/work" });
    expect(unitSpan.line).toMatch(new RegExp(`^Unit ${u.unitNumber} is already booked .*\\(resourceBooking:unit:`));
    // The person's own booking for this very job is taken too — the window is what the job holds, and the unit's booking leaves 09:00–14:00 for an eight-hour booking.
    expect(a.verdict).toBe("NOT_FEASIBLE");
    for (const f of a.findings) expect(f).toHaveProperty("deepLink");
    expect(a.findings.find(f => f.engine === "hos")!.deepLink).toBe("/hos-verification");

    // No booking at all: the next twelve hours are assumed, and the answer says so.
    const [bare] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0)", [`JOB-${rnd()}`.slice(0, 40)]);
    const none = await caller(dispatcher).work.scheduleAssess({ operatorIds: [opId], jobId: Number(bare.insertId), now: NOW });
    expect(none.basis).toMatch(/has no booking yet, so the next twelve hours were assumed; an eight-hour job was assumed/);
    await expect(caller(dispatcher).work.scheduleAssess({ operatorIds: [999_999_999], jobId, now: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/operator 999999999 has no user/) });
  });

  it("B23.4 — an open posting: the pool is the candidate set, the window is the posting's, and the matching engine's line names what each is missing", async () => {
    const dispatcher = await person("dispatcher");
    const holder = await person("driver");
    const lacking = await person("driver");
    const holderOp = await operatorFor(holder, "Priya");
    const lackingOp = await operatorFor(lacking, "Sam");
    const [job] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress) VALUES (?, 'water_haul', 'transport', 'Acme', 'LSD 04-12-052-09W5', 'dispatched', 0)", [`JOB-${rnd()}`.slice(0, 40)]);
    const jobId = Number(job.insertId);
    const requirements = { jobCode: `J-${jobId}`, requiredCapabilities: [{ kind: "certification", code: "H2S", label: "H2S Alive" }] };
    const [p] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dispatchPostings (postingNumber, jobId, distribution, planningState, priority, crewSize, requirementsJson, scheduledStart, estimatedDurationMinutes) VALUES (?, ?, 'invite_only', 'invite_only', 'normal', 1, ?, ?, 240)", [`DSP-${rnd()}`.slice(0, 40), jobId, JSON.stringify(requirements), local(2027, 4, 12, 7)]);
    const postingId = Number(p.insertId);
    await pool.execute("INSERT INTO dispatchInvitations (postingId, operatorId, status, sentAt) VALUES (?, ?, 'sent', ?), (?, ?, 'sent', ?)", [postingId, holderOp, NOW, postingId, lackingOp, NOW]);
    await pool.execute("INSERT INTO operatorCapabilities (operatorId, kind, code, label, expiresAt, isCredential) VALUES (?, 'certification', 'H2S', 'H2S Alive', ?, 1)", [holderOp, local(2028, 1, 1, 0)]);

    const r = await caller(dispatcher).work.scheduleAssess({ postingId, now: NOW });
    expect(r.postingId).toBe(postingId);
    expect(r.jobId).toBe(jobId);
    expect(r.basis).toBe(`window from posting ${postingId}'s scheduled start and estimated duration`);
    expect(r.from.toISOString()).toBe(local(2027, 4, 12, 7).toISOString());
    expect(r.to.toISOString()).toBe(local(2027, 4, 12, 11).toISOString());
    expect(r.ranked.map(a => a.candidate.userId).sort()).toEqual([holder, lacking].sort());
    const byUser = new Map(r.ranked.map(a => [a.candidate.userId, a]));
    const sam = byUser.get(lacking)!.findings.find(f => f.engine === "matching")!;
    expect(sam).toMatchObject({ state: "block", line: expect.stringMatching(/^Not a match for the posting — missing H2S Alive/), ref: `dispatchPosting:${postingId}:job:${jobId}`, deepLink: `/dispatch/${jobId}` });
    expect(byUser.get(lacking)!.verdict).toBe("NOT_FEASIBLE");
    const priya = byUser.get(holder)!.findings.find(f => f.engine === "matching")!;
    expect(priya).toMatchObject({ state: "ok", line: expect.stringMatching(/Matches the posting's requirements \(H2S Alive\)\. A match is who may see the posting, not who may be sent\./) });
    // The holder outranks the one who lacks the ticket; neither was invited, bid for or awarded anything by asking.
    expect(r.ranked[0]!.candidate.userId).toBe(holder);
    const [inv] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM dispatchInvitations WHERE postingId = ?", [postingId]);
    expect(inv.map(x => x.status)).toEqual(["sent", "sent"]);
    // A posting with no requirements recorded: the matching line is unknown, not clear.
    const [bare] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dispatchPostings (postingNumber, jobId, distribution, planningState, priority, crewSize, scheduledStart) VALUES (?, ?, 'invite_only', 'invite_only', 'normal', 1, ?)", [`DSP-${rnd()}`.slice(0, 40), jobId, local(2027, 4, 12, 7)]);
    const none = await caller(dispatcher).work.scheduleAssess({ postingId: Number(bare.insertId), operatorIds: [holderOp], now: NOW });
    expect(none.basis).toMatch(/an eight-hour job was assumed/);
    expect(none.ranked[0]!.findings.find(f => f.engine === "matching")).toMatchObject({ state: "unknown", line: expect.stringMatching(/could not be read/) });
    // A posting nobody was invited to, with no pool and no bids: nobody to assess, said plainly.
    const [empty] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO dispatchPostings (postingNumber, jobId, distribution, planningState, priority, crewSize) VALUES (?, ?, 'invite_only', 'invite_only', 'normal', 1)", [`DSP-${rnd()}`.slice(0, 40), jobId]);
    await expect(caller(dispatcher).work.scheduleAssess({ postingId: Number(empty.insertId), now: NOW })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/has no invitation, bid or pool member yet/) });
  });
});
