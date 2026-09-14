/**
 * v22.20 — a dashboard tile that cannot lie by omission.
 *
 * Pure. No network, no database.
 *
 * A number on a screen carries an implied claim: *this is true now*. Most
 * dashboards never check that claim, and the failure is quiet — a fuel level
 * from a truck that lost signal at 06:00 looks exactly like one from thirty
 * seconds ago. Somebody plans a route on it.
 *
 * So the contract is: **a widget that cannot say where a value came from and
 * how old it is does not render the value.** Not a warning badge, not a
 * subdued colour — it renders its unavailable state instead. That is
 * deliberately harsh, because a stale number with a small grey timestamp is
 * still read as a number.
 *
 * And one rule personalization does not get to override: a person may arrange
 * their dashboard and may not remove the tile that would have told them
 * something is wrong. A driver who hides the defect alert because it is
 * annoying has not made the defect go away.
 */

export type Freshness = "live" | "recent" | "aging" | "stale" | "unknown";

export type Provenance = {
  /** The record or feed this came from. */
  sourceType: string;
  sourceRef: string;
  /** When the underlying fact was true, not when the tile rendered. */
  observedAt: Date | null;
  /** How the value was obtained, so a reader can weigh it. */
  method: "recorded" | "derived" | "telemetry" | "imported" | "proposed";
};

/** How old a source may be before it stops being current, per widget. */
export type FreshnessPolicy = { liveSeconds: number; recentSeconds: number; agingSeconds: number };

export function freshnessOf(provenance: Provenance, now: Date, policy: FreshnessPolicy): { freshness: Freshness; ageSeconds: number | null } {
  if (!provenance.observedAt) return { freshness: "unknown", ageSeconds: null };
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - provenance.observedAt.getTime()) / 1000));
  if (ageSeconds <= policy.liveSeconds) return { freshness: "live", ageSeconds };
  if (ageSeconds <= policy.recentSeconds) return { freshness: "recent", ageSeconds };
  if (ageSeconds <= policy.agingSeconds) return { freshness: "aging", ageSeconds };
  return { freshness: "stale", ageSeconds };
}

export type WidgetCategory = "safety" | "compliance" | "operations" | "financial" | "personal";

export type WidgetContract = {
  widgetKey: string;
  title: string;
  category: WidgetCategory;
  /** Which permission a viewer must hold. Absent means everyone. */
  requiresPermission: string | null;
  policy: FreshnessPolicy;
  /** What to show when there is genuinely nothing, as distinct from an error. */
  emptyState: string;
  /** Safety and compliance tiles cannot be removed by personalization. */
  pinned: boolean;
};

export type WidgetValue = { display: string; provenance: Provenance };

export type Rendered =
  | { state: "value"; display: string; freshness: Freshness; ageSeconds: number | null; source: string; footnote: string }
  | { state: "empty"; message: string }
  | { state: "unavailable"; reason: string; message: string }
  | { state: "forbidden" };

export class ContractViolation extends Error {}

/**
 * Render one widget for one viewer.
 *
 * Refuses a value with no provenance outright rather than showing it bare: a
 * widget that cannot explain itself has failed its contract, and the failure
 * belongs on the screen rather than hidden behind a plausible number.
 *
 * A stale value renders as unavailable, not as a value with a warning. The
 * difference matters at 3am on a phone.
 */
export function render(args: {
  contract: WidgetContract;
  value: WidgetValue | null;
  heldPermissions: readonly string[];
  now: Date;
}): Rendered {
  const { contract } = args;
  if (contract.requiresPermission && !args.heldPermissions.includes(contract.requiresPermission)) {
    return { state: "forbidden" };
  }
  if (!args.value) return { state: "empty", message: contract.emptyState };

  const p = args.value.provenance;
  if (!p || !p.sourceType || !p.sourceRef) {
    throw new ContractViolation(
      `${contract.widgetKey} tried to render "${args.value.display}" with no source. A widget that cannot say where a value came from does not render it.`,
    );
  }

  const { freshness, ageSeconds } = freshnessOf(p, args.now, contract.policy);
  if (freshness === "stale" || freshness === "unknown") {
    return {
      state: "unavailable",
      reason: freshness,
      message: freshness === "unknown"
        ? `No observation time recorded for this ${p.sourceType}. The value is not shown because its age cannot be established.`
        : `Last observed ${describeAge(ageSeconds)} ago — too old to show as current.`,
    };
  }
  return {
    state: "value",
    display: args.value.display,
    freshness, ageSeconds,
    source: `${p.sourceType}:${p.sourceRef}`,
    footnote: `${p.method}, ${ageSeconds != null ? `${describeAge(ageSeconds)} ago` : "age unknown"}`,
  };
}

function describeAge(seconds: number | null): string {
  if (seconds == null) return "an unknown time";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/* ------------------------------------------------------------------ */
/* Compliance tiles do not round up                                     */
/* ------------------------------------------------------------------ */

export type ComplianceTileState = "clear" | "attention" | "blocked" | "unknown";

/**
 * Roll several compliance answers into one tile.
 *
 * Unknown never becomes clear. A tile that shows green because three of four
 * checks passed and the fourth could not be evaluated is the exact failure this
 * whole system is built to avoid, rendered at 200 pixels wide.
 */
export function complianceTile(items: readonly { label: string; state: ComplianceTileState }[]): { state: ComplianceTileState; summary: string } {
  if (!items.length) return { state: "unknown", summary: "Nothing evaluated" };
  const blocked = items.filter(i => i.state === "blocked");
  const unknown = items.filter(i => i.state === "unknown");
  const attention = items.filter(i => i.state === "attention");
  if (blocked.length) return { state: "blocked", summary: `${blocked.length} blocking: ${blocked.map(i => i.label).join(", ")}` };
  if (unknown.length) return { state: "unknown", summary: `${unknown.length} could not be checked: ${unknown.map(i => i.label).join(", ")}` };
  if (attention.length) return { state: "attention", summary: `${attention.length} need attention: ${attention.map(i => i.label).join(", ")}` };
  return { state: "clear", summary: `All ${items.length} checks current` };
}

/* ------------------------------------------------------------------ */
/* Personalization has a floor                                          */
/* ------------------------------------------------------------------ */

export type Layout = { widgetKey: string; position: number; hidden: boolean }[];

export class PinnedWidget extends Error {}

/**
 * Apply a person's layout to the widgets they are entitled to see.
 *
 * Reordering is theirs. Hiding a pinned safety or compliance tile is refused —
 * a driver who hides the defect alert because it is annoying has not made the
 * defect go away, and the next person to look at that screen will believe
 * nothing was wrong.
 */
export function applyLayout(contracts: readonly WidgetContract[], layout: Layout, heldPermissions: readonly string[]): WidgetContract[] {
  const permitted = contracts.filter(c => !c.requiresPermission || heldPermissions.includes(c.requiresPermission));
  const hiddenPinned = layout.filter(l => l.hidden).map(l => permitted.find(c => c.widgetKey === l.widgetKey)).filter((c): c is WidgetContract => !!c && c.pinned);
  if (hiddenPinned.length) {
    throw new PinnedWidget(`${hiddenPinned.map(c => c.title).join(", ")} cannot be hidden — hiding an alert does not resolve what it is alerting about`);
  }
  const order = new Map(layout.map(l => [l.widgetKey, l]));
  return permitted
    .filter(c => !order.get(c.widgetKey)?.hidden)
    .sort((a, b) => (order.get(a.widgetKey)?.position ?? 999) - (order.get(b.widgetKey)?.position ?? 999));
}

/** Whether a widget is pinned by its category, so the rule is not set per tile. */
export const isPinnedCategory = (category: WidgetCategory): boolean => category === "safety" || category === "compliance";
