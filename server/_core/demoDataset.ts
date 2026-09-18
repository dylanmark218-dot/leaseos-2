/**
 * P5.4 — the demonstration dataset.
 *
 * One labelled organization that walks the operational chain, built through the real procedures as
 * a real caller, so it cannot produce a state the API would refuse. Three rules it keeps:
 *
 *   1. Everything it creates says it is a demonstration, in the row, not only in a comment. A
 *      reader who finds one of these rows in a database months from now can tell what it is.
 *   2. It invents no regulatory figure and no verified value. Where a regulatory answer would be
 *      needed it leaves the record UNKNOWN or in review, which is what an unverified system owes.
 *   3. It reports what it could not do rather than forcing it. A unit with no inspection on file
 *      is not dispatchable; the walk records that refusal as a result, because that refusal is the
 *      product working.
 *
 * This exists partly because a gate database that had been reused across runs was carrying rows
 * nobody chose. A labelled, deliberate dataset is the honest version of that.
 */
export const DEMO_MARK = "DEMO";
/** Every name this dataset writes carries the mark, so a row is self-describing. */
export const demoName = (what: string, suffix: string): string => `${DEMO_MARK} ${what} ${suffix}`.slice(0, 160);

/** A step in the walk: what it tried, what came back, and whether the API refused it. */
export type DemoStep = {
  step: string;
  outcome: "created" | "refused" | "left_unknown";
  ref?: string | number | null;
  /** The refusal, verbatim, when the API refused. Never smoothed over. */
  detail?: string;
};

export type DemoResult = { orgRef: string | null; steps: DemoStep[] };

/** A regulatory value this dataset must never invent; asserted by the test. */
export const NEVER_SEEDED = [
  "hos daily drive minutes", "hos daily on-duty minutes", "axle weight limit", "bridge limit",
  "UN number", "packing group", "placard requirement", "permit validity",
] as const;

export const created = (steps: readonly DemoStep[]): DemoStep[] => steps.filter(s => s.outcome === "created");
export const refusals = (steps: readonly DemoStep[]): DemoStep[] => steps.filter(s => s.outcome === "refused");
/** A walk that created nothing is not a dataset; a walk that refused nothing never met the engine. */
export const describeWalk = (r: DemoResult): string =>
  `${r.orgRef ?? "no organization"}: ${created(r.steps).length} created, ${refusals(r.steps).length} refused, ` +
  `${r.steps.filter(s => s.outcome === "left_unknown").length} left unknown`;
