/**
 * B23 — the widget registry.
 *
 * Pure. No network, no database.
 *
 * A catalogue of ~450 widget names arrived from a planning session. Most of it
 * is not a list of widgets; it is a list of the same forty or so engine answers
 * rendered differently. "Dispatch Readiness", "Blocked Assignments" and
 * "Dispatch Blocker Details" are one B12 gate answer at three zoom levels, not
 * three features. So a definition binds one data source, and a source declares
 * the *variants* it can be drawn as. The catalogue collapses into registrations
 * rather than into files.
 *
 * Two decisions worth stating, because both delete something that was proposed.
 *
 * **A definition is code, not a row.** It names a `ProcedureName`, and that
 * union only exists at compile time. A runtime-editable definition table could
 * name a procedure nobody wrote, and the board would discover it at read time
 * in front of a driver. `WidgetDefinition` as a table is therefore dropped;
 * the two tables that survive hold *layouts*, which are genuinely user data.
 *
 * **There is no widget permission table.** Permission is derived from the
 * procedure the widget reads, by the same `permissionForProcedure` the server
 * already uses to gate that procedure. A second, separately-edited mapping
 * would be a second answer to "may this person see this", and the two would
 * drift — the drift being a tile that renders because the widget table allowed
 * it while the procedure refuses, or worse, the reverse. `roleProcedure` took a
 * bare string once and a permission was passed where a procedure name belonged,
 * twice in four checkpoints. Deriving keeps that single-sourced.
 */

import { permissionForProcedure, type ProcedureName } from "./recordsAuthorization";

/* ------------------------------------------------------------------ */
/* Variants and policies                                                */
/* ------------------------------------------------------------------ */

/**
 * How one source may be drawn. A variant changes presentation only; it can
 * never change what the source is permitted to return.
 */
export type WidgetVariant =
  | "kpi"        // one number or state
  | "status"     // a state chip with reason
  | "list"       // the contributing rows
  | "detail"     // rows plus evidence
  | "gauge"
  | "countdown"
  | "timer"
  | "timeline"
  | "chart"
  | "map"
  | "checklist"
  | "queue"
  | "form"
  | "approval";

/**
 * What this widget does when the device has no connection.
 *
 * `none` is the honest default. A source with no offline answer renders the
 * `offline` state rather than a cached number with no label, because a stale
 * HOS clock presented as live is the exact failure the offline rules exist to
 * prevent.
 */
export type OfflinePolicy =
  | { kind: "none" }
  /** Cached in the pre-departure package; renders `stale` past its budget. */
  | { kind: "pre_departure"; maxStaleMinutes: number }
  /** Computed on device from the local queue. Works with no server at all. */
  | { kind: "device_local" };

/** Where the widget's subject comes from, so the resolver can refuse to guess. */
export type WidgetScope = "self" | "unit" | "trailer" | "job" | "trip" | "org" | "branch";

/**
 * What a widget's `options` may contain.
 *
 * Declarative and tiny on purpose. Opaque JSON was fine while there were
 * twelve widgets and no UI writing to it; it is not fine as a persisted,
 * client-supplied blob that reaches resolution. The three things it must never
 * become are a way to pick a different server procedure, a way to widen
 * permission, and a place to put an expression — so options are a closed set of
 * named scalars with declared bounds, and anything else is refused by name.
 */
export type OptionSpec =
  | { kind: "int"; min: number; max: number; default: number }
  | { kind: "bool"; default: boolean }
  | { kind: "enum"; values: readonly [string, ...string[]]; default: string };

export type OptionsSchema = Readonly<Record<string, OptionSpec>>;

export type WidgetDefinition = {
  key: WidgetKey;
  /** Shown in the Add Widget picker. */
  title: string;
  /** The single source of truth this widget reads. */
  procedure: ProcedureName;
  scope: WidgetScope;
  variants: readonly [WidgetVariant, ...WidgetVariant[]];
  defaultVariant: WidgetVariant;
  /** Live-refresh budget in seconds. 0 means on-demand only. */
  refreshSeconds: number;
  offline: OfflinePolicy;
  /**
   * Ordering hint for the picker. NOT authorization — a role listed here still
   * has to hold the derived permission, and a role absent from it still sees
   * the widget if it does.
   */
  suggestedFor: readonly string[];
  /** Empty means this widget takes no options, and any key is refused. */
  optionsSchema: OptionsSchema;
  /**
   * Picker grouping. Presentation metadata only.
   *
   * It grants nothing. A widget's permission still comes from the procedure it
   * reads, and a category that looked like an access tier would be a second
   * answer to "may I see this" waiting to drift from the first.
   */
  category: WidgetCategory;
};

/**
 * Picker groups, fixed now so adding a hundred widgets later is registration
 * rather than a UI redesign.
 */
export const WIDGET_CATEGORIES = [
  "My Work", "Dispatch", "Compliance", "HOS", "Fleet", "Documents", "Trips", "System",
] as const;

export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number];

/* ------------------------------------------------------------------ */
/* The registry                                                         */
/* ------------------------------------------------------------------ */

/**
 * B23 ships the twelve that wrap engines already on the server. Every one of
 * these has schema, authorization, audit and tests behind it today; none of
 * them needs a new data source to render truthfully. The rest of the catalogue
 * waits on its engine, which is the correct dependency direction — a widget
 * should be a ten-line consequence of shipping an engine, never a promise that
 * one exists.
 */
export const WIDGET_KEYS = [
  "myDay",
  "inbox",
  "exceptions",
  "dispatchReadiness",
  "hosRemaining",
  "documentExpiry",
  "unitReadiness",
  "activeJob",
  "activeTrip",
  "syncStatus",
  "trackingLookup",
  "search",
] as const;

export type WidgetKey = (typeof WIDGET_KEYS)[number];

export const WIDGET_DEFINITIONS = {
  myDay: {
    key: "myDay", title: "My Day", procedure: "surfaces.myDay", scope: "self",
    variants: ["list", "detail"], defaultVariant: "list", refreshSeconds: 60,
    offline: { kind: "pre_departure", maxStaleMinutes: 240 },
    category: "My Work",
    suggestedFor: ["DRIVER", "OPERATOR", "FIELD_SUPERVISOR"],
    optionsSchema: { limit: { kind: "int", min: 3, max: 20, default: 8 } },
  },
  inbox: {
    key: "inbox", title: "Inbox", procedure: "surfaces.inbox", scope: "self",
    variants: ["queue", "list"], defaultVariant: "queue", refreshSeconds: 60,
    offline: { kind: "none" },
    category: "My Work",
    suggestedFor: ["DISPATCHER", "SAFETY_COMPLIANCE", "BILLING_ACCOUNTING"],
    optionsSchema: { limit: { kind: "int", min: 3, max: 50, default: 10 }, unreadOnly: { kind: "bool", default: false } },
  },
  exceptions: {
    key: "exceptions", title: "Exception Centre", procedure: "surfaces.exceptions", scope: "org",
    variants: ["queue", "kpi", "list", "detail"], defaultVariant: "queue", refreshSeconds: 120,
    // Derived on read from current state, so there is nothing to cache.
    offline: { kind: "none" },
    category: "Dispatch",
    suggestedFor: ["DISPATCHER", "SAFETY_COMPLIANCE", "TENANT_ADMIN"],
    optionsSchema: { limit: { kind: "int", min: 3, max: 50, default: 10 }, severity: { kind: "enum", values: ["all", "blocking"], default: "all" } },
  },
  dispatchReadiness: {
    key: "dispatchReadiness", title: "Dispatch Readiness", procedure: "dispatch.readiness", scope: "job",
    variants: ["status", "checklist", "detail"], defaultVariant: "status", refreshSeconds: 30,
    offline: { kind: "none" },
    category: "Dispatch",
    suggestedFor: ["DISPATCHER", "FIELD_SUPERVISOR"],
    optionsSchema: { showPassing: { kind: "bool", default: false } },
  },
  hosRemaining: {
    key: "hosRemaining", title: "Hours Remaining", procedure: "hos.status", scope: "self",
    variants: ["kpi", "gauge", "countdown", "detail"], defaultVariant: "gauge", refreshSeconds: 60,
    // The one clock that has to work with no signal, computed from the local log.
    offline: { kind: "device_local" },
    category: "HOS",
    suggestedFor: ["DRIVER", "OPERATOR"],
    optionsSchema: { clock: { kind: "enum", values: ["driving", "onDuty", "cycle"], default: "driving" } },
  },
  documentExpiry: {
    key: "documentExpiry", title: "Expiring Documents", procedure: "records.documentExpiry", scope: "self",
    variants: ["list", "kpi", "detail"], defaultVariant: "list", refreshSeconds: 300,
    offline: { kind: "pre_departure", maxStaleMinutes: 1440 },
    category: "Documents",
    suggestedFor: ["DRIVER", "SAFETY_COMPLIANCE", "TENANT_ADMIN"],
    optionsSchema: { warnDays: { kind: "int", min: 1, max: 180, default: 30 }, limit: { kind: "int", min: 3, max: 30, default: 8 } },
  },
  unitReadiness: {
    key: "unitReadiness", title: "Unit Readiness", procedure: "shop.unitReadiness", scope: "unit",
    variants: ["status", "checklist", "detail"], defaultVariant: "status", refreshSeconds: 120,
    offline: { kind: "pre_departure", maxStaleMinutes: 720 },
    category: "Fleet",
    suggestedFor: ["DRIVER", "MECHANIC", "DISPATCHER"],
    optionsSchema: { includeTrailer: { kind: "bool", default: true } },
  },
  activeJob: {
    key: "activeJob", title: "Active Job", procedure: "jobs.active", scope: "job",
    variants: ["status", "detail", "timeline"], defaultVariant: "status", refreshSeconds: 60,
    offline: { kind: "pre_departure", maxStaleMinutes: 480 },
    category: "My Work",
    suggestedFor: ["DRIVER", "DISPATCHER", "CLIENT_VIEWER"],
    optionsSchema: {},
  },
  activeTrip: {
    key: "activeTrip", title: "Active Trip", procedure: "trips.active", scope: "trip",
    variants: ["status", "timeline", "map", "detail"], defaultVariant: "timeline", refreshSeconds: 30,
    // B25: was `device_local`, which the device cannot honour. A trip is a
    // server record a dispatcher can reassign; the device knows only what it
    // last saw. The local resolver therefore returned `unknown` forever
    // offline, which is honest and useless — a dated cached value is both.
    offline: { kind: "pre_departure", maxStaleMinutes: 120 },
    category: "Trips",
    suggestedFor: ["DRIVER", "DISPATCHER"],
    optionsSchema: { layer: { kind: "enum", values: ["route", "breadcrumb", "none"], default: "route" } },
  },
  syncStatus: {
    key: "syncStatus", title: "Sync Status", procedure: "sync.status", scope: "self",
    variants: ["status", "kpi", "queue"], defaultVariant: "status", refreshSeconds: 15,
    // Reporting on the queue is the queue's own job; it cannot need the network.
    offline: { kind: "device_local" },
    category: "System",
    suggestedFor: ["DRIVER", "OPERATOR", "FIELD_SUPERVISOR"],
    optionsSchema: {},
  },
  trackingLookup: {
    key: "trackingLookup", title: "Tracking Number Lookup", procedure: "surfaces.timeline", scope: "org",
    variants: ["form", "timeline"], defaultVariant: "form", refreshSeconds: 0,
    offline: { kind: "none" },
    category: "System",
    suggestedFor: ["DISPATCHER", "BILLING_ACCOUNTING", "TENANT_ADMIN"],
    optionsSchema: {},
  },
  search: {
    key: "search", title: "Search", procedure: "surfaces.search", scope: "org",
    variants: ["form", "list"], defaultVariant: "form", refreshSeconds: 0,
    offline: { kind: "pre_departure", maxStaleMinutes: 1440 },
    category: "System",
    suggestedFor: ["DISPATCHER", "FIELD_SUPERVISOR", "TENANT_ADMIN"],
    optionsSchema: { limit: { kind: "int", min: 5, max: 50, default: 15 } },
  },
} as const satisfies Record<WidgetKey, WidgetDefinition>;

/* ------------------------------------------------------------------ */
/* Derivations                                                          */
/* ------------------------------------------------------------------ */

export const definitionFor = (key: WidgetKey): WidgetDefinition => WIDGET_DEFINITIONS[key];

/**
 * The permission a widget needs, derived from the procedure it reads.
 *
 * `null` means the procedure is not in the authorization map. That is a wiring
 * fault, and the resolver treats it as a refusal rather than letting the widget
 * degrade to authenticated-only — the same stance `roleProcedure` takes.
 */
export const permissionFor = (key: WidgetKey): string | null =>
  permissionForProcedure(WIDGET_DEFINITIONS[key].procedure);

/** Does this key name a registered widget? Guards persisted layouts. */
export const isWidgetKey = (k: string): k is WidgetKey =>
  (WIDGET_KEYS as readonly string[]).includes(k);

/** May this widget be drawn this way? Guards persisted variants. */
export const supportsVariant = (key: WidgetKey, v: string): v is WidgetVariant =>
  (WIDGET_DEFINITIONS[key].variants as readonly string[]).includes(v);
