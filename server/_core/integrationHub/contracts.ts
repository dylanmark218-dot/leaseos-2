/**
 * Integration Hub — versioned, declarative data-sync contracts.
 *
 * A contract says what may cross the boundary and what it becomes: the source
 * and destination entities, the direction, the fields (with their type,
 * requiredness, normalization and validation), how deletions arrive, which
 * authority wins a disagreement, what makes two records the same, how the
 * cursor moves, how fresh the data must be, who may act on it, and who owns it.
 *
 * Mappings are DATA. There is no transformation code a tenant can supply; the
 * transforms are a closed set. A record the contract cannot accept is rejected
 * with every reason named — never trimmed to fit, never silently dropped.
 */
import { z } from "zod";
import { sha256, canonicalJson } from "./envelope";

export const Transform = z.enum(["identity", "trim", "upper", "lower", "number", "integer", "boolean", "iso_datetime", "epoch_seconds_to_iso", "cents_from_decimal", "enum_map", "string"]);
export type Transform = z.infer<typeof Transform>;

export const FieldRule = z.object({
  /** Dotted path in the source record. */
  source: z.string().min(1).max(160),
  /** The destination field name (flat). */
  target: z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  required: z.boolean(),
  transform: Transform.default("identity"),
  enumMap: z.record(z.string(), z.string()).optional(),
  validation: z.object({
    minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().positive().optional(),
    min: z.number().optional(), max: z.number().optional(), pattern: z.string().max(200).optional(),
    oneOf: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  }).strict().optional(),
}).strict();
export type FieldRule = z.infer<typeof FieldRule>;

export const ConflictPolicy = z.enum(["reject_review", "source_wins", "leaseos_wins", "newest_wins", "manual"]);
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;

export const DataSyncContract = z.object({
  contractKey: z.string().regex(/^[a-z0-9_.]+$/).max(80),
  version: z.number().int().positive(),
  direction: z.enum(["inbound", "outbound", "bidirectional"]),
  sourceEntity: z.string().min(1).max(80),
  destinationEntity: z.string().min(1).max(80),
  schemaVersion: z.string().min(1).max(20),
  fields: z.array(FieldRule).min(1),
  /** Where the sender's own key lives in the record, for idempotency. */
  externalIdPath: z.string().min(1).max(160),
  revisionPath: z.string().max(160).nullable(),
  tombstone: z.object({ path: z.string().max(160), behaviour: z.enum(["ignore", "mark_deleted", "reject"]) }).nullable(),
  conflictPolicy: ConflictPolicy,
  idempotencyStrategy: z.enum(["external_id", "payload_hash", "external_id_and_revision"]),
  cursorStrategy: z.enum(["none", "opaque", "timestamp", "sequence", "page"]),
  freshnessSeconds: z.number().int().positive().nullable(),
  retentionClass: z.string().max(40),
  authorizationRequirement: z.string().max(80),
  dataOwnership: z.enum(["external", "leaseos", "shared"]),
}).strict();
export type DataSyncContract = z.infer<typeof DataSyncContract>;

export function contractChecksum(c: DataSyncContract): string { return sha256(canonicalJson(c)); }

/**
 * Entity classes where an ambiguous authority must NOT be resolved by the machine. A contract that
 * names one of these as its destination and asks for anything but review or manual is refused.
 */
export const FAIL_CLOSED_ENTITIES = ["safety", "compliance", "hos", "billing", "invoice", "ticket", "dispatch", "identity", "payroll", "enforcement"] as const;
export function contractPolicyRefusal(c: DataSyncContract): string | null {
  const sensitive = FAIL_CLOSED_ENTITIES.some(k => c.destinationEntity.toLowerCase().includes(k));
  if (sensitive && c.dataOwnership !== "leaseos" && !["reject_review", "manual"].includes(c.conflictPolicy)) {
    return `${c.destinationEntity} is safety/business/compliance data with ${c.dataOwnership} ownership; its conflict policy must be reject_review or manual, not ${c.conflictPolicy}`;
  }
  return null;
}

export function getPath(record: unknown, path: string): unknown {
  let cur: unknown = record;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

type ApplyOk = { ok: true; mapped: Record<string, unknown>; externalId: string; revision: string | null; tombstone: boolean };
type ApplyRejected = { ok: false; reasons: string[]; externalId: string | null };
export type ContractApplication = ApplyOk | ApplyRejected;

function transform(value: unknown, rule: FieldRule): { value: unknown } | { error: string } {
  const t = rule.transform;
  switch (t) {
    case "identity": return { value };
    case "string": return { value: value == null ? value : String(value) };
    case "trim": return typeof value === "string" ? { value: value.trim() } : { error: "expected a string" };
    case "upper": return typeof value === "string" ? { value: value.toUpperCase() } : { error: "expected a string" };
    case "lower": return typeof value === "string" ? { value: value.toLowerCase() } : { error: "expected a string" };
    case "number": { const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN; return Number.isFinite(n) ? { value: n } : { error: "expected a finite number" }; }
    case "integer": { const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN; return Number.isInteger(n) ? { value: n } : { error: "expected an integer" }; }
    case "boolean": { if (typeof value === "boolean") return { value }; if (value === "true" || value === 1 || value === "1") return { value: true }; if (value === "false" || value === 0 || value === "0") return { value: false }; return { error: "expected a boolean" }; }
    case "iso_datetime": { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return { error: "expected an ISO 8601 date-time" }; return { value: new Date(value).toISOString() }; }
    case "epoch_seconds_to_iso": { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) && n > 0 ? { value: new Date(n * 1000).toISOString() } : { error: "expected epoch seconds" }; }
    case "cents_from_decimal": { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) ? { value: Math.round(n * 100) } : { error: "expected a decimal amount" }; }
    case "enum_map": { const key = String(value); if (!rule.enumMap || !(key in rule.enumMap)) return { error: `value "${key}" is not in the contract's enum map` }; return { value: rule.enumMap[key] }; }
  }
}

function validate(value: unknown, rule: FieldRule): string | null {
  const v = rule.validation; if (!v) return null;
  if (typeof value === "string") {
    if (v.minLength != null && value.length < v.minLength) return `shorter than ${v.minLength}`;
    if (v.maxLength != null && value.length > v.maxLength) return `longer than ${v.maxLength}`;
    if (v.pattern && !new RegExp(v.pattern).test(value)) return `does not match ${v.pattern}`;
  }
  if (typeof value === "number") {
    if (v.min != null && value < v.min) return `below ${v.min}`;
    if (v.max != null && value > v.max) return `above ${v.max}`;
  }
  if (v.oneOf && !v.oneOf.some(o => o === value)) return `not one of ${v.oneOf.join(", ")}`;
  return null;
}

/** Apply a contract to one source record. Every reason is collected; nothing is coerced past a failure. */
export function applyContract(contract: DataSyncContract, record: unknown, opts: { schemaVersion?: string | null } = {}): ContractApplication {
  const reasons: string[] = [];
  const extRaw = getPath(record, contract.externalIdPath);
  const externalId = extRaw == null || extRaw === "" ? null : String(extRaw);
  if (opts.schemaVersion && opts.schemaVersion !== contract.schemaVersion) reasons.push(`schema version ${opts.schemaVersion} is not the contract's ${contract.schemaVersion}`);
  if (record == null || typeof record !== "object" || Array.isArray(record)) return { ok: false, reasons: [...reasons, "record must be a JSON object"], externalId };
  if (externalId == null) reasons.push(`${contract.externalIdPath} is required for idempotency`);
  let tombstone = false;
  if (contract.tombstone) {
    const t = getPath(record, contract.tombstone.path);
    if (t === true || t === "deleted" || t === "true") {
      tombstone = true;
      if (contract.tombstone.behaviour === "reject") reasons.push(`deletions are not accepted by contract ${contract.contractKey} v${contract.version}`);
    }
  }
  const mapped: Record<string, unknown> = {};
  for (const rule of contract.fields) {
    const raw = getPath(record, rule.source);
    if (raw === undefined || raw === null || raw === "") {
      if (rule.required && !(tombstone && contract.tombstone?.behaviour === "mark_deleted")) reasons.push(`${rule.source} is required`);
      continue;
    }
    const tr = transform(raw, rule);
    if ("error" in tr) { reasons.push(`${rule.source}: ${tr.error}`); continue; }
    const bad = validate(tr.value, rule);
    if (bad) { reasons.push(`${rule.source}: ${bad}`); continue; }
    mapped[rule.target] = tr.value;
  }
  if (reasons.length) return { ok: false, reasons, externalId };
  const revRaw = contract.revisionPath ? getPath(record, contract.revisionPath) : null;
  return { ok: true, mapped, externalId: externalId!, revision: revRaw == null ? null : String(revRaw), tombstone };
}

/** The idempotency key the contract says identifies this record. */
export function idempotencyKeyFor(contract: DataSyncContract, app: ApplyOk, rawRecord: unknown): string {
  switch (contract.idempotencyStrategy) {
    case "external_id": return app.externalId;
    case "external_id_and_revision": return `${app.externalId}@${app.revision ?? "0"}`;
    case "payload_hash": return sha256(canonicalJson(rawRecord)).slice(0, 64);
  }
}

/** A JSON Schema rendering of a contract, for a counterparty that wants one. Derived, never authored. */
export function contractToJsonSchema(c: DataSyncContract): Record<string, unknown> {
  const typeFor = (t: Transform): string => ({ number: "number", cents_from_decimal: "integer", integer: "integer", boolean: "boolean" } as Record<string, string>)[t] ?? "string";
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema", $id: `leaseos:contract:${c.contractKey}:v${c.version}`, title: `${c.sourceEntity} → ${c.destinationEntity}`,
    type: "object", required: c.fields.filter(f => f.required).map(f => f.target),
    properties: Object.fromEntries(c.fields.map(f => [f.target, { type: typeFor(f.transform), ...(f.validation?.oneOf ? { enum: f.validation.oneOf } : {}), ...(f.validation?.pattern ? { pattern: f.validation.pattern } : {}) }])),
    "x-leaseos": { direction: c.direction, schemaVersion: c.schemaVersion, conflictPolicy: c.conflictPolicy, idempotencyStrategy: c.idempotencyStrategy, cursorStrategy: c.cursorStrategy, dataOwnership: c.dataOwnership, checksum: contractChecksum(c) },
  };
}

/** The shared contracts every organization may use. System-owned; a tenant's own contracts are versioned beside them. */
export const SHARED_CONTRACTS: readonly DataSyncContract[] = [
  {
    contractKey: "generic.observation", version: 1, direction: "inbound", sourceEntity: "external_event", destinationEntity: "integration_observation", schemaVersion: "1.0",
    fields: [
      { source: "id", target: "externalId", required: true, transform: "string", validation: { maxLength: 120 } },
      { source: "type", target: "kind", required: true, transform: "trim", validation: { maxLength: 80 } },
      { source: "occurredAt", target: "occurredAt", required: false, transform: "iso_datetime" },
      { source: "subject", target: "subject", required: false, transform: "string", validation: { maxLength: 200 } },
      { source: "data", target: "data", required: false, transform: "identity" },
    ],
    externalIdPath: "id", revisionPath: "revision", tombstone: { path: "deleted", behaviour: "reject" },
    conflictPolicy: "reject_review", idempotencyStrategy: "external_id", cursorStrategy: "opaque", freshnessSeconds: null,
    retentionClass: "operational", authorizationRequirement: "integration.read", dataOwnership: "external",
  },
  {
    contractKey: "alberta511.road_advisory", version: 1, direction: "inbound", sourceEntity: "ab511_event", destinationEntity: "road_advisory_observation", schemaVersion: "1.0",
    fields: [
      { source: "ID", target: "externalId", required: true, transform: "string" },
      { source: "EventType", target: "eventType", required: true, transform: "trim" },
      { source: "Description", target: "description", required: false, transform: "trim", validation: { maxLength: 2000 } },
      { source: "Latitude", target: "latitude", required: true, transform: "number", validation: { min: -90, max: 90 } },
      { source: "Longitude", target: "longitude", required: true, transform: "number", validation: { min: -180, max: 180 } },
      { source: "StartDate", target: "startsAt", required: false, transform: "epoch_seconds_to_iso" },
      { source: "LastUpdated", target: "updatedAt", required: true, transform: "epoch_seconds_to_iso" },
    ],
    externalIdPath: "ID", revisionPath: "LastUpdated", tombstone: null,
    conflictPolicy: "source_wins", idempotencyStrategy: "external_id_and_revision", cursorStrategy: "timestamp", freshnessSeconds: 3600,
    retentionClass: "advisory", authorizationRequirement: "integration.read", dataOwnership: "external",
  },
].map(c => DataSyncContract.parse(c));

export function sharedContract(key: string, version?: number): DataSyncContract | null {
  const all = SHARED_CONTRACTS.filter(c => c.contractKey === key);
  if (!all.length) return null;
  return version ? all.find(c => c.version === version) ?? null : all.sort((a, b) => b.version - a.version)[0]!;
}
