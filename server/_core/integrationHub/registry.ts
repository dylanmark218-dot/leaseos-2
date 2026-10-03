/**
 * Integration Hub — the connector registry.
 *
 * A connector DEFINITION is what a kind of external system is: how it authenticates, which way
 * data flows, which event types it may send or receive, its limits, whether it is safety/business
 * critical, and — honestly — whether LeaseOS is authorized to use it in production at all. A
 * connector INSTANCE (integrationConnectors) is one organization's configured copy of a definition.
 *
 * Every definition below with `productionAuthorized: false` is an ADAPTER BOUNDARY: the contract
 * and the seam exist, the vendor call does not. Nothing here claims a connection that has not
 * been made.
 *
 * Retry scheduling and outbound transport are NOT declared per-connector: outbound webhook delivery
 * already has one house schedule (server/_core/integrationGateway.ts: 1/5/30/120/720 minutes,
 * SEC-004's claim/lease) and one egress guard (server/_core/egressGuard.ts); a connector does not
 * get to override either.
 */
import { z } from "zod";
import { INTEGRATION_AUTH_METHODS, INTEGRATION_PROVIDER_TYPES } from "../../../drizzle/schema";

export const AuthMethod = z.enum(INTEGRATION_AUTH_METHODS);
export type AuthMethod = z.infer<typeof AuthMethod>;
export const ProviderType = z.enum(INTEGRATION_PROVIDER_TYPES);
export type ProviderType = z.infer<typeof ProviderType>;

export const ConnectorDefinition = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  version: z.number().int().positive(),
  displayName: z.string().min(1),
  providerType: ProviderType,
  supportedApiVersions: z.array(z.string()).min(1),
  minimumLeaseOsRelease: z.string(),
  authMethods: z.array(AuthMethod).min(1),
  requestedScopes: z.array(z.string()),
  direction: z.enum(["inbound", "outbound", "bidirectional"]),
  inbound: z.object({ eventTypes: z.array(z.string()), contentTypes: z.array(z.string()), schemaVersions: z.array(z.string()) }).nullable(),
  outbound: z.object({ eventTypes: z.array(z.string()) }).nullable(),
  sync: z.object({ supported: z.boolean(), cursorStrategy: z.enum(["none", "opaque", "timestamp", "sequence", "page"]), defaultIntervalSeconds: z.number().int().positive().nullable(), bidirectional: z.boolean() }),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]),
  timeoutMs: z.number().int().positive(),
  maxPayloadBytes: z.number().int().positive(),
  retention: z.object({ classification: z.string(), minimumDays: z.number().int().nonnegative() }),
  residency: z.string().nullable(),
  healthCheck: z.enum(["none", "last_success_age", "probe_endpoint"]),
  safetyCritical: z.boolean(),
  businessCritical: z.boolean(),
  /** Operations a person must approve before the connector performs them. */
  humanApprovalRequired: z.array(z.string()),
  /** Which licence-registry source this reads, when it is a data source. */
  externalSourceKey: z.string().nullable(),
  /** TRUE only when a real, authorized production integration exists. Everything else is an adapter boundary. */
  productionAuthorized: z.boolean(),
  boundaryNote: z.string(),
}).strict();
export type ConnectorDefinition = z.infer<typeof ConnectorDefinition>;

const base = {
  version: 1, supportedApiVersions: ["1"], minimumLeaseOsRelease: "v23.31", requestedScopes: [] as string[],
  dataClassification: "internal" as const, timeoutMs: 10_000, maxPayloadBytes: 1_048_576,
  retention: { classification: "operational", minimumDays: 90 }, residency: null, healthCheck: "last_success_age" as const,
  safetyCritical: false, businessCritical: false, humanApprovalRequired: [] as string[], externalSourceKey: null, productionAuthorized: false,
};
const noSync = { supported: false, cursorStrategy: "none" as const, defaultIntervalSeconds: null, bidirectional: false };

/** The catalogue. Generic definitions are real and usable today; vendor definitions are boundaries. */
export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    ...base, key: "generic_signed_webhook_source", displayName: "Signed webhook source (generic)", providerType: "other", direction: "inbound",
    authMethods: ["hmac_shared_secret", "api_key"], inbound: { eventTypes: ["*"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: null, sync: noSync,
    productionAuthorized: true, boundaryNote: "Any system that can sign a JSON body with a shared secret, over the Hub's own inbound edge. Events become observations under a contract, never facts.",
  },
  {
    ...base, key: "generic_webhook_sink", displayName: "Outbound webhook destination (generic)", providerType: "customer_system", direction: "outbound",
    authMethods: ["hmac_shared_secret"], inbound: null, outbound: { eventTypes: ["*"] }, sync: noSync,
    productionAuthorized: true, boundaryNote: "A webhookSubscriptions row linked to this connector. Delivery, signing, retry and the egress guard are the house's existing webhookDispatchService.ts (SEC-004) — this connector only adds typed registration, health and dead letters on top.",
  },
  {
    ...base, key: "generic_polling_source", displayName: "Polling API source (generic)", providerType: "other", direction: "inbound",
    authMethods: ["api_key", "bearer_token", "none"], inbound: { eventTypes: ["*"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: null,
    sync: { supported: true, cursorStrategy: "opaque", defaultIntervalSeconds: 900, bidirectional: false },
    productionAuthorized: true, boundaryNote: "A paginated JSON endpoint fetched under a cursor through the egress guard. Each page is contract-validated; each record is idempotent by external id.",
  },
  {
    ...base, key: "alberta_511_road_conditions", displayName: "511 Alberta Developer API", providerType: "transportation_feed", direction: "inbound",
    authMethods: ["api_key"], inbound: { eventTypes: ["road.advisory.observed"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: null,
    sync: { supported: true, cursorStrategy: "timestamp", defaultIntervalSeconds: 3600, bidirectional: false },
    dataClassification: "public", externalSourceKey: "ab511", safetyCritical: true,
    boundaryNote: "Licensing unresolved (externalDataSources ab511 is unverified). The adapter refuses to fetch until the source is verified for operational use and a credential is on file. No data is retrieved.",
  },
  { ...base, key: "eld_provider", displayName: "ELD provider (adapter boundary)", providerType: "eld", direction: "inbound", authMethods: ["oauth2_client_credentials", "api_key"], inbound: { eventTypes: ["eld.duty_status.observed", "eld.log.certified"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: null, sync: { supported: true, cursorStrategy: "timestamp", defaultIntervalSeconds: 300, bidirectional: false }, dataClassification: "confidential", safetyCritical: true, boundaryNote: "No ELD vendor API is implemented. Duty-status observations would enter as duty records with source = the connector; HOS conclusions remain the rule engine's (P9)." },
  { ...base, key: "telematics_provider", displayName: "Telematics / GPS provider (adapter boundary)", providerType: "telematics", direction: "inbound", authMethods: ["oauth2_client_credentials", "api_key", "hmac_shared_secret"], inbound: { eventTypes: ["telematics.position.observed", "telematics.fault.observed", "telematics.safety_event.observed"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: null, sync: { supported: true, cursorStrategy: "sequence", defaultIntervalSeconds: 60, bidirectional: false }, dataClassification: "confidential", boundaryNote: "No telematics vendor is connected. The gateway's own feed shapes (inbound.ingest) remain the projection path into telemetrySnapshots/faultCodes/drivingEvents." },
  { ...base, key: "fuel_card_network", displayName: "Fuel-card network (adapter boundary)", providerType: "fuel_card", direction: "inbound", authMethods: ["api_key"], inbound: { eventTypes: ["fuel.transaction.observed"], contentTypes: ["application/json", "text/csv"], schemaVersions: ["1.0"] }, outbound: null, sync: { supported: true, cursorStrategy: "timestamp", defaultIntervalSeconds: 3600, bidirectional: false }, dataClassification: "confidential", businessCritical: true, boundaryNote: "No card network is connected. Transactions would enter the fuel ledger as needs_review proposals." },
  { ...base, key: "disposal_facility_system", displayName: "Disposal facility system (adapter boundary)", providerType: "disposal_facility", direction: "bidirectional", authMethods: ["hmac_shared_secret", "api_key"], inbound: { eventTypes: ["facility.ticket.received", "facility.ticket.rejected"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: { eventTypes: ["ticket.*", "manifest.*"] }, sync: noSync, dataClassification: "confidential", businessCritical: true, humanApprovalRequired: ["ticket.acceptance"], boundaryNote: "No facility system is connected. A facility's assertion about a ticket is a proposal until a person accepts it." },
  { ...base, key: "customer_system", displayName: "Customer system (adapter boundary)", providerType: "customer_system", direction: "bidirectional", authMethods: ["hmac_shared_secret", "oauth2_client_credentials", "api_key"], inbound: { eventTypes: ["customer.order.observed", "customer.po.observed"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: { eventTypes: ["job.*", "ticket.*", "invoice.*"] }, sync: noSync, dataClassification: "confidential", boundaryNote: "Outbound deliveries work through the generic sink today; inbound orders are an adapter boundary." },
  { ...base, key: "vendor_system", displayName: "Vendor system (adapter boundary)", providerType: "vendor_system", direction: "bidirectional", authMethods: ["hmac_shared_secret", "api_key"], inbound: { eventTypes: ["vendor.bill.observed"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: { eventTypes: ["purchase.*"] }, sync: noSync, dataClassification: "confidential", boundaryNote: "Vendor bills by machine are not built (portal only); this is the seam they would use." },
  { ...base, key: "accounting_system", displayName: "Accounting system (adapter boundary)", providerType: "accounting", direction: "bidirectional", authMethods: ["oauth2_client_credentials", "oauth2_refresh", "api_key"], inbound: { eventTypes: ["accounting.payment.observed"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: { eventTypes: ["invoice.finalized", "invoice.voided", "credit.*", "gl.export.*"] }, sync: { supported: true, cursorStrategy: "timestamp", defaultIntervalSeconds: 900, bidirectional: true }, dataClassification: "restricted", businessCritical: true, humanApprovalRequired: ["gl.export"], boundaryNote: "No accounting provider is connected. GL export readiness exists (P7.6); the export itself would be a human-approved outbound sync." },
  { ...base, key: "payroll_system", displayName: "Payroll system (adapter boundary)", providerType: "payroll", direction: "outbound", authMethods: ["oauth2_client_credentials", "api_key"], inbound: null, outbound: { eventTypes: ["payroll.run.*"] }, sync: noSync, dataClassification: "restricted", businessCritical: true, humanApprovalRequired: ["payroll.run.submit"], boundaryNote: "No payroll provider is connected; payroll rules are unverified (P9)." },
  { ...base, key: "email_sms_provider", displayName: "Email / SMS provider (adapter boundary)", providerType: "email_sms", direction: "bidirectional", authMethods: ["api_key", "bearer_token", "hmac_shared_secret"], inbound: { eventTypes: ["message.delivery_receipt", "message.bounce"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: { eventTypes: ["notification.*"] }, sync: noSync, dataClassification: "confidential", boundaryNote: "Email/SMS delivery is not built (customer alerts are queued in-app). The Communications & Notification Hub will consume this seam." },
  { ...base, key: "mapping_data_source", displayName: "Mapping / geospatial data source (adapter boundary)", providerType: "mapping", direction: "inbound", authMethods: ["none", "api_key"], inbound: { eventTypes: ["geo.dataset.observed"], contentTypes: ["application/json", "application/geo+json"], schemaVersions: ["1.0"] }, outbound: null, sync: { supported: true, cursorStrategy: "opaque", defaultIntervalSeconds: 86_400, bidirectional: false }, dataClassification: "public", boundaryNote: "Geo imports run through geoRouter and its own licence gate today; this seam would let them be scheduled." },
  { ...base, key: "document_storage_provider", displayName: "Document / storage provider (adapter boundary)", providerType: "document_storage", direction: "bidirectional", authMethods: ["oauth2_client_credentials", "api_key"], inbound: { eventTypes: ["document.uploaded"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: { eventTypes: ["document.*"] }, sync: noSync, dataClassification: "confidential", boundaryNote: "No storage provider is connected; records live in the vault." },
  { ...base, key: "government_regulatory_feed", displayName: "Government / regulatory data provider (adapter boundary)", providerType: "government_regulatory", direction: "inbound", authMethods: ["none", "api_key"], inbound: { eventTypes: ["regulatory.notice.observed"], contentTypes: ["application/json"], schemaVersions: ["1.0"] }, outbound: null, sync: { supported: true, cursorStrategy: "timestamp", defaultIntervalSeconds: 86_400, bidirectional: false }, dataClassification: "public", boundaryNote: "AER ST37/ST102 and similar are inspection-only pending written permission; the adapter asks the licence registry and refuses." },
].map(d => ConnectorDefinition.parse(d));

export function connectorDefinition(key: string): ConnectorDefinition | null {
  return CONNECTOR_DEFINITIONS.find(d => d.key === key) ?? null;
}

/** The instance configuration a definition accepts. Non-secret only; a secret in here is refused by name. */
export const ConnectorConfig = z.object({
  baseUrl: z.string().url().max(500).optional(),
  syncPath: z.string().max(300).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  /** Header the connector's inbound credential arrives in (api_key auth). */
  apiKeyHeader: z.string().max(60).optional(),
  labels: z.record(z.string(), z.string().max(200)).optional(),
}).strict();
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

const SECRET_LIKE = /(secret|password|token|apikey|api_key|private|credential)/i;

export function validateConnectorInstance(args: { definition: ConnectorDefinition; authMethod: AuthMethod; config: unknown; critical: boolean }): { ok: true; config: ConnectorConfig } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!args.definition.authMethods.includes(args.authMethod)) reasons.push(`${args.definition.key} does not support ${args.authMethod} authentication (supports ${args.definition.authMethods.join(", ")})`);
  const parsed = ConnectorConfig.safeParse(args.config ?? {});
  if (!parsed.success) reasons.push(...parsed.error.issues.map(i => `config.${i.path.join(".") || "(root)"}: ${i.message}`));
  else {
    for (const [k, v] of Object.entries(parsed.data.labels ?? {})) if (SECRET_LIKE.test(k) || SECRET_LIKE.test(v)) reasons.push(`config.labels.${k} looks like secret material — store it as a credential, not configuration`);
  }
  if (args.critical && !args.definition.safetyCritical && !args.definition.businessCritical) reasons.push(`${args.definition.key} is not declared safety- or business-critical; marking an instance critical needs a definition that says so`);
  return reasons.length ? { ok: false, reasons } : { ok: true, config: parsed.success ? parsed.data : {} };
}
