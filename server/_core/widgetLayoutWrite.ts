/**
 * B23 — saving a board.
 *
 * Pure. No network, no database. The caller runs the transaction; this decides
 * what is allowed into it.
 *
 * A saved layout is client-supplied data that later drives thirty server reads,
 * so it is the write path, not the read path, that has to be suspicious. Two
 * shapes of hole live here, and both have been found elsewhere in LeaseOS
 * already:
 *
 * **Naming your own subject.** 0086 closed a caller naming its own tenant.
 * `userId` and `roleKey` on a save request are the same thing one layer up: a
 * request that says whose board it is, and a server that takes its word for it.
 * Ownership is checked against the acting identity first, and a failure
 * short-circuits before anything else is examined.
 *
 * **Generic refusal.** The billing readiness rules forbid returning
 * "incomplete"; a layout save has the same duty. Every rejection is named and
 * carries its instance, and all of them are returned together so one round trip
 * fixes the board rather than one problem per attempt.
 *
 * One asymmetry is deliberate. On *read*, an unsupported variant is coerced to
 * the widget's default and an unregistered key resolves to `failed`: the row
 * already exists, the user is standing in front of it, and refusing to draw the
 * board would be worse than drawing it honestly. On *write*, both are refused:
 * the caller is holding the corrected value and can send it.
 */

import {
  definitionFor, isWidgetKey, permissionFor, supportsVariant,
  type WidgetDefinition, type WidgetKey,
} from "./widgetRegistry";
import { validateOptions } from "./widgetOptions";

export type DeviceClass = "phone" | "tablet" | "desktop";

/**
 * How wide a tile may be, by device.
 *
 * A phone board is one column. A tile claiming three of them is not a layout
 * preference, it is a row that will render wrong on the device it was saved
 * from, so it is refused rather than clamped.
 */
const MAX_SPAN_COLUMNS: Record<DeviceClass, number> = { phone: 1, tablet: 2, desktop: 4 };
const MAX_SPAN_ROWS = 3;

/**
 * The tile ceiling.
 *
 * `runBoard` resolves every tile in one pass, so a board is a fan-out
 * multiplier on thirteen engines. Forty is generous for a screen anyone can
 * read and low enough that a saved layout cannot be used to make the server
 * do four hundred reads per refresh.
 */
export const MAX_TILES = 40;

const MAX_NAME = 120;

/* ------------------------------------------------------------------ */
/* Inputs and outputs                                                   */
/* ------------------------------------------------------------------ */

export type IncomingItem = {
  instanceRef: string;
  widgetKey: string;
  variant: string;
  subjectRef?: string | null;
  position: number;
  spanColumns?: number;
  spanRows?: number;
  /**
   * Null and undefined both mean "no options".
   *
   * Same alignment defect as the read path had in B23, found again here: zod's
   * `.nullish()` emits `null`, the client omits the key, and accepting only one
   * of them forces the router to translate — which is exactly where a
   * translation gets forgotten.
   */
  options?: Readonly<Record<string, unknown>> | null;
};

export type LayoutSaveRequest = {
  /**
   * Null means create, and the store assigns the reference.
   *
   * A client-chosen reference on create is a client-chosen reference full
   * stop, and the update path then has to distinguish "new" from "someone
   * else's" by looking at the database — which is exactly the check that used
   * to be missing.
   */
  layoutRef: string | null;
  /** Whose board this claims to be. Never trusted; checked against the actor. */
  userId: number;
  roleKey: string;
  deviceClass: DeviceClass;
  name: string;
  isDefault: boolean;
  items: readonly IncomingItem[];
};

export type WriteContext = {
  actingUserId: number;
  /** Roles the actor actually holds, from the grants. */
  roles: readonly string[];
  permissions: readonly string[];
};

export type NamedRejection = { code: string; detail: string; instanceRef?: string };

export type NormalizedItem = {
  instanceRef: string;
  widgetKey: WidgetKey;
  variant: string;
  subjectRef: string | null;
  /** Rewritten to a dense 0..n-1 sequence in the caller's intended order. */
  position: number;
  spanColumns: number;
  spanRows: number;
  options: Readonly<Record<string, unknown>> | null;
};

/**
 * Work the caller must do in the same transaction.
 *
 * Returned rather than performed so this module stays pure, and named rather
 * than left implicit so "only one default" cannot be enforced in one call site
 * and forgotten in the next.
 */
export type SideEffect = {
  kind: "unset_other_defaults";
  userId: number;
  roleKey: string;
  deviceClass: DeviceClass;
};

export type LayoutSaveResult =
  | {
      ok: true;
      layout: {
        layoutRef: string | null; userId: number; roleKey: string;
        deviceClass: DeviceClass; name: string; isDefault: boolean;
      };
      items: readonly NormalizedItem[];
      sideEffects: readonly SideEffect[];
    }
  | { ok: false; rejections: readonly NamedRejection[] };

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate and normalize a layout save.
 *
 * Returns every rejection it finds, not the first, so the board can be fixed in
 * one pass. The exception is ownership: that returns alone, because a request
 * for somebody else's board has no business being told what else was wrong
 * with it.
 */
export function prepareLayoutSave(req: LayoutSaveRequest, ctx: WriteContext): LayoutSaveResult {
  // Authorization first, and nothing else if it fails.
  if (req.userId !== ctx.actingUserId) {
    return {
      ok: false,
      rejections: [{
        code: "NOT_OWNER",
        detail: `a layout may only be saved for the acting user (${ctx.actingUserId}), not ${req.userId}`,
      }],
    };
  }
  if (!ctx.roles.includes(req.roleKey)) {
    return {
      ok: false,
      rejections: [{
        code: "ROLE_NOT_HELD",
        detail: `the caller does not hold the role "${req.roleKey}"`,
      }],
    };
  }

  const rejections: NamedRejection[] = [];

  const name = req.name.trim();
  if (name.length === 0) rejections.push({ code: "NAME_EMPTY", detail: "a layout needs a name" });
  if (name.length > MAX_NAME) {
    rejections.push({ code: "NAME_TOO_LONG", detail: `a layout name is at most ${MAX_NAME} characters` });
  }

  if (req.items.length > MAX_TILES) {
    rejections.push({
      code: "TOO_MANY_TILES",
      detail: `${req.items.length} tiles exceeds the limit of ${MAX_TILES}; each tile is a server read on every refresh`,
    });
  }

  const seen = new Set<string>();
  const maxColumns = MAX_SPAN_COLUMNS[req.deviceClass];
  const accepted: {
    item: IncomingItem; def: WidgetDefinition; ordinal: number;
    options: Readonly<Record<string, unknown>> | null;
  }[] = [];

  req.items.forEach((item, ordinal) => {
    const at = item.instanceRef;

    if (at.trim().length === 0) {
      rejections.push({ code: "INSTANCE_REF_EMPTY", detail: `tile at index ${ordinal} has no instance reference` });
      return;
    }
    if (seen.has(at)) {
      rejections.push({ code: "DUPLICATE_INSTANCE", detail: `instance "${at}" appears more than once`, instanceRef: at });
      return;
    }
    seen.add(at);

    if (!isWidgetKey(item.widgetKey)) {
      rejections.push({
        code: "UNKNOWN_WIDGET",
        detail: `no widget registered as "${item.widgetKey}"`,
        instanceRef: at,
      });
      return;
    }
    const key: WidgetKey = item.widgetKey;
    const def = definitionFor(key);

    // Refuse at save what would resolve to `not_permitted` at read. An already
    // saved tile that becomes unreadable is a different case and stays on the
    // board as withheld — the user did not do anything wrong there.
    const permission = permissionFor(key);
    if (permission === null) {
      rejections.push({
        code: "WIDGET_UNMAPPED",
        detail: `"${def.procedure}" is not in the authorization map`,
        instanceRef: at,
      });
      return;
    }
    if (!ctx.permissions.includes(permission)) {
      rejections.push({
        code: "WIDGET_NOT_PERMITTED",
        detail: `${def.title} needs "${permission}"`,
        instanceRef: at,
      });
      return;
    }

    if (!supportsVariant(key, item.variant)) {
      rejections.push({
        code: "VARIANT_UNSUPPORTED",
        detail: `${def.title} cannot be drawn as "${item.variant}"; it supports ${def.variants.join(", ")}`,
        instanceRef: at,
      });
      return;
    }

    const columns = item.spanColumns ?? 1;
    const rows = item.spanRows ?? 1;
    if (!Number.isInteger(columns) || columns < 1 || columns > maxColumns) {
      rejections.push({
        code: "SPAN_OUT_OF_RANGE",
        detail: `a ${req.deviceClass} board allows 1 to ${maxColumns} columns, not ${columns}`,
        instanceRef: at,
      });
      return;
    }
    if (!Number.isInteger(rows) || rows < 1 || rows > MAX_SPAN_ROWS) {
      rejections.push({
        code: "SPAN_OUT_OF_RANGE",
        detail: `a tile spans 1 to ${MAX_SPAN_ROWS} rows, not ${rows}`,
        instanceRef: at,
      });
      return;
    }

    // A pinned subject must be a subject. Empty string is not "current" — that
    // is what null means — and treating it as such is how a tile ends up
    // describing whatever truck the caller happens to be in.
    if (item.subjectRef !== undefined && item.subjectRef !== null && item.subjectRef.trim().length === 0) {
      rejections.push({
        code: "SUBJECT_EMPTY",
        detail: `${def.title} was pinned to an empty subject; send null for "whatever is current"`,
        instanceRef: at,
      });
      return;
    }

    const options = validateOptions(key, item.options);
    if (!options.ok) {
      for (const r of options.rejections) rejections.push({ ...r, instanceRef: at });
      return;
    }

    accepted.push({ item, def, ordinal, options: options.options });
  });

  if (rejections.length > 0) return { ok: false, rejections };

  /**
   * Rewrite positions to a dense sequence.
   *
   * Clients send gaps, duplicates and stale indices after a drag. Ties break on
   * the order the items arrived rather than on anything incidental, so two
   * tiles at position 3 land in a defined order and the same request always
   * produces the same board.
   */
  const items: NormalizedItem[] = accepted
    .slice()
    .sort((a, b) => a.item.position - b.item.position || a.ordinal - b.ordinal)
    .map(({ item, options }, index) => ({
      instanceRef: item.instanceRef,
      widgetKey: item.widgetKey as WidgetKey,
      variant: item.variant,
      subjectRef: item.subjectRef ?? null,
      position: index,
      spanColumns: item.spanColumns ?? 1,
      spanRows: item.spanRows ?? 1,
      // The validated, defaulted value — never the raw one off the wire.
      options,
    }));

  return {
    ok: true,
    layout: {
      layoutRef: req.layoutRef, userId: req.userId, roleKey: req.roleKey,
      deviceClass: req.deviceClass, name, isDefault: req.isDefault,
    },
    items,
    sideEffects: req.isDefault
      ? [{ kind: "unset_other_defaults", userId: req.userId, roleKey: req.roleKey, deviceClass: req.deviceClass }]
      : [],
  };
}

/* ------------------------------------------------------------------ */
/* The starting board                                                  */
/* ------------------------------------------------------------------ */

/** How many tiles a starting board opens with, by how much screen there is. */
const DEFAULT_BOARD_SIZE: Record<DeviceClass, number> = { phone: 6, tablet: 9, desktop: 12 };

/**
 * A board for somebody who has never arranged one.
 *
 * Derived from the registry rather than stored as an org template. A template
 * table would be a second place where "what does a driver see" is decided, and
 * it would go stale against the registry the first time a widget was retired.
 * An administrator wanting a house board can still save one and share it; that
 * is deferred, not designed around.
 *
 * Only widgets the caller can actually read are included, so a starting board
 * never opens with withheld tiles.
 */
export function defaultBoardFor(
  ctx: Pick<WriteContext, "roles" | "permissions">,
  deviceClass: DeviceClass,
  limit: number = DEFAULT_BOARD_SIZE[deviceClass],
): readonly { widgetKey: WidgetKey; variant: string; position: number }[] {
  const suggested = (["myDay", "hosRemaining", "activeTrip", "unitReadiness", "documentExpiry",
    "syncStatus", "inbox", "exceptions", "dispatchReadiness", "activeJob", "search",
    "trackingLookup"] as const)
    .filter((key) => {
      const p = permissionFor(key);
      if (p === null || !ctx.permissions.includes(p)) return false;
      return definitionFor(key).suggestedFor.some((r) => ctx.roles.includes(r));
    });

  // Deliberately one column wide on every device. A seeded board should not
  // presume a width the user has not chosen, and the save path defaults spans
  // to 1 regardless — an earlier draft computed `Math.min(1, maxColumns)`
  // here, which is 1 for every device class, and returned it in a field the
  // declared type did not carry, so no caller could have read it.
  return suggested.slice(0, limit).map((key, position) => ({
    widgetKey: key,
    variant: definitionFor(key).defaultVariant,
    position,
  }));
}
