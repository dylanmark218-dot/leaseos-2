/**
 * B23 — resolving a board.
 *
 * Pure planning. The caller performs the reads; nothing here touches a
 * database or the network, so every rule below is testable without one.
 *
 * A board is thirty tiles. Thirty tiles resolved naively is thirty round trips
 * that share a failure mode: one engine throwing takes the dashboard with it,
 * and the driver gets a spinner instead of the four tiles that would have told
 * them why they cannot leave the yard. So resolution is one pass, and every
 * tile fails alone.
 *
 * The short-circuits happen here, before any read is attempted, because each
 * one is a decision about what the caller is owed rather than a fact to fetch:
 *
 * **Withheld is listed, not dropped.** A layout is saved; permissions change.
 * A dispatcher who loses billing keeps the billing tile on the board as a
 * named withheld item. Silently shrinking the board would leave someone
 * believing they had seen everything.
 *
 * **Offline is a state, not a cache miss.** A source declaring no offline
 * answer resolves to `offline`. It does not resolve to yesterday's number with
 * today's styling.
 *
 * **An unregistered key is a fault, not a blank.** Layouts outlive
 * registrations. A removed widget resolves to `failed` with its key named, so
 * the board says what it lost.
 */

import {
  definitionFor, isWidgetKey, permissionFor, supportsVariant,
  type WidgetDefinition, type WidgetKey, type WidgetVariant,
} from "./widgetRegistry";
import { type WidgetPayload } from "./widgetPayload";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** One tile as the user placed it. Persisted; therefore untrusted. */
export type LayoutItem = {
  instanceRef: string;
  widgetKey: string;
  variant: string;
  /** Which unit/job/trip this instance is pinned to, when the scope needs one. */
  subjectRef?: string | null;
  position: number;
  /**
   * Tile size on a multi-column board.
   *
   * The store has been selecting both columns from MariaDB since B24 and
   * setting them on these objects — but this type did not declare them, so
   * they arrived at runtime and were invisible to every consumer. That is why
   * "spans do not reach the UI" was the symptom: not a renderer that ignored
   * them, a read type that dropped them. Optional because a legacy row may
   * hold neither, and `planGrid` normalizes on read.
   */
  spanColumns?: number | null;
  spanRows?: number | null;
  /**
   * Null and undefined both mean "no options".
   *
   * Validation emits `null` (a column value) while a client omits the key
   * entirely, and an earlier version of this type accepted only the latter —
   * so the validated output of the write path did not fit the input of the read
   * path, and every adapter between them would have had to translate one into
   * the other. One of them would eventually have forgotten.
   */
  options?: Readonly<Record<string, unknown>> | null;
};

export type ResolveContext = {
  /** Permissions the caller actually holds, from the role grants. */
  permissions: readonly string[];
  connected: boolean;
  /** Subject the board is implicitly about — the caller's own shift, unit, trip. */
  implicitSubjects: Readonly<Partial<Record<WidgetDefinition["scope"], string>>>;
};

/** A tile the caller is owed a read for. */
export type ResolveTask = {
  /**
   * The tile's place on the board, assigned before anything is split off.
   *
   * The first version of `runBoard` reassembled the board as
   * `[...tasks, ...settled]`, which silently moved every withheld, offline or
   * faulted tile to the bottom — so a driver whose Exceptions tile was
   * withheld found their board rearranged, and the only test covering it
   * counted tiles instead of checking their sequence. Order is now carried on
   * the entry rather than reconstructed from the split.
   */
  order: number;
  instanceRef: string;
  widgetKey: WidgetKey;
  variant: WidgetVariant;
  procedure: WidgetDefinition["procedure"];
  subjectRef: string | null;
  /**
   * The tile's validated options, forwarded to the source.
   *
   * B24 validated these on save, stored them, and round-tripped them through
   * MariaDB — and then dropped them here, so no source ever saw one and two
   * tiles configured differently shared a single read. Found when the B25
   * device manifest tried to forward them and there was nothing on the task to
   * forward. Same defect as the spans: a field that survives persistence and
   * dies at the resolver reads as supported.
   */
  options: Readonly<Record<string, unknown>> | null;
  /** True when the answer must come from the device rather than the server. */
  deviceLocal: boolean;
  /** Freshness budget for aging a cached answer. Null when none applies. */
  maxStaleMinutes: number | null;
  /**
   * True when this answer can only be coming out of the pre-departure cache,
   * because the device is offline and the source declared one.
   *
   * `runBoard` enforces what this implies rather than trusting the reader to.
   * The first version handed `maxStaleMinutes` to the reader and hoped it would
   * age the value; a reader that forgot — and the demo reader did — produced a
   * verified green tile over a cached number with no connection in sight. A
   * budget nobody enforces is a comment.
   */
  servedFromCache: boolean;
};

/** A tile already decided without a read. */
export type ResolvedTile = {
  order: number;
  instanceRef: string;
  widgetKey: string;
  payload: WidgetPayload<never>;
};

export type ResolvePlan = {
  tasks: readonly ResolveTask[];
  /** Decided before any read: withheld, offline, or faulted. */
  settled: readonly ResolvedTile[];
};

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Split a saved layout into what must be read and what is already answered.
 *
 * Order is preserved by `position` so the board renders where the user put
 * things, withheld tiles included.
 */
export function planBoard(items: readonly LayoutItem[], ctx: ResolveContext): ResolvePlan {
  const tasks: ResolveTask[] = [];
  const settled: ResolvedTile[] = [];

  const ordered = [...items].sort((a, b) => a.position - b.position);
  for (const [order, item] of Array.from(ordered.entries())) {
    if (!isWidgetKey(item.widgetKey)) {
      settled.push({
        order, instanceRef: item.instanceRef, widgetKey: item.widgetKey,
        payload: { state: "failed", reason: `no widget registered as "${item.widgetKey}"` },
      });
      continue;
    }
    const key: WidgetKey = item.widgetKey;
    const def = definitionFor(key);

    // Authorization first. A withheld tile must not go on to have its subject
    // resolved or its offline policy consulted, both of which leak shape.
    const permission = permissionFor(key);
    if (permission === null) {
      // Unmapped procedure. A wiring fault, refused rather than defaulted open.
      settled.push({
        order, instanceRef: item.instanceRef, widgetKey: key,
        payload: { state: "failed", reason: `"${def.procedure}" is not in the authorization map` },
      });
      continue;
    }
    if (!ctx.permissions.includes(permission)) {
      settled.push({
        order, instanceRef: item.instanceRef, widgetKey: key,
        payload: { state: "not_permitted", permission },
      });
      continue;
    }

    const variant: WidgetVariant = supportsVariant(key, item.variant) ? item.variant : def.defaultVariant;

    const deviceLocal = def.offline.kind === "device_local";
    if (!ctx.connected && def.offline.kind === "none") {
      settled.push({
        order, instanceRef: item.instanceRef, widgetKey: key,
        payload: { state: "offline" },
      });
      continue;
    }

    const subjectRef = item.subjectRef ?? ctx.implicitSubjects[def.scope] ?? null;
    if (subjectRef === null && def.scope !== "self" && def.scope !== "org" && def.scope !== "branch") {
      // No unit, no job, no trip. The tile has nothing to be about, and
      // guessing the caller's "probably current" one is how a readiness tile
      // ends up describing the wrong truck.
      settled.push({
        order, instanceRef: item.instanceRef, widgetKey: key,
        payload: { state: "unknown", reason: `no ${def.scope} selected for this tile` },
      });
      continue;
    }

    tasks.push({
      order, instanceRef: item.instanceRef, widgetKey: key, variant, procedure: def.procedure, subjectRef,
      options: item.options ?? null,
      deviceLocal,
      maxStaleMinutes: def.offline.kind === "pre_departure" ? def.offline.maxStaleMinutes : null,
      servedFromCache: !ctx.connected && def.offline.kind === "pre_departure",
    });
  }

  return { tasks, settled };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export type TileResult = { order: number; instanceRef: string; widgetKey: string; payload: WidgetPayload<unknown> };

/**
 * Two tiles asking the same engine the same question.
 *
 * "Dispatch Readiness", "Blocked Assignments" and "Dispatch Blocker Details"
 * are one gate answer at three zoom levels. Left alone, a board holding all
 * three calls the gate three times per refresh, and forty tiles across a fleet
 * turns a dashboard into a load test. Tiles sharing a procedure and a subject
 * are read once and the answer is fanned out.
 *
 * The key deliberately excludes `variant`: variant is presentation and must
 * never change which source is consulted. It also excludes `instanceRef`,
 * which is what makes the sharing possible.
 */
export const sourceKeyOf = (t: ResolveTask): string =>
  [
    t.procedure,
    t.subjectRef ?? "~self",
    t.deviceLocal ? "local" : "server",
    t.servedFromCache ? "cache" : "live",
    t.maxStaleMinutes ?? "-",
    // Options are part of the question. An expiring-documents tile warning at
    // 7 days and one warning at 30 are not the same read, and before options
    // reached the task these two shared an answer — whichever resolved first
    // decided what both of them said.
    optionsKey(t.options),
  ].join("|");

/** Stable, order-independent encoding, so `{a,b}` and `{b,a}` are one key. */
const optionsKey = (o: Readonly<Record<string, unknown>> | null): string =>
  o === null ? "-" : JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Run the plan with every tile isolated.
 *
 * A source that throws becomes one `failed` tile carrying its message. It does
 * not reject the batch, and it does not become an empty `ok`, which would be
 * the same lie as a blank dash over a number nobody has.
 */
export async function runBoard(
  plan: ResolvePlan,
  read: (task: ResolveTask) => Promise<WidgetPayload<unknown>>,
  now: Date = new Date(),
): Promise<readonly TileResult[]> {
  // One read per distinct source query, shared by every tile that asked it.
  const inFlight = new Map<string, Promise<WidgetPayload<unknown>>>();
  const readOnce = (task: ResolveTask): Promise<WidgetPayload<unknown>> => {
    const key = sourceKeyOf(task);
    const held = inFlight.get(key);
    if (held) return held;
    const started = (async () => {
      try {
        return fromCache(task, await read(task), now);
      } catch (e) {
        const reason = e instanceof Error ? e.message : "source failed";
        return { state: "failed", reason } as WidgetPayload<unknown>;
      }
    })();
    inFlight.set(key, started);
    return started;
  };

  const fetched: readonly TileResult[] = await Promise.all(
    plan.tasks.map(async (task): Promise<TileResult> => ({
      order: task.order, instanceRef: task.instanceRef, widgetKey: task.widgetKey,
      payload: await readOnce(task),
    })),
  );

  // Reassembled from the order assigned before the split, so a withheld or
  // faulted tile stays exactly where the user put it.
  return [
    ...fetched,
    ...plan.settled.map((s) => ({ ...s, payload: s.payload as WidgetPayload<unknown> })),
  ].sort((a, b) => a.order - b.order);
}

/**
 * Downgrade an `ok` that could only have come from cache.
 *
 * Structural, not advisory: a reader cannot return a confirmed-looking value
 * for a tile the planner already knows is being served offline. `stale` keeps
 * the number — it is real — and makes the board say when it was true.
 */
export function fromCache(
  task: ResolveTask,
  payload: WidgetPayload<unknown>,
  now: Date = new Date(),
): WidgetPayload<unknown> {
  if (!task.servedFromCache || payload.state !== "ok") return payload;

  const observedAt = payload.provenance.observedAt;
  const budget = task.maxStaleMinutes;

  // Past its budget the value stops being shown at all. `stale` says "this was
  // true at 14:35"; a four-day-old odometer reading presented that way still
  // invites someone to act on it, and the budget is the source's own statement
  // about how long its answer stays useful. Expired cache reports as offline
  // with the time it last held an answer.
  if (budget !== null && (now.getTime() - observedAt.getTime()) / 60_000 > budget) {
    return { state: "offline", cachedAt: observedAt };
  }

  return {
    state: "stale", value: payload.value, asOf: observedAt, provenance: payload.provenance,
    ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* The picker                                                          */
/* ------------------------------------------------------------------ */

/**
 * What may be offered in Add Widget.
 *
 * The same derived permission that gates the read gates the offer, so the
 * picker cannot advertise a tile that would resolve to `not_permitted` the
 * moment it was placed. `suggestedFor` only orders the list.
 */
export function offerableWidgets(ctx: Pick<ResolveContext, "permissions">, roles: readonly string[]): readonly WidgetKey[] {
  const allowed = (Object.keys(WIDGET_DEFINITIONS_KEYS) as WidgetKey[]).filter((key) => {
    const p = permissionFor(key);
    return p !== null && ctx.permissions.includes(p);
  });
  return allowed.sort((a, b) => {
    const score = (k: WidgetKey) => (definitionFor(k).suggestedFor.some((r) => roles.includes(r)) ? 0 : 1);
    return score(a) - score(b) || definitionFor(a).title.localeCompare(definitionFor(b).title);
  });
}

// Imported separately to keep the picker honest about where keys come from.
import { WIDGET_DEFINITIONS as WIDGET_DEFINITIONS_KEYS } from "./widgetRegistry";
