/**
 * External data ingestion + provenance.
 *
 * This is the governance layer between "we have a file of road restrictions"
 * and "the routing engine may rely on it". Its whole purpose is to make it
 * impossible to quietly acquire authority a dataset has not earned.
 *
 * Three rules it enforces mechanically:
 *
 *   1. A batch missing provenance is REJECTED, not imported with blanks.
 *      There is no path that produces a stored record with no source.
 *   2. Coverage is MEASURED, never claimed. `assessCoverage` reports what was
 *      actually observed against the expected extent, and says "unknown" when
 *      the expected extent isn't known.
 *   3. Confidence is PROMOTED by evidence, never defaulted. An import cannot
 *      set itself to authority_confirmed; a named person confirms it against
 *      a cited authority, and that act is recorded.
 *
 * Superseded batches are retained, because a routing decision made last March
 * must stay reproducible against the data that existed last March.
 */

export type ResourceType =
  | "road_restriction"
  | "bridge"
  | "municipal_truck_route"
  | "dangerous_goods_route"
  | "seasonal_ban"
  | "construction_closure"
  | "school_zone"
  | "residential_restriction"
  | "regulatory_threshold"
  | "hos_rule"
  | "permit_rule"
  | "fuel_site"
  | "water_fill"
  | "disposal_facility"
  | "scale"
  | "washout"
  | "parking"
  | "repair"
  | "radio_resource"
  | "lease_access"
  | "emergency_resource";

export type ValidationStatus = "rejected" | "provisional" | "validated";
export type SourceConfidence =
  | "unverified"
  | "operator_supplied"
  | "authority_confirmed";

export type ImportBatch = {
  batchId: string;
  resourceType: ResourceType;
  jurisdiction: string;
  /** Publishing authority or vendor. Free text, but required. */
  source: string;
  sourceReference?: string | null;
  /** Licence / usage terms. Required — an unlicensed import is a legal risk. */
  licenceNotes?: string | null;
  datasetVersion: string;
  effectiveDate?: Date | null;
  importedAt: Date;
  recordCount: number;
  checksum: string;
  confidence: SourceConfidence;
};

export type BatchProblem = {
  field: string;
  message: string;
  severity: "reject" | "warn";
};

/**
 * Provenance fields required before a batch may be stored at all. Missing any
 * of these rejects the batch — the alternative is a road restriction in the
 * database that nobody can attribute.
 */
const REQUIRED: Array<{ key: keyof ImportBatch; label: string }> = [
  { key: "resourceType", label: "Resource type" },
  { key: "jurisdiction", label: "Jurisdiction" },
  { key: "source", label: "Source authority" },
  { key: "datasetVersion", label: "Dataset version" },
  { key: "importedAt", label: "Import timestamp" },
  { key: "checksum", label: "Checksum" },
];

export function validateImportBatch(batch: Partial<ImportBatch>): {
  status: ValidationStatus;
  problems: BatchProblem[];
} {
  const problems: BatchProblem[] = [];

  for (const { key, label } of REQUIRED) {
    const v = batch[key];
    if (v === null || v === undefined || v === "") {
      problems.push({
        field: String(key),
        message: `${label} is required`,
        severity: "reject",
      });
    }
  }

  if (batch.recordCount === undefined || batch.recordCount === null) {
    problems.push({
      field: "recordCount",
      message: "Record count is required",
      severity: "reject",
    });
  } else if (batch.recordCount <= 0) {
    problems.push({
      field: "recordCount",
      message: "Batch contains no records",
      severity: "reject",
    });
  }

  if (!batch.licenceNotes) {
    problems.push({
      field: "licenceNotes",
      message:
        "No licence or usage terms recorded — confirm redistribution rights before relying on this data",
      severity: "warn",
    });
  }
  if (!batch.effectiveDate) {
    problems.push({
      field: "effectiveDate",
      message: "No effective date — the age of these rules cannot be assessed",
      severity: "warn",
    });
  }
  if (!batch.sourceReference) {
    problems.push({
      field: "sourceReference",
      message:
        "No URL or document reference — the import cannot be traced back",
      severity: "warn",
    });
  }

  // An import never awards itself authority. That requires a human act.
  if (batch.confidence === "authority_confirmed") {
    problems.push({
      field: "confidence",
      message:
        "An import cannot self-declare authority_confirmed — use confirmDataset() with a named confirmer",
      severity: "reject",
    });
  }

  const rejected = problems.some(p => p.severity === "reject");
  return { status: rejected ? "rejected" : "provisional", problems };
}

/** FNV-1a over the canonical record payload. Deterministic, dependency-free. */
export function computeChecksum(records: unknown[]): string {
  const canonical = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (typeof v === "object") {
      return `{${Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => `${k}:${canonical(x)}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  };
  let h = 0x811c9dc5;
  const s = canonical(records);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, "0")}:${records.length}`;
}

/* ========================= measured coverage ========================= */

export type CoverageReport = {
  observed: number;
  expected: number | null;
  percent: number | null;
  state: "unknown" | "partial" | "complete";
  message: string;
};

/**
 * Rule 2: never claim complete coverage until measured. If the expected
 * extent isn't known, the answer is "unknown" — not an optimistic 100%.
 */
export function assessCoverage(
  observed: number,
  expected: number | null | undefined,
  label: string
): CoverageReport {
  if (expected === null || expected === undefined || expected <= 0) {
    return {
      observed,
      expected: null,
      percent: null,
      state: "unknown",
      message: `${observed} ${label} imported. Total extent unknown — coverage cannot be measured, so it is not claimed.`,
    };
  }
  const percent = Math.round((observed / expected) * 1000) / 10;
  const state = observed >= expected ? "complete" : "partial";
  return {
    observed,
    expected,
    percent,
    state,
    message:
      state === "complete"
        ? `${observed} of ${expected} ${label} — coverage complete as measured against the published extent.`
        : `${observed} of ${expected} ${label} (${percent}%). Gaps remain; unmapped segments evaluate as unknown.`,
  };
}

/* ==================== confidence promotion ==================== */

export type DatasetConfirmation = {
  batchId: string;
  confirmedByUserId: number;
  confirmedByName: string;
  /** The authority the confirmer checked against, e.g. a permit office. */
  authority: string;
  authorityReference?: string | null;
  confirmedAt: Date;
  notes?: string | null;
};

export type PromotionResult =
  | { ok: true; confidence: SourceConfidence; record: DatasetConfirmation }
  | { ok: false; reason: string };

/**
 * Rule 3: the only route from `unverified` to `authority_confirmed`. Requires
 * a named person and a named authority, and records both — so "who said this
 * bridge limit was right?" always has an answer.
 */
export function confirmDataset(
  batch: ImportBatch,
  confirmation: Omit<DatasetConfirmation, "batchId">
): PromotionResult {
  if (!confirmation.confirmedByName?.trim()) {
    return { ok: false, reason: "A named confirmer is required" };
  }
  if (!confirmation.authority?.trim()) {
    return { ok: false, reason: "The authority checked against must be named" };
  }
  if (confirmation.confirmedAt < batch.importedAt) {
    return {
      ok: false,
      reason: "Confirmation cannot predate the import it confirms",
    };
  }
  return {
    ok: true,
    confidence: "authority_confirmed",
    record: { ...confirmation, batchId: batch.batchId },
  };
}

/**
 * Operator-supplied is a real, useful middle state: a dispatcher entering a
 * limit they know is better than nothing, and worse than an authority.
 */
export function markOperatorSupplied(batch: ImportBatch): ImportBatch {
  return { ...batch, confidence: "operator_supplied" };
}

/* ========================== supersession ========================== */

export type SupersessionPlan = {
  supersedeBatchIds: string[];
  retainForReproducibility: true;
  message: string;
};

/**
 * A newer batch for the same resource + jurisdiction supersedes older ones —
 * but they are retained, never deleted. A routing decision made in March must
 * stay reproducible against March's data.
 */
export function planSupersession(
  incoming: ImportBatch,
  existing: ImportBatch[]
): SupersessionPlan {
  const targets = existing.filter(
    b =>
      b.resourceType === incoming.resourceType &&
      b.jurisdiction === incoming.jurisdiction &&
      b.batchId !== incoming.batchId &&
      b.importedAt <= incoming.importedAt
  );
  return {
    supersedeBatchIds: targets.map(b => b.batchId),
    retainForReproducibility: true,
    message: targets.length
      ? `${targets.length} earlier ${incoming.resourceType} batch(es) for ${incoming.jurisdiction} marked superseded and retained for reproducibility.`
      : `First ${incoming.resourceType} batch for ${incoming.jurisdiction}.`,
  };
}

/* ===================== dispatch trust gate ===================== */

export type DispatchTrust = {
  trustworthy: boolean;
  blockers: string[];
  message: string;
};

/**
 * Whether routing output for a jurisdiction may be treated as dispatch-grade.
 * Separates the engine question (does the code work?) from the data question
 * (may we rely on what it computed?) — they are not the same, and conflating
 * them is how an unverified placeholder ends up authorising a movement.
 */
export function assessDispatchTrust(
  jurisdiction: string,
  batches: ImportBatch[],
  requiredTypes: ResourceType[] = [
    "regulatory_threshold",
    "road_restriction",
    "bridge",
  ]
): DispatchTrust {
  const blockers: string[] = [];
  const forJurisdiction = batches.filter(b => b.jurisdiction === jurisdiction);

  for (const type of requiredTypes) {
    const matching = forJurisdiction.filter(b => b.resourceType === type);
    if (matching.length === 0) {
      blockers.push(
        `No ${type.replace(/_/g, " ")} data loaded for ${jurisdiction}`
      );
      continue;
    }
    if (!matching.some(b => b.confidence === "authority_confirmed")) {
      blockers.push(
        `${type.replace(/_/g, " ")} data for ${jurisdiction} is not authority-confirmed`
      );
    }
  }

  return {
    trustworthy: blockers.length === 0,
    blockers,
    message:
      blockers.length === 0
        ? `Routing data for ${jurisdiction} is authority-confirmed and may be used for dispatch decisions.`
        : `Routing for ${jurisdiction} is NOT dispatch-grade. The engine works; the data does not yet support a clear decision.`,
  };
}
