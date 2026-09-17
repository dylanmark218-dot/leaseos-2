/**
 * B28E — Widget Registry V2, for the four widgets the evidence supports.
 *
 * Pure. The legacy registry is untouched and the other eight stay on the
 * adapter.
 *
 * The job of these types is to make the mistakes of B23–B27 unrepresentable
 * rather than merely discouraged. Each union below exists because something
 * went wrong that a type could have caught:
 *
 * - `sync.status` was invented to satisfy a `procedure: ProcedureName` field on
 *   a device-local widget. `DeviceLocalSource` has no procedure field, so the
 *   fabrication cannot be written down.
 * - `HOS_PROJECTORS` read `drivingRemainingMinutes` from a source that returns
 *   elapsed clocks. `HosClockPresentation` has no remaining field.
 * - A historical readiness view would have rendered `contributions: []`,
 *   claiming there were none. `HistoricalDispatchReadiness` types the absence.
 * - A cached trip tile could have been marked authoritative. `ValueAuthority`
 *   is per-connectivity, so online and offline cannot share one answer.
 *
 * A type that merely documents is not worth adding. Every field here is read by
 * the promotion gate, the runtime, or a test.
 */

import type { ProcedureName } from "./recordsAuthorization";
import type { DeviceSourceType } from "./deviceManifest";
import type { OfflinePolicy, OptionsSchema, WidgetCategory, WidgetVariant } from "./widgetRegistry";

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

/**
 * May the acting role use this widget?
 *
 * Never inferred from the data source. B23 derived permission from
 * `procedure`, which is why a device-local widget needed a fake one.
 */
export type AuthorizationContract =
  | { kind: "procedure"; procedure: ProcedureName; confidence: "CONFIRMED" }
  | { kind: "unresolved"; question: string };

/* ------------------------------------------------------------------ */
/* Data sources                                                        */
/* ------------------------------------------------------------------ */

/** Computed on the device. No procedure field exists to fabricate. */
export type DeviceLocalSource = {
  kind: "device_local";
  resolver: DeviceSourceType;
  runtimeVersion: number;
  /** Null when the value is recomputed rather than recalled. */
  maxStaleMinutes: number | null;
  /** What the local resolver must be able to say about where its value came from. */
  requiresLocalProvenance: true;
};

/** Fetched from a protected procedure. */
export type ServerSource = {
  kind: "server";
  procedure: ProcedureName;
  /** Subjects the procedure needs. Empty means the acting identity suffices. */
  subjectRequirements: readonly ("operator" | "unit" | "trailer" | "job" | "trip" | "route")[];
  refreshSeconds: number;
  cacheable: boolean;
};

/** Assembled by a domain composer from several inputs. */
export type ComposedSource = {
  kind: "composed";
  composer: string;
  /** Input classes named by evidence. Not a claim of completeness. */
  inputs: readonly string[];
  dependencyGraphConfirmed: boolean;
};

export type DataSource = DeviceLocalSource | ServerSource | ComposedSource;

/* ------------------------------------------------------------------ */
/* Temporal                                                           */
/* ------------------------------------------------------------------ */

/**
 * Which shapes the source can answer in.
 *
 * `live_and_historical` must declare what history loses — `dispatch.readiness`
 * returns contributions live and persists none of them, and a single shape for
 * both is exactly how a historical view promises a field nobody stored.
 */
export type TemporalContract =
  | { capability: "live" }
  | { capability: "historical"; persistedFields: readonly string[] }
  | { capability: "live_and_historical"; persistedFields: readonly string[]; liveOnlyFields: readonly string[] };

/* ------------------------------------------------------------------ */
/* Authority                                                           */
/* ------------------------------------------------------------------ */

export type AuthorityLevel = "authoritative" | "display_only" | "none";

/**
 * Value authority depends on connectivity.
 *
 * A trip is server truth online and a stale picture offline; a device outbox is
 * the device's own truth in both. One boolean could not hold that, and B26
 * found the trip case the hard way.
 */
export type ValueAuthority = { online: AuthorityLevel; offline: AuthorityLevel };

/* ------------------------------------------------------------------ */
/* Semantic                                                           */
/* ------------------------------------------------------------------ */

export type SemanticContract =
  | { status: "CONFIRMED"; title: string }
  | { status: "PARTIAL"; title: string; unresolved: string }
  | { status: "UNSUPPORTED"; legacyTitle: string; truthfulTitle: string; reason: string }
  | { status: "UNRESOLVED"; reason: string };

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export type WidgetDescriptorV2 = {
  contractVersion: 2;
  key: string;
  /** The title shown today. For a legacy key with corrected semantics, truthful. */
  title: string;
  /** Kept only where the persisted key's original title is still recognizable. */
  legacyTitle?: string;
  category: WidgetCategory;
  authorization: AuthorizationContract;
  source: DataSource;
  engine: { engine: string; confidence: "CONFIRMED" | "PARTIAL" | "NO_EVIDENCE"; evidence?: string };
  semantic: SemanticContract;
  temporal: TemporalContract;
  valueAuthority: ValueAuthority;
  /** Fixed. No descriptor may raise it; a stale tile must never authorize. */
  readonly actionAuthority: "none";
  offline: OfflinePolicy;
  variants: readonly [WidgetVariant, ...WidgetVariant[]];
  defaultVariant: WidgetVariant;
  optionsSchema: OptionsSchema;
  suggestedFor: readonly string[];
  /** Why this widget is not production. Empty would mean it is. */
  promotionBlockers: readonly string[];
};

/* ------------------------------------------------------------------ */
/* The four native descriptors                                         */
/* ------------------------------------------------------------------ */

export const V2_DESCRIPTORS = {
  /**
   * The cleanest conversion: a device-local source that never needed a
   * procedure, and an authorization nobody can yet name.
   */
  syncStatus: {
    contractVersion: 2, key: "syncStatus", title: "Sync Status", category: "System",
    authorization: {
      kind: "unresolved",
      question: "what authorizes a driver to see their own device's sync state? No sync.* procedure and no own-scoped permission appear in the 0088 evidence.",
    },
    source: {
      kind: "device_local", resolver: "sync_queue", runtimeVersion: 1,
      maxStaleMinutes: null, requiresLocalProvenance: true,
    },
    engine: { engine: "device outbox / syncEngine", confidence: "PARTIAL", evidence: "0088 worktree diff" },
    semantic: { status: "CONFIRMED", title: "Sync Status" },
    temporal: { capability: "live" },
    // The device is the authority on its own queue whether or not it has signal.
    valueAuthority: { online: "authoritative", offline: "authoritative" },
    actionAuthority: "none",
    offline: { kind: "device_local" },
    variants: ["status", "kpi", "queue"], defaultVariant: "status",
    optionsSchema: {}, suggestedFor: ["DRIVER", "OPERATOR", "FIELD_SUPERVISOR"],
    promotionBlockers: ["authorization unresolved", "branch runtime not executed"],
  },

  /**
   * Legacy key, corrected meaning.
   *
   * `hosRemaining` is in saved layouts, offline envelopes and archived boards,
   * so the key stays. What changes is that the descriptor states plainly that
   * the name it was given is not what the source returns.
   */
  hosRemaining: {
    contractVersion: 2, key: "hosRemaining", title: "Hours Worked", legacyTitle: "Hours Remaining",
    category: "HOS",
    authorization: { kind: "procedure", procedure: "hos.status", confidence: "CONFIRMED" },
    source: {
      kind: "server", procedure: "hos.status",
      subjectRequirements: ["operator"], refreshSeconds: 60, cacheable: true,
    },
    engine: {
      engine: "HOS status (selectProfile + computeClocks + determine)",
      confidence: "CONFIRMED", evidence: "0088 worktree diff",
    },
    semantic: {
      status: "UNSUPPORTED",
      legacyTitle: "Hours Remaining", truthfulTitle: "Hours Worked",
      reason: "hos.status returns sixteen elapsed clocks and no remaining-hours field — the branch removed it deliberately, \"no single hours-remaining to be wrong with\". Remaining needs a verified rule limit; under P9 every determination reads UNKNOWN.",
    },
    temporal: { capability: "live" },
    // Elapsed clocks are arithmetic over duty records the device holds. The
    // compliance answer is not the device's to give, online or off.
    valueAuthority: { online: "authoritative", offline: "authoritative" },
    actionAuthority: "none",
    offline: { kind: "device_local" },
    variants: ["kpi", "gauge", "countdown", "detail"], defaultVariant: "kpi",
    optionsSchema: {}, suggestedFor: ["DRIVER", "OPERATOR"],
    promotionBlockers: [
      "semantic contract UNSUPPORTED — the tile's name is not what the source returns",
      "branch runtime not executed",
    ],
  },

  dispatchReadiness: {
    contractVersion: 2, key: "dispatchReadiness", title: "Dispatch Readiness", category: "Dispatch",
    authorization: {
      kind: "unresolved",
      question: "the dispatch permission map was not in the 0088 worktree; dispatch.read is a guess.",
    },
    source: {
      kind: "server", procedure: "dispatch.readiness",
      // Not one entity: the gate asks about a combination.
      subjectRequirements: ["operator", "unit", "trailer", "job", "route"],
      refreshSeconds: 30, cacheable: false,
    },
    engine: { engine: "composeReadiness (readinessComposer.ts)", confidence: "CONFIRMED", evidence: "0088 worktree diff" },
    semantic: { status: "CONFIRMED", title: "Dispatch Readiness" },
    temporal: {
      capability: "live_and_historical",
      persistedFields: ["verdict", "blockers", "fingerprint", "evaluatedAt"],
      // Returned live, persisted never.
      liveOnlyFields: ["explanation", "contributions"],
    },
    valueAuthority: { online: "authoritative", offline: "none" },
    actionAuthority: "none",
    offline: { kind: "none" },
    variants: ["status", "checklist", "detail"], defaultVariant: "status",
    optionsSchema: {}, suggestedFor: ["DISPATCHER", "FIELD_SUPERVISOR"],
    promotionBlockers: [
      "permission unresolved",
      "dependency on HOS unresolved — composeReadiness not in the 0088 worktree",
      "branch runtime not executed",
    ],
  },

  activeTrip: {
    contractVersion: 2, key: "activeTrip", title: "Active Trip", category: "Trips",
    authorization: { kind: "unresolved", question: "no trips.* procedure appears in the 0088 evidence." },
    source: {
      kind: "server", procedure: "trips.list",
      subjectRequirements: ["trip"], refreshSeconds: 30, cacheable: true,
    },
    engine: { engine: "trips (server record)", confidence: "NO_EVIDENCE" },
    semantic: { status: "PARTIAL", title: "Active Trip", unresolved: "no trips.* procedure evidenced; the shape of the answer is unknown" },
    temporal: { capability: "live" },
    // The case that forced the split: a dispatcher can reassign a trip, so the
    // device's copy is a picture of the past however recent it is.
    valueAuthority: { online: "authoritative", offline: "display_only" },
    actionAuthority: "none",
    offline: { kind: "pre_departure", maxStaleMinutes: 120 },
    variants: ["status", "timeline", "map", "detail"], defaultVariant: "timeline",
    optionsSchema: {}, suggestedFor: ["DRIVER", "DISPATCHER"],
    promotionBlockers: ["no procedure evidence", "authorization unresolved", "branch runtime not executed"],
  },
} as const satisfies Record<string, WidgetDescriptorV2>;

export type V2Key = keyof typeof V2_DESCRIPTORS;
export const V2_KEYS = Object.keys(V2_DESCRIPTORS) as readonly V2Key[];
export const isV2 = (key: string): key is V2Key => key in V2_DESCRIPTORS;

/* ------------------------------------------------------------------ */
/* Runtime rules                                                       */
/* ------------------------------------------------------------------ */

/**
 * May this widget be rendered in a historical board?
 *
 * A `live` widget refuses. Rendering yesterday's dispatch answer from a source
 * that only answers about now would put a timestamp on a value that never had
 * one.
 */
export const canRenderHistorically = (d: WidgetDescriptorV2): boolean =>
  d.temporal.capability !== "live";

/** Fields a historical render must not promise. */
export const liveOnlyFields = (d: WidgetDescriptorV2): readonly string[] =>
  d.temporal.capability === "live_and_historical" ? d.temporal.liveOnlyFields : [];

/**
 * Authority for the current connectivity.
 *
 * Read at render time rather than baked into the descriptor, because the same
 * tile is authoritative online and a stale picture offline.
 */
export const authorityFor = (d: WidgetDescriptorV2, connected: boolean): AuthorityLevel =>
  connected ? d.valueAuthority.online : d.valueAuthority.offline;

/* ------------------------------------------------------------------ */
/* Migration report                                                    */
/* ------------------------------------------------------------------ */

export type MigrationReport = {
  v2Native: readonly string[];
  legacyAdapter: readonly string[];
  production: number;
  /** Per widget, why it is still legacy. Half-migrated forever is the risk. */
  legacyReasons: Readonly<Record<string, string>>;
};

const LEGACY_REASONS: Readonly<Record<string, string>> = {
  myDay: "no surfaces.* procedure in the 0088 evidence",
  inbox: "loadInbox is confirmed but no surfaces.* procedure is",
  exceptions: "no surfaces.* procedure in the 0088 evidence",
  search: "no surfaces.* procedure in the 0088 evidence",
  trackingLookup: "no surfaces.* procedure in the 0088 evidence",
  documentExpiry: "no records.* procedure in the 0088 evidence",
  activeJob: "no jobs.* procedure in the 0088 evidence",
  unitReadiness: "composed; whether contributions carry a renderable unit axis is unresolved",
};

export function migrationReport(allKeys: readonly string[]): MigrationReport {
  const v2Native = allKeys.filter(isV2);
  const legacyAdapter = allKeys.filter((k) => !isV2(k));
  return {
    v2Native, legacyAdapter, production: 0,
    legacyReasons: Object.fromEntries(legacyAdapter.map((k) => [k, LEGACY_REASONS[k] ?? "unclassified"])),
  };
}

/**
 * When the adapter may be deleted. Evidence criteria, not a date.
 */
export const ADAPTER_REMOVAL_CRITERIA: readonly string[] = [
  "every registry entry has contractVersion 2",
  "no authorization contract is unresolved",
  "every persisted key opens a pre-migration cached board in a test",
  "no runtime path reads the legacy `procedure` field",
  "the registry integrity test asserts `procedure` is absent",
];
