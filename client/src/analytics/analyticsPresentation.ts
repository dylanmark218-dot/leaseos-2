/**
 * Analytics Checkpoint C — how an analytics answer is said on a screen.
 *
 * Pure. No tRPC, no React. Every word the dashboard shows about a metric's completeness, its age
 * or its range comes from here, so the rules live in one place and are tested once.
 *
 * Three rules the server already keeps, kept again at the last place they could be lost:
 *
 *   - **No value is not zero.** A metric with no value says so in words; it never renders "0" or a
 *     blank that a reader fills in as zero.
 *   - **Incomplete says what is missing.** A partial answer is shown with the records it could not
 *     place, not as a number with a footnote nobody opens.
 *   - **Old is not live.** Every answer carries when it was computed. Past its freshness budget it is
 *     marked stale, and a failed refresh keeps the old answer only with that said beside it.
 *
 * There is no red/amber/green here. These are counts and durations, not verdicts; colouring a count
 * of open defects red would be a judgement the server never made.
 */

export type Determination = "computed" | "partial" | "unknown" | "not_applicable" | "not_derivable" | "not_evaluated";

export type Tone = "complete" | "incomplete" | "absent";

export type PresentedDetermination = { label: string; meaning: string; tone: Tone };

const DETERMINATIONS: Record<Determination, PresentedDetermination> = {
  computed: { label: "Complete", meaning: "Every qualifying record was counted.", tone: "complete" },
  partial: { label: "Incomplete", meaning: "Some records could not be placed. They are listed with the value.", tone: "incomplete" },
  unknown: { label: "Unknown", meaning: "No value can be stated. The reason is shown.", tone: "absent" },
  not_applicable: { label: "Nothing to measure", meaning: "There were no records to average. This is not zero.", tone: "absent" },
  not_derivable: { label: "Not available", meaning: "LeaseOS does not keep the records this would need.", tone: "absent" },
  not_evaluated: { label: "Not evaluated yet", meaning: "This waits on a decision. The reason is shown.", tone: "absent" },
};

/** The server's determination in words. A state this screen does not know is shown as unknown to it, never as complete. */
export function presentDetermination(d: string): PresentedDetermination {
  return (DETERMINATIONS as Record<string, PresentedDetermination>)[d]
    ?? { label: "Unrecognized answer", meaning: `The server sent "${d}", which this screen does not know. Nothing is assumed from it.`, tone: "absent" };
}

/** A value with its unit, or a sentence saying there is none. Never "0" for a missing value. */
export function formatValue(value: number | null, unit: string): string {
  if (value === null) return "No value";
  if (unit === "minutes") {
    const total = Math.round(value);
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  }
  if (unit === "hours") return `${value.toLocaleString("en-CA", { maximumFractionDigits: 2 })} h`;
  return value.toLocaleString("en-CA", { maximumFractionDigits: 2 });
}

export type Freshness = { stale: boolean; ageSeconds: number };

/** Whether an answer is older than the metric's budget. A clock behind the server's counts as age zero. */
export function freshnessOf(computedAt: Date, freshnessSeconds: number, now: Date): Freshness {
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - computedAt.getTime()) / 1000));
  return { stale: ageSeconds > freshnessSeconds, ageSeconds };
}

const sameDay = (a: Date, b: Date, zone: string) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(a) === f.format(b);
};

/** "Last updated 14:02", or with the date when it is not today, in the zone the screen states. */
export function lastUpdatedLabel(computedAt: Date, now: Date, zone: string): string {
  const time = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(computedAt);
  if (sameDay(computedAt, now, zone)) return `Last updated ${time}`;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, month: "short", day: "numeric" }).format(computedAt);
  return `Last updated ${date}, ${time}`;
}

export const RANGE_CHOICES = [
  { label: "today", text: "Today" },
  { label: "yesterday", text: "Yesterday" },
  { label: "last_7_days", text: "Last 7 days" },
  { label: "last_30_days", text: "Last 30 days" },
  { label: "month_to_date", text: "Month to date" },
  { label: "quarter_to_date", text: "Quarter to date" },
  { label: "year_to_date", text: "Year to date" },
] as const;
export type RangeChoice = (typeof RANGE_CHOICES)[number]["label"];

/** The exact interval an answer covered, in the screen's zone. The end is exclusive, and the text says so. */
export function rangeText(range: { from: Date; to: Date } | null, zone: string): string {
  if (!range) return "Current state";
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${f.format(range.from)} up to ${f.format(range.to)}`;
}

export const FAMILY_ORDER = ["operations", "fleet", "maintenance", "compliance", "safety", "hours_of_service", "workforce"] as const;

const FAMILY_TITLES: Record<string, string> = {
  operations: "Operations", fleet: "Fleet", maintenance: "Maintenance", compliance: "Compliance",
  safety: "Safety", hours_of_service: "Hours of service", workforce: "Workforce",
};
export const familyTitle = (f: string) => FAMILY_TITLES[f] ?? f;

/** A drill-down field name as a column a person reads: `daysRemaining` → "Days remaining". */
export function fieldLabel(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A drill-down field value. An empty value is "not recorded", never a blank cell. */
export function fieldValue(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined || v === "") return "not recorded";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}
