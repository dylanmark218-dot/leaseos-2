/**
 * B24 — layout persistence.
 *
 * Executed against MariaDB 10.11 in the B24 container. The queries below have
 * run; see `server/widgetPersistence.db.test.ts`.
 *
 * The rule this file exists to enforce: a client-supplied `layoutRef` is a
 * string, not a capability. B23's store took one and wrote against it, so the
 * ownership check lived entirely in a pure validator comparing the request body
 * to itself. Here, every write resolves the layout to an internal `id` through
 * a query that includes the owner, and does so inside the transaction that will
 * modify it — so the row cannot change owner between the check and the write.
 *
 * Reads are the same shape. `findLayout` takes `userId` and uses it
 * unconditionally, rather than accepting an optional filter a future caller
 * could omit and never notice.
 */

import { and, eq, sql } from "drizzle-orm";
import { widgetLayoutItems, widgetLayouts } from "../drizzle/schema";
import type { StoredLayout, WidgetLayoutStore } from "./_core/widgetService";
import type { LayoutItem } from "./_core/widgetDashboard";
import type { DeviceClass, NormalizedItem } from "./_core/widgetLayoutWrite";

// The repo's own Db type comes from its drizzle client factory.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/**
 * Server-assigned reference.
 *
 * Random rather than sequential: a sequential external reference tells every
 * holder how many boards exist and lets them name their neighbour's, and the
 * per-owner uniqueness constraint means guessing one is useless anyway. This
 * belt is cheap enough to keep with the braces.
 */
/**
 * Retry a transaction that InnoDB rolled back for deadlock.
 *
 * Found by the B24 concurrency tests: five concurrent saves to one owner's
 * boards produced `ER_LOCK_DEADLOCK` (1213) and surfaced it to the caller,
 * which in the product means a driver taps Save, gets an error, and loses the
 * arrangement. A deadlock is not a bug report — InnoDB picks a victim and
 * expects the loser to try again — so a store that does not retry is simply
 * incomplete.
 *
 * Bounded and jittered. Unbounded retry would turn contention into a spin, and
 * a fixed backoff makes two colliding writers collide again in lockstep.
 * Anything that is not a deadlock or a lock-wait timeout is rethrown
 * immediately: a constraint violation must not be retried into existence.
 */
const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

/**
 * Find a driver error code anywhere in the cause chain.
 *
 * Drizzle wraps a driver failure in its own error and hangs the mysql2 error
 * off `cause`. The first version of the retry read `.code` straight off the
 * thrown object, found `undefined`, decided the deadlock was not retryable and
 * rethrew it — so the retry existed, was covered by no test of its own, and did
 * nothing at all. The concurrency tests kept failing identically, which is the
 * only reason it was caught.
 */
function driverCode(e: unknown, depth = 0): string | undefined {
  if (e === null || typeof e !== "object" || depth > 5) return undefined;
  const here = (e as { code?: unknown }).code;
  if (typeof here === "string") return here;
  return driverCode((e as { cause?: unknown }).cause, depth + 1);
}

async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      const code = driverCode(e);
      if (code === undefined || !RETRYABLE.has(code) || attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, attempt * 15 + Math.floor(Math.random() * 25)));
    }
  }
}

function newLayoutRef(): string {
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `WL-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

export function drizzleWidgetLayoutStore(db: Db, orgRef: string): WidgetLayoutStore {
  /**
   * Resolve a layout to its internal id, or nothing.
   *
   * Every element of the scope is required. A caller cannot ask "which layout
   * has this ref" without also saying whose, in what tenant, for which role
   * and which device — and a mismatch on any of them is indistinguishable from
   * the row not existing.
   */
  async function ownedId(
    tx: Db,
    q: { userId: number; roleKey: string; deviceClass: DeviceClass; layoutRef: string; orgRef: string },
    lock = false,
  ): Promise<number | null> {
    // `FOR UPDATE` when a write follows, so the parent row is always the first
    // lock taken. The deadlock the concurrency tests found came from two
    // transactions acquiring the parent row and the owner-range in opposite
    // orders; locking the row first gives every writer the same order.
    const q1 = tx
      .select({ id: widgetLayouts.id })
      .from(widgetLayouts)
      .where(and(
        eq(widgetLayouts.orgRef, q.orgRef),
        eq(widgetLayouts.userId, q.userId),
        eq(widgetLayouts.roleKey, q.roleKey),
        eq(widgetLayouts.deviceClass, q.deviceClass),
        eq(widgetLayouts.layoutRef, q.layoutRef),
      ))
      .limit(1);
    const rows = lock ? await q1.for("update") : await q1;
    return rows[0]?.id ?? null;
  }

  async function unsetDefaults(tx: Db, l: { userId: number; roleKey: string; deviceClass: DeviceClass }) {
    await tx.update(widgetLayouts).set({ isDefault: false }).where(and(
      eq(widgetLayouts.orgRef, orgRef),
      eq(widgetLayouts.userId, l.userId),
      eq(widgetLayouts.roleKey, l.roleKey),
      eq(widgetLayouts.deviceClass, l.deviceClass),
    ));
  }

  async function writeItems(tx: Db, layoutId: number, items: readonly NormalizedItem[]) {
    // Replace, not diff. Forty rows at most, identity is not stable across a
    // drag, and a half-applied diff leaves a board the user did not arrange.
    await tx.delete(widgetLayoutItems).where(eq(widgetLayoutItems.layoutId, layoutId));
    if (items.length === 0) return;
    await tx.insert(widgetLayoutItems).values(items.map((i) => ({
      layoutId, instanceRef: i.instanceRef, widgetKey: i.widgetKey, variant: i.variant,
      subjectRef: i.subjectRef, position: i.position,
      spanColumns: i.spanColumns, spanRows: i.spanRows, options: i.options,
    })));
  }

  return {
    async findLayout(q) {
      const scope = and(
        eq(widgetLayouts.orgRef, orgRef),
        eq(widgetLayouts.userId, q.userId),
        eq(widgetLayouts.roleKey, q.roleKey),
        eq(widgetLayouts.deviceClass, q.deviceClass),
      );
      const where = q.layoutRef
        ? and(scope, eq(widgetLayouts.layoutRef, q.layoutRef))
        : and(scope, eq(widgetLayouts.isDefault, true));

      const rows = await db.select().from(widgetLayouts).where(where).limit(1);
      const row = rows[0];
      if (!row) return null;

      const itemRows = await db
        .select().from(widgetLayoutItems)
        .where(eq(widgetLayoutItems.layoutId, row.id))
        .orderBy(widgetLayoutItems.position);

      const layout: StoredLayout = {
        layoutRef: row.layoutRef, userId: row.userId, roleKey: row.roleKey,
        deviceClass: row.deviceClass as DeviceClass, name: row.name,
        isDefault: Boolean(row.isDefault),
        // Defaulted to 1, not 0: a row written before 0090 has been saved once,
        // and a client comparing "never saved" against "saved once" should not
        // see both as zero.
        revision: (row.revision as number | undefined) ?? 1,
      };
      const items: LayoutItem[] = itemRows.map((i: Record<string, unknown>) => ({
        instanceRef: i.instanceRef as string,
        widgetKey: i.widgetKey as string,
        variant: i.variant as string,
        subjectRef: (i.subjectRef as string | null) ?? null,
        position: i.position as number,
        spanColumns: i.spanColumns as number,
        spanRows: i.spanRows as number,
        options: (i.options as Readonly<Record<string, unknown>> | null) ?? null,
      }));
      return { layout, items };
    },

    async createLayout(layout, items, unsetOtherDefaults) {
      const layoutRef = newLayoutRef();
      await withDeadlockRetry(() => db.transaction(async (tx: Db) => {
        // Parent row first, then the range, then our own flag, then items —
        // the same order every writer takes.
        await tx.insert(widgetLayouts).values({
          layoutRef, orgRef, userId: layout.userId, roleKey: layout.roleKey,
          deviceClass: layout.deviceClass, name: layout.name, isDefault: false,
          createdByUserId: layout.userId,
        });
        const id = await ownedId(tx, { ...layout, layoutRef, orgRef }, true);
        // Cannot happen after a successful insert in the same transaction; if
        // it ever does, failing is correct and silently writing items to a
        // layout we cannot re-find is not.
        if (id === null) throw new Error("created layout could not be resolved in its own transaction");
        if (unsetOtherDefaults) await unsetDefaults(tx, layout);
        if (layout.isDefault) {
          await tx.update(widgetLayouts).set({ isDefault: true }).where(eq(widgetLayouts.id, id));
        }
        await writeItems(tx, id, items);
      }));
      return { layoutRef };
    },

    async updateOwnedLayout(layout, items, unsetOtherDefaults, tenantId, expectedRevision) {
      let ok = false;
      let conflict = false;
      let currentRevision: number | null = null;
      await withDeadlockRetry(() => db.transaction(async (tx: Db) => {
        // Reset per attempt: a retried transaction must not inherit the last
        // attempt's verdict.
        ok = false;
        // Ownership first, inside the transaction, before a single item row is
        // touched. The tenant comes from the acting scope, not the request.
        const id = await ownedId(tx, {
          userId: layout.userId, roleKey: layout.roleKey, deviceClass: layout.deviceClass,
          layoutRef: layout.layoutRef, orgRef: tenantId,
        }, true);
        if (id === null) return; // fail closed; ok stays false, nothing written

        // Compare-and-swap, inside the same transaction and the same statement
        // as the write. Reading the revision first and updating second would
        // leave a window another connection fits through, which is precisely
        // the race two offline devices reconnecting together produce.
        const rows = await tx.select({ revision: widgetLayouts.revision })
          .from(widgetLayouts).where(eq(widgetLayouts.id, id)).limit(1);
        currentRevision = (rows[0]?.revision as number | undefined) ?? null;
        if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
          conflict = true;
          return; // nothing written; the caller is told what the server holds
        }

        if (unsetOtherDefaults) await unsetDefaults(tx, layout);
        const applied = await tx.update(widgetLayouts)
          .set({
            name: layout.name, isDefault: layout.isDefault,
            revision: sql`${widgetLayouts.revision} + 1`,
          })
          .where(expectedRevision === undefined
            ? eq(widgetLayouts.id, id)
            : and(eq(widgetLayouts.id, id), eq(widgetLayouts.revision, expectedRevision)));

        // Drizzle/mysql2 reports affected rows; zero means the guard matched
        // nothing, which is a conflict rather than a success with no work.
        const affected = (applied as unknown as { rowsAffected?: number; affectedRows?: number })
          ?.rowsAffected ?? (applied as unknown as [{ affectedRows?: number }])?.[0]?.affectedRows ?? 1;
        if (affected === 0) { conflict = true; return; }

        await writeItems(tx, id, items);
        currentRevision = (currentRevision ?? 0) + 1;
        ok = true;
      }));
      if (ok) return currentRevision === null ? { ok: true } : { ok: true, revision: currentRevision };
      if (!conflict) return { ok: false };
      return currentRevision === null
        ? { ok: false, code: "LAYOUT_CONFLICT" as const }
        : { ok: false, code: "LAYOUT_CONFLICT" as const, serverRevision: currentRevision };
    },
  };
}

/** Applied by the DB test harness and by the repo's migration runner. */
export const WIDGET_TABLES = [widgetLayouts, widgetLayoutItems];
export { sql as widgetSql };
