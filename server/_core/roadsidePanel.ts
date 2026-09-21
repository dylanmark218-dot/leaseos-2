/**
 * v22.20 — what an inspector at the scale sees.
 *
 * Pure. No network, no database.
 *
 * This builds on the passport and requirement engine that already exist rather
 * than beside them: the axes below are composed from evaluations those produce,
 * and nothing here re-decides whether a requirement is met.
 *
 * Four rules, and the first two are the ones that make this safe to hand to a
 * stranger.
 *
 * **Possession of the QR code is not access.** This module produces the
 * projection; a caller still has to hold a scoped, expiring grant, and the scan
 * is logged. A panel is a view, not a key.
 *
 * **What is withheld is listed.** The same rule the audit packages follow. An
 * inspector who is shown eight of eleven items and told nothing about the other
 * three has been misled; one who is told "three items withheld: driver medical,
 * insurance premium, purchase cost" has been given an honest document. Nothing
 * personal, medical, or financial crosses this boundary, and the panel says so
 * on its face.
 *
 * **One status per unit is a lie.** A truck's chassis can be roadworthy while
 * its crane certification is expired. So the panel is per axis, and the overall
 * verdict is derived from the axes rather than stored anywhere.
 *
 * **Unknown is not compliant.** A missing CVIP document is not a current CVIP.
 * It reads UNKNOWN, it is never NOT APPLICABLE, and it does not read ready.
 */

export type AxisKey =
  | "roadworthiness"
  | "periodic_inspection"
  | "daily_inspection"
  | "maintenance"
  | "tank_containment"
  | "pressure_equipment"
  | "lifting_equipment"
  | "well_servicing"
  | "dangerous_goods"
  | "documentation";

export const AXIS_LABELS: Record<AxisKey, string> = {
  roadworthiness: "Roadworthiness",
  periodic_inspection: "Periodic inspection (CVIP)",
  daily_inspection: "Daily inspection",
  maintenance: "Maintenance",
  tank_containment: "Tank / means of containment",
  pressure_equipment: "Pressure equipment",
  lifting_equipment: "Lifting equipment",
  well_servicing: "Well servicing",
  dangerous_goods: "Dangerous goods",
  documentation: "Documentation",
};

/** Deliberately the same vocabulary the passport already uses, plus one. */
export type AxisState = "ready" | "review" | "blocked" | "unknown" | "not_applicable";

/**
 * One evaluated requirement, as the requirement engine produced it. `ruleCode`
 * is what turns a red icon into an answer an inspector can act on.
 */
export type PanelItem = {
  ruleCode: string;
  label: string;
  axis: AxisKey;
  state: Exclude<AxisState, "not_applicable">;
  /** Why, in the words a person would use. Never a code alone. */
  reason: string;
  /** When it expires, where the publisher's authority says so. */
  expiresAt: Date | null;
  /** The document backing it, if one is releasable to an inspector. */
  documentRef: string | null;
  authority: string | null;
};

export type WithheldItem = { label: string; because: "personal" | "medical" | "financial" | "commercial" | "not_releasable" };

/**
 * Categories that never cross this boundary, whatever a caller asks for.
 * Listed rather than silently filtered, and the list is the contract.
 */
export const NEVER_RELEASED: readonly WithheldItem["because"][] = ["personal", "medical", "financial", "commercial"];

export type RoadsidePanel = {
  unitRef: string;
  plate: string | null;
  vin: string | null;
  generatedAt: Date;
  /** Derived from the axes. Never read from a stored column. */
  verdict: AxisState;
  axes: { axis: AxisKey; label: string; state: AxisState; items: PanelItem[] }[];
  /** Every reason the unit is not simply ready, each naming its rule. */
  blockingReasons: string[];
  unknownReasons: string[];
  /** What this panel does not contain, and why. Always present, even when empty. */
  withheld: WithheldItem[];
  /** The sentence at the top of the printed page. */
  headline: string;
  /** The standing statement, carried so it cannot be lost between here and the roadside. */
  notice: string;
};

export const PANEL_NOTICE =
  "This panel is generated from records LeaseOS holds. An item shown UNKNOWN means no verified record was found — it is not a statement that the requirement does not apply, and it is not a statement of compliance. Personal, medical, financial and commercial information is withheld by policy and listed below.";

const WORST: AxisState[] = ["blocked", "unknown", "review", "ready", "not_applicable"];
const worse = (a: AxisState, b: AxisState): AxisState => (WORST.indexOf(a) <= WORST.indexOf(b) ? a : b);

/**
 * Roll a set of items up to an axis state.
 *
 * `blocked` beats `unknown` beats `review` beats `ready`, and an axis with no
 * items at all is `not_applicable` — which is a real answer for a truck with no
 * crane, and is the only place `not_applicable` may come from. An axis that has
 * items but cannot evaluate them is `unknown`, never `not_applicable`.
 */
export function axisState(items: readonly PanelItem[]): AxisState {
  if (!items.length) return "not_applicable";
  return items.map(i => i.state as AxisState).reduce(worse, "ready");
}

export type PanelInput = {
  unitRef: string;
  plate?: string | null;
  vin?: string | null;
  items: readonly PanelItem[];
  /** Axes the caller knows apply to this unit but could not evaluate. */
  unevaluatedAxes?: readonly AxisKey[];
  withheld?: readonly WithheldItem[];
  generatedAt: Date;
};

/**
 * Build the panel. Everything an inspector reads is derived here, in one place,
 * from evaluations somebody else made.
 */
export function buildRoadsidePanel(input: PanelInput): RoadsidePanel {
  const byAxis = new Map<AxisKey, PanelItem[]>();
  for (const item of input.items) {
    const list = byAxis.get(item.axis);
    if (list) list.push(item); else byAxis.set(item.axis, [item]);
  }

  const axes = (Object.keys(AXIS_LABELS) as AxisKey[])
    .map(axis => {
      const items = byAxis.get(axis) ?? [];
      // An axis the caller says applies but could not evaluate is UNKNOWN.
      // Silence about a crane a truck has is not the same as having no crane.
      const state = items.length ? axisState(items) : input.unevaluatedAxes?.includes(axis) ? "unknown" : "not_applicable";
      return { axis, label: AXIS_LABELS[axis], state: state as AxisState, items };
    })
    .filter(a => a.state !== "not_applicable" || a.items.length > 0);

  const verdict = axes.length ? axes.map(a => a.state).reduce(worse, "ready") : "unknown";

  const blockingReasons = input.items.filter(i => i.state === "blocked").map(i => `${i.ruleCode} — ${i.reason}`);
  const unknownReasons = [
    ...input.items.filter(i => i.state === "unknown").map(i => `${i.ruleCode} — ${i.reason}`),
    ...(input.unevaluatedAxes ?? []).filter(a => !byAxis.has(a)).map(a => `${AXIS_LABELS[a]} — applies to this unit and no verified record was found`),
  ];

  const headline =
    verdict === "blocked" ? `NOT AUTHORIZED TO OPERATE — ${blockingReasons.length} blocking item(s)`
    : verdict === "unknown" ? `INCOMPLETE — ${unknownReasons.length} item(s) have no verified record. Unknown is not compliance.`
    : verdict === "review" ? `REVIEW — every requirement has a record, and at least one needs attention`
    : `IN ORDER — every evaluated requirement is current as of this panel's generation time`;

  return {
    unitRef: input.unitRef, plate: input.plate ?? null, vin: input.vin ?? null,
    generatedAt: input.generatedAt, verdict, axes,
    blockingReasons, unknownReasons,
    withheld: [...(input.withheld ?? [])],
    headline, notice: PANEL_NOTICE,
  };
}

/* ------------------------------------------------------------------ */
/* Access is a grant, not a scan                                        */
/* ------------------------------------------------------------------ */

export type PanelGrant = {
  grantRef: string;
  unitRef: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Who it was issued to, in the issuer's words. Recorded, never verified by us. */
  issuedFor: string;
  revokedAt: Date | null;
};

export type AccessOutcome =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string; because: "no_grant" | "expired" | "revoked" | "wrong_unit" };

/**
 * A QR code carries a grant reference. It does not carry authority: the grant is
 * resolved server-side, has to be live, and has to be for the unit being
 * presented. Somebody photographing a sticker on a parked truck gets nothing.
 */
export function checkPanelAccess(grant: PanelGrant | null, unitRef: string, now: Date): AccessOutcome {
  if (!grant) return { allowed: false, reason: "That code does not resolve to an issued panel grant", because: "no_grant" };
  if (grant.revokedAt) return { allowed: false, reason: `This panel grant was revoked ${grant.revokedAt.toISOString().slice(0, 16).replace("T", " ")}`, because: "revoked" };
  if (now.getTime() >= grant.expiresAt.getTime()) return { allowed: false, reason: `This panel grant expired ${grant.expiresAt.toISOString().slice(0, 16).replace("T", " ")}`, because: "expired" };
  if (grant.unitRef !== unitRef) return { allowed: false, reason: "This panel grant is for a different unit", because: "wrong_unit" };
  return { allowed: true, reason: `Grant ${grant.grantRef}, issued for ${grant.issuedFor}, valid until ${grant.expiresAt.toISOString().slice(0, 16).replace("T", " ")}` };
}

/* ------------------------------------------------------------------ */
/* The printed page                                                     */
/* ------------------------------------------------------------------ */

/**
 * The panel as ordered lines, for a PDF or a screen. Blocking items first,
 * then unknowns, then everything else — because the reason a truck is stopped
 * should not be on page two.
 */
export function panelLines(panel: RoadsidePanel): string[] {
  const lines: string[] = [
    `UNIT ${panel.unitRef}${panel.plate ? ` · plate ${panel.plate}` : ""}${panel.vin ? ` · VIN ${panel.vin}` : ""}`,
    `Generated ${panel.generatedAt.toISOString().slice(0, 16).replace("T", " ")}`,
    panel.headline,
    "",
  ];
  if (panel.blockingReasons.length) lines.push("BLOCKING", ...panel.blockingReasons.map(r => `  ${r}`), "");
  if (panel.unknownReasons.length) lines.push("NO VERIFIED RECORD", ...panel.unknownReasons.map(r => `  ${r}`), "");
  for (const axis of panel.axes) {
    lines.push(`${axis.label}: ${axis.state.toUpperCase().replace("_", " ")}`);
    for (const i of axis.items) {
      const exp = i.expiresAt ? ` · expires ${i.expiresAt.toISOString().slice(0, 10)}` : "";
      lines.push(`  ${i.state.toUpperCase()} · ${i.ruleCode} · ${i.label}${exp}${i.authority ? ` · ${i.authority}` : ""}`);
    }
  }
  lines.push("", `WITHHELD (${panel.withheld.length})`);
  for (const w of panel.withheld) lines.push(`  ${w.label} — ${w.because}`);
  lines.push("", panel.notice);
  return lines;
}
