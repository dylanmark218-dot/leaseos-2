/**
 * B26 — compare-and-swap, against real MariaDB.
 *
 * The race this covers cannot be proven with a mock: two connections, one row,
 * one guard clause. Runs only when a database is configured, and is reported
 * skipped rather than passing when it is not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";
import { drizzleWidgetLayoutStore } from "./widgetLayouts";
import type { NormalizedItem } from "./_core/widgetLayoutWrite";
import type { StoredLayout } from "./_core/widgetService";

const DB_SOCKET = process.env.WIDGET_DB_SOCKET;
const suite = DB_SOCKET || process.env.WIDGET_DB_URL ? describe : describe.skip;

const item = (o: Partial<NormalizedItem> = {}): NormalizedItem => ({
  instanceRef: "WI-1", widgetKey: "hosRemaining", variant: "gauge",
  subjectRef: null, position: 0, spanColumns: 1, spanRows: 1, options: null, ...o,
});
const layout = (o: Partial<StoredLayout> = {}): StoredLayout => ({
  layoutRef: "unused-on-create", userId: 77, roleKey: "DRIVER",
  deviceClass: "phone", name: "Yard", isDefault: false, ...o,
});

suite("layout revision and conflict", () => {
  let pool: mysql.Pool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeAll(async () => {
    pool = mysql.createPool({
      socketPath: DB_SOCKET as string, user: "root",
      database: process.env.WIDGET_DB_NAME ?? "leaseos_b24",
      multipleStatements: true, connectionLimit: 8,
    });
    const sqlText = ["0089_widget_dashboards.sql", "0090_widget_layout_revision.sql"]
      .map((f) => readFileSync(new URL(`../drizzle/${f}`, import.meta.url), "utf8"))
      .join("\n");
    await pool.query("DROP TABLE IF EXISTS widgetLayoutItems");
    await pool.query("DROP TABLE IF EXISTS widgetLayouts");
    // Split on the breakpoint, exactly as the persistence harness and the
    // repo's runner do. The first version of this file replaced the breakpoint
    // with a semicolon and produced `;;`, which MariaDB rejected — a second way
    // of doing one thing, wrong on its first outing.
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const body = stmt.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
      if (body.length > 0) await pool.query(body);
    }
    db = drizzle(pool);
  });

  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => { await pool.query("DELETE FROM widgetLayoutItems; DELETE FROM widgetLayouts;"); });

  const store = () => drizzleWidgetLayoutStore(db, "ORG-A");

  /**
   * Creates the layout as the default.
   *
   * `findLayout` with no reference resolves the *default* board — the first
   * version of this helper created a non-default layout and then looked it up
   * that way, got null, and reported revision 0. The lookup was right; the
   * fixture was wrong.
   */
  const create = async () => {
    const { layoutRef } = await store().createLayout(
      { ...layout({ isDefault: true }), layoutRef: null }, [item()], true,
    );
    const found = await store().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone" });
    return { layoutRef, revision: found?.layout.revision ?? 0 };
  };

  it("starts a new layout at revision 1", async () => {
    const { revision } = await create();
    expect(revision).toBe(1);
  });

  it("bumps the revision on every authoritative save", async () => {
    const { layoutRef } = await create();
    await store().updateOwnedLayout(layout({ layoutRef, name: "Second", isDefault: true }), [item()], false, "ORG-A", 1);
    const after = await store().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone" });
    expect(after?.layout.revision).toBe(2);
    expect(after?.layout.name).toBe("Second");
  });

  it("accepts a save carrying the revision the client edited", async () => {
    const { layoutRef, revision } = await create();
    const res = await store().updateOwnedLayout(layout({ layoutRef, name: "Fresh", isDefault: true }), [item()], false, "ORG-A", revision);
    expect(res).toMatchObject({ ok: true, revision: 2 });
  });

  it("refuses a stale revision and writes nothing", async () => {
    const { layoutRef } = await create();
    await store().updateOwnedLayout(layout({ layoutRef, name: "Server change", isDefault: true }), [item()], false, "ORG-A", 1);

    // The offline device still believes it holds revision 1.
    const stale = await store().updateOwnedLayout(
      layout({ layoutRef, name: "Offline edit", isDefault: true }), [item({ instanceRef: "WI-2" })], false, "ORG-A", 1,
    );
    expect(stale).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT" });

    const after = await store().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone" });
    // Neither the name nor the items moved: a refused save is not a partial one.
    expect(after?.layout.name).toBe("Server change");
    expect(after?.items.map((i) => i.instanceRef)).toEqual(["WI-1"]);
  });

  it("tells the client what the server actually holds", async () => {
    const { layoutRef } = await create();
    await store().updateOwnedLayout(layout({ layoutRef, name: "A", isDefault: true }), [item()], false, "ORG-A", 1);
    await store().updateOwnedLayout(layout({ layoutRef, name: "B", isDefault: true }), [item()], false, "ORG-A", 2);
    const stale = await store().updateOwnedLayout(layout({ layoutRef, name: "C", isDefault: true }), [item()], false, "ORG-A", 1);
    expect(stale).toMatchObject({ ok: false, code: "LAYOUT_CONFLICT", serverRevision: 3 });
  });

  it("lets exactly one of two simultaneous saves win", async () => {
    const { layoutRef } = await create();
    const attempt = (name: string) =>
      store().updateOwnedLayout(layout({ layoutRef, name, isDefault: true }), [item()], false, "ORG-A", 1);

    const results = await Promise.all([attempt("first"), attempt("second")]);
    const wins = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: "LAYOUT_CONFLICT" });

    const after = await store().findLayout({ userId: 77, roleKey: "DRIVER", deviceClass: "phone" });
    expect(after?.layout.revision).toBe(2);
  });

  it("still updates when the caller expresses no opinion about the revision", async () => {
    // Callers with no offline story pass nothing and keep last-write-wins.
    const { layoutRef } = await create();
    const res = await store().updateOwnedLayout(layout({ layoutRef, name: "No CAS", isDefault: true }), [item()], false, "ORG-A");
    expect(res).toMatchObject({ ok: true });
  });

  it("refuses another user's layout before it ever reaches the revision check", async () => {
    const { layoutRef } = await create();
    const res = await store().updateOwnedLayout(
      layout({ layoutRef, userId: 91, name: "Mine now" }), [item()], false, "ORG-A", 1,
    );
    // Ownership first: not a conflict, a refusal, and indistinguishable from
    // a layout that does not exist.
    expect(res).toMatchObject({ ok: false });
    expect((res as { code?: string }).code).toBeUndefined();
  });
});
