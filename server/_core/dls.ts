/**
 * Dominion Land Survey — parsing, validation, and the THEORETICAL grid.
 *
 * An LSD names a quarter-mile square: legal subdivision (1–16) within a
 * section (1–36) within a township (1–126) within a range west of a
 * meridian (W1–W6). A UWI names a wellbore at an LSD with a location
 * exception code and an event sequence. Both are validated here.
 *
 * The theoretical grid position is computed from the survey system's
 * definition — six-mile townships north from the 49th parallel, six-mile
 * ranges west from the meridian, one-mile sections numbered boustrophedon
 * from the southeast corner, quarter-mile LSDs numbered the same way. It
 * ignores correction lines, road allowances and convergence, so it can be
 * hundreds of metres from the surveyed position. It is labelled
 * `theoretical_grid`, confidence `low`, and is never a verified coordinate:
 * ATS v4.1 or a field GPS fix, verified by a person, is.
 */

export type Lsd = { lsd: number; section: number; township: number; range: number; meridian: number; canonical: string; identity: string };

/**
 * v22.14 — A forgiving reader, a strict validator.
 *
 * Drivers and dispatchers write an LSD every imaginable way. All of these are
 * the same parcel: 13-24-54-18-W5 · 13/24-54-18-W5 · 13-24-054-18W5 ·
 * LSD 13 SEC 24 TWP 54 RGE 18 W5M · 13 24 54 18 W5 · 13-24-54-18-5.
 * What is *out of range* still fails, by field and by name — a section is
 * numbered 1 to 36, so 44 is refused rather than guessed at.
 *
 * `canonical` stays the human form the rest of the system already stores.
 * `identity` is the key form — AB:M5:R18:T54:S24:L13 — so two spellings of
 * one parcel can never become two parcels.
 */
export function parseLsd(input: string): { ok: true; value: Lsd } | { ok: false; reason: string; field?: "lsd" | "section" | "township" | "range" | "meridian" | "format" } {
  const cleaned = input
    .replace(/\b(LSD|LS|SEC|SECTION|TWP|TOWNSHIP|RGE|RANGE|MER|MERIDIAN)\b\.?/gi, " ")
    .replace(/W\s*(\d)\s*M\b/gi, "W$1")
    .replace(/[\/,]/g, "-")
    .trim();
  const m = /^\s*(\d{1,2})\s*[-\s]\s*(\d{1,2})\s*[-\s]\s*(\d{1,3})\s*[-\s]\s*(\d{1,2})\s*[-\s]?\s*W?\s*(\d)\s*M?\s*$/i.exec(cleaned);
  if (!m) return { ok: false, field: "format", reason: "An LSD reads LSD-SEC-TWP-RGE-W#M, for example 10-22-045-06-W5" };
  const [lsd, section, township, range, meridian] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (lsd < 1 || lsd > 16) return { ok: false, field: "lsd", reason: `LSD ${lsd} is outside 1–16` };
  if (section < 1 || section > 36) return { ok: false, field: "section", reason: `Section ${section} is outside 1–36` };
  if (township < 1 || township > 126) return { ok: false, field: "township", reason: `Township ${township} is outside 1–126` };
  if (range < 1 || range > 34) return { ok: false, field: "range", reason: `Range ${range} is outside 1–34` };
  if (meridian < 1 || meridian > 6) return { ok: false, field: "meridian", reason: `Meridian W${meridian} is not W1–W6` };
  return { ok: true, value: { lsd, section, township, range, meridian, canonical: `${String(lsd).padStart(2, "0")}-${String(section).padStart(2, "0")}-${String(township).padStart(3, "0")}-${String(range).padStart(2, "0")}-W${meridian}`, identity: lsdIdentity({ lsd, section, township, range, meridian }) } };
}

/** The key form. Two spellings of one parcel resolve to one identity. */
export function lsdIdentity(p: { meridian: number; range: number; township: number; section: number; lsd: number }): string {
  return `AB:M${p.meridian}:R${p.range}:T${p.township}:S${p.section}:L${p.lsd}`;
}

export function parseUwi(input: string): { ok: true; value: { locationException: string; lsd: Lsd; eventSequence: string; canonical: string } } | { ok: false; reason: string } {
  const m = /^\s*(\d)(\d{2})\s*\/\s*(\d{2})\s*-\s*(\d{2})\s*-\s*(\d{3})\s*-\s*(\d{2})\s*W\s*(\d)\s*\/\s*(\d{2})\s*$/i.exec(input);
  if (!m) return { ok: false, reason: "A UWI reads SLE/LSD-SEC-TWP-RGEW#/ES, for example 100/10-22-045-06W5/00" };
  const lsd = parseLsd(`${m[3]}-${m[4]}-${m[5]}-${m[6]}-W${m[7]}`);
  if (!lsd.ok) return lsd;
  const le = `${m[1]}${m[2]}`;
  return { ok: true, value: { locationException: le, lsd: lsd.value, eventSequence: m[8], canonical: `${le}/${m[3]}-${m[4]}-${m[5]}-${m[6]}W${m[7]}/${m[8]}` } };
}

/** The six meridians' longitudes, from the survey system. */
export const MERIDIAN_LONGITUDE: Readonly<Record<number, number>> = { 1: -97.4578, 2: -102, 3: -106, 4: -110, 5: -114, 6: -118 };
const MILE_KM = 1.609344;
const KM_PER_DEG_LAT = 111.0;

/** Row (0 = south) and column (0 = east) of a section within its township, boustrophedon from the southeast corner. */
export function sectionRowCol(section: number): { row: number; col: number } {
  const row = Math.floor((section - 1) / 6);
  const inRow = (section - 1) % 6;
  return { row, col: row % 2 === 0 ? inRow : 5 - inRow };
}
/** Row and column of an LSD within its section, numbered the same way. */
export function lsdRowCol(lsd: number): { row: number; col: number } {
  const row = Math.floor((lsd - 1) / 4);
  const inRow = (lsd - 1) % 4;
  return { row, col: row % 2 === 0 ? inRow : 3 - inRow };
}

export type TheoreticalPosition = { latitude: number; longitude: number; source: "theoretical_grid"; confidence: "low"; caveat: string };

export function theoreticalCentroid(l: Lsd): TheoreticalPosition {
  const sec = sectionRowCol(l.section), sub = lsdRowCol(l.lsd);
  const milesNorth = (l.township - 1) * 6 + sec.row + sub.row * 0.25 + 0.125;
  const milesWest = (l.range - 1) * 6 + sec.col + sub.col * 0.25 + 0.125;
  const latitude = 49 + (milesNorth * MILE_KM) / KM_PER_DEG_LAT;
  const kmPerDegLon = 111.32 * Math.cos((latitude * Math.PI) / 180);
  const longitude = MERIDIAN_LONGITUDE[l.meridian]! - (milesWest * MILE_KM) / kmPerDegLon;
  return { latitude: Math.round(latitude * 1e5) / 1e5, longitude: Math.round(longitude * 1e5) / 1e5, source: "theoretical_grid", confidence: "low", caveat: "Theoretical survey grid — ignores correction lines, road allowances and convergence; can be hundreds of metres off. Not for navigation. Verify against ATS v4.1 or a field GPS fix." };
}
