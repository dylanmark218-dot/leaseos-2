/**
 * A guard on where a citation points.
 *
 * Deliberately **not** a correctness check. A figure read off an official
 * government page can still be the wrong figure, and no domain match fixes
 * that — only the verifier does. What this catches is the citation pointing at
 * a summary site, a forum, a law firm's blog or a training vendor, when the
 * verifier has claimed to have read the instrument itself.
 *
 * `OFFICIAL_WEB` and `OFFICIAL_PDF` assert "I read the official publication",
 * so they are held to it. `REGULATOR_CONFIRMATION` and `LEGAL_COUNSEL` are the
 * deliberate exceptions: a regulator's email or counsel's written advice is not
 * on a government domain and is not supposed to be.
 */

import type { VerificationMethod } from "./promotionLedger";

/**
 * Domain suffixes that are the publisher rather than a commentator.
 *
 * Suffix-matched on a label boundary, so `justice.gc.ca` matches
 * `laws-lois.justice.gc.ca` and does not match `notjustice.gc.ca.example.com`.
 * The list is short and additive on purpose — a verifier meeting an
 * unrecognised official source records it and somebody adds it, rather than the
 * guard being loosened.
 */
export const OFFICIAL_DOMAINS: readonly string[] = [
  // Canada — federal
  "laws-lois.justice.gc.ca", "justice.gc.ca", "gazette.gc.ca", "tc.canada.ca",
  "canada.ca", "gc.ca",
  // Provinces and territories
  "alberta.ca", "qp.alberta.ca", "bclaws.gov.bc.ca", "gov.bc.ca",
  "gov.sk.ca", "publications.saskatchewan.ca", "gov.mb.ca", "web2.gov.mb.ca",
  "ontario.ca", "legisquebec.gouv.qc.ca", "gouv.qc.ca",
  "gnb.ca", "novascotia.ca", "princeedwardisland.ca", "assembly.nl.ca",
  "gov.nt.ca", "gov.nu.ca", "yukon.ca",
  // Recognized standards bodies and national bodies
  "ccmta.ca", "csagroup.org", "nsc-cnc.ca",
  // United States, for cross-border operations
  "ecfr.gov", "govinfo.gov", "fmcsa.dot.gov", "dot.gov", "federalregister.gov",
];

export type CitationVerdict =
  | { ok: true; matched: string | null; note: string }
  | { ok: false; code: "UNRECOGNIZED_AUTHORITY_DOMAIN" | "MALFORMED_CITATION_URL"; reason: string };

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase();
  } catch { return null; }
};

/**
 * Suffix match on a label boundary, so a lookalike host cannot pass.
 *
 * Returns the **most specific** entry that matches, not the first in list
 * order. `qp.alberta.ca` matches both `alberta.ca` and `qp.alberta.ca`, and the
 * note a promotion carries should name the register entry that actually
 * describes the publisher rather than the broadest one that happens to cover it.
 */
export const isOfficialHost = (host: string): string | null => {
  const matches = OFFICIAL_DOMAINS.filter((d) => host === d || host.endsWith(`.${d}`));
  if (matches.length === 0) return null;
  return matches.reduce((best, d) => (d.length > best.length ? d : best));
};

export function checkCitation(url: string, method: VerificationMethod): CitationVerdict {
  const host = hostOf(url);
  if (!host) {
    return { ok: false, code: "MALFORMED_CITATION_URL",
      reason: "the citation must be an http or https URL a reader can open" };
  }

  if (method === "REGULATOR_CONFIRMATION" || method === "LEGAL_COUNSEL" || method === "OFFICIAL_PRINT") {
    // The deliberate exceptions. A regulator's written confirmation and
    // counsel's advice do not live on a government domain, and a printed
    // consolidation has no domain at all.
    return { ok: true, matched: isOfficialHost(host),
      note: `${method} does not require an official domain; the verifier is the evidence` };
  }

  const matched = isOfficialHost(host);
  if (!matched) {
    return { ok: false, code: "UNRECOGNIZED_AUTHORITY_DOMAIN",
      reason: `${host} is not a recognized publisher of the instrument. If this is an official source, add it to the register; if the figure came from a regulator or counsel, record that method instead — do not point OFFICIAL_WEB at a summary.` };
  }

  // Matching the publisher's domain says the citation points at the publisher.
  // It says nothing about whether the figure is right.
  return { ok: true, matched, note: `${matched} is a recognized publisher; this does not establish that the figure is correct` };
}
