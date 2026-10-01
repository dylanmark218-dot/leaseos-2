/**
 * The Fleet portfolio's presentation contract — the one place a server status becomes a thing on a
 * screen, in the readinessPresentation.ts manner: nothing here recomputes a state, and a value this
 * module does not recognise is `unavailable`, never `available`.
 */
export type FleetTone = "ready" | "review" | "blocked" | "insufficient" | "unavailable";
export type Presented = { tone: FleetTone; label: string; meaning: string };

export const UNAVAILABLE: Presented = { tone: "unavailable", label: "Unavailable", meaning: "The server sent a status this screen does not recognise. Treat it as not established." };

/** The portfolio's five operational states (owner's list, 2026-09-25), in order of consequence. */
export const OPERATIONAL_STATUSES = ["available", "warning", "indeterminate", "maintenance_hold", "out_of_service"] as const;
const OPERATIONAL: Record<(typeof OPERATIONAL_STATUSES)[number], Presented> = {
  available: { tone: "ready", label: "Operational", meaning: "No hold, defect, order or fault stands against this unit. Documents and insurance are decided at dispatch." },
  warning: { tone: "review", label: "Operational, with warnings", meaning: "The unit may operate; something on it needs a person to look." },
  indeterminate: { tone: "insufficient", label: "Not established", meaning: "A source could not be read or a safety input nobody has judged. Not the same as clear." },
  maintenance_hold: { tone: "blocked", label: "Maintenance hold", meaning: "Do not operate. The reasons name the act that lifts each one." },
  out_of_service: { tone: "blocked", label: "Out of service", meaning: "Do not operate. A safety hold or a government order stands; no override exists." },
};
export function presentOperational(status: string | null | undefined): Presented {
  return (OPERATIONAL as Record<string, Presented>)[status ?? ""] ?? UNAVAILABLE;
}

export const LIFECYCLE_STATUSES = ["active", "seasonal_storage", "retired", "sold", "transferred"] as const;
const LIFECYCLE: Record<(typeof LIFECYCLE_STATUSES)[number], Presented> = {
  active: { tone: "ready", label: "In fleet", meaning: "An active asset." },
  seasonal_storage: { tone: "review", label: "In storage", meaning: "Held out of service for the season; dispatch needs an approved policy to use it." },
  retired: { tone: "blocked", label: "Retired", meaning: "Out of the fleet. Its history stays; management may return it." },
  sold: { tone: "blocked", label: "Sold", meaning: "Out of the fleet. Its history stays; management may return it." },
  transferred: { tone: "blocked", label: "Transferred", meaning: "Owned by another organization now. Its history here stays." },
};
export function presentLifecycle(status: string | null | undefined): Presented {
  return (LIFECYCLE as Record<string, Presented>)[status ?? ""] ?? UNAVAILABLE;
}

/** The unit-side readiness verdict — explicitly not a dispatch verdict. */
export const UNIT_SIDE_VERDICTS = ["clear", "review", "blocked", "unknown"] as const;
const UNIT_SIDE: Record<(typeof UNIT_SIDE_VERDICTS)[number], Presented> = {
  clear: { tone: "ready", label: "Clear on the unit side", meaning: "No unit-side finding stood. The driver, the job and the route are decided at dispatch." },
  review: { tone: "review", label: "Review", meaning: "A unit-side finding needs a person before dispatch." },
  blocked: { tone: "blocked", label: "Blocked", meaning: "A unit-side finding stops any dispatch of this unit." },
  unknown: { tone: "insufficient", label: "Not established", meaning: "A unit-side fact could not be established. Not the same as clear." },
};
export function presentUnitSide(verdict: string | null | undefined): Presented {
  return (UNIT_SIDE as Record<string, Presented>)[verdict ?? ""] ?? UNAVAILABLE;
}

/** Asset class, as words. Unknown is said, never guessed from the vehicle type. */
export function presentAssetClass(assetClass: string | null | undefined): string {
  if (!assetClass) return "Unclassified";
  return assetClass.replace(/_/g, " ");
}

/** Tailwind classes for a tone — the shell's palette, carried by word and icon as well as colour. */
export const TONE_CLASS: Record<FleetTone, string> = {
  ready: "bg-[#e7f5ec] text-[#1b6b3a]",
  review: "bg-[#fff3e0] text-[#c4620a]",
  blocked: "bg-[#fde8e6] text-[#b42318]",
  insufficient: "bg-[#eef2f7] text-[#5b6b82]",
  unavailable: "bg-[#eef2f7] text-[#5b6b82]",
};
export const TONE_GLYPH: Record<FleetTone, string> = { ready: "✓", review: "!", blocked: "✕", insufficient: "?", unavailable: "?" };
