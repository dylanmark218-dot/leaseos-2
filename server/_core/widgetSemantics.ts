/**
 * B28D — what a widget is allowed to mean.
 *
 * Pure. DESIGN + ADAPTER. The registry is unchanged; this normalizes it.
 *
 * B23 collapsed four questions into one field. `procedure` answered all of:
 * may this role see it, where does the data come from, which domain owns the
 * meaning, and — implicitly — is the widget's own name true. For server widgets
 * the first three happened to share an answer, so nothing looked wrong.
 *
 * The fourth was never asked at all, and it is the one that bites. `hos.status`
 * is a real procedure with a real permission and a real engine. Wiring it to a
 * widget called **Hours Remaining** produces a tile that passes TypeScript,
 * tests, SQL and a browser, and tells a driver something the branch has
 * explicitly declined to compute — *"separate clocks … with no single
 * hours-remaining to be wrong with"*. A correct procedure does not make a
 * truthful widget.
 *
 * So the normalized form carries five contracts, and a widget can fail on the
 * semantic one while passing every mechanical one.
 */

import type { ProcedureName } from "./recordsAuthorization";
import type { DeviceSourceType } from "./deviceManifest";
import { definitionFor, type WidgetDefinition, type WidgetKey } from "./widgetRegistry";

/* ------------------------------------------------------------------ */
/* The contracts                                                       */
/* ------------------------------------------------------------------ */

/** May this acting role use this widget? */
export type AuthorizationContract =
  | { kind: "procedure"; procedure: ProcedureName }
  | { kind: "unresolved"; question: string };

/** Where does the tile get its current data? */
export type SourceContract =
  | { kind: "server"; procedure: ProcedureName }
  | { kind: "device_local"; resolver: DeviceSourceType }
  | { kind: "composed"; engine: string };

/** Which domain owns the meaning of the answer? */
export type EngineContract = {
  engine: string;
  confidence: "CONFIRMED" | "PARTIAL" | "NO_EVIDENCE";
  evidence?: string;
};

/**
 * Is the widget's own name true of what its source returns?
 *
 * The contract B23 never had. `hos.status` is confirmed on every other axis and
 * fails here.
 */
export type SemanticContract =
  | { status: "CONFIRMED"; title: string }
  | {
      status: "UNSUPPORTED_NAME_OR_MEANING";
      /** What the tile is called today, kept because layouts persist it. */
      legacyTitle: string;
      /** What the evidence actually supports calling it. */
      truthfulTitle: string;
      reason: string;
    }
  | { status: "UNCONFIRMED"; reason: string };

/**
 * What the source can answer about, in time.
 *
 * `dispatch.readiness` returns `contributions` live and persists none of them,
 * so a historical view of the same widget is a different capability with a
 * different field set — not the same widget with older numbers.
 */
export type TemporalCapability = "live" | "historical" | "live_and_historical";

/**
 * Can this source truthfully report this value?
 *
 * Separate from action authority on purpose. The device is authoritative about
 * its own outbox and reports it truthfully; that says nothing about whether the
 * outbox may authorize anything.
 */
export type ValueAuthority = "authoritative" | "display_only" | "none";

export type NormalizedWidget = {
  key: WidgetKey;
  /** True while the definition still uses the single-`procedure` shape. */
  legacyContract: boolean;
  authorization: AuthorizationContract;
  source: SourceContract;
  engine: EngineContract;
  semantic: SemanticContract;
  temporal: TemporalCapability;
  valueAuthority: ValueAuthority;
  /**
   * Always `"none"`. A widget is a view.
   *
   * Not configurable, not a field a future definition can raise: every
   * protected operation reruns its own gate, and a tile that could carry
   * action authority would be a tile that could be stale and still authorize.
   */
  readonly actionAuthority: "none";
  offline: WidgetDefinition["offline"];
  refreshSeconds: number;
};

/* ------------------------------------------------------------------ */
/* Evidence overlays                                                   */
/* ------------------------------------------------------------------ */

type Overlay = Partial<Pick<NormalizedWidget,
  "authorization" | "source" | "engine" | "semantic" | "temporal" | "valueAuthority">>;

/**
 * Where evidence says the legacy shape is wrong.
 *
 * Only widgets the 0088 diff has something to say about appear here. Everything
 * else normalizes from the legacy field and keeps `legacyContract: true`.
 */
const OVERLAYS: Readonly<Partial<Record<WidgetKey, Overlay>>> = {
  hosRemaining: {
    authorization: { kind: "procedure", procedure: "hos.status" },
    source: { kind: "server", procedure: "hos.status" },
    engine: { engine: "HOS status (selectProfile + computeClocks + determine)", confidence: "CONFIRMED", evidence: "0088 worktree diff" },
    semantic: {
      status: "UNSUPPORTED_NAME_OR_MEANING",
      legacyTitle: "Hours Remaining",
      truthfulTitle: "Hours Worked",
      reason: "hos.status returns sixteen elapsed clocks and no remaining-hours field; the branch removed it deliberately — \"no single hours-remaining to be wrong with\". Remaining needs a verified rule limit, and under P9 every determination reads UNKNOWN.",
    },
    temporal: "live",
    // Clocks are arithmetic over duty records the device holds; the compliance
    // answer is not the device's to give.
    valueAuthority: "authoritative",
  },

  syncStatus: {
    // The clearest case for the split: no sync.* procedure exists in 62, and no
    // own-scoped permission exists anywhere. `sync.status` was invented to
    // satisfy the registry type.
    authorization: {
      kind: "unresolved",
      question: "what authorizes a driver to see their own device's sync state? No sync.* procedure and no own-scoped permission appear in the 0088 evidence.",
    },
    source: { kind: "device_local", resolver: "sync_queue" },
    engine: { engine: "device outbox / syncEngine", confidence: "PARTIAL", evidence: "outbox and syncEngine appear client-side in the 0088 diff" },
    semantic: { status: "CONFIRMED", title: "Sync Status" },
    temporal: "live",
    valueAuthority: "authoritative",
  },

  dispatchReadiness: {
    authorization: {
      kind: "unresolved",
      question: "the dispatch permission map was not in the 0088 worktree; dispatch.read is a guess.",
    },
    source: { kind: "server", procedure: "dispatch.readiness" },
    engine: { engine: "composeReadiness (readinessComposer.ts)", confidence: "CONFIRMED", evidence: "0088 worktree diff" },
    semantic: { status: "CONFIRMED", title: "Dispatch Readiness" },
    // contributions are returned live and never persisted.
    temporal: "live",
    valueAuthority: "none",
  },

  unitReadiness: {
    authorization: { kind: "unresolved", question: "shop.unitReadiness does not exist; readiness is composed and its permission is unevidenced." },
    source: { kind: "composed", engine: "readinessComposer.ts" },
    engine: { engine: "composeReadiness contributions (unit axis)", confidence: "PARTIAL", evidence: "0088 worktree diff names readinessComposer.ts" },
    semantic: { status: "UNCONFIRMED", reason: "whether contributions carry a unit axis detailed enough to render a tile is unresolved" },
    temporal: "live",
    valueAuthority: "none",
  },

  activeTrip: {
    engine: { engine: "trips (server record)", confidence: "NO_EVIDENCE" },
    semantic: { status: "UNCONFIRMED", reason: "no trips.* procedure in the 0088 evidence" },
    temporal: "live_and_historical",
    // B26 established this: a trip is a server record a dispatcher can
    // reassign; the device holds only what it last saw.
    valueAuthority: "display_only",
  },
};

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Read a legacy definition into the five-contract form.
 *
 * Compatibility, not migration: the registry keeps its shape and every existing
 * caller keeps working. What changes is that nothing downstream has to guess
 * which question `procedure` was answering.
 *
 * A legacy definition never yields a CONFIRMED semantic contract. Its title was
 * chosen before anyone had read the source, and inheriting confidence from a
 * field that never encoded it is how `hosRemaining` got here.
 */
export function normalizeWidgetDefinition(key: WidgetKey): NormalizedWidget {
  const def = definitionFor(key);
  const overlay = OVERLAYS[key] ?? {};

  const base: NormalizedWidget = {
    key,
    legacyContract: !("source" in overlay),
    authorization: { kind: "procedure", procedure: def.procedure },
    source: def.offline.kind === "device_local"
      // A device-local widget carrying a server procedure is the fabrication
      // this adapter exists to stop propagating, so the legacy path refuses to
      // copy the procedure across for one.
      ? { kind: "composed", engine: `unresolved device resolver for ${key}` }
      : { kind: "server", procedure: def.procedure },
    engine: { engine: def.procedure, confidence: "NO_EVIDENCE" },
    semantic: { status: "UNCONFIRMED", reason: "legacy definition; the title predates any reading of the source" },
    temporal: "live",
    valueAuthority: "none",
    actionAuthority: "none",
    offline: def.offline,
    refreshSeconds: def.refreshSeconds,
  };

  return { ...base, ...overlay, actionAuthority: "none" };
}

export const normalizeAll = (keys: readonly WidgetKey[]): readonly NormalizedWidget[] =>
  keys.map(normalizeWidgetDefinition);

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/** A device-local source carrying a server procedure. */
export const hasFabricatedProcedure = (w: NormalizedWidget): boolean =>
  w.source.kind === "device_local" && w.authorization.kind === "procedure" &&
  w.authorization.procedure === (definitionFor(w.key).procedure);

/** The title a tile should actually show. */
export const truthfulTitle = (w: NormalizedWidget): string =>
  w.semantic.status === "CONFIRMED" ? w.semantic.title
    : w.semantic.status === "UNSUPPORTED_NAME_OR_MEANING" ? w.semantic.truthfulTitle
    : definitionFor(w.key).title;

/* ------------------------------------------------------------------ */
/* Unknown is not empty                                                */
/* ------------------------------------------------------------------ */

/**
 * A field that was never stored, distinguished from one that was stored empty.
 *
 * `contributions: []` on a historical dispatch check would say "there were no
 * contributors", which is false — there were four and nobody kept them.
 */
export type Recorded<T> =
  | { state: "recorded"; value: T }
  | { state: "none"; reason: string }
  | { state: "unavailable_historically"; reason: string };

export const recorded = <T>(value: T): Recorded<T> => ({ state: "recorded", value });
export const none = <T>(reason: string): Recorded<T> => ({ state: "none", reason });
export const notStored = <T>(reason: string): Recorded<T> =>
  ({ state: "unavailable_historically", reason });

/** Live readiness: contributions are returned. */
export type LiveReadiness = {
  mode: "live";
  verdict: string;
  explanation: string;
  blockers: readonly { code: string; detail: string }[];
  contributions: Recorded<readonly { engine: string; finding: string }[]>;
};

/**
 * Historical readiness, from `dispatchEligibilityChecks`.
 *
 * A separate type rather than the live one with holes, because sharing one type
 * is what lets a historical view promise a field the persistence layer never
 * stored.
 */
export type HistoricalReadiness = {
  mode: "historical";
  verdict: string;
  blockers: readonly { code: string; detail: string }[];
  /** Opaque. Equality and change detection only. */
  fingerprint: string;
  evaluatedAt: Date;
  contributions: Recorded<never>;
};

export const historicalReadiness = (
  row: { verdict: string; blockers: readonly { code: string; detail: string }[]; fingerprint: string; evaluatedAt: Date },
): HistoricalReadiness => ({
  ...row,
  mode: "historical",
  contributions: notStored(
    "dispatchEligibilityChecks stores verdict, blockersJson and fingerprint; the contribution breakdown was never persisted",
  ),
});

/**
 * The fingerprint is opaque.
 *
 * Equality and change detection are all the evidence supports. It is computed
 * over `EligibilityFacts`, which is a snapshot identity — it answers "were
 * these the same facts?", never "is this the same problem?".
 */
export const fingerprintChanged = (a: string, b: string): boolean => a !== b;
