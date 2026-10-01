/**
 * The source catalogue: *what* a source is, kept apart from *whether we may use it*.
 *
 * `knowledgeSources` holds both halves in one row. The licence half — the
 * assessment, the four permissions, the permission document — is written by
 * `repository.registerSource` from a stored assessment and nothing else. This
 * module describes the other half: publisher, jurisdiction, format, authority,
 * topics, crawl cadence. `repository.registerCatalogueEntry` writes only those
 * columns and never touches a licence column, so seeding the catalogue cannot
 * grant, widen or revoke a permission.
 *
 * Every seed below therefore lands `unassessed`, which permits nothing — not
 * even a fetch (`collectors.decideFetch`). That is the intended state: the
 * catalogue says what we would like to read, and a person reading the terms
 * says whether we may. `licenceNotes` records what that person should look at
 * first; it is a pointer for the assessment, not a conclusion.
 *
 * Effective dates are deliberately absent. They belong to a *version* of a
 * document, read off that version when it is retrieved — not to the source,
 * and not remembered into code.
 */

import { AUTHORITY_LEVELS, type AuthorityLevel } from "./admission";
import { validateTopics, type IndustryTopic } from "./industryTaxonomy";
import { SOURCE_KINDS, DEFAULT_CRAWL_POLICY, type CrawlPolicy, type SourceKind } from "./collectors";
import { validateSourceUrl } from "./provenance";

export type CatalogueEntry = {
  sourceId: string;
  sourceName: string;
  /** The publisher. Stored in `knowledgeSources.owner`. */
  owner: string;
  jurisdiction: string;
  homeUrl: string;
  /** Hosts a collector may fetch from for this source. Exact hosts, not parent domains, unless the whole domain is the publisher's. */
  domains: readonly string[];
  sourceKind: SourceKind;
  authorityLevel: AuthorityLevel;
  topics: readonly IndustryTopic[];
  refreshIntervalHours: number;
  crawlPolicy: CrawlPolicy;
  termsUrl: string | null;
  accessControlled: boolean;
  /** Where the licence assessment should start. Not an assessment. */
  licenceNotes: string;
  /** When somebody confirmed `homeUrl` resolves. */
  urlCheckedOn: string;
};

export type CatalogueRefusal =
  | "BAD_SOURCE_ID" | "BAD_JURISDICTION" | "BAD_NAME" | "BAD_DOMAIN" | "BAD_URL" | "BAD_TOPICS"
  | "BAD_KIND" | "BAD_AUTHORITY" | "BAD_POLICY" | "PRIVATE_MATERIAL";

export type CatalogueVerdict = { ok: true } | { ok: false; code: CatalogueRefusal; reason: string };

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Is this a well-formed entry for the *public* industry corpus?
 *
 * The public corpus has no tenant column, on purpose: an organization's own
 * documents go to the passage library, which is tenant-keyed. An entry that
 * arrives carrying a tenant or organization is refused here rather than having
 * its owner silently dropped — dropping it would publish a customer's document
 * to every customer.
 */
export function validateCatalogueEntry(e: CatalogueEntry): CatalogueVerdict {
  const bag = e as unknown as Record<string, unknown>;
  for (const k of ["tenantId", "organizationId", "companyId"]) {
    if (bag[k] !== undefined && bag[k] !== null) {
      return { ok: false, code: "PRIVATE_MATERIAL", reason: `"${e.sourceId}" carries ${k}; organization material never enters the public industry corpus` };
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(e.sourceId)) return { ok: false, code: "BAD_SOURCE_ID", reason: `"${e.sourceId}" is not a lowercase slug of 3–64 characters` };
  if (!/^[A-Z]{2}-[A-Z]{2,13}$/.test(e.jurisdiction)) return { ok: false, code: "BAD_JURISDICTION", reason: `"${e.jurisdiction}" is not a jurisdiction code like CA-AB or CA-FEDERAL` };
  if (!e.sourceName.trim() || e.sourceName.length > 200 || !e.owner.trim() || e.owner.length > 200) {
    return { ok: false, code: "BAD_NAME", reason: "name and publisher are required and at most 200 characters" };
  }
  if (e.domains.length === 0 || e.domains.some((d) => !HOST.test(d))) {
    return { ok: false, code: "BAD_DOMAIN", reason: `domains must be bare lowercase hostnames: ${e.domains.join(", ") || "(none)"}` };
  }
  const home = validateSourceUrl(e.homeUrl, e.domains);
  if (!home.ok) return { ok: false, code: "BAD_URL", reason: home.reason };
  if (e.termsUrl !== null && !validateSourceUrl(e.termsUrl, e.domains).ok) {
    return { ok: false, code: "BAD_URL", reason: `terms URL "${e.termsUrl}" is not a safe URL under the source's domains` };
  }
  const topics = validateTopics(e.topics);
  if (!topics.ok) return { ok: false, code: "BAD_TOPICS", reason: topics.reason };
  if (!(SOURCE_KINDS as readonly string[]).includes(e.sourceKind)) return { ok: false, code: "BAD_KIND", reason: `unknown source kind "${e.sourceKind}"` };
  if (!(AUTHORITY_LEVELS as readonly string[]).includes(e.authorityLevel)) return { ok: false, code: "BAD_AUTHORITY", reason: `unknown authority level "${e.authorityLevel}"` };
  const p = e.crawlPolicy;
  if (!(e.refreshIntervalHours >= 1) || !(p.minDelayMs >= 1000) || !(p.maxConcurrency >= 1 && p.maxConcurrency <= 4) || !(p.maxBytes > 0)) {
    return { ok: false, code: "BAD_POLICY", reason: "refresh ≥ 1h, delay ≥ 1s and concurrency 1–4 are required" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

const AER_LICENCE_NOTE =
  "AER publication terms for commercial reuse are unconfirmed — DATA_SOURCES.md already holds AER ST37/ST102 as unverified for the same reason. Assess the AER copyright and terms of use before any fetch.";

/**
 * Checkpoint 1's seed set: six authoritative Alberta and federal sources.
 *
 * Small on purpose. The point is to prove the provenance model on sources whose
 * authority is not in doubt, before anything scales. Each `homeUrl` was
 * confirmed to resolve on the `urlCheckedOn` date.
 *
 * Domains are exact publisher hosts. `www.alberta.ca` rather than `alberta.ca`,
 * because `511.alberta.ca` is a different source with its own — blocking —
 * assessment (`sourceGate.AB_511`), and a parent domain would have let a crawl
 * of carrier guidance wander into it.
 */
export const SEED_CATALOGUE: readonly CatalogueEntry[] = [
  {
    sourceId: "ca-justice-sor-2005-313",
    sourceName: "Commercial Vehicle Drivers Hours of Service Regulations (SOR/2005-313)",
    owner: "Government of Canada — Department of Justice (Justice Laws Website)",
    jurisdiction: "CA-FEDERAL",
    homeUrl: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2005-313/",
    domains: ["laws-lois.justice.gc.ca"],
    sourceKind: "html",
    authorityLevel: "law",
    topics: ["hos_eld"],
    refreshIntervalHours: 168,
    crawlPolicy: DEFAULT_CRAWL_POLICY,
    termsUrl: null,
    accessControlled: false,
    licenceNotes: "Start from the Reproduction of Federal Law Order and the Justice Laws terms. The site also publishes XML; prefer it for section-level extraction once assessed. Federal HOS governs provincial operations only for federally regulated (extra-provincial) carriers — see provenance.jurisdictionFit.",
    urlCheckedOn: "2026-09-25",
  },
  {
    sourceId: "ab-tec-commercial-carriers",
    sourceName: "Alberta commercial carriers (NSC, audits, certificates, operating status)",
    owner: "Government of Alberta — Transportation and Economic Corridors",
    jurisdiction: "CA-AB",
    homeUrl: "https://www.alberta.ca/commercial-carriers",
    domains: ["www.alberta.ca"],
    sourceKind: "html",
    authorityLevel: "official_guidance",
    topics: ["nsc", "inspections", "cvip", "permits"],
    refreshIntervalHours: 168,
    crawlPolicy: DEFAULT_CRAWL_POLICY,
    termsUrl: null,
    accessControlled: false,
    licenceNotes: "Government of Alberta copyright. The 511 assessment (LIC-AB-511-2026-09-13) found Alberta requires written permission for commercial reproduction of some carrier material; that finding does not transfer, but it is the first question to ask here.",
    urlCheckedOn: "2026-09-25",
  },
  {
    sourceId: "ab-tec-carrier-requirements",
    sourceName: "Alberta commercial carrier requirements (hours of service and permits)",
    owner: "Government of Alberta — Transportation and Economic Corridors",
    jurisdiction: "CA-AB",
    homeUrl: "https://www.alberta.ca/commercial-carrier-requirements-alberta",
    domains: ["www.alberta.ca"],
    sourceKind: "html",
    authorityLevel: "official_guidance",
    topics: ["hos_eld", "permits", "nsc"],
    refreshIntervalHours: 168,
    crawlPolicy: DEFAULT_CRAWL_POLICY,
    termsUrl: null,
    accessControlled: false,
    licenceNotes: "A dedicated Alberta hours-of-service or HOS-permit page was not located on 2026-09-25; this entry points at the carrier requirements page that links onward. Replace homeUrl once the specific page is confirmed rather than guessing a path. Same Alberta copyright question as ab-tec-commercial-carriers.",
    urlCheckedOn: "2026-09-25",
  },
  {
    sourceId: "aer-directive-047",
    sourceName: "AER Directive 047 — Waste Reporting Requirements for Oilfield Waste Management Facilities",
    owner: "Alberta Energy Regulator",
    jurisdiction: "CA-AB",
    homeUrl: "https://www.aer.ca/regulating-development/rules-and-directives/directives/directive-047",
    domains: ["www.aer.ca", "static.aer.ca"],
    // The home URL is the directive's HTML landing page (title, release and effective dates,
    // a link to the PDF). The PDF itself is the instrument and is a separate document to add.
    sourceKind: "html",
    authorityLevel: "law",
    topics: ["disposal_facilities", "disposal_tickets", "aer_petrinex", "waste_classification"],
    refreshIntervalHours: 168,
    crawlPolicy: DEFAULT_CRAWL_POLICY,
    termsUrl: null,
    accessControlled: false,
    licenceNotes: `Directive editions carry release and effective dates that differ; record both on the version, never on the source. ${AER_LICENCE_NOTE}`,
    urlCheckedOn: "2026-09-25",
  },
  {
    sourceId: "aer-directive-058",
    sourceName: "AER Directive 058 — Oilfield Waste Management Requirements for the Upstream Petroleum Industry",
    owner: "Alberta Energy Regulator",
    jurisdiction: "CA-AB",
    homeUrl: "https://www.aer.ca/regulating-development/rules-and-directives/directives/directive-058",
    domains: ["www.aer.ca", "static.aer.ca"],
    // The home URL is the directive's HTML landing page (title, release and effective dates,
    // a link to the PDF). The PDF itself is the instrument and is a separate document to add.
    sourceKind: "html",
    authorityLevel: "law",
    topics: ["waste_classification", "disposal_facilities", "environmental_compliance"],
    refreshIntervalHours: 168,
    crawlPolicy: DEFAULT_CRAWL_POLICY,
    termsUrl: null,
    accessControlled: false,
    licenceNotes: AER_LICENCE_NOTE,
    urlCheckedOn: "2026-09-25",
  },
  {
    sourceId: "aer-st107",
    sourceName: "AER ST107 — Approved oilfield waste management facilities",
    owner: "Alberta Energy Regulator",
    jurisdiction: "CA-AB",
    homeUrl: "https://www.aer.ca/providing-information/data-and-reports/statistical-reports/st107",
    domains: ["www.aer.ca", "static.aer.ca"],
    sourceKind: "html",
    authorityLevel: "official_guidance",
    topics: ["disposal_facilities", "waste_classification"],
    refreshIntervalHours: 24,
    crawlPolicy: DEFAULT_CRAWL_POLICY,
    termsUrl: null,
    accessControlled: false,
    licenceNotes: `A facility list, refreshed daily once permitted: a facility disappearing from it is a change worth detecting. Reconcile with the facility directory (shared/facilities.ts) rather than creating a second one. ${AER_LICENCE_NOTE}`,
    urlCheckedOn: "2026-09-25",
  },
];
