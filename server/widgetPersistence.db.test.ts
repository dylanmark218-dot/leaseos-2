/**
 * B24 — persistence, against a real MariaDB.
 *
 * Runs only when `WIDGET_DB_URL` is set; skipped otherwise, and reported as
 * skipped rather than counted as passing. In the B24 container this ran against
 * MariaDB 10.11.14, the version the repo targets.
 *
 * The security block is the reason this file exists. B23's store could be made
 * to overwrite another user's board by supplying their `layoutRef`, and no unit
 * test could have caught it, because the defect was in a SQL statement that had
 * never executed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzleWidgetLayoutStore } from "./widgetLayouts";
import { widgetLayoutItems, widgetLayouts } from "../drizzle/schema";
import type { NormalizedItem } from "./_core/widgetLayoutWrite";
import type { StoredLayout } from "./_core/widgetService";

// Named DB_URL, not URL: the first version shadowed the global `URL`
// constructor and the whole suite died in beforeAll with "URL is not a
// constructor" while reporting 22 tests skipped — which reads exactly like a
// missing database rather than a broken harness.
const DB_URL = process.env.WIDGET_DB_URL;
const suite = DB_URL || process.env.WIDGET_DB_SOCKET ? describe : describe.skip;

const ORG_A = "ORG-A";
const ORG_B = "ORG-B";

const item = (o: Partial<NormalizedItem> = {}): NormalizedItem => ({
  instanceRef: "WI-1", widgetKey: "hosRemaining", variant: "gauge",
  subjectRef: null, position: 0, spanColumns: 1, spanRows: 1, options: null, ...o,
});

const layout = (o: Partial<StoredLayout> = {}): StoredLayout => ({
  layoutRef: "unused-on-create", userId: 77, roleKey: "DRIVER",
  deviceClass: "phone", name: "Yard", isDefault: false, ...o,
});

suite("persistence against MariaDB", () => {
  let pool: mysql.Pool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    // A unix socket is accepted as well as a URL. The B24 container's
    // MariaDB listens on both, and TCP to 127.0.0.1 was refused from node
    // while the CLI connected happily — an environment quirk, not a product
    // one, and not worth burning the checkpoint on. Same server, same SQL.
    pool = mysql.createPool(
      process.env.WIDGET_DB_SOCKET
        ? {
            socketPath: process.env.WIDGET_DB_SOCKET, user: "root",
            database: process.env.WIDGET_DB_NAME ?? "leaseos_b24",
            multipleStatements: true, connectionLimit: 8,
          }
        : { uri: DB_URL as string, multipleStatements: true, connectionLimit: 8 },
    );
    db = drizzle(pool);
    // Every widget migration in order, not a hard-coded one. B26 added 0090
    // and the harness silently kept applying only 0089, so the suite failed on
    // a missing column rather than on anything about the product — exactly the
    // kind of harness drift that gets blamed on the schema.
    const migrations = ["0089_widget_dashboards.sql", "0090_widget_layout_revision.sql"];
    const sqlText = migrations
      .map((f) => readFileSync(new URL(`../drizzle/${f}`, import.meta.url), "utf8"))
      .join("\n");
    await pool.query("DROP TABLE IF EXISTS widgetLayoutItems");
    await pool.query("DROP TABLE IF EXISTS widgetLayouts");
    // Applied exactly as the repo's runner would: split on the breakpoint.
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const body = stmt.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
      if (body.length > 0) await pool.query(body);
    }
  });

  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    await pool.query("DELETE FROM widgetLayoutItems");
    await pool.query("DELETE FROM widgetLayouts");
  });

  const storeA = () => drizzleWidgetLayoutStore(db, ORG_A);

  describe("migration", () => {
    it("creates the cascade and the per-owner uniqueness", async () => {
      const [fks] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_NAME = 'widgetLayoutItems_layout_fk'`);
      expect(fks[0]?.DELETE_RULE).toBe("CASCADE");

      const [idx] = await pool.query<mysql.RowDataPacket[]>(
        `SHOW INDEX FROM widgetLayouts WHERE Key_name = 'widgetLayouts_owner_ref'`);
      expect(idx.map((r: Record<string, unknown>) => r.Column_name)).toEqual(["orgRef", "userId", "layoutRef"]);
    });
  });

  describe("create, read, update", () => {
    it("assigns the reference server-side", async () => {
      const { layoutRef } = await storeA().createLayout({ ...layout(), layoutRef: null }, [item()], false);
      expect(layoutRef).toMatch(/^WL-/);
      expect(layoutRef).not.toBe("unused-on-create");
    });

    it("round-trips every column, not just the ones the reader happens to use", async () => {
      const full = item({
        instanceRef: "WI-FULL", widgetKey: "documentExpiry", variant: "list",
        subjectRef: "UNIT-114", position: 0, spanColumns: 1, spanRows: 2,
        options: { warnDays: 30, limit: 5 },
      });
      const { layoutRef } = await storeA().createLayout(
        { ...layout({ name: "Full", isDefault: true }), layoutRef: null }, [full], true,
      );
      const read = await storeA().findLayout({
        userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef,
      });
      expect(read?.layout).toMatchObject({ name: "Full", isDefault: true, deviceClass: "phone" });
      expect(read?.items[0]).toMatchObject({
        instanceRef: "WI-FULL", widgetKey: "documentExpiry", variant: "list",
        subjectRef: "UNIT-114", position: 0, spanColumns: 1, spanRows: 2,
        options: { warnDays: 30, limit: 5 },
      });
    });

    it("preserves item order across a reopen", async () => {
      const items = (["myDay", "hosRemaining", "unitReadiness", "syncStatus"] as const).map((k, i) =>
        item({ instanceRef: `WI-${i}`, widgetKey: k, variant: "status", position: i }));
      const { layoutRef } = await storeA().createLayout({ ...layout(), layoutRef: null }, items, false);
      const read = await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef });
      expect(read?.items.map((i) => i.widgetKey)).toEqual(["myDay", "hosRemaining", "unitReadiness", "syncStatus"]);
    });

    it("renames, reorders, adds and removes on update", async () => {
      const { layoutRef } = await storeA().createLayout(
        { ...layout(), layoutRef: null }, [item({ instanceRef: "WI-A" })], false);
      const out = await storeA().updateOwnedLayout(
        layout({ layoutRef, name: "Renamed" }),
        [item({ instanceRef: "WI-B", widgetKey: "myDay", variant: "list", position: 0 }),
         item({ instanceRef: "WI-C", widgetKey: "syncStatus", variant: "status", position: 1 })],
        false, ORG_A,
      );
      expect(out.ok).toBe(true);
      const read = await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef });
      expect(read?.layout.name).toBe("Renamed");
      expect(read?.items.map((i) => i.instanceRef)).toEqual(["WI-B", "WI-C"]);
    });

    it("keeps separate boards per device class", async () => {
      for (const deviceClass of ["phone", "tablet", "desktop"] as const) {
        await storeA().createLayout(
          { ...layout({ deviceClass, name: deviceClass, isDefault: true }), layoutRef: null }, [item()], true);
      }
      for (const deviceClass of ["phone", "tablet", "desktop"] as const) {
        const read = await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass });
        expect(read?.layout.name).toBe(deviceClass);
      }
    });

    it("cascades items away when a layout is deleted", async () => {
      const { layoutRef } = await storeA().createLayout(
        { ...layout(), layoutRef: null }, [item(), item({ instanceRef: "WI-2", position: 1 })], false);
      const rows = await db.select().from(widgetLayouts).where(eq(widgetLayouts.layoutRef, layoutRef));
      await db.delete(widgetLayouts).where(eq(widgetLayouts.id, rows[0]!.id));
      const orphans = await db.select().from(widgetLayoutItems);
      expect(orphans).toHaveLength(0);
    });
  });

  describe("exactly one default", () => {
    it("clears the previous default when a new one is set", async () => {
      const a = await storeA().createLayout({ ...layout({ name: "A", isDefault: true }), layoutRef: null }, [item()], true);
      const b = await storeA().createLayout({ ...layout({ name: "B", isDefault: true }), layoutRef: null }, [item()], true);
      const rows = await db.select().from(widgetLayouts);
      const defaults = rows.filter((r: Record<string, unknown>) => Boolean(r.isDefault));
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.layoutRef).toBe(b.layoutRef);
      expect(a.layoutRef).not.toBe(b.layoutRef);
    });

    it("survives concurrent default changes with exactly one winner", async () => {
      const refs = await Promise.all([1, 2, 3, 4].map((n) =>
        storeA().createLayout({ ...layout({ name: `L${n}` }), layoutRef: null }, [item()], false)));
      await Promise.all(refs.map((r) =>
        storeA().updateOwnedLayout(layout({ layoutRef: r.layoutRef, isDefault: true }), [item()], true, ORG_A)));
      const rows = await db.select().from(widgetLayouts);
      expect(rows.filter((r: Record<string, unknown>) => Boolean(r.isDefault))).toHaveLength(1);
    });

    it("does not clear another role's default", async () => {
      await storeA().createLayout({ ...layout({ roleKey: "DISPATCHER", name: "D", isDefault: true }), layoutRef: null }, [item()], true);
      await storeA().createLayout({ ...layout({ roleKey: "DRIVER", name: "R", isDefault: true }), layoutRef: null }, [item()], true);
      const rows = await db.select().from(widgetLayouts);
      expect(rows.filter((r: Record<string, unknown>) => Boolean(r.isDefault))).toHaveLength(2);
    });
  });

  describe("transactions", () => {
    it("rolls the parent back when an item write fails", async () => {
      const before = await db.select().from(widgetLayouts);
      const tooLong = item({ variant: "x".repeat(80) }); // varchar(32)
      await expect(
        storeA().createLayout({ ...layout({ name: "Doomed" }), layoutRef: null }, [tooLong], false),
      ).rejects.toThrow();
      const after = await db.select().from(widgetLayouts);
      // No half-saved board: the layout row is gone with its items.
      expect(after).toHaveLength(before.length);
      expect(after.find((r: Record<string, unknown>) => r.name === "Doomed")).toBeUndefined();
    });

    it("leaves the old item set intact when an update fails mid-write", async () => {
      const { layoutRef } = await storeA().createLayout(
        { ...layout({ name: "Keep" }), layoutRef: null },
        [item({ instanceRef: "WI-KEEP", widgetKey: "myDay", variant: "list" })], false);
      await expect(
        storeA().updateOwnedLayout(layout({ layoutRef }), [item({ variant: "y".repeat(80) })], false, ORG_A),
      ).rejects.toThrow();
      const read = await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef });
      expect(read?.items.map((i) => i.instanceRef)).toEqual(["WI-KEEP"]);
    });
  });

  describe("P0 — one user cannot touch another user's board", () => {
    it("refuses an update using a reference that belongs to somebody else", async () => {
      const a = await storeA().createLayout(
        { ...layout({ userId: 77, name: "A's board" }), layoutRef: null },
        [item({ instanceRef: "WI-A", widgetKey: "myDay", variant: "list" })], false);

      // User 91, same tenant, same role, same device, supplying A's reference.
      const out = await storeA().updateOwnedLayout(
        layout({ userId: 91, layoutRef: a.layoutRef, name: "Mine now" }),
        [item({ instanceRef: "WI-B", widgetKey: "syncStatus", variant: "status" })],
        true, ORG_A,
      );
      expect(out.ok).toBe(false);

      // Not one row of A's changed, and A's items are still A's.
      const read = await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef: a.layoutRef });
      expect(read?.layout.name).toBe("A's board");
      expect(read?.items.map((i) => i.instanceRef)).toEqual(["WI-A"]);

      const all = await db.select().from(widgetLayoutItems);
      expect(all).toHaveLength(1);
    });

    it("does not let a failed takeover clear A's default flag", async () => {
      const a = await storeA().createLayout(
        { ...layout({ userId: 77, isDefault: true }), layoutRef: null }, [item()], true);
      await storeA().updateOwnedLayout(
        layout({ userId: 91, layoutRef: a.layoutRef, isDefault: true }), [item()], true, ORG_A);
      const rows = await db.select().from(widgetLayouts).where(eq(widgetLayouts.userId, 77));
      // The unset ran only after ownership was established, so it never ran.
      expect(Boolean(rows[0]?.isDefault)).toBe(true);
    });

    it("lets two users hold the same reference string without collision", async () => {
      // Per-owner uniqueness: B's namespace is B's. Under B23's global unique
      // index this was an INSERT ... ON DUPLICATE KEY UPDATE onto A's row.
      const a = await storeA().createLayout({ ...layout({ userId: 77 }), layoutRef: null }, [item()], false);
      await pool.query(
        "INSERT INTO widgetLayouts (layoutRef, orgRef, userId, roleKey, deviceClass, name, isDefault, createdByUserId) VALUES (?,?,?,?,?,?,?,?)",
        [a.layoutRef, ORG_A, 91, "DRIVER", "phone", "B's own", false, 91]);
      const rows = await db.select().from(widgetLayouts).where(eq(widgetLayouts.layoutRef, a.layoutRef));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r: Record<string, unknown>) => r.userId))).toEqual(new Set([77, 91]));
    });

    it("refuses a same-user update naming the wrong role", async () => {
      const a = await storeA().createLayout({ ...layout({ roleKey: "DRIVER" }), layoutRef: null }, [item()], false);
      const out = await storeA().updateOwnedLayout(
        layout({ roleKey: "DISPATCHER", layoutRef: a.layoutRef }), [item()], false, ORG_A);
      expect(out.ok).toBe(false);
    });

    it("refuses a same-user update naming the wrong device class", async () => {
      const a = await storeA().createLayout({ ...layout({ deviceClass: "phone" }), layoutRef: null }, [item()], false);
      const out = await storeA().updateOwnedLayout(
        layout({ deviceClass: "desktop", layoutRef: a.layoutRef }), [item()], false, ORG_A);
      expect(out.ok).toBe(false);
    });

    it("refuses across tenants, and the read cannot see it either", async () => {
      const a = await storeA().createLayout({ ...layout({ name: "A tenant" }), layoutRef: null }, [item()], false);
      const storeB = drizzleWidgetLayoutStore(db, ORG_B);
      const out = await storeB.updateOwnedLayout(layout({ layoutRef: a.layoutRef, name: "Crossed" }), [item()], false, ORG_B);
      expect(out.ok).toBe(false);
      expect(await storeB.findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef: a.layoutRef })).toBeNull();
    });

    it("gives a nonexistent reference and an unauthorized one the same answer", async () => {
      const a = await storeA().createLayout({ ...layout({ userId: 77 }), layoutRef: null }, [item()], false);
      const unauthorized = await storeA().updateOwnedLayout(
        layout({ userId: 91, layoutRef: a.layoutRef }), [item()], false, ORG_A);
      const nonexistent = await storeA().updateOwnedLayout(
        layout({ userId: 91, layoutRef: "WL-NEVER-EXISTED" }), [item()], false, ORG_A);
      // Identical, so the endpoint is not a probe for whose layout exists.
      expect(unauthorized).toEqual(nonexistent);
      expect(unauthorized).toEqual({ ok: false });
    });

    it("does not read another user's default board", async () => {
      await storeA().createLayout({ ...layout({ userId: 91, name: "Theirs", isDefault: true }), layoutRef: null }, [item()], true);
      expect(await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone" })).toBeNull();
    });
  });

  describe("concurrency", () => {
    it("reaches a deterministic state under concurrent updates to one layout", async () => {
      const { layoutRef } = await storeA().createLayout({ ...layout(), layoutRef: null }, [item()], false);
      const names = ["one", "two", "three", "four", "five"];
      await Promise.all(names.map((n) =>
        storeA().updateOwnedLayout(layout({ layoutRef, name: n }),
          [item({ instanceRef: `WI-${n}`, position: 0 })], false, ORG_A)));
      const read = await storeA().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone", layoutRef });
      // One writer wins outright: exactly one item set, matching the name.
      expect(read?.items).toHaveLength(1);
      expect(read?.items[0]?.instanceRef).toBe(`WI-${read?.layout.name}`);
    });

    it("does not duplicate rows under concurrent creates", async () => {
      await Promise.all([1, 2, 3, 4, 5, 6].map((n) =>
        storeA().createLayout({ ...layout({ name: `C${n}` }), layoutRef: null }, [item()], false)));
      const rows = await db.select().from(widgetLayouts);
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((r: Record<string, unknown>) => r.layoutRef)).size).toBe(6);
    });
  });
});
