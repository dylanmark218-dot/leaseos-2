/**
 * Legal land description → approximate coordinate, on top of the existing DLS module.
 *
 * `parseLsd` / `theoreticalCentroid` (server/_core/dls.ts) take the full LSD form.
 * Operator directories also write quarter sections ("SW-12-043-07 W5M") and bare
 * sections ("22-23-29-W4M"); those are mapped to a representative LSD near the
 * centre of the quarter or section — within ~400 m of it — and said so in the note.
 * NTS descriptions ("D-096-K/094-A-12") are not converted. Every result is
 * `approximate_site`: the centre of a survey cell, never an entrance, never routable.
 */
import { parseLsd, theoreticalCentroid } from "./dls";

export type ApproximateFromLegal = { latitude: number; longitude: number; precision: "approximate_site"; note: string } | null;

const QUARTER_REPRESENTATIVE_LSD: Record<"NE" | "NW" | "SE" | "SW", number> = { SE: 2, SW: 6, NW: 12, NE: 15 };

export function approximateFromLegalLocation(text: string): ApproximateFromLegal {
  // Regulators write the meridian several ways: "-W4M", "W5", " W4M", "-W6 M". Normalize to " W<n>M" first.
  const t = text.trim().toUpperCase().replace(/\s+/g, " ").replace(/[-\s]*W\s?(\d)\s?M?$/, " W$1M").replace(/¼|1\/4/g, "").replace(/\s+/g, " ").trim();
  const full = t.match(/^(\d{1,2})-(\d{1,2})-(\d{1,3})-(\d{1,2}) W(\d)M$/);
  const quarter = t.match(/^(NE|NW|SE|SW)[- ]+(\d{1,2})-(\d{1,3})-(\d{1,2}) W(\d)M$/);
  const section = t.match(/^(\d{1,2})-(\d{1,3})-(\d{1,2}) W(\d)M$/);
  let canonical: string, cell: string;
  if (full) { canonical = `${full[1]}-${full[2]}-${full[3]}-${full[4]}-W${full[5]}`; cell = "LSD"; }
  else if (quarter) { canonical = `${QUARTER_REPRESENTATIVE_LSD[quarter[1] as "NE"]}-${quarter[2]}-${quarter[3]}-${quarter[4]}-W${quarter[5]}`; cell = `${quarter[1]} quarter section (represented by a central LSD)`; }
  else if (section) { canonical = `7-${section[1]}-${section[2]}-${section[3]}-W${section[4]}`; cell = "section (represented by a central LSD)"; }
  else return null;
  const parsed = parseLsd(canonical);
  if (!parsed.ok) return null;
  const c = theoreticalCentroid(parsed.value);
  return { latitude: Math.round(c.latitude * 1e4) / 1e4, longitude: Math.round(c.longitude * 1e4) / 1e4, precision: "approximate_site", note: `computed from the legal land description ${text.trim()}: theoretical centre of the ${cell}, roughly ±2 km; not an entrance` };
}
