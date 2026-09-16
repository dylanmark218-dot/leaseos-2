/**
 * LeaseOS — the source licence gate.
 *
 * Every scraper, RAG importer, API connector and AI agent passes through here.
 * A source with no assessment can do nothing; a source with an assessment can
 * do exactly what the assessment says and nothing adjacent to it.
 *
 * The 511 Alberta assessment is the first real record, and it is a useful one
 * because the answer is not a simple no. Alberta's terms permit non-commercial
 * educational reproduction and require written permission for commercial use;
 * the developer API exists but does not obviously override that; and the
 * companion manual says plainly it is not to be reproduced or sold for
 * commercial gain. So linking is fine, metadata is fine, and almost everything
 * else waits for a letter.
 *
 * The invariant the assessment asks for, made mechanical:
 *
 *   "Do not change `commercial_reuse_authorized` to true until written
 *    permission or an applicable explicit licence is stored with the source
 *    record."
 *
 * `authorizeCommercialUse` will not return an authorized record without a
 * permission document reference. There is no other way to set the flag.
 */

import type { AllowedUses, KnowledgeAuthority } from "./admission";

/* ------------------------------------------------------------------ */
/* The assessment record                                               */
/* ------------------------------------------------------------------ */

export type LicenceStatusCode =
  | "blocked_pending_written_permission"
  | "authorized_commercial"
  | "authorized_non_commercial_only"
  | "link_and_metadata_only"
  | "prohibited";

/** The shape of a stored assessment. Field names follow the assessment record. */
export type SourceLicenceRecord = {
  assessment_id: string;
  source_id: string;
  source_name: string;
  jurisdiction: string;
  owner: string;
  assessed_at: string;
  /** True when LeaseOS's use of it is part of a paid product. */
  commercial_product: boolean;
  status: LicenceStatusCode;

  commercial_reuse_authorized: boolean;
  api_production_authorized: boolean;
  rag_ingestion_authorized: boolean;
  model_training_authorized: boolean;
  linking_authorized: boolean;
  metadata_only_authorized: boolean;

  /** The written permission or explicit licence. Null means none is held. */
  permission_document_id: string | null;

  reasons: readonly string[];
  conditions_to_unblock: readonly string[];
  sources: readonly string[];
};

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

/**
 * 511 Alberta, as assessed.
 *
 * Recorded rather than summarised: the reasons travel with the decision so a
 * future reader does not have to re-derive why it was blocked, and the
 * conditions travel with it so they know what would change it.
 */
export const AB_511: SourceLicenceRecord = {
  assessment_id: "LIC-AB-511-2026-09-13",
  source_id: "gov-ab-511",
  source_name: "511 Alberta / Alberta Carrier Training",
  jurisdiction: "CA-AB",
  owner: "Government of Alberta — Alberta Transportation and Economic Corridors",
  assessed_at: "2026-09-13",
  commercial_product: true,
  status: "blocked_pending_written_permission",

  commercial_reuse_authorized: false,
  api_production_authorized: false,
  rag_ingestion_authorized: false,
  model_training_authorized: false,
  linking_authorized: true,
  metadata_only_authorized: true,

  permission_document_id: null,

  reasons: [
    "511 Alberta public terms permit non-commercial/educational reproduction but require written permission for commercial reproduction/distribution.",
    "Public API documentation supports developer access but does not clearly provide a separate commercial licence overriding the general commercial-reproduction restriction.",
    "Alberta Carrier Training shows Government of Alberta copyright and no separate commercial reuse licence was located.",
    "Commercial Vehicle Safety Compliance in Alberta manual states it is not intended to be reproduced or sold for commercial purposes or financial gain.",
  ],
  conditions_to_unblock: [
    "Store written permission or explicit licence covering LeaseOS commercial use.",
    "Confirm API caching, offline, historical storage, redisplay, derivative-use and attribution conditions.",
    "Confirm camera-image and third-party data rights.",
    "Confirm whether AI/RAG indexing is permitted.",
    "Confirm whether course content may be commercially reproduced.",
  ],
  sources: [
    "https://511.alberta.ca/about/about",
    "https://511.alberta.ca/developers/doc",
    "https://commercial-driver-training.511.alberta.ca/",
    "https://www.alberta.ca/education-manual-for-commercial-carriers",
    "https://www.alberta.ca/open-government-program",
  ],
};

/**
 * The registry.
 *
 * A government being the publisher does not make a source assessable in bulk —
 * Alberta's Open Government program licenses some material separately, so each
 * source is assessed on its own. `gov-ab-511` blocked says nothing about any
 * other Alberta dataset.
 */
const REGISTRY = new Map<string, SourceLicenceRecord>([[AB_511.source_id, AB_511]]);

export const licenceFor = (sourceId: string): SourceLicenceRecord | null => REGISTRY.get(sourceId) ?? null;
export const registeredSources = (): readonly string[] => Array.from(REGISTRY.keys());

/* ------------------------------------------------------------------ */
/* Ingestion lifecycle                                                 */
/* ------------------------------------------------------------------ */

/**
 * Where a fetched document can be.
 *
 * `QUARANTINED` is the only entry point. Nothing is created `PUBLISHED`, and
 * the transition out of quarantine is the licence gate.
 */
export const INGESTION_STATES = [
  "QUARANTINED", "LICENCE_CHECKED", "PARSED", "CLASSIFIED", "VERIFIED", "PUBLISHED", "REJECTED",
] as const;

export type IngestionState = (typeof INGESTION_STATES)[number];

/** What an ingestion job intends to do with a source. */
export type IngestionPurpose =
  | "link_only"            // store a URL and a title
  | "metadata_only"        // plus author, date, section headings
  | "rag_ingestion"        // chunk and embed the text
  | "api_production"       // call the live API in a paid product
  | "api_dev_testing"      // call it in development
  | "model_training"       // fine-tune on it
  | "commercial_redisplay";// show its content to paying customers

export type GateDecision =
  | { allowed: true; purpose: IngestionPurpose; note: string }
  | { allowed: false; purpose: IngestionPurpose; code: GateRefusal; reason: string; conditions: readonly string[] };

export type GateRefusal =
  | "NO_LICENCE_ASSESSMENT"
  | "NOT_AUTHORIZED_FOR_PURPOSE"
  | "COMMERCIAL_USE_UNAUTHORIZED"
  | "PROHIBITED_SOURCE";

/**
 * May this job do this, with this source?
 *
 * Fail closed on every unknown. An unregistered source is not "probably fine";
 * it is a source nobody has looked at.
 */
export function checkSourceGate(sourceId: string, purpose: IngestionPurpose): GateDecision {
  const record = licenceFor(sourceId);

  if (!record) {
    return {
      allowed: false, purpose, code: "NO_LICENCE_ASSESSMENT",
      reason: `"${sourceId}" has no stored licence assessment; nothing may be ingested from it`,
      conditions: ["Create a licence assessment for this source and store it in the registry."],
    };
  }

  if (record.status === "prohibited") {
    return { allowed: false, purpose, code: "PROHIBITED_SOURCE",
      reason: `"${record.source_name}" is prohibited`, conditions: record.conditions_to_unblock };
  }

  const authorized: Readonly<Record<IngestionPurpose, boolean>> = {
    link_only: record.linking_authorized,
    metadata_only: record.metadata_only_authorized,
    rag_ingestion: record.rag_ingestion_authorized,
    api_production: record.api_production_authorized,
    // Development testing is not a free pass — the developer-key terms still
    // apply — but it is not commercial redisplay either, so it is separable.
    // (Prohibited sources returned above, so reaching here means not prohibited.)
    api_dev_testing: true,
    model_training: record.model_training_authorized,
    commercial_redisplay: record.commercial_reuse_authorized,
  };

  if (!authorized[purpose]) {
    // For a commercial product, a blocked *content* use is a commercial
    // refusal, not a generic one. The reason 511 blocks RAG ingestion is
    // commercial reuse, and coding it as "not authorized for purpose" would
    // hide why — and hide what would unblock it.
    const commercialPurpose =
      purpose === "commercial_redisplay" || purpose === "api_production" ||
      purpose === "rag_ingestion" || purpose === "model_training";
    const commercial = commercialPurpose && record.commercial_product;
    return {
      allowed: false, purpose,
      code: commercial ? "COMMERCIAL_USE_UNAUTHORIZED" : "NOT_AUTHORIZED_FOR_PURPOSE",
      reason: `"${record.source_name}" is not authorized for ${purpose} — ${record.reasons[0] ?? "see the assessment"}`,
      conditions: record.conditions_to_unblock,
    };
  }

  // Commercial product plus any content use means the commercial flag governs,
  // whatever the narrower flag says.
  const contentUse = purpose === "rag_ingestion" || purpose === "model_training" || purpose === "commercial_redisplay";
  if (record.commercial_product && contentUse && !record.commercial_reuse_authorized) {
    return {
      allowed: false, purpose, code: "COMMERCIAL_USE_UNAUTHORIZED",
      reason: `LeaseOS is a commercial product and "${record.source_name}" has no commercial reuse authorization`,
      conditions: record.conditions_to_unblock,
    };
  }

  return { allowed: true, purpose, note: `authorized by ${record.assessment_id}` };
}

/**
 * The only transition out of quarantine.
 *
 * An ingestion job cannot reach `PUBLISHED` without passing the gate for the
 * purpose it actually intends. A job that lied about its purpose earlier fails
 * here, because this is checked at the transition rather than at the start.
 */
export function advance(
  from: IngestionState,
  sourceId: string,
  purpose: IngestionPurpose,
): { to: IngestionState; reason?: string } {
  if (from === "QUARANTINED") {
    const gate = checkSourceGate(sourceId, purpose);
    return gate.allowed
      ? { to: "LICENCE_CHECKED", reason: gate.note }
      : { to: "REJECTED", reason: gate.reason };
  }

  const next: Partial<Record<IngestionState, IngestionState>> = {
    LICENCE_CHECKED: "PARSED", PARSED: "CLASSIFIED", CLASSIFIED: "VERIFIED", VERIFIED: "PUBLISHED",
  };
  const to = next[from];
  return to ? { to } : { to: from, reason: `${from} is terminal` };
}

/* ------------------------------------------------------------------ */
/* Authorizing a source                                                */
/* ------------------------------------------------------------------ */

export type Authorization =
  | { authorized: true; record: SourceLicenceRecord }
  | { authorized: false; reason: string };

/**
 * Flip a source to commercially authorized.
 *
 * Requires a stored permission document. There is deliberately no other path,
 * and no argument that sets the flag directly — the assessment's condition is
 * that written permission exists, so the function takes the document or refuses.
 */
export function authorizeCommercialUse(
  record: SourceLicenceRecord,
  permission: { documentId: string; scope: readonly IngestionPurpose[]; recordedByUserId: number },
): Authorization {
  if (!permission.documentId.trim()) {
    return { authorized: false, reason: "a stored permission document is required; there is no other way to authorize commercial use" };
  }
  if (!Number.isInteger(permission.recordedByUserId) || permission.recordedByUserId < 1) {
    return { authorized: false, reason: "a named person must record the permission" };
  }
  if (permission.scope.length === 0) {
    return { authorized: false, reason: "the permission must name which uses it covers" };
  }

  const covers = (p: IngestionPurpose) => permission.scope.includes(p);

  return {
    authorized: true,
    record: {
      ...record,
      permission_document_id: permission.documentId,
      status: "authorized_commercial",
      // Each flag is granted only where the permission actually says so. A
      // letter about the API is not a licence for the course.
      commercial_reuse_authorized: covers("commercial_redisplay"),
      api_production_authorized: covers("api_production"),
      rag_ingestion_authorized: covers("rag_ingestion"),
      model_training_authorized: covers("model_training"),
      linking_authorized: true,
      metadata_only_authorized: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bridge to the knowledge admission gate                              */
/* ------------------------------------------------------------------ */

/**
 * Translate a licence record into the four permissions the answer gate reads.
 *
 * One source of truth: the assessment decides, and `admission.ts` enforces.
 * Without this the two could drift, and the drift would be invisible until
 * something got quoted that should not have been.
 */
export function allowedUsesFrom(record: SourceLicenceRecord): AllowedUses {
  return {
    search: record.linking_authorized || record.metadata_only_authorized,
    // Answering from content is reproduction of content.
    aiAnswer: record.rag_ingestion_authorized && record.commercial_reuse_authorized,
    training: record.model_training_authorized,
    reproduce: record.rag_ingestion_authorized && record.commercial_reuse_authorized,
  };
}

/** Build the authority stub a retrieved passage carries. */
export function authorityFrom(
  record: SourceLicenceRecord,
  o: { authorityLevel: KnowledgeAuthority["authorityLevel"]; sourceTitle: string; contentHash: string; sourceUrl?: string },
): KnowledgeAuthority {
  return {
    id: `${record.source_id}:${o.contentHash.slice(0, 8)}`,
    jurisdiction: record.jurisdiction,
    authorityLevel: o.authorityLevel,
    issuingAuthority: record.owner,
    sourceTitle: o.sourceTitle,
    ...(o.sourceUrl ? { sourceUrl: o.sourceUrl } : {}),
    contentHash: o.contentHash,
    licenceStatus: record.commercial_reuse_authorized ? "licensed" : "permission_required",
    allowedUses: allowedUsesFrom(record),
    confidence: "imported",
  };
}
