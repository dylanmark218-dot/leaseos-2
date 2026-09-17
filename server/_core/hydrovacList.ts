/**
 * Alberta "Facilities that Accept Hydrovac Waste" (alberta.ca, OGL–Alberta) → structured rows (pure).
 *
 * The PDF's text wraps cells across lines and sometimes two rows share a line, so the
 * parser tokenizes on authorization numbers — numeric EPEA authorizations or `WM nnn`
 * (AER-regulated) — and reads each row's text between them. Inside a row it extracts
 * what is unambiguous by shape: a legal land description, phones, emails, and the
 * acceptable-material phrase; the company and place are heuristics and are marked so.
 * Every row keeps its raw text for a reviewer. The list's own caveat is kept verbatim:
 * "Information in this document is based on information provided by the facility."
 */
export type HydrovacRow = {
  authorization: string; regulator: "AER" | "EPA"; region: "NORTH" | "SOUTH" | null;
  company: string; place: string | null; legalLocation: string | null; address: string | null;
  phones: string[]; emails: string[]; acceptableMaterial: string; hazardousAllowed: boolean | null; contactFacility: boolean;
  parseConfidence: "high" | "medium" | "low"; raw: string;
};
export const HYDROVAC_LIST = { title: "Alberta Facilities that Accept Hydrovac Waste", dated: "2026-04-10", sourceUrl: "https://www.alberta.ca/system/files/epa-facilities-list-hydrovac-waste.pdf", licenceKey: "ogl_alberta", caveat: "Information in this document is based on information provided by the facility. Please contact the facility directly for the most up to date information." };

const AUTH = /(?:^|\s)((?:WM \d{3}(?:-[A-Z])?)|(?:0{2}\d{6,7})|(?:\d{5}-\d{2}))(?=\s)/g;
const HEADER = /Alberta Facilities that Accept Hydrovac Waste \| April 10, 2026 \d+|Authorization Company Name Location Contact Information Acceptable Material/g;
const LSD = /\(?((?:NE|NW|SE|SW)[ -]?(?:¼|1\/4)?[ -]?\d{1,2}-\d{2,3}-\d{1,2}-?W\d ?M?|\d{1,2}-\d{1,2}-\d{2,3}-\d{1,2}-?W\d ?M?|\d{1,2}-\d{2,3}-\d{1,2}-W\dM)\)?/;
const PHONE = /(?:1[-. ])?\d{3}[-. ]\d{3}[-. ]\d{4}(?: ext\. \d+)?/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MATERIAL_PHRASES = [
  "Non-oilfield hazardous hydrovac must have a recoverable hydrocarbon component", "A hazardous and non-hazardous waste facility", "A hazardous waste management facility",
  "Hydrovac slurry/sludge/hazardous and non-hazardous", "Hazardous, non-hazardous, and hydrovac material", "Hazardous and non-hazardous waste",
  "Oilfield and non-oilfield hydrovac slurries. Contact the facility for additional information", "Non-hazardous industrial and oilfield hydrovac waste",
  "Limited to dangerous goods Class 8, 9, 4.1 and non-hazardous waste only", "Non-hazardous waste only – waste transported to landfill and waste water treatment plant",
  "Non-hazardous waste only, liquids disposal not permitted in landfill", "Non-hazardous hydrovac waste. Acceptance of impacted materials subject to facility review",
  "Non-impacted and non-hazardous hydrovac waste", "Non-contaminated hydrovac slurry", "Clean Hydrovac Slurry Contaminated Hydrovac Slurry Drilling Mud", "Non-hazardous Hydrovac waste or Contact the Facility directly",
  "Non-hazardous hydrovac slurry", "Non-hazardous hydrovac waste", "Non-Hazardous Hydrovac Waste", "Non-hazardous waste only", "Non-hazardous Waste", "Non-hazardous waste", "Non-hazardous material", "No restrictions", "Contact facility directly", "Contact Facility directly", "Contact Facility Directly", "Contact the Facility directly",
];
const PLACES = ["Fort McMurray", "Red Deer County", "Rocky View County", "Wheatland County", "Lacombe County", "Leduc County", "Westlock County", "Brazeau County", "Rocky Mountain House", "South Grande Prairie", "Grande Prairie", "Grande Cache", "Paddle River", "Fox Creek East", "Fox Creek", "La Glace", "LaGlace", "Judy Creek", "Elk Point", "Spirit River", "Peace River", "Rainbow Lake", "South Wapiti", "Valleyview West", "Valleyview", "Red Earth", "West Edson", "Niton Junction", "High Prairie", "Big Valley", "Brooks West", "Drayton Valley", "Buck Creek", "Tide Lake", "Fort Kent", "Edmonton", "Calgary", "Red Deer", "Acheson", "Redwater", "Edson", "Obed", "Hughenden", "Gordondale", "Lindbergh", "Mitsue", "Greencourt", "Atmore", "Conklin", "Lethbridge", "Ryley", "Drumheller", "Okotoks", "Brazeau", "Tuilliby", "Taber", "Eckville", "Coronation", "Stauffer", "Brooks", "Cynthia", "Claresholm", "Westlock"];
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseHydrovacList(text: string): HydrovacRow[] {
  const cleaned = text.replace(HEADER, " ").replace(/\r/g, "");
  // Region markers split the document; the rest is one stream of rows.
  const rows: HydrovacRow[] = [];
  let region: HydrovacRow["region"] = null;
  const segments = cleaned.split(/(NORTH REGION|SOUTH REGION)/);
  for (const seg of segments) {
    if (seg === "NORTH REGION") { region = "NORTH"; continue; }
    if (seg === "SOUTH REGION") { region = "SOUTH"; continue; }
    const body = seg.replace(/The (North|South) Region is based on[^.]*\./, " ");
    const tokens = Array.from(body.matchAll(AUTH));
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!; const start = t.index! + t[0].indexOf(t[1]!) + t[1]!.length; const end = i + 1 < tokens.length ? tokens[i + 1]!.index! : body.length;
      const raw = norm(body.slice(start, end));
      if (!raw) continue;
      const authorization = t[1]!.trim();
      const regulator = authorization.startsWith("WM") ? "AER" : "EPA";
      const lsdMatch = raw.match(LSD);
      const legalLocation = lsdMatch ? norm(lsdMatch[1]!).replace(/¼/, "1/4") : null;
      const phones = Array.from(raw.matchAll(PHONE)).map(m => m[0].replace(/\./g, "-"));
      const emails = Array.from(raw.matchAll(EMAIL)).map(m => m[0]);
      const material = MATERIAL_PHRASES.find(p => raw.toLowerCase().includes(p.toLowerCase()));
      const acceptableMaterial = material ?? "Contact facility directly";
      const contactFacility = /contact (the )?facility/i.test(acceptableMaterial) || material === undefined;
      const hazardousAllowed = /non-oilfield hazardous|a hazardous waste management|hazardous and non-hazardous|hazardous, non-hazardous|hazardous and non|dangerous goods/i.test(acceptableMaterial) ? true : /^non-|non-hazardous|non-contaminated|non-impacted|clean hydrovac/i.test(acceptableMaterial) ? false : null;
      const place = PLACES.find(pl => new RegExp(`(^|[^A-Za-z])${pl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`).test(raw)) ?? null;
      // Company: the text before the first address/LSD/phone/email clue.
      const clue = raw.search(/\(|\b\d{3,6}[- –]\d{0,4}\s?(Street|St\b|Avenue|Ave|Range|RD\b|Rd\b|Township|TWP|Highway|AB-|Memorial|Mt Lawn|Wagon|Enterprise|Hewlett)|\bBuilding [A-Z]\b|\bNW ¼|\bNE |\bSE1\/4|\d{3}[-. ]\d{3}[-. ]\d{4}|[A-Za-z0-9._%+-]+@/);
      let company = norm(clue > 0 ? raw.slice(0, clue) : raw.split(/\s\d/)[0] ?? raw);
      if (place && company.endsWith(place) && company !== place && !/City of/.test(company)) company = norm(company.slice(0, -place.length));
      const addressMatch = raw.match(/(\b(?:Building [A-Z] )?\d{2,6}[ –-]+\d{0,4} ?(?:Street|St\b|Avenue|Ave|Range Road|Range RD|Highway|AB-\d+|Memorial Drive|Mt Lawn Rd NW|Wagon Wheel Way|Enterprise Way|Hewlett Drive|TWP Rd \d+)[^,(]*)/);
      const address = addressMatch ? norm(addressMatch[1]!) : null;
      const parseConfidence: HydrovacRow["parseConfidence"] = material && (legalLocation || address) && phones.length ? "high" : material || legalLocation || phones.length ? "medium" : "low";
      rows.push({ authorization, regulator, region, company, place, legalLocation, address, phones, emails, acceptableMaterial, hazardousAllowed, contactFacility, parseConfidence, raw });
    }
  }
  return rows;
}

/** A stable key: the authorization plus the place, because WM 042 appears twice (Elk Point and Niton Junction). */
export function hydrovacFacilityKey(r: HydrovacRow): string {
  const slug = (r.place ?? r.legalLocation ?? r.address ?? r.company).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `ab_hydrovac:${r.authorization.replace(/\s+/g, "").toLowerCase()}:${slug}`;
}
