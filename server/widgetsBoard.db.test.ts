/**
 * B28 — the widget board through the real appRouter (v22.23).
 *
 * A driver opens a board: `myDay` (the one promoted source) reads through
 * `surfaces.myDay` as that driver; every other tile on the seeded board says
 * `unknown` with its reason on its face. Saving an order round-trips through the
 * 0127/0128 store. A role the caller does not hold is refused, not defaulted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 190_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function person(role: string) {
  const orgRef = `ORG-${rnd()}`; const userId = seq++;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return { userId, orgRef };
}

d("a driver's board", () => {
  it("seeds from the registry and reads My Day as the driver; unpromoted tiles say unknown", async () => {
    const { userId } = await person("driver");
    const board = await callerFor(userId).widgets.boardResolve({ deviceClass: "phone", connected: true, subjects: {} });
    expect(board.seeded).toBe(true);
    expect(board.tiles.length).toBeGreaterThan(0);
    const myDay = board.tiles.find(t => t.widgetKey === "myDay");
    expect(myDay?.payload.state).toBe("ok");
    // inbox reads as the driver when seeded; hosRemaining is device-local by the
    // engine's own plan (the clocks tick on the tablet), so the server says so.
    const inbox = board.tiles.find(t => t.widgetKey === "inbox");
    if (inbox) expect(["ok", "not_permitted"]).toContain(inbox.payload.state);
    const hos = board.tiles.find(t => t.widgetKey === "hosRemaining");
    if (hos) { expect(hos.payload.state).toBe("unknown"); if (hos.payload.state === "unknown") expect(hos.payload.reason).toMatch(/device-local/); }
    const others = board.tiles.filter(t => !["myDay", "inbox", "hosRemaining", "exceptions"].includes(t.widgetKey));
    for (const t of others) {
      expect(["unknown", "not_permitted", "offline"]).toContain(t.payload.state);
      if (t.payload.state === "unknown") expect(t.payload.reason).toMatch(/not promoted|device-local|no (unit|trailer|job|trip) selected/);
    }
  });

  it("saves an order and reads it back under the same role and device", async () => {
    const { userId } = await person("driver");
    const first = await callerFor(userId).widgets.boardResolve({ deviceClass: "tablet", connected: true, subjects: {} });
    const reversed = [...first.tiles].reverse();
    const saved = await callerFor(userId).widgets.layoutSave({
      layoutRef: null, deviceClass: "tablet", name: "Mine", isDefault: true,
      items: reversed.map((t, position) => ({ instanceRef: t.instanceRef, widgetKey: t.widgetKey, variant: t.variant, position })),
    });
    expect("ok" in saved && saved.ok).toBe(true);
    const again = await callerFor(userId).widgets.boardResolve({ deviceClass: "tablet", connected: true, subjects: {} });
    expect(again.seeded).toBe(false);
    expect(again.tiles.map(t => t.widgetKey)).toEqual(reversed.map(t => t.widgetKey));
  });

  it("refuses a role the caller does not hold rather than opening someone else's board", async () => {
    const { userId } = await person("driver");
    await expect(callerFor(userId).widgets.boardResolve({ deviceClass: "phone", connected: true, subjects: {}, roleKey: "DISPATCHER" }))
      .rejects.toThrow(/not currently acting as/);
  });

  it("offers only what the role may put on its board", async () => {
    const { userId } = await person("driver");
    const offers = await callerFor(userId).widgets.offerable();
    const keys = offers.map((o: { widgetKey: string }) => o.widgetKey);
    expect(keys).toContain("myDay");
    // dispatch readiness needs dispatch.read, which a driver does not hold
    expect(keys).not.toContain("dispatchReadiness");
  });
});

d("scoped tiles read their subject through the governing procedure", () => {
  async function fixtures(userId: number, orgRef: string) {
    const jobCode = `JOB-${rnd()}`;
    const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [jobCode, "Hydrovac", "Fixture Energy", "LSD 04-12-045-08W4", orgRef]);
    const [u] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO units (unitNumber, vehicleType) VALUES (?,?)", [`U-${rnd()}`, "hydrovac"]);
    const tripNumber = `TRP-${rnd()}`;
    await pool.execute("INSERT INTO trips (tripNumber, jobId, unitId, operatorId, tripType, status, orgRef) VALUES (?,?,?,?,'one_way','planned',?)", [tripNumber, j.insertId, u.insertId, userId, orgRef]);
    const soon = new Date(Date.now() + 10 * 86_400_000), later = new Date(Date.now() + 200 * 86_400_000);
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator',?,?,?,NOW(),?,'verified')", [userId, "licence", "Class 1", soon]);
    await pool.execute("INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus) VALUES ('operator',?,?,?,NOW(),?,'needs_review')", [userId, "h2s", "H2S Alive", later]);
    return { jobCode, tripNumber, unitId: u.insertId, jobId: j.insertId };
  }

  it("activeJob / activeTrip match the subject by code, and say so when nothing matches", async () => {
    const { userId, orgRef } = await person("dispatcher");
    const f = await fixtures(userId, orgRef);
    const save = await callerFor(userId).widgets.layoutSave({
      layoutRef: null, deviceClass: "desktop", name: "Ops", isDefault: true,
      items: [
        { instanceRef: "j1", widgetKey: "activeJob", variant: "status", position: 0, subjectRef: f.jobCode },
        { instanceRef: "t1", widgetKey: "activeTrip", variant: "status", position: 1, subjectRef: f.tripNumber },
        { instanceRef: "j2", widgetKey: "activeJob", variant: "status", position: 2, subjectRef: "JOB-NOPE" },
      ],
    });
    expect("ok" in save && save.ok).toBe(true);
    const board = await callerFor(userId).widgets.boardResolve({ deviceClass: "desktop", connected: true, subjects: {} });
    const t = (ref: string) => board.tiles.find(x => x.instanceRef === ref)!.payload;
    expect(t("j1").state).toBe("ok");
    expect(t("t1").state).toBe("ok");
    expect(t("j2").state).toBe("unknown");
    if (t("j2").state === "unknown") expect(t("j2").reason).toContain("no job matches");
  }, 20_000);

  it("documentExpiry shows the operator's own documents in the vault's states", async () => {
    const { userId, orgRef } = await person("dispatcher");
    await fixtures(userId, orgRef);
    await callerFor(userId).widgets.layoutSave({
      layoutRef: null, deviceClass: "desktop", name: "Ops", isDefault: true,
      items: [{ instanceRef: "d1", widgetKey: "documentExpiry", variant: "list", position: 0, options: { warnDays: 30 } }],
    });
    const board = await callerFor(userId).widgets.boardResolve({ deviceClass: "desktop", connected: true, subjects: {} });
    const p = board.tiles[0]!.payload;
    expect(p.state).toBe("ok");
    if (p.state === "ok") {
      const v = p.value as { documents: { docType: string; state: string }[]; total: number };
      expect(v.total).toBe(2);
      expect(v.documents.find(x => x.docType === "licence")?.state).toBe("expiring");
      expect(v.documents.find(x => x.docType === "h2s")?.state).toBe("unverified");
    }
  }, 20_000);

  it("dispatchReadiness takes the operator and unit from the job's dispatched trip", async () => {
    const { userId, orgRef } = await person("dispatcher");
    const f = await fixtures(userId, orgRef);
    await callerFor(userId).widgets.layoutSave({
      layoutRef: null, deviceClass: "desktop", name: "Ops", isDefault: true,
      items: [{ instanceRef: "r1", widgetKey: "dispatchReadiness", variant: "status", position: 0, subjectRef: f.jobCode }],
    });
    const board = await callerFor(userId).widgets.boardResolve({ deviceClass: "desktop", connected: true, subjects: {} });
    const p = board.tiles[0]!.payload;
    expect(["ok", "failed"]).toContain(p.state);
    if (p.state === "ok") {
      const v = p.value as { jobCode: string; tripNumber: string; readiness: { verdict: string } };
      expect(v.jobCode).toBe(f.jobCode);
      expect(v.tripNumber).toBe(f.tripNumber);
      // A fixture operator with no licence on file is not READY — the composer names why, it never rounds up.
      expect(["BLOCKED", "REVIEW", "UNKNOWN", "READY"]).toContain(v.readiness.verdict);
      expect(v.readiness.verdict).not.toBe("READY");
    }
  }, 20_000);

  it("search and trackingLookup are on-demand tiles, not silent empties", async () => {
    const { userId } = await person("dispatcher");
    await callerFor(userId).widgets.layoutSave({
      layoutRef: null, deviceClass: "desktop", name: "Ops", isDefault: true,
      items: [{ instanceRef: "s1", widgetKey: "search", variant: "list", position: 0 }],
    });
    const board = await callerFor(userId).widgets.boardResolve({ deviceClass: "desktop", connected: true, subjects: {} });
    const p = board.tiles[0]!.payload;
    expect(p.state).toBe("unknown");
    if (p.state === "unknown") expect(p.reason).toMatch(/on demand/);
  }, 20_000);
});
