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
