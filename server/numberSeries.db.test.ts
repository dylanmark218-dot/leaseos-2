/**
 * Document Control, Checkpoint C (0190) — controlled numbering with a ledger, against a real database.
 *
 * The properties here are the ones a paper ticket book has and a MAX()+1 does not: two offices
 * cannot mint the same number, two devices cannot hold the same range, a number once handed out
 * never comes back, and every gap has a reason written beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { allocateDeviceBlock, consumeFromBlock, ensureSeriesRow, gapReport, mintNumberInTx, reserveNumber, retireBlock, voidNumber } from "./_core/numberSeries";
import { nextTrackingNumber } from "./_core/trackingNumbers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 270_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 12 }); });
afterAll(async () => { await pool?.end(); });
const db = () => drizzle(pool as never) as never as Parameters<typeof allocateDeviceBlock>[0];
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function device(orgRef: string, userId: number, status = "active") { const ref = `DEV-${rnd()}`; await pool.execute("INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, keystoreAttestation, encryptedStorageAttested, status, enrolledAt, enrolledByUserId, createdAt) VALUES (?,?,?,'android',?,'hardware',1,?,NOW(),?,NOW())", [ref, userId, orgRef, `fp-${ref}`, status, userId]); return ref; }
const series = (orgRef: string | null, t: string) => ({ orgRef, sequenceType: t });
const period = String(new Date().getUTCFullYear());

d("concurrency: the counter and the ledger under contention", () => {
  it("eight workers minting fifteen numbers each on one series get 120 distinct numbers, 120 ledger rows, and no gap", async () => {
    const a = await org(); const t = `T${rnd().slice(0, 3)}`;
    await ensureSeriesRow(db(), series(a, t));
    const workers = Array.from({ length: 8 }, (_, w) => (async () => {
      const out: number[] = [];
      for (let i = 0; i < 15; i++) {
        const m = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: null, actor: { userId: 1 } }));
        out.push(m.sequence);
        if (w === 0 && i === 0) expect(m.number).toMatch(new RegExp(`^${t}-\\d{4}-\\d{6}$`));
      }
      return out;
    })());
    const all = (await Promise.all(workers)).flat();
    expect(new Set(all).size).toBe(120);
    expect(Math.min(...all)).toBe(1);
    expect(Math.max(...all)).toBe(120);
    const report = await gapReport(db(), series(a, t), period);
    expect(report).toMatchObject({ issued: 120, unexplained: 0, explained: 0 });
  }, 120_000);

  it("six devices allocating blocks at once receive disjoint, contiguous ranges cut from one counter", async () => {
    const a = await org(); const mgr = await member(a, ["management"]); const t = `B${rnd().slice(0, 3)}`;
    const devices = await Promise.all(Array.from({ length: 6 }, () => device(a, mgr)));
    const blocks = await Promise.all(devices.map(dev => allocateDeviceBlock(db(), series(a, t), { count: 25, deviceRef: dev, allocatedByUserId: mgr })));
    const ranges = blocks.map(b => [b.firstSequence, b.lastSequence]).sort((x, y) => x[0]! - y[0]!);
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i]![1]! - ranges[i]![0]! + 1).toBe(25);
      if (i > 0) expect(ranges[i]![0]).toBe(ranges[i - 1]![1]! + 1);
    }
    expect(ranges[0]![0]).toBe(1);
    expect(ranges[5]![1]).toBe(150);
    expect(blocks[0]!.numbers.length).toBe(25);
    // A server-side mint after the blocks lands beyond every range.
    await ensureSeriesRow(db(), series(a, t));
    const m = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: null, actor: { userId: mgr } }));
    expect(m.sequence).toBe(151);
  }, 120_000);
});

d("devices: consume inside the block only, once, and never after the device is lost", () => {
  it("refuses a number outside the block or from another device, replays a retried capture, and lets the database refuse a second consumption", async () => {
    const a = await org(); const mgr = await member(a, ["management"]); const t = `D${rnd().slice(0, 3)}`;
    const devA = await device(a, mgr), devB = await device(a, mgr);
    const block = await allocateDeviceBlock(db(), series(a, t), { count: 10, deviceRef: devA, allocatedByUserId: mgr });
    const consume = (args: Partial<Parameters<typeof consumeFromBlock>[1]>) => db().transaction(async tx => consumeFromBlock(tx as never, { scopeKey: a, blockRef: block.allocationRef, sequence: block.firstSequence + 3, deviceRef: devA, recordType: "test", recordId: 77, idempotencyKey: `cap-${rnd()}`, actor: { userId: mgr, deviceRef: devA }, ...args }));
    await expect(consume({ sequence: block.lastSequence + 1 })).rejects.toThrow(/outside block/);
    await expect(consume({ deviceRef: devB })).rejects.toThrow(/belongs to/);
    const key = `cap-${rnd()}`;
    const first = await consume({ idempotencyKey: key });
    expect(first.replayed).toBe(false);
    expect(first.number).toBe(block.numbers[3]);
    const again = await consume({ idempotencyKey: key });
    expect(again).toMatchObject({ replayed: true, number: first.number, allocationRef: first.allocationRef });
    await expect(consume({ idempotencyKey: `other-${rnd()}` })).rejects.toThrow(/already consumed.*database refused/);
    const [[rows]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM numberAllocations WHERE scopeKey = ? AND sequenceType = ?", [a, t]);
    expect(Number(rows!.n)).toBe(1);
    // The ledger row names the record and the device; trackingReferences (unique per number, global) is reserved for default-scope series such as DOC.
    const [[led]] = await pool.query<mysql.RowDataPacket[]>("SELECT recordType, recordId, deviceRef, state FROM numberAllocations WHERE allocationRef = ?", [first.allocationRef]);
    expect(led).toMatchObject({ recordType: "test", recordId: 77, deviceRef: devA, state: "issued" });
    const [[tr]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM trackingReferences WHERE trackingNumber = ?", [first.number]);
    expect(Number(tr!.n)).toBe(0);
  }, 60_000);

  it("a lost tablet's block is retired: every unissued number is explained as lost, nothing is reissued, and the next block starts after it", async () => {
    const a = await org(); const mgr = await member(a, ["management"]); const t = `L${rnd().slice(0, 3)}`;
    const lost = await device(a, mgr), replacement = await device(a, mgr);
    const block = await allocateDeviceBlock(db(), series(a, t), { count: 8, deviceRef: lost, allocatedByUserId: mgr });
    await db().transaction(async tx => consumeFromBlock(tx as never, { scopeKey: a, blockRef: block.allocationRef, sequence: block.firstSequence, deviceRef: lost, recordType: "test", recordId: 1, idempotencyKey: `c-${rnd()}`, actor: { userId: mgr, deviceRef: lost } }));
    await db().transaction(async tx => consumeFromBlock(tx as never, { scopeKey: a, blockRef: block.allocationRef, sequence: block.firstSequence + 4, deviceRef: lost, recordType: "test", recordId: 2, idempotencyKey: `c-${rnd()}`, actor: { userId: mgr, deviceRef: lost } }));
    const r = await retireBlock(db(), { scopeKey: a, blockRef: block.allocationRef, reasonCode: "device_lost", reasonText: "tablet left on the tailgate at the lease and not recovered", actor: { userId: mgr } });
    expect(r).toMatchObject({ state: "device_lost", explained: 6, alreadyIssued: 2 });
    await expect(db().transaction(async tx => consumeFromBlock(tx as never, { scopeKey: a, blockRef: block.allocationRef, sequence: block.firstSequence + 2, deviceRef: lost, recordType: "test", recordId: 3, idempotencyKey: `c-${rnd()}`, actor: { userId: mgr, deviceRef: lost } }))).rejects.toThrow(/is device_lost/);
    const next = await allocateDeviceBlock(db(), series(a, t), { count: 5, deviceRef: replacement, allocatedByUserId: mgr });
    expect(next.firstSequence).toBe(block.lastSequence + 1);
    const report = await gapReport(db(), series(a, t), period);
    expect(report.unexplained).toBe(0);
    expect(report.heldByDevice).toBe(5);   // the replacement's block, in its hands
    expect(report.rows.filter(x => x.state === "held_by_device").every(x => x.deviceRef === replacement && x.blockRef === next.allocationRef)).toBe(true);
    expect(report.rows.filter(x => x.state === "lost").length).toBe(6);
    expect(report.rows.filter(x => x.state === "issued").length).toBe(2);
    expect(report.rows.filter(x => x.state === "lost").every(x => x.reasonCode === "device_lost" && /tailgate/.test(x.reasonText ?? ""))).toBe(true);
    // Retiring twice is a no-op, not a second explanation.
    expect((await retireBlock(db(), { scopeKey: a, blockRef: block.allocationRef, reasonCode: "device_lost", reasonText: "again, by mistake", actor: { userId: mgr } })).explained).toBe(0);
  }, 60_000);
});

d("voids, rollbacks, independence and isolation", () => {
  it("a voided number keeps its row and its sequence; the counter does not move back; a rolled-back mint leaves no gap", async () => {
    const a = await org(); const t = `V${rnd().slice(0, 3)}`;
    const r = await reserveNumber(db(), series(a, t), { actor: { userId: 1 } });
    expect(r.sequence).toBe(1);
    const v = await voidNumber(db(), { scopeKey: a, allocationRef: r.allocationRef, reasonCode: "cancelled_before_issue", reasonText: "the driver opened a ticket for the wrong job", actor: { userId: 1 } });
    expect(v.state).toBe("voided");
    await expect(voidNumber(db(), { scopeKey: a, allocationRef: r.allocationRef, reasonCode: "other", reasonText: "twice is not a thing", actor: { userId: 1 } })).rejects.toThrow(/already voided/);
    await expect(db().transaction(async tx => { await mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: null, actor: { userId: 1 } }); throw new Error("record insert failed"); })).rejects.toThrow(/record insert failed/);
    const m = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: null, actor: { userId: 1 } }));
    expect(m.sequence).toBe(2);
    const report = await gapReport(db(), series(a, t), period);
    expect(report.rows.map(x => [x.sequence, x.state])).toEqual([[1, "voided"], [2, "issued"]]);
    expect(report.unexplained).toBe(0);
    // A retry with the same idempotency key mints nothing.
    const k = `idem-${rnd()}`;
    const m1 = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: 9, actor: { userId: 1 }, idempotencyKey: k }));
    const m2 = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: 9, actor: { userId: 1 }, idempotencyKey: k }));
    expect(m2).toMatchObject({ replayed: true, number: m1.number, sequence: 3 });
  }, 60_000);

  it("series are independent, businesses are isolated, and the legacy default-scope counter is untouched by either", async () => {
    const a = await org(), b = await org(); const t = `I${rnd().slice(0, 3)}`, u = `J${rnd().slice(0, 3)}`;
    for (const s of [series(a, t), series(a, u), series(b, t)]) await ensureSeriesRow(db(), s);
    const at = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, t), { recordType: "test", recordId: null, actor: { userId: 1 } }));
    const au = await db().transaction(async tx => mintNumberInTx(tx as never, series(a, u), { recordType: "test", recordId: null, actor: { userId: 1 } }));
    const bt = await db().transaction(async tx => mintNumberInTx(tx as never, series(b, t), { recordType: "test", recordId: null, actor: { userId: 1 } }));
    expect([at.sequence, au.sequence, bt.sequence]).toEqual([1, 1, 1]);
    expect(at.number).toBe(bt.number);   // the same shape in two books, which the register keeps apart by book
    expect(at.number).not.toBe(au.number);
    const legacyBefore = await nextTrackingNumber(db() as never, { sequenceType: t });
    expect(legacyBefore.sequence).toBe(1);   // the default scope has its own counter for the same type
    const legacyAfter = await nextTrackingNumber(db() as never, { sequenceType: t });
    expect(legacyAfter.sequence).toBe(2);
    const [[cnt]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM trackingSequences WHERE sequenceType = ?", [t]);
    expect(Number(cnt!.n)).toBe(3);   // default, A, B
    // Another business cannot void A's number.
    await expect(voidNumber(db(), { scopeKey: b, allocationRef: at.allocationRef, reasonCode: "other", reasonText: "not ours to void, ever", actor: { userId: 1 } })).rejects.toThrow(/not in this business's ledger/);
  }, 60_000);
});

d("the register mints through the series", () => {
  it("issues a tenant-produced JSA with a control number from the business's own series; a proposed one takes a device-issued number; a voided one explains its number", async () => {
    const a = await org(); const mgr = await member(a, ["management"]); const office = await member(a, ["office"]);
    await callerFor(mgr).documentControl.definitions.catalogSeed();
    const c = callerFor(office); const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const one = await c.documentControl.documents.registerRendered({ definitionKey: "job_safety_analysis", title: "JSA 1", originKind: "system_rendered", contentHash: hash(`jsa1-${rnd()}`), storageKey: "jsa/1.pdf" });
    const two = await c.documentControl.documents.registerRendered({ definitionKey: "job_safety_analysis", title: "JSA 2", originKind: "system_rendered", contentHash: hash(`jsa2-${rnd()}`), storageKey: "jsa/2.pdf" });
    expect(one.controlNumber).toMatch(/^JSA-\d{4}-000001$/);
    expect(two.controlNumber).toMatch(/^JSA-\d{4}-000002$/);
    const v = await c.documentControl.documents.get({ documentRef: one.documentRef });
    expect(v.timeline.map(e => e.eventType)).toEqual(["document.issued", "document.number_issued"]);
    expect(v.timeline[1]!.detail).toMatchObject({ minted: "leaseos_series", series: "JSA" });
    // A device-issued number: the block is the device's, the proposed document takes it at issue.
    const dev = await device(a, office);
    const block = await callerFor(mgr).documentControl.series.allocateDeviceBlock({ sequenceType: "JSA", deviceRef: dev, count: 3 });
    expect(block.firstSequence).toBe(3);
    const proposed = await c.documentControl.documents.registerRendered({ definitionKey: "job_safety_analysis", title: "JSA offline", originKind: "system_rendered", contentHash: hash(`jsa3-${rnd()}`), storageKey: "jsa/3.pdf", requestedState: "proposed" });
    expect(proposed.controlNumber).toBeNull();
    const issued = await c.documentControl.documents.issue({ documentRef: proposed.documentRef, deviceNumber: { blockRef: block.allocationRef, sequence: block.firstSequence + 1, deviceRef: dev, idempotencyKey: `cap-${rnd()}` } });
    expect(issued).toMatchObject({ controlState: "issued", controlNumber: block.numbers[1], minted: "device_block" });
    // Voiding a proposed document with a series number explains the number in the ledger.
    const spoiled = await c.documentControl.documents.registerRendered({ definitionKey: "job_safety_analysis", title: "JSA spoiled", originKind: "system_rendered", contentHash: hash(`jsa4-${rnd()}`), storageKey: "jsa/4.pdf", requestedState: "proposed" });
    const n = await c.documentControl.documents.issue({ documentRef: spoiled.documentRef });
    expect(n.controlNumber).toMatch(/^JSA-\d{4}-000006$/);
    await expect(c.documentControl.documents.void({ documentRef: spoiled.documentRef, reason: "issued, so it is withdrawn" })).rejects.toThrow(/withdrawn or superseded/);
    const gaps = await c.documentControl.series.gapReport({ sequenceType: "JSA", periodKey: period });
    expect(gaps.unexplained).toBe(0);
    const states = gaps.rows.map(r => `${r.sequence}:${r.state}`);
    expect(states).toContain("1:issued");
    expect(states).toContain("2:issued");
    expect(states).toContain("4:issued");   // consumed from the block
    expect(states).toContain("6:issued");
    expect(states.filter(s => s.endsWith(":unexplained")).length).toBe(0);
    expect(states).toContain("3:held_by_device");
    expect(states).toContain("5:held_by_device");
    // Numbers 3 and 5 are in the device's hands until the block is retired, when each gets a row saying why it was never issued.
    const retired = await callerFor(mgr).documentControl.series.retireDeviceBlock({ blockRef: block.allocationRef, reasonCode: "device_retired", reasonText: "device returned to the office with two blanks unused" });
    expect(retired).toMatchObject({ explained: 2, alreadyIssued: 1 });
    const after = await c.documentControl.series.gapReport({ sequenceType: "JSA", periodKey: period });
    expect(after.rows.map(r => `${r.sequence}:${r.state}`)).toEqual(["1:issued", "2:issued", "3:unused_retired", "4:issued", "5:unused_retired", "6:issued"]);
    // The office may not cut blocks; management may.
    await expect(c.documentControl.series.allocateDeviceBlock({ sequenceType: "JSA", deviceRef: dev, count: 3 })).rejects.toThrow();
    expect((await c.documentControl.series.list()).find(s => s.sequenceType === "JSA")).toMatchObject({ handedOut: 6 });
  }, 90_000);
});
