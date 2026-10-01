import { sql } from "drizzle-orm";
import { bigint, boolean, date, decimal, double, index, int, json, mysqlEnum, mysqlTable, text, timestamp, tinyint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const jobs = mysqlTable("jobs", {
  id: int("id").autoincrement().primaryKey(),
  /** 0132 — the organization that owns the row; NULL means the historical single tenant. */
  orgRef: varchar("orgRef", { length: 64 }),
  /** 0134 — the client organization a person linked; `customer` stays as the captured text. */
  customerOrgRef: varchar("customerOrgRef", { length: 64 }),
  jobCode: varchar("jobCode", { length: 32 }).notNull().unique(),
  type: varchar("type", { length: 120 }).notNull(),
  mode: mysqlEnum("mode", ["general", "hydrovac", "recovery", "transport"])
    .default("general")
    .notNull(),
  customer: varchar("customer", { length: 160 }).notNull(),
  location: varchar("location", { length: 220 }).notNull(),
  vehicle: varchar("vehicle", { length: 120 }),
  driver: varchar("driver", { length: 120 }),
  status: mysqlEnum("status", [
    "dispatched",
    "in_transit",
    "loading",
    "on_site",
    "awaiting_docs",
    "complete",
  ])
    .default("dispatched")
    .notNull(),
  progress: int("progress").default(0).notNull(),
  eta: varchar("eta", { length: 32 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const evidenceRecords = mysqlTable("evidenceRecords", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  title: varchar("title", { length: 220 }).notNull(),
  category: varchar("category", { length: 80 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: varchar("storageUrl", { length: 1024 }),
  mimeType: varchar("mimeType", { length: 120 }),
  capturedAt: timestamp("capturedAt").notNull(),
  capturedBy: int("capturedBy"),
  latitude: double("latitude"),
  longitude: double("longitude"),
  status: mysqlEnum("status", ["needs_review", "verified", "unverified"])
    .default("needs_review")
    .notNull(),
  notes: text("notes"),
  // B20 — sealing identity. Added to the existing table rather than a parallel
  // one: an evidence object has one identity, not two.
  trackingNumber: varchar("trackingNumber", { length: 64 }).unique(),
  // v21.6 — the device's own reference; makes an offline upload idempotent.
  clientCaptureRef: varchar("clientCaptureRef", { length: 80 }).unique(),
  recordType: varchar("recordType", { length: 60 }).default("other").notNull(),
  sealState: mysqlEnum("sealState", ["draft", "sealed", "amended", "superseded"])
    .default("draft")
    .notNull(),
  currentVersion: int("currentVersion").default(1).notNull(),
  legalHold: boolean("legalHold").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const routeContexts = mysqlTable("routeContexts", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  source: varchar("source", { length: 220 }).notNull(),
  effectiveAt: timestamp("effectiveAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  verifiedAt: timestamp("verifiedAt"),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("medium")
    .notNull(),
  restrictions: text("restrictions"),
  snapshotKey: varchar("snapshotKey", { length: 512 }),
  snapshotUrl: varchar("snapshotUrl", { length: 1024 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const safetyEvents = mysqlTable("safetyEvents", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  eventType: varchar("eventType", { length: 80 }).notNull(),
  severity: mysqlEnum("severity", ["info", "warning", "critical"])
    .default("info")
    .notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  detail: text("detail"),
  occurredAt: timestamp("occurredAt").notNull(),
  status: mysqlEnum("status", ["open", "acknowledged", "resolved"])
    .default("open")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const checklistItems = mysqlTable("checklistItems", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  title: varchar("title", { length: 220 }).notNull(),
  completed: boolean("completed").default(false).notNull(),
  completedAt: timestamp("completedAt"),
  completedBy: int("completedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const operators = mysqlTable("operators", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId"),
  name: varchar("name", { length: 180 }).notNull(),
  company: varchar("company", { length: 180 }),
  licenseNumber: varchar("licenseNumber", { length: 100 }),
  licenseClass: varchar("licenseClass", { length: 40 }),
  licenseExpiresAt: timestamp("licenseExpiresAt"),
  restrictions: text("restrictions"),
  trainingStatus: varchar("trainingStatus", { length: 120 }),
  certifications: text("certifications"),
  insurance: text("insurance"),
  emergencyContact: varchar("emergencyContact", { length: 220 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const units = mysqlTable("units", {
  id: int("id").autoincrement().primaryKey(),
  unitNumber: varchar("unitNumber", { length: 40 }).notNull().unique(),
  vin: varchar("vin", { length: 80 }),
  plate: varchar("plate", { length: 40 }),
  vehicleType: varchar("vehicleType", { length: 120 }).notNull(),
  company: varchar("company", { length: 180 }),
  weightKg: int("weightKg"),
  axles: int("axles"),
  dimensions: varchar("dimensions", { length: 160 }),
  equipment: text("equipment"),
  inspectionStatus: mysqlEnum("inspectionStatus", ["current", "due", "blocked"])
    .default("current")
    .notNull(),
  maintenanceStatus: mysqlEnum("maintenanceStatus", [
    "clear",
    "review",
    "blocked",
  ])
    .default("clear")
    .notNull(),
  qrTag: varchar("qrTag", { length: 120 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const jobUnits = mysqlTable("jobUnits", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  unitId: int("unitId").notNull(),
  operatorId: int("operatorId"),
  // v21.2 — the readiness check the assignment relied on, and the enforcement mode in force when it was made.
  eligibilityCheckId: int("eligibilityCheckId"),
  enforcementModeAtCreate: mysqlEnum("enforcementModeAtCreate", ["off", "advisory", "enforced"]),
  role: varchar("role", { length: 100 }).notNull(),
  joinedAt: timestamp("joinedAt").notNull(),
  departedAt: timestamp("departedAt"),
  hours: int("hours"),
  mileage: int("mileage"),
  workPerformed: text("workPerformed"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const complianceDocuments = mysqlTable("complianceDocuments", {
  id: int("id").autoincrement().primaryKey(),
  ownerType: mysqlEnum("ownerType", ["operator", "unit", "job", "trailer", "carrier", "user", "equipment"]).notNull(),
  ownerId: int("ownerId").notNull(),
  docType: varchar("docType", { length: 100 }).notNull(),
  requirementKey: varchar("requirementKey", { length: 120 }),
  title: varchar("title", { length: 220 }).notNull(),
  identifier: varchar("identifier", { length: 120 }),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: varchar("storageUrl", { length: 1024 }),
  capturedAt: timestamp("capturedAt").notNull(),
  issuedAt: timestamp("issuedAt"),
  expiresAt: timestamp("expiresAt"),
  jurisdiction: varchar("jurisdiction", { length: 80 }),
  verificationStatus: mysqlEnum("verificationStatus", [
    "needs_review",
    "verified",
    "rejected",
  ])
    .default("needs_review")
    .notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  privateDetail: boolean("privateDetail").default(false).notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  source: varchar("source", { length: 220 }),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("medium")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const loadProfiles = mysqlTable("loadProfiles", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  material: varchar("material", { length: 220 }).notNull(),
  isWaste: boolean("isWaste").default(false).notNull(),
  composition: text("composition"),
  sdsStorageKey: varchar("sdsStorageKey", { length: 512 }),
  sdsStorageUrl: varchar("sdsStorageUrl", { length: 1024 }),
  unNumber: varchar("unNumber", { length: 40 }),
  properShippingName: varchar("properShippingName", { length: 220 }),
  dgClass: varchar("dgClass", { length: 40 }),
  packingGroup: varchar("packingGroup", { length: 40 }),
  quantity: varchar("quantity", { length: 80 }),
  transportMode: varchar("transportMode", { length: 80 }),
  jurisdiction: varchar("jurisdiction", { length: 120 }),
  classificationStatus: mysqlEnum("classificationStatus", [
    "needs_verification",
    "verified",
    "blocked",
  ])
    .default("needs_verification")
    .notNull(),
  source: varchar("source", { length: 220 }),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("low")
    .notNull(),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const facilities = mysqlTable("facilities", {
  id: int("id").autoincrement().primaryKey(),
  /** 0134 — the organization a person linked this facility to; NULL until someone does. */
  orgRef: varchar("orgRef", { length: 64 }),
  // 0139 — facility directory (re-based from feature/facility-map-v7). Coordinates always carry precision and provenance.
  facilityKey: varchar("facilityKey", { length: 100 }),
  province: varchar("province", { length: 2 }),
  facilityType: varchar("facilityType", { length: 100 }),
  municipality: varchar("municipality", { length: 120 }),
  legalLocation: varchar("legalLocation", { length: 80 }),
  coordinatePrecision: mysqlEnum("coordinatePrecision", ["verified_entrance", "verified_site", "approximate_site", "community_only", "unknown"]).default("unknown").notNull(),
  coordinateSourceUrl: varchar("coordinateSourceUrl", { length: 1024 }),
  coordinateVerifiedAt: timestamp("coordinateVerifiedAt"),
  coordinateVerifiedByUserId: int("coordinateVerifiedByUserId"),
  disposition: mysqlEnum("disposition", ["verified_facility", "approximate_facility", "service_location", "ambiguous"]).default("ambiguous").notNull(),
  regulatorRef: varchar("regulatorRef", { length: 80 }),
  regulatorRefSourceUrl: varchar("regulatorRefSourceUrl", { length: 1024 }),
  operatorNameFromSource: varchar("operatorNameFromSource", { length: 220 }),
  websiteUrl: varchar("websiteUrl", { length: 1024 }),
  accountRegistrationUrl: varchar("accountRegistrationUrl", { length: 1024 }),
  // 0141 — contacts, access and requirements from the operator briefs.
  parentCompany: varchar("parentCompany", { length: 220 }),
  physicalAddress: varchar("physicalAddress", { length: 300 }),
  dispatchPhone: varchar("dispatchPhone", { length: 60 }),
  afterHoursPhone: varchar("afterHoursPhone", { length: 60 }),
  salesContact: varchar("salesContact", { length: 220 }),
  email: varchar("email", { length: 200 }),
  commercialAccess: mysqlEnum("commercialAccess", ["commercial_public", "commercial_preapproval_required", "operator_private", "transfer_only", "unknown"]).default("unknown").notNull(),
  lifecycle: mysqlEnum("lifecycle", ["operating", "suspended", "closed", "conflicting", "unknown"]).default("unknown").notNull(),
  preapprovalRequired: boolean("preapprovalRequired"),
  manifestRequired: boolean("manifestRequired"),
  tdgRequired: boolean("tdgRequired"),
  twentyFourHourCallout: boolean("twentyFourHourCallout"),
  normAccepted: boolean("normAccepted"),
  sourAccepted: boolean("sourAccepted"),
  wasteApprovalFormUrl: varchar("wasteApprovalFormUrl", { length: 1024 }),
  facilityTypes: json("facilityTypes").$type<string[]>(),
  statusVerifiedAt: timestamp("statusVerifiedAt"),
  sourceAuthority: varchar("sourceAuthority", { length: 400 }),
  name: varchar("name", { length: 220 }).notNull(),
  status: mysqlEnum("status", ["unknown", "open", "closed"])
    .default("unknown")
    .notNull(),
  operatingHours: varchar("operatingHours", { length: 120 }),
  acceptedMaterials: text("acceptedMaterials"),
  restrictions: text("restrictions"),
  phone: varchar("phone", { length: 60 }),
  emergencyPhone: varchar("emergencyPhone", { length: 60 }),
  gateInstructions: text("gateInstructions"),
  requiredDocuments: text("requiredDocuments"),
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  latitude: double("latitude"),
  longitude: double("longitude"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const inspections = mysqlTable("inspections", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull(),
  type: mysqlEnum("type", ["training", "pre_trip", "post_trip"]).notNull(),
  status: mysqlEnum("status", [
    "pass",
    "fail",
    "needs_maintenance",
    "not_applicable",
  ])
    .default("pass")
    .notNull(),
  checklist: text("checklist"),
  resultSummary: text("resultSummary"),
  observedAt: timestamp("observedAt").notNull(),
  authenticatedOperatorId: int("authenticatedOperatorId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const maintenanceDefects = mysqlTable("maintenanceDefects", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  severity: mysqlEnum("severity", [
    "advisory",
    "inspection_required",
    "critical",
  ])
    .default("advisory")
    .notNull(),
  status: mysqlEnum("status", ["open", "in_progress", "resolved"])
    .default("open")
    .notNull(),
  detail: text("detail"),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: varchar("storageUrl", { length: 1024 }),
  reportedAt: timestamp("reportedAt").notNull(),
  reportedBy: int("reportedBy"),
  workOrderNumber: varchar("workOrderNumber", { length: 80 }),
  completedAt: timestamp("completedAt"),
  /* 0169 — the resolution act, recorded on the row it changes. */
  resolvedAt: timestamp("resolvedAt"),
  resolvedByUserId: int("resolvedByUserId"),
  /**
   * The release that evidenced this resolution, when one was required. Readiness reads it so that
   * revoking that release is visible as the loss of evidence it is, rather than leaving a defect
   * resolved on a release that no longer stands.
   */
  resolvedByReleaseId: int("resolvedByReleaseId"),
  resolutionNote: varchar("resolutionNote", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const deliveries = mysqlTable("deliveries", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  recipientRole: varchar("recipientRole", { length: 80 }).notNull(),
  recipient: varchar("recipient", { length: 220 }).notNull(),
  status: mysqlEnum("status", ["queued", "delivered", "failed"])
    .default("queued")
    .notNull(),
  deliveredAt: timestamp("deliveredAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const signatureAudits = mysqlTable("signatureAudits", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  signerName: varchar("signerName", { length: 180 }).notNull(),
  authMethod: varchar("authMethod", { length: 120 }).notNull(),
  signedAt: timestamp("signedAt").notNull(),
  documentHash: varchar("documentHash", { length: 180 }),
  status: mysqlEnum("status", ["pending", "authenticated", "invalidated"])
    .default("pending")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;
export type EvidenceRecord = typeof evidenceRecords.$inferSelect;
export type InsertEvidenceRecord = typeof evidenceRecords.$inferInsert;
export type SafetyEvent = typeof safetyEvents.$inferSelect;
export type InsertSafetyEvent = typeof safetyEvents.$inferInsert;
export type RouteContext = typeof routeContexts.$inferSelect;
export type InsertRouteContext = typeof routeContexts.$inferInsert;
export type ChecklistItem = typeof checklistItems.$inferSelect;
export type InsertChecklistItem = typeof checklistItems.$inferInsert;

export type Operator = typeof operators.$inferSelect;
export type InsertOperator = typeof operators.$inferInsert;
export type Unit = typeof units.$inferSelect;
export type InsertUnit = typeof units.$inferInsert;
export type JobUnit = typeof jobUnits.$inferSelect;
export type InsertJobUnit = typeof jobUnits.$inferInsert;
export type ComplianceDocument = typeof complianceDocuments.$inferSelect;
export type InsertComplianceDocument = typeof complianceDocuments.$inferInsert;
export type LoadProfile = typeof loadProfiles.$inferSelect;
export type InsertLoadProfile = typeof loadProfiles.$inferInsert;
export type Facility = typeof facilities.$inferSelect;
export type InsertFacility = typeof facilities.$inferInsert;
export type Inspection = typeof inspections.$inferSelect;
export type InsertInspection = typeof inspections.$inferInsert;
export type MaintenanceDefect = typeof maintenanceDefects.$inferSelect;
export type InsertMaintenanceDefect = typeof maintenanceDefects.$inferInsert;
export type Delivery = typeof deliveries.$inferSelect;
export type InsertDelivery = typeof deliveries.$inferInsert;
export type SignatureAudit = typeof signatureAudits.$inferSelect;
export type InsertSignatureAudit = typeof signatureAudits.$inferInsert;

export const locationIdentities = mysqlTable("locationIdentities", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  surfaceLsd: varchar("surfaceLsd", { length: 80 }).notNull(),
  lsdValid: boolean("lsdValid"),
  downholeLsd: varchar("downholeLsd", { length: 80 }),
  uwi: varchar("uwi", { length: 120 }),
  uwiValid: boolean("uwiValid"),
  wellLicense: varchar("wellLicense", { length: 100 }),
  operator: varchar("operator", { length: 180 }),
  lease: varchar("lease", { length: 180 }),
  field: varchar("field", { length: 160 }),
  province: varchar("province", { length: 100 }),
  accessRoad: varchar("accessRoad", { length: 220 }),
  gate: varchar("gate", { length: 180 }),
  hazards: text("hazards"),
  emergencyInfo: text("emergencyInfo"),
  surfaceLatitude: double("surfaceLatitude"),
  surfaceLongitude: double("surfaceLongitude"),
  downholeLatitude: double("downholeLatitude"),
  downholeLongitude: double("downholeLongitude"),
  // v22.0 — where the coordinate came from, and whether a person verified it.
  coordinateSource: mysqlEnum("coordinateSource", ["ats_v41", "field_gps", "customer_stated", "theoretical_grid", "unknown"]).default("unknown").notNull(),
  coordinateConfidence: mysqlEnum("coordinateConfidence", ["low", "medium", "high", "unknown"]).default("unknown").notNull(),
  coordinateVerificationStatus: mysqlEnum("coordinateVerificationStatus", ["unverified", "verified"]).default("unverified").notNull(),
  coordinateVerifiedByUserId: int("coordinateVerifiedByUserId"),
  coordinateEvidenceRecordId: int("coordinateEvidenceRecordId"),
  source: varchar("source", { length: 220 }),
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const manifests = mysqlTable("manifests", {
  id: int("id").autoincrement().primaryKey(),
  manifestNumber: varchar("manifestNumber", { length: 80 }).notNull().unique(),
  locationId: int("locationId"),
  jobId: int("jobId"),
  material: varchar("material", { length: 220 }),
  unNumber: varchar("unNumber", { length: 40 }),
  unitId: int("unitId"),
  trailer: varchar("trailer", { length: 100 }),
  driver: varchar("driver", { length: 180 }),
  route: varchar("route", { length: 220 }),
  facility: varchar("facility", { length: 220 }),
  scaleTickets: text("scaleTickets"),
  evidenceRefs: text("evidenceRefs"),
  signatureRefs: text("signatureRefs"),
  status: mysqlEnum("status", ["draft", "verified", "sealed", "complete"])
    .default("draft")
    .notNull(),
  // 0162 (P3.1): which printed fields were rendered from the authoritative record rather than
  // typed by a person. A filled field is evidence of a different kind from a stated one.
  generatedFromReferenceJson: text("generatedFromReferenceJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** 0129 (P3.1) — canonical references beside the captured text; the text stays as the snapshot. */
  orgRef: varchar("orgRef", { length: 64 }),
  tripId: int("tripId"),
  loadId: int("loadId"),
  operatorId: int("operatorId"),
  trailerUnitId: int("trailerUnitId"),
  originFacilityId: int("originFacilityId"),
  destinationFacilityId: int("destinationFacilityId"),
  loadClass: varchar("loadClass", { length: 64 }),
  sealedAt: timestamp("sealedAt"),
  closedAt: timestamp("closedAt"),
  currentHash: varchar("currentHash", { length: 64 }),
  amendmentCount: int("amendmentCount").default(0).notNull(),
}, (t) => ({ orgIdx: index("manifests_org_idx").on(t.orgRef, t.status) }));

/** 0129 — what each party was represented as, at the time. */
export const manifestPartySnapshots = mysqlTable("manifestPartySnapshots", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  role: mysqlEnum("role", ["operator", "unit", "trailer", "route", "origin_facility", "destination_facility"]).notNull(),
  canonicalEntityId: int("canonicalEntityId"),
  capturedName: varchar("capturedName", { length: 220 }).notNull(),
  capturedIdentifier: varchar("capturedIdentifier", { length: 120 }),
  capturedAddress: varchar("capturedAddress", { length: 300 }),
  source: mysqlEnum("source", ["backfilled_text", "bound_from_record", "amendment"]).notNull(),
  capturedAt: timestamp("capturedAt").defaultNow().notNull(),
}, (t) => ({ manifestIdx: index("manifestPartySnapshots_manifest_idx").on(t.manifestId, t.role) }));

/** 0129 — custody as a sequence of events. */
export const manifestCustodyEvents = mysqlTable("manifestCustodyEvents", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  sequence: int("sequence").notNull(),
  eventType: mysqlEnum("eventType", ["loaded", "departed_origin", "arrived_facility", "accepted_by_facility", "rejected_by_facility", "unloaded", "closed"]).notNull(),
  actorUserId: int("actorUserId").notNull(),
  facilityId: int("facilityId"),
  occurredAt: timestamp("occurredAt").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  notes: varchar("notes", { length: 500 }),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
}, (t) => ({ seq: uniqueIndex("manifestCustodyEvents_seq_unique").on(t.manifestId, t.sequence) }));

/** 0129 — append-only amendments carrying the hash of what they replaced. */
export const manifestAmendments = mysqlTable("manifestAmendments", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  amendmentNo: int("amendmentNo").notNull(),
  reasonCode: mysqlEnum("reasonCode", ["party_correction", "quantity_correction", "facility_change", "evidence_added", "other"]).notNull(),
  reasonText: varchar("reasonText", { length: 500 }).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  approvedByUserId: int("approvedByUserId").notNull(),
  previousHash: varchar("previousHash", { length: 64 }).notNull(),
  replacementHash: varchar("replacementHash", { length: 64 }).notNull(),
  changesJson: text("changesJson").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ no: uniqueIndex("manifestAmendments_no_unique").on(t.manifestId, t.amendmentNo) }));

/** 0129 — evidence through the registry, with a named relationship. */
export const manifestEvidenceLinks = mysqlTable("manifestEvidenceLinks", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  relationship: mysqlEnum("relationship", ["origin_ticket", "scale_ticket", "disposal_ticket", "photo", "signature", "client_authorization", "facility_acceptance", "route_evidence"]).notNull(),
  attachedByUserId: int("attachedByUserId").notNull(),
  attachedAt: timestamp("attachedAt").defaultNow().notNull(),
}, (t) => ({ unique: uniqueIndex("manifestEvidenceLinks_unique").on(t.manifestId, t.evidenceRecordId, t.relationship), evidenceIdx: index("manifestEvidenceLinks_evidence_idx").on(t.evidenceRecordId, t.relationship) }));

/** 0129 — what closing requires, per load class, as configuration. None seeded. */
export const manifestEvidenceProfiles = mysqlTable("manifestEvidenceProfiles", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  loadClass: varchar("loadClass", { length: 64 }).notNull(),
  requiredRelationshipsJson: text("requiredRelationshipsJson").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ unique: uniqueIndex("manifestEvidenceProfiles_unique").on(t.orgRef, t.loadClass) }));

export const scanAudits = mysqlTable("scanAudits", {
  id: int("id").autoincrement().primaryKey(),
  scanType: mysqlEnum("scanType", ["qr", "nfc"]).notNull(),
  subjectType: mysqlEnum("subjectType", [
    "unit",
    "location",
    "manifest",
  ]).notNull(),
  subjectId: int("subjectId").notNull(),
  accessRole: mysqlEnum("accessRole", [
    "inspection",
    "driver",
    "mechanic",
    "dispatcher",
    "admin",
  ]).notNull(),
  scannedAt: timestamp("scannedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type LocationIdentity = typeof locationIdentities.$inferSelect;
export type InsertLocationIdentity = typeof locationIdentities.$inferInsert;
export type Manifest = typeof manifests.$inferSelect;
export type InsertManifest = typeof manifests.$inferInsert;
export type ScanAudit = typeof scanAudits.$inferSelect;
export type InsertScanAudit = typeof scanAudits.$inferInsert;

export const trips = mysqlTable("trips", {
  id: int("id").autoincrement().primaryKey(),
  /** 0132 — the organization that owns the row; NULL means the historical single tenant. */
  orgRef: varchar("orgRef", { length: 64 }),
  tripNumber: varchar("tripNumber", { length: 50 }).notNull().unique(),
  jobId: int("jobId"),
  unitId: int("unitId"),
  operatorId: int("operatorId"),
  manifestId: int("manifestId"),
  originLocationId: int("originLocationId"),
  destinationFacilityId: int("destinationFacilityId"),
  tripType: mysqlEnum("tripType", ["round_trip", "one_way", "shuttle"])
    .default("round_trip")
    .notNull(),
  status: mysqlEnum("status", [
    "planned",
    "loading",
    "in_transit",
    "unloading",
    "complete",
    "cancelled",
  ])
    .default("planned")
    .notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  odometerStartKm: double("odometerStartKm"),
  odometerEndKm: double("odometerEndKm"),
  distanceKm: double("distanceKm"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const tripStops = mysqlTable("tripStops", {
  id: int("id").autoincrement().primaryKey(),
  tripId: int("tripId").notNull(),
  stopType: mysqlEnum("stopType", [
    "load",
    "unload",
    "fuel",
    "checkpoint",
  ]).notNull(),
  locationId: int("locationId"),
  facilityId: int("facilityId"),
  sequence: int("sequence").default(1).notNull(),
  arrivedAt: timestamp("arrivedAt"),
  setupStartedAt: timestamp("setupStartedAt"),
  operationStartedAt: timestamp("operationStartedAt"),
  operationCompletedAt: timestamp("operationCompletedAt"),
  departedAt: timestamp("departedAt"),
  durationMinutes: double("durationMinutes"),
  setupMinutes: double("setupMinutes"),
  waitMinutes: double("waitMinutes"),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 30 }),
  ticketNumber: varchar("ticketNumber", { length: 100 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /*
   * 0179 — row provenance (leaseos's 0169, reconciled forward; see
   * docs/register/MIGRATION_0169_RECONCILIATION.md). Both write paths hold the
   * actor; neither recorded it.
   *
   * `recordedSource` reuses `proposalFields.source` rather than minting a second
   * vocabulary. NULL means the row-level source is not authoritative here: the
   * assistant commit path holds provenance per FIELD in `proposalFields`,
   * reachable through `assistantCommitReceipts`, and a row-level guess would be
   * less true than a null.
   *
   * This is not the per-boundary confirmation `siteBaseline` reads. That is
   * derived from committed receipts by `boundaryConfirmation.ts`; `updatedAt` and
   * `updatedByUserId` are what `boundaryEvidence.ts` compares a receipt against.
   */
  recordedByUserId: int("recordedByUserId"),
  recordedSource: mysqlEnum("recordedSource", ["driver_voice", "driver_typed", "gps", "photo_ocr", "system_inferred", "imported", "human_corrected"]),
  updatedByUserId: int("updatedByUserId"),
  updatedSource: mysqlEnum("updatedSource", ["driver_voice", "driver_typed", "gps", "photo_ocr", "system_inferred", "imported", "human_corrected"]),
  updatedAt: timestamp("updatedAt"),
});

export const operatingZones = mysqlTable("operatingZones", {
  id: int("id").autoincrement().primaryKey(),
  /** 0209 (P0-A2.1) — the organization whose geofence this is; NULL means the historical single tenant. */
  orgRef: varchar("orgRef", { length: 64 }),
  name: varchar("name", { length: 180 }).notNull(),
  zoneType: mysqlEnum("zoneType", ["loading", "unloading", "both"]).notNull(),
  locationId: int("locationId"),
  facilityId: int("facilityId"),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  radiusMetres: double("radiusMetres").default(75).notNull(),
  active: int("active").default(1).notNull(),
  verifiedAt: timestamp("verifiedAt"),
  source: varchar("source", { length: 220 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const dutyRecords = mysqlTable("dutyRecords", {
  id: int("id").autoincrement().primaryKey(),
  operatorId: int("operatorId").notNull(),
  tripId: int("tripId"),
  dutyStatus: mysqlEnum("dutyStatus", [
    "driving",
    "on_duty",
    "sleeper_berth",
    "off_duty",
  ]).notNull(),
  startedAt: timestamp("startedAt").notNull(),
  endedAt: timestamp("endedAt"),
  durationMinutes: double("durationMinutes"),
  latitude: double("latitude"),
  longitude: double("longitude"),
  locationLabel: varchar("locationLabel", { length: 220 }),
  jurisdiction: varchar("jurisdiction", { length: 100 }),
  source: varchar("source", { length: 80 }).default("driver_entry").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const workOrders = mysqlTable("workOrders", {
  id: int("id").autoincrement().primaryKey(),
  workOrderNumber: varchar("workOrderNumber", { length: 80 })
    .notNull()
    .unique(),
  unitId: int("unitId").notNull(),
  inspectionId: int("inspectionId"),
  defectId: int("defectId"),
  status: mysqlEnum("status", [
    "draft",
    "open",
    "in_progress",
    "waiting_parts",
    "ready_for_service",
    "closed",
  ])
    .default("open")
    .notNull(),
  priority: mysqlEnum("priority", ["routine", "urgent", "critical"])
    .default("routine")
    .notNull(),
  openedAt: timestamp("openedAt").notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  odometerKm: double("odometerKm"),
  engineHours: double("engineHours"),
  technician: varchar("technician", { length: 180 }),
  laborMinutes: double("laborMinutes"),
  parts: text("parts"),
  findings: text("findings"),
  correctiveAction: text("correctiveAction"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Trip = typeof trips.$inferSelect;
export type InsertTrip = typeof trips.$inferInsert;
export type TripStop = typeof tripStops.$inferSelect;
export type InsertTripStop = typeof tripStops.$inferInsert;
export type OperatingZone = typeof operatingZones.$inferSelect;
export type InsertOperatingZone = typeof operatingZones.$inferInsert;
export type DutyRecord = typeof dutyRecords.$inferSelect;
export type InsertDutyRecord = typeof dutyRecords.$inferInsert;
export type WorkOrder = typeof workOrders.$inferSelect;
export type InsertWorkOrder = typeof workOrders.$inferInsert;

export const complianceArtifacts = mysqlTable("complianceArtifacts", {
  id: int("id").autoincrement().primaryKey(),
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull().unique(),
  artifactType: varchar("artifactType", { length: 40 }).notNull(),
  jobId: int("jobId"),
  locationId: int("locationId"),
  manifestId: int("manifestId"),
  status: mysqlEnum("status", ["active", "completed", "archived", "legal_hold"])
    .default("active")
    .notNull(),
  jurisdiction: varchar("jurisdiction", { length: 100 }),
  regulatoryProfile: varchar("regulatoryProfile", { length: 180 }),
  regulatoryVersion: varchar("regulatoryVersion", { length: 100 }),
  retentionUntil: timestamp("retentionUntil"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const tailgateMeetings = mysqlTable("tailgateMeetings", {
  id: int("id").autoincrement().primaryKey(),
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull().unique(),
  jobId: int("jobId"),
  locationId: int("locationId"),
  supervisor: varchar("supervisor", { length: 180 }),
  operators: text("operators"),
  units: text("units"),
  hazards: text("hazards"),
  ppe: text("ppe"),
  controls: text("controls"),
  voiceTranscript: text("voiceTranscript"),
  reviewStatus: mysqlEnum("reviewStatus", ["needs_review", "approved"])
    .default("needs_review")
    .notNull(),
  startedAt: timestamp("startedAt"),
  endedAt: timestamp("endedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const transferAcknowledgements = mysqlTable("transferAcknowledgements", {
  id: int("id").autoincrement().primaryKey(),
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull(),
  channel: mysqlEnum("channel", [
    "email",
    "portal",
    "api",
    "download",
  ]).notNull(),
  recipient: varchar("recipient", { length: 220 }).notNull(),
  deliveryStatus: mysqlEnum("deliveryStatus", [
    "pending",
    "confirmed",
    "failed",
    "opened",
  ])
    .default("pending")
    .notNull(),
  messageId: varchar("messageId", { length: 180 }),
  attachmentCount: int("attachmentCount").default(0).notNull(),
  acknowledgedBy: varchar("acknowledgedBy", { length: 180 }),
  acknowledgedAt: timestamp("acknowledgedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ComplianceArtifact = typeof complianceArtifacts.$inferSelect;
export type InsertComplianceArtifact = typeof complianceArtifacts.$inferInsert;
export type TailgateMeeting = typeof tailgateMeetings.$inferSelect;
export type InsertTailgateMeeting = typeof tailgateMeetings.$inferInsert;
export type TransferAcknowledgement =
  typeof transferAcknowledgements.$inferSelect;
export type InsertTransferAcknowledgement =
  typeof transferAcknowledgements.$inferInsert;

export const billingRateCards = mysqlTable("billingRateCards", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),   // 0148: NULL = the historical single tenant; the owning organization otherwise
  name: varchar("name", { length: 160 }).notNull(),
  unitType: varchar("unitType", { length: 100 }).notNull(),
  hourlyRate: int("hourlyRate").default(0).notNull(),
  dailyRate: int("dailyRate").default(0).notNull(),
  jumpHourRate: int("jumpHourRate").default(0).notNull(),
  disposalRate: int("disposalRate").default(0).notNull(),
  specialtyEquipmentRate: int("specialtyEquipmentRate").default(0).notNull(),
  currency: varchar("currency", { length: 3 }).default("CAD").notNull(),
  active: int("active").default(1).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export const jobChargeLines = mysqlTable("jobChargeLines", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  description: varchar("description", { length: 220 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  unitRate: int("unitRate").default(0).notNull(),
  amount: int("amount").default(0).notNull(),
  source: varchar("source", { length: 80 }).default("rate_card").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const vendors = mysqlTable("vendors", {
  id: int("id").autoincrement().primaryKey(),
  /** 0134 — the organization a person linked this vendor to; NULL until someone does. */
  orgRef: varchar("orgRef", { length: 64 }),
  // v20.19
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),   // 0149: the business that keeps this vendor record; NULL = the historical single tenant (orgRef is the vendor's own organization, P7.2)
  vendorRef: varchar("vendorRef", { length: 64 }),
  name: varchar("name", { length: 180 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  contactName: varchar("contactName", { length: 160 }),
  phone: varchar("phone", { length: 40 }),
  emergencyPhone: varchar("emergencyPhone", { length: 40 }),
  email: varchar("email", { length: 220 }),
  accountNumberRef: varchar("accountNumberRef", { length: 120 }),
  paymentTermsDays: int("paymentTermsDays"),
  requiresPurchaseAuthorization: boolean("requiresPurchaseAuthorization").default(false).notNull(),
  portalEnabled: boolean("portalEnabled").default(false).notNull(),
  preferred: boolean("preferred").default(false).notNull(),
  emergency24h: boolean("emergency24h").default(false).notNull(),
  status: mysqlEnum("status", ["active", "inactive", "blocked"]).default("active").notNull(),
  coverageArea: varchar("coverageArea", { length: 220 }),
  availability: varchar("availability", { length: 100 }),
  notes: text("notes"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export const unitSafetyPlans = mysqlTable("unitSafetyPlans", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId"),
  unitLabel: varchar("unitLabel", { length: 120 }).notNull(),
  hazardSummary: text("hazardSummary"),
  shutdownProcedure: text("shutdownProcedure"),
  requiredPpe: text("requiredPpe"),
  sdsReferences: text("sdsReferences"),
  emergencyContacts: text("emergencyContacts"),
  version: int("version").default(1).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type BillingRateCard = typeof billingRateCards.$inferSelect;
export type InsertBillingRateCard = typeof billingRateCards.$inferInsert;
export type JobChargeLine = typeof jobChargeLines.$inferSelect;
export type InsertJobChargeLine = typeof jobChargeLines.$inferInsert;
export type Vendor = typeof vendors.$inferSelect;
export type InsertVendor = typeof vendors.$inferInsert;
export type UnitSafetyPlan = typeof unitSafetyPlans.$inferSelect;
export type InsertUnitSafetyPlan = typeof unitSafetyPlans.$inferInsert;

export const routeDecisions = mysqlTable("routeDecisions", {
  id: int("id").autoincrement().primaryKey(),
  tripId: varchar("tripId", { length: 40 }).notNull(),
  selectedRoute: varchar("selectedRoute", { length: 180 }).notNull(),
  alternatives: text("alternatives"),
  vehicleType: varchar("vehicleType", { length: 100 }).notNull(),
  gvwTonnes: int("gvwTonnes").notNull(),
  axleCount: int("axleCount").notNull(),
  heightMetres: int("heightMetres").notNull(),
  widthMetres: int("widthMetres").notNull(),
  lengthMetres: int("lengthMetres").notNull(),
  hazmatClass: varchar("hazmatClass", { length: 40 }),
  quantity: varchar("quantity", { length: 80 }),
  riskLevel: mysqlEnum("riskLevel", ["low", "moderate", "high", "blocked"])
    .default("moderate")
    .notNull(),
  source: varchar("source", { length: 180 }),
  confidence: varchar("confidence", { length: 40 }),
  driverAcknowledged: int("driverAcknowledged").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RouteDecision = typeof routeDecisions.$inferSelect;
export type InsertRouteDecision = typeof routeDecisions.$inferInsert;

// GPS breadcrumb ingestion + geofence auto-detection engine.
// A breadcrumb is a raw position ping. A zoneEvent is a *proposed* enter/exit
// of an operatingZone derived from breadcrumbs — it starts "pending" and must
// be confirmed or rejected by a driver/dispatcher before it can update a
// tripStop. Nothing here is ever treated as a confirmed fact on its own.
export const tripBreadcrumbs = mysqlTable("tripBreadcrumbs", {
  id: int("id").autoincrement().primaryKey(),
  tripId: int("tripId").notNull(),
  unitId: int("unitId"),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  accuracyMetres: double("accuracyMetres"),
  speedKmh: double("speedKmh"),
  headingDegrees: double("headingDegrees"),
  source: mysqlEnum("source", ["gps", "dead_reckoning", "manual"])
    .default("gps")
    .notNull(),
  recordedAt: timestamp("recordedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const zoneEvents = mysqlTable("zoneEvents", {
  id: int("id").autoincrement().primaryKey(),
  tripId: int("tripId").notNull(),
  zoneId: int("zoneId").notNull(),
  tripStopId: int("tripStopId"),
  eventType: mysqlEnum("eventType", ["enter", "exit"]).notNull(),
  detectedAt: timestamp("detectedAt").notNull(),
  distanceMetres: double("distanceMetres").notNull(),
  accuracyMetres: double("accuracyMetres"),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("medium")
    .notNull(),
  status: mysqlEnum("status", ["pending", "confirmed", "rejected", "expired"])
    .default("pending")
    .notNull(),
  confirmedAt: timestamp("confirmedAt"),
  confirmedBy: int("confirmedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TripBreadcrumb = typeof tripBreadcrumbs.$inferSelect;
export type InsertTripBreadcrumb = typeof tripBreadcrumbs.$inferInsert;
export type ZoneEvent = typeof zoneEvents.$inferSelect;
export type InsertZoneEvent = typeof zoneEvents.$inferInsert;

// ===================== BILLING + RECORDS CHAIN =====================
// Human tracking numbers are issued labels, never primary keys. Every row
// keeps its autoincrement id; trackingReferences is the universal index that
// maps a printed/spoken number back to whatever table owns the record.

export const trackingSequences = mysqlTable("trackingSequences", {
  id: int("id").autoincrement().primaryKey(),
  /** DC-C (0196) — the business the counter belongs to; NULL and scopeKey 'default' for the historical single tenant and every legacy series. */
  orgRef: varchar("orgRef", { length: 64 }),
  scopeKey: varchar("scopeKey", { length: 64 }).default("default").notNull(),
  sequenceType: varchar("sequenceType", { length: 24 }).notNull(),
  branch: varchar("branch", { length: 12 }),
  periodKey: varchar("periodKey", { length: 16 }).notNull(),
  nextNumber: int("nextNumber").default(1).notNull(),
  prefix: varchar("prefix", { length: 12 }).notNull(),
  separator: varchar("separator", { length: 4 }).default("-").notNull(),
  yearDigits: int("yearDigits").default(4).notNull(),
  includeMonth: boolean("includeMonth").default(false).notNull(),
  sequenceDigits: int("sequenceDigits").default(6).notNull(),
  resetPeriod: mysqlEnum("resetPeriod", ["never", "yearly", "monthly"])
    .default("yearly")
    .notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const trackingReferences = mysqlTable("trackingReferences", {
  id: int("id").autoincrement().primaryKey(),
  trackingNumber: varchar("trackingNumber", { length: 64 }).notNull().unique(),
  entityType: varchar("entityType", { length: 40 }).notNull(),
  entityId: int("entityId").notNull(),
  parentTrackingNumber: varchar("parentTrackingNumber", { length: 64 }),
  jobId: int("jobId"),
  issuedAt: timestamp("issuedAt").notNull(),
  // Who was authenticated vs who the record is *for* — delegation without
  // losing accountability. Office entering a paper log for a driver records
  // both, never just the driver.
  issuedByUserId: int("issuedByUserId"),
  onBehalfOfOperatorId: int("onBehalfOfOperatorId"),
  delegationReason: varchar("delegationReason", { length: 220 }),
  deviceId: varchar("deviceId", { length: 120 }),
  sessionId: varchar("sessionId", { length: 120 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const billingBooks = mysqlTable("billingBooks", {
  id: int("id").autoincrement().primaryKey(),
  bookNumber: varchar("bookNumber", { length: 64 }).notNull().unique(),
  jobId: int("jobId").notNull(),
  customer: varchar("customer", { length: 220 }).notNull(),
  // Oilfield AP rejects invoices without cost coding. Captured at the lease
  // from the company representative, not guessed at month-end.
  afeNumber: varchar("afeNumber", { length: 80 }),
  costCenter: varchar("costCenter", { length: 80 }),
  purchaseOrder: varchar("purchaseOrder", { length: 80 }),
  chargedToUwi: varchar("chargedToUwi", { length: 120 }),
  rateCardId: int("rateCardId"),
  billingState: mysqlEnum("billingState", [
    "draft",
    "operations_complete",
    "documents_complete",
    "disposal_verified",
    "logs_complete",
    "billing_review",
    "approved",
    "invoiced",
    "disputed",
    "closed",
  ])
    .default("draft")
    .notNull(),
  blockedReasons: text("blockedReasons"),
  openedAt: timestamp("openedAt").notNull(),
  closedAt: timestamp("closedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const loads = mysqlTable("loads", {
  id: int("id").autoincrement().primaryKey(),
  loadNumber: varchar("loadNumber", { length: 64 }).notNull().unique(),
  jobId: int("jobId").notNull(),
  tripId: int("tripId"),
  billingBookId: int("billingBookId"),
  loadStopId: int("loadStopId"),
  unloadStopId: int("unloadStopId"),
  operatorId: int("operatorId"),
  unitId: int("unitId"),
  material: varchar("material", { length: 220 }),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 30 }),
  // How the number was obtained decides whether it can be billed.
  measurementMethod: mysqlEnum("measurementMethod", [
    "meter",
    "scale",
    "loadsense_calibrated",
    "loadsense_uncalibrated",
    "gauge",
    "estimate",
    "customer_stated",
    "unknown",
  ])
    .default("unknown")
    .notNull(),
  // v20.22 — which device produced the number.
  measurementDeviceId: int("measurementDeviceId"),
  loadTicketNumber: varchar("loadTicketNumber", { length: 64 }),
  chainState: mysqlEnum("chainState", [
    "created",
    "material_identified",
    "loaded",
    "in_transit",
    "arrived_disposal",
    "weighed",
    "unloaded",
    "disposal_verified",
    "billed",
  ])
    .default("created")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const disposalTickets = mysqlTable("disposalTickets", {
  id: int("id").autoincrement().primaryKey(),
  ticketNumber: varchar("ticketNumber", { length: 64 }).notNull().unique(),
  loadId: int("loadId"),
  disposalBatchId: int("disposalBatchId"),
  jobId: int("jobId"),
  tripId: int("tripId"),
  facilityId: int("facilityId"),
  operatorId: int("operatorId"),
  unitId: int("unitId"),
  facilityTicketNumber: varchar("facilityTicketNumber", { length: 80 }),
  scaleInAt: timestamp("scaleInAt"),
  grossKg: double("grossKg"),
  tareKg: double("tareKg"),
  netKg: double("netKg"),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 30 }),
  verificationStatus: mysqlEnum("verificationStatus", [
    "unverified",
    "needs_review",
    "verified",
    "rejected",
  ])
    .default("unverified")
    .notNull(),
  source: varchar("source", { length: 80 }),
  measurementDeviceId: int("measurementDeviceId"),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("low")
    .notNull(),
  evidenceRefs: text("evidenceRefs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Several loads can roll into one facility batch — the system must never
// assume one load equals one ticket.
export const disposalBatches = mysqlTable("disposalBatches", {
  id: int("id").autoincrement().primaryKey(),
  batchNumber: varchar("batchNumber", { length: 64 }).notNull().unique(),
  facilityId: int("facilityId"),
  jobId: int("jobId"),
  openedAt: timestamp("openedAt").notNull(),
  closedAt: timestamp("closedAt"),
  totalQuantity: double("totalQuantity"),
  quantityUnit: varchar("quantityUnit", { length: 30 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const dailyLogs = mysqlTable("dailyLogs", {
  id: int("id").autoincrement().primaryKey(),
  logNumber: varchar("logNumber", { length: 64 }).notNull().unique(),
  operatorId: int("operatorId").notNull(),
  logDate: timestamp("logDate").notNull(),
  reportingLocation: varchar("reportingLocation", { length: 220 }),
  reportedAt: timestamp("reportedAt"),
  releasedAt: timestamp("releasedAt"),
  totalOnDutyMinutes: double("totalOnDutyMinutes"),
  completenessPercent: int("completenessPercent").default(0).notNull(),
  status: mysqlEnum("status", [
    "open",
    "submitted",
    "office_review",
    "certified",
    "amended",
  ])
    .default("open")
    .notNull(),
  paperFallbackRef: varchar("paperFallbackRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// A field ticket is a billable SERVICE EVENT, not a job or a trip. Scope says
// what this one covers, so one customer can sign per load and another per
// site visit without a schema change.
//
//   scope=job           tripId NULL   loadId NULL
//   scope=trip          tripId SET    loadId NULL
//   scope=load          tripId SET    loadId SET
//   scope=service_event tripId/loadId optional (standby, washout, callout)
//
// Enforced by validateFieldTicketScope() in server/_core/fieldTicket.ts.
//
// This table records WHAT HAPPENED. It deliberately carries no rates or
// amounts — "45 minutes standby" is a fact; whether that becomes money is the
// rate engine's decision. Keeps accounting logic out of field evidence.
export const fieldTickets = mysqlTable("fieldTickets", {
  id: int("id").autoincrement().primaryKey(),
  ticketNumber: varchar("ticketNumber", { length: 64 }).notNull().unique(),
  scope: mysqlEnum("scope", ["job", "trip", "load", "service_event"])
    .default("load")
    .notNull(),
  jobId: int("jobId").notNull(),
  // v21.11 — the account this ticket bills to (the portal scopes by it).
  customerAccountId: int("customerAccountId"),
  tripId: int("tripId"),
  loadId: int("loadId"),
  billingBookId: int("billingBookId"),
  siteLocationId: int("siteLocationId"),
  operatorId: int("operatorId"),
  unitId: int("unitId"),
  serviceDescription: varchar("serviceDescription", { length: 220 }),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  postSiteRequired: boolean("postSiteRequired").default(false).notNull(),
  afeNumber: varchar("afeNumber", { length: 80 }),
  costCenter: varchar("costCenter", { length: 80 }),
  status: mysqlEnum("status", [
    "draft",
    "presented",
    "closed",
    "amended_after_signature",
  ])
    .default("draft")
    .notNull(),
  signatureStatus: mysqlEnum("signatureStatus", [
    "unsigned",
    "accepted",
    "partially_accepted",
    "refused",
    "no_representative",
  ])
    .default("unsigned")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// What the representative is being asked to accept, line by line. Facts and
// quantities only — no rates. Disposition is per line so a disputed standby
// doesn't invalidate an accepted 3-hour service.
export const fieldTicketLines = mysqlTable("fieldTicketLines", {
  id: int("id").autoincrement().primaryKey(),
  fieldTicketId: int("fieldTicketId").notNull(),
  lineKind: mysqlEnum("lineKind", [
    "service",
    "load",
    "disposal",
    "standby",
    "equipment",
    "personnel",
    "mileage",
    "other",
  ]).notNull(),
  serviceCode: varchar("serviceCode", { length: 60 }),
  description: varchar("description", { length: 220 }).notNull(),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 30 }),
  measurementMethod: mysqlEnum("measurementMethod", [
    "meter",
    "scale",
    "loadsense_calibrated",
    "loadsense_uncalibrated",
    "gauge",
    "estimate",
    "customer_stated",
    "system_timed",
    "unknown",
  ])
    .default("unknown")
    .notNull(),
  sourceTrackingNumber: varchar("sourceTrackingNumber", { length: 64 }),
  pricingDecisionRef: varchar("pricingDecisionRef", { length: 64 }),
  disposition: mysqlEnum("disposition", [
    "not_presented",
    "accepted",
    "disputed",
  ])
    .default("not_presented")
    .notNull(),
  // Both sides of a dispute are kept. "Driver says 45 min, company says 20"
  // is operational data worth having, not something to overwrite.
  operatorStatement: varchar("operatorStatement", { length: 220 }),
  customerStatement: varchar("customerStatement", { length: 220 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Signature is separate from the ticket: a ticket may be re-presented after
// an amendment, or signed by a different representative on a later visit.
export const fieldTicketSignatures = mysqlTable("fieldTicketSignatures", {
  id: int("id").autoincrement().primaryKey(),
  fieldTicketId: int("fieldTicketId").notNull(),
  revision: int("revision").default(1).notNull(),
  result: mysqlEnum("result", [
    "accepted",
    "partially_accepted",
    "refused",
    "no_representative",
  ]).notNull(),
  signerName: varchar("signerName", { length: 180 }),
  signerCompany: varchar("signerCompany", { length: 180 }),
  signerRole: varchar("signerRole", { length: 120 }),
  // v21.11 — what the signature exercised, and whether that was within the signatory's authority.
  authoritiesExercised: varchar("authoritiesExercised", { length: 300 }),
  withinAuthority: mysqlEnum("withinAuthority", ["yes", "no", "unknown"]).default("unknown").notNull(),
  signerPhone: varchar("signerPhone", { length: 60 }),
  // The sentence the signer actually agreed to — site, window, quantities.
  // "John Smith signed" on its own proves very little.
  signedScopeStatement: text("signedScopeStatement"),
  postSiteAuthorizationJson: text("postSiteAuthorizationJson"),
  signatureStorageKey: varchar("signatureStorageKey", { length: 512 }),
  signatureMethod: mysqlEnum("signatureMethod", [
    "drawn",
    "device_auth",
    "pin",
    "paper_scan",
    // 0158 — identity proved through the signed portal link; the customer has no enrolled device.
    "portal_link",
  ]),
  payloadHash: varchar("payloadHash", { length: 128 }),
  refusalReason: text("refusalReason"),
  capturedAt: timestamp("capturedAt").notNull(),
  capturedLatitude: double("capturedLatitude"),
  capturedLongitude: double("capturedLongitude"),
  capturedOffline: boolean("capturedOffline").default(false).notNull(),
  witnessedByOperatorId: int("witnessedByOperatorId"),
  externalIdentityId: int("externalIdentityId"),
  // 0157 (P1.4): proof the enrolled device made this signature. No biometric material, ever:
  // the platform biometric unlocks the key on the device and never leaves it.
  deviceRef: varchar("deviceRef", { length: 64 }),
  deviceKeyFingerprint: varchar("deviceKeyFingerprint", { length: 80 }),
  deviceSignatureBase64: text("deviceSignatureBase64"),
  deviceSignedAt: timestamp("deviceSignedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Service timeline. Where an event is already captured on a tripStop it points
// back via sourceTripStopId rather than being retyped — standby, extra service
// and customer instructions are the events that have nowhere else to live.
export const fieldTicketEvents = mysqlTable("fieldTicketEvents", {
  id: int("id").autoincrement().primaryKey(),
  fieldTicketId: int("fieldTicketId").notNull(),
  eventType: varchar("eventType", { length: 60 }).notNull(),
  // v21.11 — which clock this event belongs to, and whether the customer pays for it.
  clock: mysqlEnum("clock", ["duty", "payroll", "job", "customer_billing", "equipment", "standby", "travel", "disposal", "internal_service"]),
  customerBillable: mysqlEnum("customerBillable", ["yes", "no", "review"]).default("review").notNull(),
  billingRuleRef: varchar("billingRuleRef", { length: 80 }),
  occurredAt: timestamp("occurredAt").notNull(),
  endedAt: timestamp("endedAt"),
  durationMinutes: double("durationMinutes"),
  // v22.1 — minutes the customer pays for, when a contract term reduces them (grace); the clock is untouched.
  billableMinutes: double("billableMinutes"),
  sourceTripStopId: int("sourceTripStopId"),
  authorisedBy: varchar("authorisedBy", { length: 180 }),
  detail: text("detail"),
  source: varchar("source", { length: 80 }).default("driver_entry").notNull(),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("medium")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),
  invoiceNumber: varchar("invoiceNumber", { length: 64 }).notNull().unique(),
  // v21.8 — which entity issued it, when, and whether the sale is taxable.
  financialEntityId: int("financialEntityId"),
  issuedAt: timestamp("issuedAt"),
  billingBookId: int("billingBookId").notNull(),
  jobId: int("jobId"),
  customer: varchar("customer", { length: 220 }).notNull(),
  // v21.9.1 — identity, not a name.
  customerAccountId: int("customerAccountId"),
  afeNumber: varchar("afeNumber", { length: 80 }),
  purchaseOrder: varchar("purchaseOrder", { length: 80 }),
  // v21.10 — the authorization this invoice consumes and the card that priced it.
  customerPurchaseOrderId: int("customerPurchaseOrderId"),
  rateCardId: int("rateCardId"),
  subtotalCents: int("subtotalCents").default(0).notNull(),
  taxCents: int("taxCents").default(0).notNull(),
  gstTreatment: mysqlEnum("gstTreatment", ["taxable", "zero_rated", "exempt", "unknown"]).default("unknown").notNull(),
  gstTreatmentSource: varchar("gstTreatmentSource", { length: 40 }),
  totalCents: int("totalCents").default(0).notNull(),
  currency: varchar("currency", { length: 3 }).default("CAD").notNull(),
  status: mysqlEnum("status", [
    "draft",
    "sent",
    "viewed",
    "approved",
    "disputed",
    "partially_paid",
    "paid",
    "void",
  ])
    .default("draft")
    .notNull(),
  sentAt: timestamp("sentAt"),
  viewedAt: timestamp("viewedAt"),
  dueAt: timestamp("dueAt"),
  // Client-side acceptance: a tokenised link, no login required for the
  // customer, with their approval or dispute recorded against it.
  acceptanceToken: varchar("acceptanceToken", { length: 128 }),
  acceptedByName: varchar("acceptedByName", { length: 180 }),
  acceptedByRole: varchar("acceptedByRole", { length: 120 }),
  acceptedAt: timestamp("acceptedAt"),
  acceptanceSignatureKey: varchar("acceptanceSignatureKey", { length: 512 }),
  disputeReason: text("disputeReason"),
  disputedAt: timestamp("disputedAt"),
  voidedAt: timestamp("voidedAt"),
  voidedByUserId: int("voidedByUserId"),
  voidReason: varchar("voidReason", { length: 400 }),
  externalPortalRef: varchar("externalPortalRef", { length: 120 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Append-only. Never update a row here — corrections create new rows.
export const recordAmendments = mysqlTable("recordAmendments", {
  id: int("id").autoincrement().primaryKey(),
  entityType: varchar("entityType", { length: 40 }).notNull(),
  entityId: int("entityId").notNull(),
  trackingNumber: varchar("trackingNumber", { length: 64 }),
  fieldKey: varchar("fieldKey", { length: 80 }).notNull(),
  originalValue: text("originalValue"),
  correctedValue: text("correctedValue"),
  reason: text("reason").notNull(),
  supportingTrackingNumber: varchar("supportingTrackingNumber", { length: 64 }),
  actorUserId: int("actorUserId"),
  actorRole: varchar("actorRole", { length: 40 }),
  onBehalfOfOperatorId: int("onBehalfOfOperatorId"),
  afterSignature: boolean("afterSignature").default(false).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TrackingSequence = typeof trackingSequences.$inferSelect;
export type InsertTrackingSequence = typeof trackingSequences.$inferInsert;
export type TrackingReference = typeof trackingReferences.$inferSelect;
export type InsertTrackingReference = typeof trackingReferences.$inferInsert;
export type BillingBook = typeof billingBooks.$inferSelect;
export type InsertBillingBook = typeof billingBooks.$inferInsert;
export type Load = typeof loads.$inferSelect;
export type InsertLoad = typeof loads.$inferInsert;
export type DisposalTicket = typeof disposalTickets.$inferSelect;
export type InsertDisposalTicket = typeof disposalTickets.$inferInsert;
export type DisposalBatch = typeof disposalBatches.$inferSelect;
export type InsertDisposalBatch = typeof disposalBatches.$inferInsert;
export type DailyLog = typeof dailyLogs.$inferSelect;
export type InsertDailyLog = typeof dailyLogs.$inferInsert;
export type FieldTicket = typeof fieldTickets.$inferSelect;
export type InsertFieldTicket = typeof fieldTickets.$inferInsert;
export type FieldTicketLine = typeof fieldTicketLines.$inferSelect;
export type InsertFieldTicketLine = typeof fieldTicketLines.$inferInsert;
export type FieldTicketSignature = typeof fieldTicketSignatures.$inferSelect;
export type InsertFieldTicketSignature =
  typeof fieldTicketSignatures.$inferInsert;
export type FieldTicketEvent = typeof fieldTicketEvents.$inferSelect;
export type InsertFieldTicketEvent = typeof fieldTicketEvents.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;
export type RecordAmendment = typeof recordAmendments.$inferSelect;
export type InsertRecordAmendment = typeof recordAmendments.$inferInsert;

// ===================== TAXONOMY + CUSTOMER CONFIG =====================
// The taxonomy is DATA, not code: administrators extend these tables without
// a deployment. server/_core/taxonomy.ts holds only the derivation logic that
// turns a classification into routing constraints and requirement checklists.

export const taxonomyEntries = mysqlTable("taxonomyEntries", {
  id: int("id").autoincrement().primaryKey(),
  dimension: mysqlEnum("dimension", [
    "service",
    "truck",
    "trailer",
    "cargo",
    "environment",
    "radius",
    "load_method",
    "unload_method",
    "billing_unit",
    "safety_ticket",
    "ppe",
    "permit",
  ]).notNull(),
  code: varchar("code", { length: 40 }).notNull(),
  label: varchar("label", { length: 180 }).notNull(),
  parentCode: varchar("parentCode", { length: 40 }),
  attributesJson: text("attributesJson"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Oversize/overweight triggers are versioned configuration with provenance,
// never asserted law. An unverified row makes the routing engine warn rather
// than quietly treating a placeholder as authoritative.
export const regulatoryThresholds = mysqlTable("regulatoryThresholds", {
  id: int("id").autoincrement().primaryKey(),
  jurisdiction: varchar("jurisdiction", { length: 60 }).notNull(),
  widthM: double("widthM").notNull(),
  heightM: double("heightM").notNull(),
  lengthM: double("lengthM").notNull(),
  gvwKg: double("gvwKg").notNull(),
  source: varchar("source", { length: 300 }).notNull(),
  effectiveDate: timestamp("effectiveDate"),
  lastVerified: timestamp("lastVerified"),
  confidence: mysqlEnum("confidence", [
    "unverified",
    "operator_supplied",
    "authority_confirmed",
  ])
    .default("unverified")
    .notNull(),
  supersededAt: timestamp("supersededAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Per-customer billing policy. Keeps the driver out of business decisions:
// LeaseOS presents the customer's normal workflow rather than asking the
// driver to choose a ticket scope at the lease.
export const customerBillingConfigs = mysqlTable("customerBillingConfigs", {
  id: int("id").autoincrement().primaryKey(),
  customer: varchar("customer", { length: 220 }).notNull().unique(),
  defaultTicketScope: mysqlEnum("defaultTicketScope", [
    "job",
    "trip",
    "load",
    "service_event",
  ])
    .default("load")
    .notNull(),
  allowedScopeOverrides: varchar("allowedScopeOverrides", { length: 200 }),
  signatureRequired: boolean("signatureRequired").default(true).notNull(),
  partialAcceptanceAllowed: boolean("partialAcceptanceAllowed")
    .default(true)
    .notNull(),
  requiredFields: text("requiredFields"),
  requiredDocuments: text("requiredDocuments"),
  externalPortal: varchar("externalPortal", { length: 120 }),
  paymentTermsDays: int("paymentTermsDays").default(30).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// Billing entries REFERENCE operational records rather than copying values.
// Copying is what makes a billing table disagree with the disposal ticket it
// came from. Snapshots are the one deliberate exception, below.
export const billingBookEntries = mysqlTable("billingBookEntries", {
  id: int("id").autoincrement().primaryKey(),
  billingBookId: int("billingBookId").notNull(),
  fieldTicketLineId: int("fieldTicketLineId"),
  tripId: int("tripId"),
  loadId: int("loadId"),
  disposalTicketId: int("disposalTicketId"),
  rateCardId: int("rateCardId"),
  billingUnit: varchar("billingUnit", { length: 60 }),
  billingStatus: mysqlEnum("billingStatus", [
    "pending",
    "ready",
    "held",
    "billed",
    "credited",
    "written_off",
  ])
    .default("pending")
    .notNull(),
  holdReason: varchar("holdReason", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Taken at invoice finalisation. An invoice must not depend on records that
// keep changing afterwards — this is what lets "why did we bill $X?" be
// answered years later, reproducibly.
export const billingSnapshots = mysqlTable("billingSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  billingBookId: int("billingBookId").notNull(),
  capturedAt: timestamp("capturedAt").notNull(),
  capturedByUserId: int("capturedByUserId"),
  rateCardVersion: varchar("rateCardVersion", { length: 40 }),
  sourceFactsJson: text("sourceFactsJson").notNull(),
  calculatedLinesJson: text("calculatedLinesJson").notNull(),
  excludedLinesJson: text("excludedLinesJson"),
  subtotalCents: int("subtotalCents").notNull(),
  totalCents: int("totalCents").notNull(),
  payloadHash: varchar("payloadHash", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TaxonomyEntry = typeof taxonomyEntries.$inferSelect;
export type InsertTaxonomyEntry = typeof taxonomyEntries.$inferInsert;
export type RegulatoryThreshold = typeof regulatoryThresholds.$inferSelect;
export type InsertRegulatoryThreshold =
  typeof regulatoryThresholds.$inferInsert;
export type CustomerBillingConfig = typeof customerBillingConfigs.$inferSelect;
export type InsertCustomerBillingConfig =
  typeof customerBillingConfigs.$inferInsert;
export type BillingBookEntry = typeof billingBookEntries.$inferSelect;
export type InsertBillingBookEntry = typeof billingBookEntries.$inferInsert;
export type BillingSnapshot = typeof billingSnapshots.$inferSelect;
export type InsertBillingSnapshot = typeof billingSnapshots.$inferInsert;

// ================= ROAD GRAPH + INGESTION PROVENANCE =================
// Persists what B12's evaluator currently receives as supplied input. Every
// attribute row carries its own provenance, because a road graph assembled
// from several sources has several trust levels within one route.

export const importBatches = mysqlTable("importBatches", {
  id: int("id").autoincrement().primaryKey(),
  batchId: varchar("batchId", { length: 64 }).notNull().unique(),
  resourceType: varchar("resourceType", { length: 40 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 60 }).notNull(),
  source: varchar("source", { length: 300 }).notNull(),
  sourceReference: varchar("sourceReference", { length: 500 }),
  licenceNotes: text("licenceNotes"),
  datasetVersion: varchar("datasetVersion", { length: 60 }).notNull(),
  effectiveDate: timestamp("effectiveDate"),
  importedAt: timestamp("importedAt").notNull(),
  recordCount: int("recordCount").notNull(),
  checksum: varchar("checksum", { length: 128 }).notNull(),
  validationStatus: mysqlEnum("validationStatus", [
    "rejected",
    "provisional",
    "validated",
  ])
    .default("provisional")
    .notNull(),
  confidence: mysqlEnum("confidence", [
    "unverified",
    "operator_supplied",
    "authority_confirmed",
  ])
    .default("unverified")
    .notNull(),
  observedRecords: int("observedRecords"),
  expectedRecords: int("expectedRecords"),
  coverageState: mysqlEnum("coverageState", ["unknown", "partial", "complete"])
    .default("unknown")
    .notNull(),
  // Superseded batches are RETAINED. A routing decision made in March must
  // stay reproducible against March's data.
  supersededByBatchId: varchar("supersededByBatchId", { length: 64 }),
  supersededAt: timestamp("supersededAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// The only route from unverified to authority_confirmed. Requires a named
// person and a named authority — "who said this bridge limit was right?"
// must always have an answer.
export const datasetConfirmations = mysqlTable("datasetConfirmations", {
  id: int("id").autoincrement().primaryKey(),
  batchId: varchar("batchId", { length: 64 }).notNull(),
  confirmedByUserId: int("confirmedByUserId").notNull(),
  confirmedByName: varchar("confirmedByName", { length: 180 }).notNull(),
  authority: varchar("authority", { length: 300 }).notNull(),
  authorityReference: varchar("authorityReference", { length: 300 }),
  confirmedAt: timestamp("confirmedAt").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const roadSegments = mysqlTable("roadSegments", {
  id: int("id").autoincrement().primaryKey(),
  segmentId: varchar("segmentId", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 220 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 60 }),
  roadClass: varchar("roadClass", { length: 60 }),
  surface: varchar("surface", { length: 40 }),
  lengthKm: double("lengthKm"),
  startLatitude: double("startLatitude"),
  startLongitude: double("startLongitude"),
  endLatitude: double("endLatitude"),
  endLongitude: double("endLongitude"),
  geometryJson: text("geometryJson"),
  batchId: varchar("batchId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// One row per (segment, check). Mirrors SegmentAttribute in routeEvaluation.ts
// so the evaluator reads persisted rows without reshaping. A NULL limitValue
// is meaningful: it evaluates as unknown, never as clear.
export const segmentAttributes = mysqlTable("segmentAttributes", {
  id: int("id").autoincrement().primaryKey(),
  segmentId: varchar("segmentId", { length: 64 }).notNull(),
  checkKey: varchar("checkKey", { length: 60 }).notNull(),
  limitValue: double("limitValue"),
  textValue: varchar("textValue", { length: 120 }),
  jurisdiction: varchar("jurisdiction", { length: 60 }),
  source: varchar("source", { length: 300 }),
  sourceVersion: varchar("sourceVersion", { length: 60 }),
  verifiedAt: timestamp("verifiedAt"),
  confidence: mysqlEnum("confidence", [
    "unverified",
    "operator_supplied",
    "authority_confirmed",
  ])
    .default("unverified")
    .notNull(),
  batchId: varchar("batchId", { length: 64 }),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const bridges = mysqlTable("bridges", {
  id: int("id").autoincrement().primaryKey(),
  structureId: varchar("structureId", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 220 }),
  segmentId: varchar("segmentId", { length: 64 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  direction: varchar("direction", { length: 30 }),
  clearanceM: double("clearanceM"),
  postedWeightKg: double("postedWeightKg"),
  postedAxleGroupKg: double("postedAxleGroupKg"),
  seasonalRestriction: varchar("seasonalRestriction", { length: 160 }),
  jurisdiction: varchar("jurisdiction", { length: 60 }),
  source: varchar("source", { length: 300 }),
  sourceVersion: varchar("sourceVersion", { length: 60 }),
  verifiedAt: timestamp("verifiedAt"),
  confidence: mysqlEnum("confidence", [
    "unverified",
    "operator_supplied",
    "authority_confirmed",
  ])
    .default("unverified")
    .notNull(),
  batchId: varchar("batchId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Persisted evidence ledger — one row per check, per segment, per decision.
// reproduceVerdict() replays a decision from these rows with no map access.
export const routeEvidenceEntries = mysqlTable("routeEvidenceEntries", {
  id: int("id").autoincrement().primaryKey(),
  routeDecisionId: int("routeDecisionId"),
  routeProfileId: varchar("routeProfileId", { length: 64 }).notNull(),
  tripId: int("tripId"),
  jobId: int("jobId"),
  segmentId: varchar("segmentId", { length: 64 }).notNull(),
  segmentLabel: varchar("segmentLabel", { length: 220 }),
  checkKey: varchar("checkKey", { length: 60 }).notNull(),
  axis: mysqlEnum("axis", ["legal", "feasible", "preferred"]).notNull(),
  result: mysqlEnum("result", ["pass", "fail", "review", "unknown"]).notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  vehicleValue: double("vehicleValue"),
  limitValue: double("limitValue"),
  unit: varchar("unit", { length: 20 }),
  jurisdiction: varchar("jurisdiction", { length: 60 }),
  source: varchar("source", { length: 300 }),
  sourceVersion: varchar("sourceVersion", { length: 60 }),
  verifiedAt: timestamp("verifiedAt"),
  confidence: mysqlEnum("confidence", [
    "unverified",
    "operator_supplied",
    "authority_confirmed",
  ])
    .default("unverified")
    .notNull(),
  evaluatedAt: timestamp("evaluatedAt").notNull(),
  // 0167: which evaluation produced this row. A trip evaluated three times leaves three sets;
  // without this, none of them can be told apart.
  evaluationRef: varchar("evaluationRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ImportBatchRow = typeof importBatches.$inferSelect;
export type InsertImportBatch = typeof importBatches.$inferInsert;
export type DatasetConfirmationRow = typeof datasetConfirmations.$inferSelect;
export type InsertDatasetConfirmation =
  typeof datasetConfirmations.$inferInsert;
export type RoadSegment = typeof roadSegments.$inferSelect;
export type InsertRoadSegment = typeof roadSegments.$inferInsert;
export type SegmentAttributeRow = typeof segmentAttributes.$inferSelect;
export type InsertSegmentAttribute = typeof segmentAttributes.$inferInsert;
export type Bridge = typeof bridges.$inferSelect;
export type InsertBridge = typeof bridges.$inferInsert;
export type RouteEvidenceEntry = typeof routeEvidenceEntries.$inferSelect;
export type InsertRouteEvidenceEntry = typeof routeEvidenceEntries.$inferInsert;

// ========================= DISPATCH OPERATIONS =========================
// Three concepts kept in separate tables on purpose: a posting/bid records
// willingness, dispatchEligibilityChecks records the safety gate, and neither
// implies the other. Assignment requires a fresh eligibility check.

export const specialtyPools = mysqlTable("specialtyPools", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 60 }).notNull().unique(),
  label: varchar("label", { length: 180 }).notNull(),
  category: varchar("category", { length: 60 }),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const operatorCapabilities = mysqlTable("operatorCapabilities", {
  id: int("id").autoincrement().primaryKey(),
  operatorId: int("operatorId").notNull(),
  kind: mysqlEnum("kind", [
    "licence",
    "endorsement",
    "certification",
    "orientation",
    "equipment_class",
    "trailer_class",
    "specialty",
    "region",
    "experience",
  ]).notNull(),
  code: varchar("code", { length: 60 }).notNull(),
  label: varchar("label", { length: 180 }).notNull(),
  expiresAt: timestamp("expiresAt"),
  // Experience aids matching but is NOT a credential and must never be
  // presented as one.
  isCredential: boolean("isCredential").default(false).notNull(),
  verifiedAt: timestamp("verifiedAt"),
  documentId: int("documentId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const operatorAvailability = mysqlTable("operatorAvailability", {
  id: int("id").autoincrement().primaryKey(),
  operatorId: int("operatorId").notNull(),
  state: mysqlEnum("state", [
    "available",
    "unavailable",
    "available_after",
    "on_job",
    "returning",
    "off_duty",
    "on_call",
    "hos_limited",
    "qualification_blocked",
  ]).notNull(),
  availableFrom: timestamp("availableFrom"),
  availableUntil: timestamp("availableUntil"),
  region: varchar("region", { length: 120 }),
  maxRadiusKm: double("maxRadiusKm"),
  preferredServices: varchar("preferredServices", { length: 300 }),
  declaredAt: timestamp("declaredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const onCallRotations = mysqlTable("onCallRotations", {
  id: int("id").autoincrement().primaryKey(),
  operatorId: int("operatorId").notNull(),
  branch: varchar("branch", { length: 120 }),
  region: varchar("region", { length: 120 }),
  serviceCategory: varchar("serviceCategory", { length: 60 }),
  poolCode: varchar("poolCode", { length: 60 }),
  startsAt: timestamp("startsAt").notNull(),
  endsAt: timestamp("endsAt").notNull(),
  position: int("position").default(1).notNull(),
  status: mysqlEnum("status", [
    "scheduled",
    "on_call",
    "called",
    "accepted",
    "declined",
    "no_response",
    "dispatched",
    "completed",
    "unavailable",
  ])
    .default("scheduled")
    .notNull(),
  calledAt: timestamp("calledAt"),
  respondedAt: timestamp("respondedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const dispatchPostings = mysqlTable("dispatchPostings", {
  id: int("id").autoincrement().primaryKey(),
  postingNumber: varchar("postingNumber", { length: 64 }).notNull().unique(),
  jobId: int("jobId").notNull(),
  distribution: mysqlEnum("distribution", [
    "public_internal_bid",
    "selected_pool",
    "invite_only",
    "direct_assignment",
    "on_call",
    "emergency",
    "subcontractor_bid",
  ])
    .default("public_internal_bid")
    .notNull(),
  poolCode: varchar("poolCode", { length: 60 }),
  // Lifecycle state. Kept separate from planningBlocker below: "where is
  // this posting in its life" and "why is it stuck" are different questions,
  // and conflating them made the state machine unrepresentable.
  planningState: mysqlEnum("planningState", [
    "draft",
    "planning",
    "open_for_bid",
    "invite_only",
    "on_call",
    "direct",
    "bid_closed",
    "awarding",
    "partially_staffed",
    "staffed",
    "dispatched",
    "in_progress",
    "completed",
    "cancelled",
  ])
    .default("draft")
    .notNull(),
  planningBlocker: mysqlEnum("planningBlocker", [
    "none",
    "awaiting_customer",
    "awaiting_permit",
    "awaiting_equipment",
    "awaiting_crew",
    "awaiting_classification",
    "awaiting_disposal_site",
    "weather",
  ])
    .default("none")
    .notNull(),
  // Emergency affects notification urgency and ordering only. It is NOT an
  // input to the readiness gate and cannot weaken a safety blocker.
  priority: mysqlEnum("priority", ["low", "normal", "high", "emergency"])
    .default("normal")
    .notNull(),
  requirementsJson: text("requirementsJson"),
  scheduledStart: timestamp("scheduledStart"),
  estimatedDurationMinutes: int("estimatedDurationMinutes"),
  estimatedDistanceKm: double("estimatedDistanceKm"),
  expectedLoads: int("expectedLoads"),
  crewSize: int("crewSize").default(1).notNull(),
  rateVisible: boolean("rateVisible").default(false).notNull(),
  postedRateCents: int("postedRateCents"),
  bidDeadline: timestamp("bidDeadline"),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// One posting may need several roles — a rig move is a lead, winch tractors,
// a bed truck, a picker and pilot vehicles, each assigned independently.
export const dispatchRoles = mysqlTable("dispatchRoles", {
  id: int("id").autoincrement().primaryKey(),
  postingId: int("postingId").notNull(),
  roleCode: varchar("roleCode", { length: 60 }).notNull(),
  roleLabel: varchar("roleLabel", { length: 180 }).notNull(),
  requiredEquipmentClass: varchar("requiredEquipmentClass", { length: 60 }),
  requiredTrailerClass: varchar("requiredTrailerClass", { length: 60 }),
  requirementsJson: text("requirementsJson"),
  assignedOperatorId: int("assignedOperatorId"),
  assignedUnitId: int("assignedUnitId"),
  assignedTrailerId: int("assignedTrailerId"),
  status: mysqlEnum("status", [
    "open",
    "invited",
    "bid_received",
    "assigned",
    "cancelled",
  ])
    .default("open")
    .notNull(),
  // 0170 — whether this slot holds the posting back from `staffed`. `assessStaffing` has always
  // distinguished required from optional; the data could not say which, so the award passed
  // `required: true` for every row. Default true preserves exactly that.
  required: boolean("required").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * 0170 — the vocabulary `dispatchRoles.roleCode` is drawn from.
 *
 * `orgRef` NULL means "every tenant may use this", which is the opposite of what NULL means
 * elsewhere in this schema, where it marks the historical single tenant's own rows. A catalog is
 * shared vocabulary rather than an owned record, so this table is never read with `orgScopeWhere` —
 * that helper would hide every global row from a real tenant. See `_core/dispatchRoleCatalog.ts`.
 */
export const dispatchRoleTypes = mysqlTable("dispatchRoleTypes", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  roleCode: varchar("roleCode", { length: 60 }).notNull(),
  displayName: varchar("displayName", { length: 120 }).notNull(),
  description: varchar("description", { length: 500 }),
  /** Copied onto a new slot at creation. Never read live — see the module comment. */
  defaultEquipmentClass: varchar("defaultEquipmentClass", { length: 60 }),
  defaultTrailerClass: varchar("defaultTrailerClass", { length: 60 }),
  active: boolean("active").default(true).notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  // Persistent generated column: CONCAT(COALESCE(orgRef,'*'), ':', roleCode), unique. Never written
  // by the application — the database derives it. A nullable composite unique would not have
  // refused a second global row, which is the bug 0021 found and fixed the same way.
  roleTypeKey: varchar("roleTypeKey", { length: 140 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * 0171 — append-only assignment history for a role slot.
 *
 * Deliberately not `dispatchAuditEvents`: that table's `assignment_approved` doubles as the award
 * transaction's idempotency record, so assignment history written there would be indistinguishable
 * from an award to the award's own replay check. An assignment writes here and nowhere else.
 */
export const dispatchRoleAssignmentEvents = mysqlTable("dispatchRoleAssignmentEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 64 }).notNull().unique(),
  roleId: int("roleId").notNull(),
  postingId: int("postingId").notNull(),
  jobId: int("jobId").notNull(),
  orgRef: varchar("orgRef", { length: 64 }),
  eventType: mysqlEnum("eventType", [
    "assignment_created",
    "assignment_reassigned",
    "assignment_unassigned",
  ]).notNull(),
  fromOperatorId: int("fromOperatorId"),
  fromUnitId: int("fromUnitId"),
  fromTrailerId: int("fromTrailerId"),
  toOperatorId: int("toOperatorId"),
  toUnitId: int("toUnitId"),
  toTrailerId: int("toTrailerId"),
  reason: varchar("reason", { length: 500 }),
  actorUserId: int("actorUserId").notNull(),
  actorRole: varchar("actorRole", { length: 60 }).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const dispatchInvitations = mysqlTable("dispatchInvitations", {
  id: int("id").autoincrement().primaryKey(),
  postingId: int("postingId").notNull(),
  roleId: int("roleId"),
  operatorId: int("operatorId"),
  poolCode: varchar("poolCode", { length: 60 }),
  status: mysqlEnum("status", [
    "sent",
    "delivered",
    "viewed",
    "interested",
    "declined",
    "no_response",
    "bid_submitted",
    "awarded",
    "cancelled",
  ])
    .default("sent")
    .notNull(),
  sentAt: timestamp("sentAt").notNull(),
  viewedAt: timestamp("viewedAt"),
  respondedAt: timestamp("respondedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// A bid records willingness. It confers no eligibility whatsoever.
export const dispatchBids = mysqlTable("dispatchBids", {
  id: int("id").autoincrement().primaryKey(),
  postingId: int("postingId").notNull(),
  roleId: int("roleId"),
  operatorId: int("operatorId").notNull(),
  proposedUnitId: int("proposedUnitId"),
  proposedTrailerId: int("proposedTrailerId"),
  earliestDeparture: timestamp("earliestDeparture"),
  estimatedArrival: timestamp("estimatedArrival"),
  bidAmountCents: int("bidAmountCents"),
  acceptsPostedRate: boolean("acceptsPostedRate").default(true).notNull(),
  notes: text("notes"),
  // Snapshot of the match at bid time — a suggestion record, never a verdict.
  matchScore: int("matchScore"),
  matchExplanation: text("matchExplanation"),
  status: mysqlEnum("status", [
    "submitted",
    "withdrawn",
    "awarded",
    "not_selected",
  ])
    .default("submitted")
    .notNull(),
  submittedAt: timestamp("submittedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// The safety gate result, stored separately and timestamped. Awarding
// requires a fresh check — a bid gated three hours ago proves nothing about
// a licence that expired at midnight.
export const dispatchEligibilityChecks = mysqlTable(
  "dispatchEligibilityChecks",
  {
    id: int("id").autoincrement().primaryKey(),
    postingId: int("postingId"),
    jobId: int("jobId"),
    roleId: int("roleId"),
    operatorId: int("operatorId").notNull(),
    unitId: int("unitId"),
    trailerId: int("trailerId"),
    verdict: mysqlEnum("verdict", [
      "eligible",
      "eligible_review",
      "blocked",
      "unknown",
    ]).notNull(),
    blockersJson: text("blockersJson"),
    // Hash of the facts this verdict depended on. A check is reusable only if
    // it is both recent AND still describes the world — freshness alone is
    // worthless if a defect was raised four minutes after the check ran.
    // 0174 (C1a): widened to 80 for `EF2-` + SHA-256.
    fingerprint: varchar("fingerprint", { length: 80 }).notNull(),
    // v22.18 — the route this check asked about, so the award-time recompute
    // asks the same question rather than a smaller one.
    // 0152: the capability picture this decision was made on, including what was not evaluated.
  // NULL = the check predates the contract; it is not backfilled with an assumption.
  capabilitiesJson: text("capabilitiesJson"),
  // 0153: the automation policy this decision was made under. Read by audit; never re-resolved.
  automationPolicyJson: text("automationPolicyJson"),
  capabilityVerdict: varchar("capabilityVerdict", { length: 16 }),
  routeApprovalRef: varchar("routeApprovalRef", { length: 64 }),
  // 0174 (C1a): the rules the findings were decided under, and the acting organization. NULL = legacy / single tenant.
  ruleSetHash: varchar("ruleSetHash", { length: 64 }),
  orgRef: varchar("orgRef", { length: 64 }),
    evaluatedAt: timestamp("evaluatedAt").notNull(),
    evaluatedByUserId: int("evaluatedByUserId"),
    usedForAward: boolean("usedForAward").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  }
);

// Attempted overrides are recorded whether or not they succeed. A refused
// attempt to dispatch a unit with an open critical defect is exactly what an
// auditor needs to see.
export const dispatchOverrides = mysqlTable("dispatchOverrides", {
  id: int("id").autoincrement().primaryKey(),
  eligibilityCheckId: int("eligibilityCheckId"),
  postingId: int("postingId"),
  blockerCode: varchar("blockerCode", { length: 80 }).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  requestedByRole: varchar("requestedByRole", { length: 40 }).notNull(),
  reason: text("reason"),
  granted: boolean("granted").notNull(),
  refusalReason: varchar("refusalReason", { length: 400 }),
  requestedAt: timestamp("requestedAt").notNull(),
  // 0174 (C1a-3): the GRANTOR, separately from the requester. NULL on a granted row = not provably granted.
  grantedByUserId: int("grantedByUserId"),
  grantedByRole: varchar("grantedByRole", { length: 40 }),
  grantedAt: timestamp("grantedAt"),
  grantReason: text("grantReason"),
  overrideClass: varchar("overrideClass", { length: 32 }),
  policyRef: varchar("policyRef", { length: 120 }),
  policyVersion: int("policyVersion"),
  scopeJson: text("scopeJson"),
  expiresAt: timestamp("expiresAt"),
  orgRef: varchar("orgRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const dispatchAuditEvents = mysqlTable("dispatchAuditEvents", {
  id: int("id").autoincrement().primaryKey(),
  postingId: int("postingId"),
  roleId: int("roleId"),
  eventType: varchar("eventType", { length: 60 }).notNull(),
  actorUserId: int("actorUserId"),
  actorRole: varchar("actorRole", { length: 40 }),
  subjectOperatorId: int("subjectOperatorId"),
  detail: text("detail"),
  previousState: varchar("previousState", { length: 80 }),
  newState: varchar("newState", { length: 80 }),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const resourceBookings = mysqlTable("resourceBookings", {
  id: int("id").autoincrement().primaryKey(),
  resourceType: mysqlEnum("resourceType", [
    "operator",
    "unit",
    "trailer",
    "equipment",
  ]).notNull(),
  resourceRef: varchar("resourceRef", { length: 64 }).notNull(),
  postingId: int("postingId"),
  jobId: int("jobId"),
  startsAt: timestamp("startsAt").notNull(),
  endsAt: timestamp("endsAt").notNull(),
  bookingState: mysqlEnum("bookingState", [
    "tentative",
    "confirmed",
    "released",
    "cancelled",
  ])
    .default("tentative")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const dispatchTemplates = mysqlTable("dispatchTemplates", {
  id: int("id").autoincrement().primaryKey(),
  templateCode: varchar("templateCode", { length: 60 }).notNull().unique(),
  label: varchar("label", { length: 180 }).notNull(),
  customer: varchar("customer", { length: 220 }),
  recurrence: varchar("recurrence", { length: 120 }),
  requirementsJson: text("requirementsJson"),
  rolesJson: text("rolesJson"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SpecialtyPool = typeof specialtyPools.$inferSelect;
export type InsertSpecialtyPool = typeof specialtyPools.$inferInsert;
export type OperatorCapability = typeof operatorCapabilities.$inferSelect;
export type InsertOperatorCapability = typeof operatorCapabilities.$inferInsert;
export type OperatorAvailabilityRow = typeof operatorAvailability.$inferSelect;
export type InsertOperatorAvailability =
  typeof operatorAvailability.$inferInsert;
export type OnCallRotation = typeof onCallRotations.$inferSelect;
export type InsertOnCallRotation = typeof onCallRotations.$inferInsert;
export type DispatchPosting = typeof dispatchPostings.$inferSelect;
export type InsertDispatchPosting = typeof dispatchPostings.$inferInsert;
export type DispatchRole = typeof dispatchRoles.$inferSelect;
export type InsertDispatchRole = typeof dispatchRoles.$inferInsert;
export type DispatchInvitation = typeof dispatchInvitations.$inferSelect;
export type InsertDispatchInvitation = typeof dispatchInvitations.$inferInsert;
export type DispatchBid = typeof dispatchBids.$inferSelect;
export type InsertDispatchBid = typeof dispatchBids.$inferInsert;
export type DispatchEligibilityCheck =
  typeof dispatchEligibilityChecks.$inferSelect;
export type InsertDispatchEligibilityCheck =
  typeof dispatchEligibilityChecks.$inferInsert;
export type DispatchOverride = typeof dispatchOverrides.$inferSelect;
export type InsertDispatchOverride = typeof dispatchOverrides.$inferInsert;
export type DispatchAuditEvent = typeof dispatchAuditEvents.$inferSelect;
export type InsertDispatchAuditEvent = typeof dispatchAuditEvents.$inferInsert;
export type ResourceBooking = typeof resourceBookings.$inferSelect;
export type InsertResourceBooking = typeof resourceBookings.$inferInsert;
export type DispatchTemplate = typeof dispatchTemplates.$inferSelect;
export type InsertDispatchTemplate = typeof dispatchTemplates.$inferInsert;

// ===================== ASSISTANT PROPOSALS =====================
// A spoken sentence becomes a proposal, not a record. These tables hold the
// draft while it waits on a person, and keep the utterance it came from so an
// interpretation can be checked rather than trusted.

export const formDefinitions = mysqlTable("formDefinitions", {
  id: int("id").autoincrement().primaryKey(),
  formKey: varchar("formKey", { length: 60 }).notNull(),
  version: int("version").default(1).notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  fieldsJson: text("fieldsJson").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const assistantProposals = mysqlTable("assistantProposals", {
  id: int("id").autoincrement().primaryKey(),
  proposalId: varchar("proposalId", { length: 40 }).notNull().unique(),
  formKey: varchar("formKey", { length: 60 }).notNull(),
  formVersion: int("formVersion").default(1).notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  /** The record this would modify, e.g. "TRIP-2026-004821 unload stop". */
  targetRef: varchar("targetRef", { length: 180 }).notNull(),
  // Human-readable refs are not safe write targets. Typed commit adapters use
  // this structured id when updating an existing operational record.
  targetRecordId: int("targetRecordId"),
  // Local date + UTC offset anchor HH:MM form values without guessing a day
  // or silently applying the server timezone. Example MDT offset: -360.
  eventDateLocal: varchar("eventDateLocal", { length: 10 }),
  utcOffsetMinutes: int("utcOffsetMinutes"),
  jobId: int("jobId"),
  tripId: int("tripId"),
  unitId: int("unitId"),
  // v20.16 — server-resolved, like tripId and unitId.
  loadId: int("loadId"),
  facilityId: int("facilityId"),
  // v20.18 — resolved from the card token at capture, like loadId.
  fleetCardId: int("fleetCardId"),
  // v20.17 — a recorded human act, not a client flag.
  duplicateOverride: boolean("duplicateOverride").default(false).notNull(),
  duplicateOverrideByUserId: int("duplicateOverrideByUserId"),
  duplicateOverrideReason: varchar("duplicateOverrideReason", { length: 400 }),
  operatorId: int("operatorId"),
  createdByUserId: int("createdByUserId"),
  transcript: text("transcript"),
  notes: text("notes"),
  readBack: text("readBack"),
  readBackAcknowledged: boolean("readBackAcknowledged")
    .default(false)
    .notNull(),
  commitState: mysqlEnum("commitState", [
    "drafting",
    "awaiting_answers",
    "awaiting_readback",
    "committed",
    "rejected",
  ])
    .default("drafting")
    .notNull(),
  // Set when the model asserted something it has no standing to assert.
  // Kept rather than discarded — a pattern of these is worth seeing.
  overreachFlags: text("overreachFlags"),
  capturedOffline: boolean("capturedOffline").default(false).notNull(),
  committedAt: timestamp("committedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const proposalFields = mysqlTable("proposalFields", {
  id: int("id").autoincrement().primaryKey(),
  proposalId: varchar("proposalId", { length: 40 }).notNull(),
  fieldKey: varchar("fieldKey", { length: 60 }).notNull(),
  label: varchar("label", { length: 180 }).notNull(),
  fieldValue: text("fieldValue"),
  // "About 8,000 litres" must never become an exact measured quantity.
  precision: mysqlEnum("precision", ["exact", "approximate"])
    .default("approximate")
    .notNull(),
  source: mysqlEnum("source", [
    "driver_voice",
    "driver_typed",
    "gps",
    "photo_ocr",
    "system_inferred",
    "imported",
    "human_corrected",
  ]).notNull(),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"])
    .default("medium")
    .notNull(),
  status: mysqlEnum("status", [
    "proposed",
    "confirmed",
    "rejected",
    "corrected",
  ])
    .default("proposed")
    .notNull(),
  /** The speaker's own words, so an interpretation can be checked. */
  sourceUtterance: varchar("sourceUtterance", { length: 400 }),
  correctedFrom: text("correctedFrom"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type FormDefinitionRow = typeof formDefinitions.$inferSelect;
export type InsertFormDefinition = typeof formDefinitions.$inferInsert;
export type AssistantProposal = typeof assistantProposals.$inferSelect;
export type InsertAssistantProposal = typeof assistantProposals.$inferInsert;
export type ProposalField = typeof proposalFields.$inferSelect;
export type InsertProposalField = typeof proposalFields.$inferInsert;

// One receipt per proposal is the database idempotency boundary for Assistant
// commits. A proposal can be retried; it may create/update its target once.
export const assistantCommitReceipts = mysqlTable("assistantCommitReceipts", {
  id: int("id").autoincrement().primaryKey(),
  proposalId: varchar("proposalId", { length: 40 }).notNull().unique(),
  formKey: varchar("formKey", { length: 60 }).notNull(),
  action: mysqlEnum("action", ["create", "update"]).notNull(),
  targetType: mysqlEnum("targetType", [
    "trip_stop",
    "maintenance_defect",
    // v20.15
    "expense_record",
    // v20.16
    "disposal_ticket",
    // v20.18
    "fuel_transaction",
  ]).notNull(),
  targetRecordId: int("targetRecordId").notNull(),
  requiredPermission: varchar("requiredPermission", { length: 80 }).notNull(),
  authorizationDecisionId: int("authorizationDecisionId"),
  adapterVersion: varchar("adapterVersion", { length: 40 }).notNull(),
  fieldManifest: text("fieldManifest").notNull(),
  fieldManifestHash: varchar("fieldManifestHash", { length: 64 }).notNull(),
  actorUserId: int("actorUserId").notNull(),
  committedAt: timestamp("committedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AssistantCommitReceipt = typeof assistantCommitReceipts.$inferSelect;
export type InsertAssistantCommitReceipt = typeof assistantCommitReceipts.$inferInsert;

// ===================== WORKFLOW ORCHESTRATION =====================
// Event → policy → task/workflow → owner → notification → resolution → audit.
// These tables coordinate the domain engines; they never override them.

// Transactional outbox. A state change and its event commit together, so a
// crash between them cannot lose the event.
export const domainEventOutbox = mysqlTable("domainEventOutbox", {
  id: int("id").autoincrement().primaryKey(),
  eventId: varchar("eventId", { length: 40 }).notNull().unique(),
  eventType: varchar("eventType", { length: 80 }).notNull(),
  eventVersion: int("eventVersion").default(1).notNull(),
  aggregateType: varchar("aggregateType", { length: 40 }).notNull(),
  aggregateId: varchar("aggregateId", { length: 64 }).notNull(),
  tenantId: varchar("tenantId", { length: 40 }).notNull(),
  branchId: varchar("branchId", { length: 40 }),
  jobId: varchar("jobId", { length: 64 }),
  tripId: varchar("tripId", { length: 64 }),
  unitId: varchar("unitId", { length: 64 }),
  correlationId: varchar("correlationId", { length: 40 }),
  causationId: varchar("causationId", { length: 40 }),
  actorSource: mysqlEnum("actorSource", [
    "human",
    "system",
    "ai",
    "integration",
  ])
    .default("system")
    .notNull(),
  actorUserId: varchar("actorUserId", { length: 40 }),
  payloadJson: text("payloadJson").notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  // Claimed by exactly one worker via SELECT ... FOR UPDATE SKIP LOCKED.
  claimedAt: timestamp("claimedAt"),
  /** The lease. Old enough and another worker may take the event. */
  retryAvailableAt: timestamp("retryAvailableAt"),
  deadLetteredAt: timestamp("deadLetteredAt"),
  deadLetterReason: varchar("deadLetterReason", { length: 1000 }),
  claimedBy: varchar("claimedBy", { length: 64 }),
  processedAt: timestamp("processedAt"),
  attemptCount: int("attemptCount").default(0).notNull(),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const workflowRules = mysqlTable("workflowRules", {
  id: int("id").autoincrement().primaryKey(),
  ruleKey: varchar("ruleKey", { length: 80 }).notNull(),
  version: int("version").default(1).notNull(),
  name: varchar("name", { length: 180 }).notNull(),
  description: text("description"),
  eventType: varchar("eventType", { length: 80 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  tenantId: varchar("tenantId", { length: 40 }),
  branchId: varchar("branchId", { length: 40 }),
  conditionsJson: text("conditionsJson").notNull(),
  actionsJson: text("actionsJson").notNull(),
  dedupeOnJson: text("dedupeOnJson"),
  source: varchar("source", { length: 180 }),
  createdBy: int("createdBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const operationalTasks = mysqlTable("operationalTasks", {
  id: int("id").autoincrement().primaryKey(),
  taskNumber: varchar("taskNumber", { length: 40 }).notNull().unique(),
  taskType: varchar("taskType", { length: 60 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  description: text("description"),
  status: mysqlEnum("status", [
    "open",
    "acknowledged",
    "in_progress",
    "waiting",
    "completed",
    "cancelled",
  ])
    .default("open")
    .notNull(),
  priority: mysqlEnum("priority", ["low", "normal", "high", "critical"])
    .default("normal")
    .notNull(),
  tenantId: varchar("tenantId", { length: 40 }).notNull(),
  branchId: varchar("branchId", { length: 40 }),
  subjectType: varchar("subjectType", { length: 40 }).notNull(),
  subjectId: varchar("subjectId", { length: 64 }).notNull(),
  jobId: varchar("jobId", { length: 64 }),
  tripId: varchar("tripId", { length: 64 }),
  unitId: varchar("unitId", { length: 64 }),
  assignedRole: varchar("assignedRole", { length: 60 }).notNull(),
  assignedUserId: int("assignedUserId"),
  sourceEventId: varchar("sourceEventId", { length: 40 }),
  sourceRuleKey: varchar("sourceRuleKey", { length: 80 }),
  sourceRuleVersion: int("sourceRuleVersion"),
  // One unresolved condition, one active task — however often the event fires.
  dedupeKey: varchar("dedupeKey", { length: 300 }).notNull(),
  rootDedupeKey: varchar("rootDedupeKey", { length: 300 }),
  // Regulated conditions do not clear because somebody pressed Done.
  requiresEvidence: boolean("requiresEvidence").default(false).notNull(),
  completionEvidenceRef: varchar("completionEvidenceRef", { length: 120 }),
  resolutionCode: varchar("resolutionCode", { length: 60 }),
  resolutionNote: text("resolutionNote"),
  escalationStep: int("escalationStep").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  dueAt: timestamp("dueAt"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  completedAt: timestamp("completedAt"),
  cancelledAt: timestamp("cancelledAt"),
});

export const workflowInstances = mysqlTable("workflowInstances", {
  id: int("id").autoincrement().primaryKey(),
  workflowNumber: varchar("workflowNumber", { length: 40 }).notNull().unique(),
  workflowKey: varchar("workflowKey", { length: 60 }).notNull(),
  currentState: varchar("currentState", { length: 60 }).notNull(),
  tenantId: varchar("tenantId", { length: 40 }).notNull(),
  branchId: varchar("branchId", { length: 40 }),
  subjectType: varchar("subjectType", { length: 40 }).notNull(),
  subjectId: varchar("subjectId", { length: 64 }).notNull(),
  jobId: varchar("jobId", { length: 64 }),
  tripId: varchar("tripId", { length: 64 }),
  unitId: varchar("unitId", { length: 64 }),
  dedupeKey: varchar("dedupeKey", { length: 300 }).notNull(),
  sourceEventId: varchar("sourceEventId", { length: 40 }),
  openedAt: timestamp("openedAt").notNull(),
  closedAt: timestamp("closedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Append-only. Workflow history is never overwritten.
export const workflowTransitions = mysqlTable("workflowTransitions", {
  id: int("id").autoincrement().primaryKey(),
  workflowNumber: varchar("workflowNumber", { length: 40 }).notNull(),
  fromState: varchar("fromState", { length: 60 }).notNull(),
  toState: varchar("toState", { length: 60 }).notNull(),
  action: varchar("action", { length: 80 }),
  actorUserId: int("actorUserId"),
  actorRole: varchar("actorRole", { length: 40 }),
  actorSource: mysqlEnum("actorSource", [
    "human",
    "system",
    "ai",
    "integration",
  ])
    .default("human")
    .notNull(),
  sourceEventId: varchar("sourceEventId", { length: 40 }),
  ruleKey: varchar("ruleKey", { length: 80 }),
  ruleVersion: int("ruleVersion"),
  evidenceRef: varchar("evidenceRef", { length: 120 }),
  reason: text("reason"),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Records exist independently of delivery channel, so a failed email is
// visible rather than silently lost.
export const workflowNotifications = mysqlTable("workflowNotifications", {
  id: int("id").autoincrement().primaryKey(),
  notificationKey: varchar("notificationKey", { length: 200 })
    .notNull()
    .unique(),
  taskId: int("taskId"),
  workflowNumber: varchar("workflowNumber", { length: 40 }),
  tenantId: varchar("tenantId", { length: 40 }).notNull(),
  recipientRole: varchar("recipientRole", { length: 60 }),
  recipientUserId: int("recipientUserId"),
  title: varchar("title", { length: 220 }).notNull(),
  body: text("body"),
  deepLink: varchar("deepLink", { length: 300 }),
  channel: mysqlEnum("channel", [
    "in_app",
    "push",
    "email",
    "sms",
    "integration",
  ])
    .default("in_app")
    .notNull(),
  status: mysqlEnum("status", [
    "queued",
    "sent",
    "delivered",
    "viewed",
    "acknowledged",
    "failed",
  ])
    .default("queued")
    .notNull(),
  queuedAt: timestamp("queuedAt").notNull(),
  sentAt: timestamp("sentAt"),
  viewedAt: timestamp("viewedAt"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  failureReason: text("failureReason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DomainEventOutboxRow = typeof domainEventOutbox.$inferSelect;
export type InsertDomainEventOutbox = typeof domainEventOutbox.$inferInsert;
export type WorkflowRuleRow = typeof workflowRules.$inferSelect;
export type InsertWorkflowRule = typeof workflowRules.$inferInsert;
export type OperationalTaskRow = typeof operationalTasks.$inferSelect;
export type InsertOperationalTask = typeof operationalTasks.$inferInsert;
export type WorkflowInstanceRow = typeof workflowInstances.$inferSelect;
export type InsertWorkflowInstance = typeof workflowInstances.$inferInsert;
export type WorkflowTransitionRow = typeof workflowTransitions.$inferSelect;
export type InsertWorkflowTransition = typeof workflowTransitions.$inferInsert;
export type WorkflowNotificationRow = typeof workflowNotifications.$inferSelect;
export type InsertWorkflowNotification =
  typeof workflowNotifications.$inferInsert;

// ============ BILLING ADJUSTMENTS, DISPUTES, THIRD-PARTY WORK ============
// A finalised invoice and its hashed snapshot are immutable. Office staff
// correct billing by issuing records that REFERENCE the original, so
// "what did we charge" and "what did we change after" stay separable.

export const billingAdjustments = mysqlTable("billingAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  adjustmentNumber: varchar("adjustmentNumber", { length: 64 })
    .notNull()
    .unique(),
  invoiceNumber: varchar("invoiceNumber", { length: 64 }).notNull(),
  invoiceId: int("invoiceId"),
  invoiceLineRef: varchar("invoiceLineRef", { length: 64 }),
  billingBookId: int("billingBookId"),
  jobId: int("jobId"),
  kind: mysqlEnum("kind", [
    "credit",
    "debit",
    "write_off",
    "reclassify",
    "rate_correction",
  ]).notNull(),
  amountCents: int("amountCents").notNull(),
  /** Signed effect on the receivable; the running total derives from these. */
  signedCents: int("signedCents").notNull(),
  reasonCode: varchar("reasonCode", { length: 60 }).notNull(),
  narrative: text("narrative").notNull(),
  evidenceRef: varchar("evidenceRef", { length: 120 }),
  createdByUserId: int("createdByUserId").notNull(),
  createdByRole: varchar("createdByRole", { length: 40 }).notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedByRole: varchar("approvedByRole", { length: 40 }),
  approvedAt: timestamp("approvedAt"),
  /** Set only when a matching payable decision was taken on the sub side. */
  payableAdjustmentNumber: varchar("payableAdjustmentNumber", { length: 64 }),
  disputeCaseNumber: varchar("disputeCaseNumber", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const billingAuthorityBands = mysqlTable("billingAuthorityBands", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: varchar("tenantId", { length: 40 }),
  role: varchar("role", { length: 40 }).notNull(),
  maxCents: int("maxCents"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const disputeCases = mysqlTable("disputeCases", {
  id: int("id").autoincrement().primaryKey(),
  caseNumber: varchar("caseNumber", { length: 64 }).notNull().unique(),
  invoiceNumber: varchar("invoiceNumber", { length: 64 }),
  invoiceLineRef: varchar("invoiceLineRef", { length: 64 }),
  jobId: int("jobId"),
  customer: varchar("customer", { length: 220 }).notNull(),
  raisedByName: varchar("raisedByName", { length: 180 }),
  raisedByCompany: varchar("raisedByCompany", { length: 180 }),
  disputedAmountCents: int("disputedAmountCents"),
  reasonStated: text("reasonStated"),
  status: mysqlEnum("status", [
    "raised",
    "investigating",
    "evidence_gathered",
    "resolved_upheld",
    "resolved_credited",
    "resolved_partial",
    "escalated",
    "withdrawn",
  ])
    .default("raised")
    .notNull(),
  ourEvidenceRefs: text("ourEvidenceRefs"),
  resolutionNarrative: text("resolutionNarrative"),
  assignedUserId: int("assignedUserId"),
  raisedAt: timestamp("raisedAt").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const subcontractors = mysqlTable("subcontractors", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 220 }).notNull(),
  contactName: varchar("contactName", { length: 180 }),
  contactPhone: varchar("contactPhone", { length: 60 }),
  contactEmail: varchar("contactEmail", { length: 220 }),
  wcbNumber: varchar("wcbNumber", { length: 80 }),
  insuranceExpiresAt: timestamp("insuranceExpiresAt"),
  safetyProgramVerifiedAt: timestamp("safetyProgramVerifiedAt"),
  // Same discipline as our own units: unverified is not approved.
  approvalStatus: mysqlEnum("approvalStatus", [
    "pending",
    "approved",
    "suspended",
    "expired",
  ])
    .default("pending")
    .notNull(),
  paymentTermsDays: int("paymentTermsDays").default(30).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const subcontractedLines = mysqlTable("subcontractedLines", {
  id: int("id").autoincrement().primaryKey(),
  lineRef: varchar("lineRef", { length: 64 }).notNull(),
  jobId: int("jobId"),
  billingBookId: int("billingBookId"),
  invoiceNumber: varchar("invoiceNumber", { length: 64 }),
  subcontractorId: int("subcontractorId").notNull(),
  basis: mysqlEnum("basis", [
    "pass_through",
    "marked_up",
    "fixed_resale",
  ]).notNull(),
  /** What the sub invoices us. */
  costCents: int("costCents").notNull(),
  /** What we invoice the client. */
  billedCents: int("billedCents").notNull(),
  subInvoiceRef: varchar("subInvoiceRef", { length: 80 }),
  workVerifiedBy: varchar("workVerifiedBy", { length: 180 }),
  workVerifiedAt: timestamp("workVerifiedAt"),
  payableStatus: mysqlEnum("payableStatus", [
    "pending",
    "approved",
    "held",
    "paid",
    "disputed",
    "short_paid",
  ])
    .default("pending")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Reducing what a subcontractor is owed is a claim against them, not a
// bookkeeping entry — it carries its own notice and acknowledgement.
export const payableAdjustments = mysqlTable("payableAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  payableAdjustmentNumber: varchar("payableAdjustmentNumber", { length: 64 })
    .notNull()
    .unique(),
  subcontractorId: int("subcontractorId").notNull(),
  subcontractedLineRef: varchar("subcontractedLineRef", { length: 64 }),
  relatedAdjustmentNumber: varchar("relatedAdjustmentNumber", { length: 64 }),
  amountCents: int("amountCents").notNull(),
  attribution: mysqlEnum("attribution", [
    "our_cost",
    "subcontractor_fault",
    "shared",
  ]).notNull(),
  marginImpactCents: int("marginImpactCents").notNull(),
  narrative: text("narrative").notNull(),
  noticeSentAt: timestamp("noticeSentAt"),
  subcontractorAcknowledgedAt: timestamp("subcontractorAcknowledgedAt"),
  subcontractorDisputed: boolean("subcontractorDisputed")
    .default(false)
    .notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const calloutRecords = mysqlTable("calloutRecords", {
  id: int("id").autoincrement().primaryKey(),
  calloutRef: varchar("calloutRef", { length: 64 }).notNull().unique(),
  jobId: int("jobId"),
  receivedAt: timestamp("receivedAt").notNull(),
  receivedByUserId: int("receivedByUserId"),
  callerName: varchar("callerName", { length: 180 }),
  callerCompany: varchar("callerCompany", { length: 220 }),
  callerPhone: varchar("callerPhone", { length: 60 }),
  claimedAuthority: mysqlEnum("claimedAuthority", [
    "client_representative",
    "client_office",
    "third_party_operator",
    "emergency_services",
    "unknown",
  ])
    .default("unknown")
    .notNull(),
  // Unverified authority means review, never silent billing and never a
  // silent write-off.
  authorityVerified: boolean("authorityVerified").default(false).notNull(),
  verifiedBy: varchar("verifiedBy", { length: 180 }),
  verifiedAt: timestamp("verifiedAt"),
  afeNumber: varchar("afeNumber", { length: 80 }),
  purchaseOrder: varchar("purchaseOrder", { length: 80 }),
  billToParty: varchar("billToParty", { length: 220 }),
  billableStatus: mysqlEnum("billableStatus", ["yes", "review", "no"])
    .default("review")
    .notNull(),
  blockersJson: text("blockersJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type BillingAdjustmentRow = typeof billingAdjustments.$inferSelect;
export type InsertBillingAdjustment = typeof billingAdjustments.$inferInsert;
export type BillingAuthorityBand = typeof billingAuthorityBands.$inferSelect;
export type InsertBillingAuthorityBand =
  typeof billingAuthorityBands.$inferInsert;
export type DisputeCase = typeof disputeCases.$inferSelect;
export type InsertDisputeCase = typeof disputeCases.$inferInsert;
export type Subcontractor = typeof subcontractors.$inferSelect;
export type InsertSubcontractor = typeof subcontractors.$inferInsert;
export type SubcontractedLineRow = typeof subcontractedLines.$inferSelect;
export type InsertSubcontractedLine = typeof subcontractedLines.$inferInsert;
export type PayableAdjustment = typeof payableAdjustments.$inferSelect;
export type InsertPayableAdjustment = typeof payableAdjustments.$inferInsert;
export type CalloutRecordRow = typeof calloutRecords.$inferSelect;
export type InsertCalloutRecord = typeof calloutRecords.$inferInsert;

/* ==================================================================
 * B20 — Records, Evidence & Compliance Vault
 * ================================================================== */

export const evidenceRelationships = mysqlTable("evidenceRelationships", {
  id: int("id").autoincrement().primaryKey(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  entityType: mysqlEnum("entityType", [
    "operator", "unit", "trailer", "equipment", "job", "trip", "load",
    "manifest", "disposalTicket", "fieldTicket", "workOrder", "incident",
    "nearMiss", "safetyMeeting", "invoice", "customer", "facility",
    "dailyLog", "inspection",
    // v20.17
    "expenseRecord", "financialEntity", "taxYear", "user",
    // v20.18
    "fuelTransaction",
  ]).notNull(),
  entityId: int("entityId"),
  entityRef: varchar("entityRef", { length: 64 }),
  role: varchar("role", { length: 60 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const evidenceVersions = mysqlTable("evidenceVersions", {
  id: int("id").autoincrement().primaryKey(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  version: int("version").notNull(),
  supersedesVersion: int("supersedesVersion"),
  storageKey: varchar("storageKey", { length: 512 }),
  mimeType: varchar("mimeType", { length: 120 }),
  byteSize: int("byteSize"),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  manifestHash: varchar("manifestHash", { length: 64 }).notNull(),
  amendmentReason: text("amendmentReason"),
  amendedByUserId: int("amendedByUserId"),
  amendedByRole: varchar("amendedByRole", { length: 40 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const evidenceSeals = mysqlTable("evidenceSeals", {
  id: int("id").autoincrement().primaryKey(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  version: int("version").default(1).notNull(),
  canonicalManifest: text("canonicalManifest").notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  manifestHash: varchar("manifestHash", { length: 64 }).notNull(),
  hashAlgorithm: varchar("hashAlgorithm", { length: 20 }).default("sha256").notNull(),
  sealedAt: timestamp("sealedAt").notNull(),
  sealedByUserId: int("sealedByUserId").notNull(),
  sealedByEmployeeNumber: varchar("sealedByEmployeeNumber", { length: 40 }),
  deviceId: varchar("deviceId", { length: 120 }),
  devicePlatform: varchar("devicePlatform", { length: 40 }),
  capturedLatitude: double("capturedLatitude"),
  capturedLongitude: double("capturedLongitude"),
  serverVerifiedAt: timestamp("serverVerifiedAt"),
  verificationResult: mysqlEnum("verificationResult", [
    "pending", "verified", "hash_mismatch", "manifest_mismatch",
    // 0157: the server tried to read the stored object and could not. Not "pending", which would
    // say the check has not happened; not a mismatch, which nobody observed.
    "content_unavailable",
  ]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const retentionPolicies = mysqlTable("retentionPolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyKey: varchar("policyKey", { length: 80 }).notNull().unique(),
  recordType: varchar("recordType", { length: 60 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }),
  statutoryMinimumMonths: int("statutoryMinimumMonths"),
  statutorySourceStatus: mysqlEnum("statutorySourceStatus", [
    "unverified", "verified", "not_applicable",
  ]).default("unverified").notNull(),
  statutorySourceRef: varchar("statutorySourceRef", { length: 400 }),
  statutorySourceVersion: varchar("statutorySourceVersion", { length: 80 }),
  statutoryLastVerifiedAt: timestamp("statutoryLastVerifiedAt"),
  companyRetentionMonths: int("companyRetentionMonths").notNull(),
  contractRetentionMonths: int("contractRetentionMonths"),
  deviceRetentionDays: int("deviceRetentionDays"),
  deletionRequiresOfficeReceipt: boolean("deletionRequiresOfficeReceipt").default(true).notNull(),
  legalHoldOverridesDeletion: boolean("legalHoldOverridesDeletion").default(true).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const recordRetentionState = mysqlTable("recordRetentionState", {
  id: int("id").autoincrement().primaryKey(),
  evidenceRecordId: int("evidenceRecordId").notNull().unique(),
  retentionPolicyId: int("retentionPolicyId"),
  effectiveRetentionMonths: int("effectiveRetentionMonths"),
  retentionBasis: varchar("retentionBasis", { length: 60 }),
  officeRetainUntil: timestamp("officeRetainUntil"),
  deviceRetainUntil: timestamp("deviceRetainUntil"),
  officeReceivedAt: timestamp("officeReceivedAt"),
  officeIntegrityVerifiedAt: timestamp("officeIntegrityVerifiedAt"),
  officeReviewedAt: timestamp("officeReviewedAt"),
  officeReviewedByUserId: int("officeReviewedByUserId"),
  deviceCopyDeletedAt: timestamp("deviceCopyDeletedAt"),
  deviceCopyDeletedByUserId: int("deviceCopyDeletedByUserId"),
  dispositionedAt: timestamp("dispositionedAt"),
  dispositionedByUserId: int("dispositionedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const legalHolds = mysqlTable("legalHolds", {
  id: int("id").autoincrement().primaryKey(),
  holdNumber: varchar("holdNumber", { length: 64 }).notNull().unique(),
  reason: text("reason").notNull(),
  matterRef: varchar("matterRef", { length: 120 }),
  incidentNumber: varchar("incidentNumber", { length: 64 }),
  placedByUserId: int("placedByUserId").notNull(),
  placedByRole: varchar("placedByRole", { length: 40 }).notNull(),
  placedAt: timestamp("placedAt").notNull(),
  releasedByUserId: int("releasedByUserId"),
  releasedByRole: varchar("releasedByRole", { length: 40 }),
  releasedAt: timestamp("releasedAt"),
  releaseReason: text("releaseReason"),
  releaseAuthority: varchar("releaseAuthority", { length: 180 }),
  status: mysqlEnum("status", ["active", "released"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const legalHoldRecords = mysqlTable("legalHoldRecords", {
  id: int("id").autoincrement().primaryKey(),
  legalHoldId: int("legalHoldId").notNull(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  addedAt: timestamp("addedAt").defaultNow().notNull(),
  addedByUserId: int("addedByUserId"),
});

export const syncPackages = mysqlTable("syncPackages", {
  id: int("id").autoincrement().primaryKey(),
  /** 0142 — exact_wire: signature verified over the bytes the device signed; reconstructed: over a re-canonicalized parse (pre-0142 devices). */
  verificationMode: mysqlEnum("verificationMode", ["exact_wire", "reconstructed", "unverified"]).default("unverified").notNull(),
  deviceClockAt: timestamp("deviceClockAt"),
  clockSkewMs: int("clockSkewMs"),
  packageRef: varchar("packageRef", { length: 64 }).notNull().unique(),
  deviceId: varchar("deviceId", { length: 120 }).notNull(),
  // v20.20 — an enrolled device, and the key it signed with.
  fieldDeviceId: int("fieldDeviceId"),
  signedWithFingerprint: varchar("signedWithFingerprint", { length: 64 }),
  operatorId: int("operatorId"),
  state: mysqlEnum("state", [
    "queued", "waiting_for_service", "transmitting", "server_received",
    "hash_verified", "office_accepted", "failed", "rejected",
  ]).default("queued").notNull(),
  itemCount: int("itemCount").default(0).notNull(),
  queuedAt: timestamp("queuedAt").notNull(),
  lastAttemptAt: timestamp("lastAttemptAt"),
  attemptCount: int("attemptCount").default(0).notNull(),
  serverReceivedAt: timestamp("serverReceivedAt"),
  hashVerifiedAt: timestamp("hashVerifiedAt"),
  officeAcceptedAt: timestamp("officeAcceptedAt"),
  failureReason: text("failureReason"),
  refusalReason: varchar("refusalReason", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const syncPackageItems = mysqlTable("syncPackageItems", {
  id: int("id").autoincrement().primaryKey(),
  syncPackageId: int("syncPackageId").notNull(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  declaredContentHash: varchar("declaredContentHash", { length: 64 }).notNull(),
  declaredManifestHash: varchar("declaredManifestHash", { length: 64 }).notNull(),
  // 0079 — historical capture context, never inferred from later sync success.
  captureAuthorizationClaim: mysqlEnum("captureAuthorizationClaim", ["authorized", "unauthorized", "unknown"]).default("unknown").notNull(),
  captureAuthorizationReason: varchar("captureAuthorizationReason", { length: 300 }),
  state: mysqlEnum("state", ["pending", "received", "verified", "mismatch"])
    .default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const syncReceipts = mysqlTable("syncReceipts", {
  id: int("id").autoincrement().primaryKey(),
  syncPackageId: int("syncPackageId").notNull(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  computedContentHash: varchar("computedContentHash", { length: 64 }).notNull(),
  computedManifestHash: varchar("computedManifestHash", { length: 64 }).notNull(),
  matched: boolean("matched").notNull(),
  receivedAt: timestamp("receivedAt").notNull(),
  failureDetail: text("failureDetail"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const incidentReports = mysqlTable("incidentReports", {
  id: int("id").autoincrement().primaryKey(),
  incidentNumber: varchar("incidentNumber", { length: 64 }).notNull().unique(),
  incidentType: mysqlEnum("incidentType", [
    "hazard_observation", "near_miss", "incident", "collision", "injury",
    "environmental_release", "property_damage", "equipment_event",
  ]).notNull(),
  severity: mysqlEnum("severity", ["none", "minor", "moderate", "serious", "critical"])
    .default("minor").notNull(),
  operatorId: int("operatorId"),
  employeeNumber: varchar("employeeNumber", { length: 40 }),
  jobId: int("jobId"),
  tripId: int("tripId"),
  unitId: int("unitId"),
  trailerId: int("trailerId"),
  occurredAt: timestamp("occurredAt").notNull(),
  reportedAt: timestamp("reportedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  locationDescription: varchar("locationDescription", { length: 400 }),
  originalStatement: text("originalStatement").notNull(),
  originalStatementSource: mysqlEnum("originalStatementSource", [
    "typed", "voice", "dictated_transcript",
  ]).default("typed").notNull(),
  structuredSummary: text("structuredSummary"),
  summarySource: mysqlEnum("summarySource", ["human", "ai_proposed", "ai_confirmed"])
    .default("human").notNull(),
  injuryReported: boolean("injuryReported").default(false).notNull(),
  emergencyServicesAttended: boolean("emergencyServicesAttended").default(false).notNull(),
  policeAttended: boolean("policeAttended").default(false).notNull(),
  environmentalRelease: boolean("environmentalRelease").default(false).notNull(),
  dangerousGoodsInvolved: boolean("dangerousGoodsInvolved").default(false).notNull(),
  unNumber: varchar("unNumber", { length: 20 }),
  dangerousGoodsClass: varchar("dangerousGoodsClass", { length: 20 }),
  dangerousGoodsVerified: boolean("dangerousGoodsVerified").default(false).notNull(),
  workStopped: boolean("workStopped").default(false).notNull(),
  unitHeld: boolean("unitHeld").default(false).notNull(),
  supervisorNotifiedAt: timestamp("supervisorNotifiedAt"),
  supervisorUserId: int("supervisorUserId"),
  safetyReviewedAt: timestamp("safetyReviewedAt"),
  safetyReviewedByUserId: int("safetyReviewedByUserId"),
  escalationState: mysqlEnum("escalationState", [
    "captured", "sealed", "management_notified", "under_review",
    "corrective_action", "closed",
  ]).default("captured").notNull(),
  convertedFromNearMissId: int("convertedFromNearMissId"),
  status: mysqlEnum("status", ["open", "under_review", "closed"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const incidentPeople = mysqlTable("incidentPeople", {
  id: int("id").autoincrement().primaryKey(),
  incidentReportId: int("incidentReportId").notNull(),
  role: mysqlEnum("role", ["involved", "witness", "injured", "supervisor", "third_party"]).notNull(),
  operatorId: int("operatorId"),
  employeeNumber: varchar("employeeNumber", { length: 40 }),
  name: varchar("name", { length: 180 }),
  company: varchar("company", { length: 180 }),
  contact: varchar("contact", { length: 180 }),
  statement: text("statement"),
  statementSource: mysqlEnum("statementSource", ["typed", "voice", "dictated_transcript"]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const incidentActions = mysqlTable("incidentActions", {
  id: int("id").autoincrement().primaryKey(),
  incidentReportId: int("incidentReportId").notNull(),
  actionType: mysqlEnum("actionType", ["immediate", "corrective", "preventive", "notification"]).notNull(),
  description: text("description").notNull(),
  assignedToUserId: int("assignedToUserId"),
  dueAt: timestamp("dueAt"),
  completedAt: timestamp("completedAt"),
  completedByUserId: int("completedByUserId"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const nearMissReports = mysqlTable("nearMissReports", {
  id: int("id").autoincrement().primaryKey(),
  nearMissNumber: varchar("nearMissNumber", { length: 64 }).notNull().unique(),
  operatorId: int("operatorId"),
  employeeNumber: varchar("employeeNumber", { length: 40 }),
  jobId: int("jobId"),
  unitId: int("unitId"),
  occurredAt: timestamp("occurredAt").notNull(),
  reportedAt: timestamp("reportedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  originalStatement: text("originalStatement").notNull(),
  originalStatementSource: mysqlEnum("originalStatementSource", [
    "typed", "voice", "dictated_transcript",
  ]).default("typed").notNull(),
  structuredSummary: text("structuredSummary"),
  anyoneInjured: boolean("anyoneInjured").default(false).notNull(),
  workStopped: boolean("workStopped").default(false).notNull(),
  escalatedToIncidentId: int("escalatedToIncidentId"),
  escalatedAt: timestamp("escalatedAt"),
  reviewedAt: timestamp("reviewedAt"),
  reviewedByUserId: int("reviewedByUserId"),
  status: mysqlEnum("status", ["open", "reviewed", "escalated", "closed"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const workOrderReleases = mysqlTable("workOrderReleases", {
  id: int("id").autoincrement().primaryKey(),
  workOrderId: int("workOrderId").notNull(),
  unitId: int("unitId").notNull(),
  releaseType: mysqlEnum("releaseType", ["full", "restricted", "revoked"]).notNull(),
  restrictionDetail: text("restrictionDetail"),
  repairSummary: text("repairSummary").notNull(),
  testProcedure: text("testProcedure"),
  testResult: mysqlEnum("testResult", ["pass", "fail", "not_required"]),
  roadTestPerformed: boolean("roadTestPerformed").default(false).notNull(),
  roadTestNotes: text("roadTestNotes"),
  technicianUserId: int("technicianUserId").notNull(),
  technicianIdentifier: varchar("technicianIdentifier", { length: 80 }).notNull(),
  technicianCertificationRef: varchar("technicianCertificationRef", { length: 120 }),
  releasedAt: timestamp("releasedAt").notNull(),
  resolvedDefectIds: varchar("resolvedDefectIds", { length: 400 }),
  supersededByReleaseId: int("supersededByReleaseId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const evidenceAccessEvents = mysqlTable("evidenceAccessEvents", {
  id: int("id").autoincrement().primaryKey(),
  evidenceRecordId: int("evidenceRecordId").notNull(),
  actorUserId: int("actorUserId").notNull(),
  actorRole: varchar("actorRole", { length: 40 }).notNull(),
  action: mysqlEnum("action", [
    "viewed", "downloaded", "exported", "shared", "printed", "seal_verified",
  ]).notNull(),
  context: varchar("context", { length: 220 }),
  scope: varchar("scope", { length: 60 }),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type EvidenceRelationship = typeof evidenceRelationships.$inferSelect;
export type EvidenceVersion = typeof evidenceVersions.$inferSelect;
export type EvidenceSeal = typeof evidenceSeals.$inferSelect;
export type RetentionPolicyRow = typeof retentionPolicies.$inferSelect;
export type RecordRetentionStateRow = typeof recordRetentionState.$inferSelect;
export type LegalHold = typeof legalHolds.$inferSelect;
export type SyncPackage = typeof syncPackages.$inferSelect;
export type IncidentReport = typeof incidentReports.$inferSelect;
export type NearMissReport = typeof nearMissReports.$inferSelect;
export type WorkOrderRelease = typeof workOrderReleases.$inferSelect;
export type EvidenceAccessEvent = typeof evidenceAccessEvents.$inferSelect;

/* ==================================================================
 * B20.2 — Domain role assignments & authorization audit
 * ================================================================== */

export const userRoleAssignments = mysqlTable("userRoleAssignments", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", [
    "driver", "dispatcher", "mechanic", "shop_lead", "safety",
    "office", "management", "hr", "legal", "auditor",
    // B20.5 — finance and payroll functions
    "bookkeeper", "payroll_admin", "tax_preparer", "controller",
    "external_accountant",
  ]).notNull(),
  // B23.1 (0170) — how far the grant reaches. `global` is deliberate
  // platform-wide authority and is held by nobody after the backfill;
  // `organization` is the ordinary case; `branch` names its organization too,
  // because branch identifiers are bare strings with no owner;
  // `unscoped_legacy` is a pre-B23.1 grant whose organization could not be
  // inferred without guessing, and authorizes nothing until re-granted.
  scopeType: mysqlEnum("scopeType", ["global", "organization", "branch", "unscoped_legacy"]).default("global").notNull(),
  /** The organization that issued this grant. NULL only for platform-global and quarantined rows. */
  orgRef: varchar("orgRef", { length: 40 }),
  scopeRef: varchar("scopeRef", { length: 64 }),
  grantedByUserId: int("grantedByUserId").notNull(),
  grantedAt: timestamp("grantedAt").notNull(),
  revokedByUserId: int("revokedByUserId"),
  revokedAt: timestamp("revokedAt"),
  revokeReason: text("revokeReason"),
  // Persistent generated column: NULL for revoked rows, collision key for
  // active ones. Never written by the application — the database derives it.
  // B23.1 (0170) widened it to include orgRef: without that, `driver @ ABC`
  // and `driver @ XYZ` collide and the second grant cannot be written at all.
  activeGrantKey: varchar("activeGrantKey", { length: 220 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const roleBootstrapEvents = mysqlTable("roleBootstrapEvents", {
  id: int("id").autoincrement().primaryKey(),
  targetUserId: int("targetUserId").notNull(),
  performedByUserId: int("performedByUserId").notNull(),
  reason: text("reason").notNull(),
  activeManagementCountBefore: int("activeManagementCountBefore").notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const authorizationDecisions = mysqlTable("authorizationDecisions", {
  id: int("id").autoincrement().primaryKey(),
  actorUserId: int("actorUserId"),
  procedureName: varchar("procedureName", { length: 120 }).notNull(),
  permission: varchar("permission", { length: 80 }).notNull(),
  rolesHeld: varchar("rolesHeld", { length: 300 }),
  outcome: mysqlEnum("outcome", [
    "allowed", "denied_no_role", "denied_permission",
    "denied_scope", "denied_unauthenticated",
  ]).notNull(),
  subjectType: varchar("subjectType", { length: 60 }),
  subjectId: varchar("subjectId", { length: 64 }),
  detail: varchar("detail", { length: 400 }),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type UserRoleAssignment = typeof userRoleAssignments.$inferSelect;
export type AuthorizationDecision = typeof authorizationDecisions.$inferSelect;
export type InsertUserRoleAssignment = typeof userRoleAssignments.$inferInsert;
export type InsertAuthorizationDecision = typeof authorizationDecisions.$inferInsert;
export type RoleBootstrapEvent = typeof roleBootstrapEvents.$inferSelect;

/* ==================================================================
 * B20.5 — Payroll, Finance & Tax
 * ================================================================== */

export const financialEntities = mysqlTable("financialEntities", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),   // 0146: NULL = the historical single tenant; a member sees the entities its organization owns
  entityRef: varchar("entityRef", { length: 64 }).notNull().unique(),
  legalName: varchar("legalName", { length: 220 }).notNull(),
  operatingName: varchar("operatingName", { length: 220 }),
  taxpayerType: mysqlEnum("taxpayerType", ["corporation", "sole_proprietor", "partnership", "employee", "independent_contractor"]).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  fiscalYearEndMonth: int("fiscalYearEndMonth"),
  fiscalYearEndDay: int("fiscalYearEndDay"),
  ownerUserId: int("ownerUserId"),
  ownerOperatorId: int("ownerOperatorId"),
  parentEntityId: int("parentEntityId"),
  status: mysqlEnum("status", ["active", "dormant", "closed"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const taxRegistrations = mysqlTable("taxRegistrations", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId").notNull(),
  registrationType: varchar("registrationType", { length: 80 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  registered: boolean("registered").default(false).notNull(),
  registeredAt: timestamp("registeredAt"),
  closedAt: timestamp("closedAt"),
  identifierPresent: boolean("identifierPresent").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const taxRuleSources = mysqlTable("taxRuleSources", {
  id: int("id").autoincrement().primaryKey(),
  sourceKey: varchar("sourceKey", { length: 120 }).notNull().unique(),
  authority: varchar("authority", { length: 220 }).notNull(),
  reference: varchar("reference", { length: 500 }),
  publishedAt: timestamp("publishedAt"),
  retrievedAt: timestamp("retrievedAt"),
  verifiedAt: timestamp("verifiedAt"),
  verifiedByUserId: int("verifiedByUserId"),
  status: mysqlEnum("status", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const taxRules = mysqlTable("taxRules", {
  id: int("id").autoincrement().primaryKey(),
  ruleKey: varchar("ruleKey", { length: 120 }).notNull(),
  version: int("version").default(1).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  taxYear: int("taxYear"),
  entityType: varchar("entityType", { length: 60 }),
  ruleType: varchar("ruleType", { length: 80 }).notNull(),
  parametersJson: text("parametersJson"),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveUntil: timestamp("effectiveUntil"),
  sourceId: int("sourceId"),
  status: mysqlEnum("status", ["unverified", "verified", "expired", "superseded"]).default("unverified").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const expenseCategories = mysqlTable("expenseCategories", {
  id: int("id").autoincrement().primaryKey(),
  categoryKey: varchar("categoryKey", { length: 120 }).notNull().unique(),
  groupKey: varchar("groupKey", { length: 80 }).notNull(),
  label: varchar("label", { length: 220 }).notNull(),
  capitalReviewThreshold: double("capitalReviewThreshold"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const expenseRecords = mysqlTable("expenseRecords", {
  id: int("id").autoincrement().primaryKey(),
  expenseRef: varchar("expenseRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  vendorName: varchar("vendorName", { length: 220 }),
  transactionDate: timestamp("transactionDate").notNull(),
  currency: varchar("currency", { length: 8 }).default("CAD").notNull(),
  subtotal: double("subtotal"),
  subtotalCents: int("subtotalCents"),
  salesTaxAmount: double("salesTaxAmount"),
  salesTaxAmountCents: int("salesTaxAmountCents"),
  total: double("total").notNull(),
  totalCents: int("totalCents"),
  categoryId: int("categoryId"),
  categorySource: mysqlEnum("categorySource", ["human", "ai_proposed", "ai_confirmed", "merchant_memory"]).default("human").notNull(),
  categoryConfidence: double("categoryConfidence"),
  // A receipt is not a deduction. The default is review, always.
  taxTreatment: mysqlEnum("taxTreatment", [
    "unknown_review_required",
    "potentially_deductible",
    "capital_asset",
    "inventory",
    "employee_reimbursement",
    "personal",
    "mixed_use",
    "non_deductible",
    "taxable_benefit_review",
  ])
    .default("unknown_review_required")
    .notNull(),
  treatmentDeterminedByUserId: int("treatmentDeterminedByUserId"),
  treatmentDeterminedAt: timestamp("treatmentDeterminedAt"),
  treatmentRuleId: int("treatmentRuleId"),
  businessUsePercent: double("businessUsePercent").default(100).notNull(),
  paidByUserId: int("paidByUserId"),
  paidPersonally: boolean("paidPersonally").default(false).notNull(),
  reimbursementRequired: boolean("reimbursementRequired").default(false).notNull(),
  jobId: int("jobId"),
  unitId: int("unitId"),
  operatorId: int("operatorId"),
  evidenceRecordId: int("evidenceRecordId"),
  status: mysqlEnum("status", ["draft", "submitted", "review", "approved", "rejected", "posted"]).default("draft").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const expenseAllocations = mysqlTable("expenseAllocations", {
  id: int("id").autoincrement().primaryKey(),
  expenseRecordId: int("expenseRecordId").notNull(),
  allocationType: mysqlEnum("allocationType", ["business", "personal", "job", "unit", "entity"]).notNull(),
  jobId: int("jobId"),
  unitId: int("unitId"),
  financialEntityId: int("financialEntityId"),
  percent: double("percent").notNull(),
  amount: double("amount").notNull(),
  amountCents: int("amountCents"),
  basis: varchar("basis", { length: 220 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payGroups = mysqlTable("payGroups", {
  id: int("id").autoincrement().primaryKey(),
  groupKey: varchar("groupKey", { length: 80 }).notNull().unique(),
  label: varchar("label", { length: 180 }).notNull(),
  financialEntityId: int("financialEntityId"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const employeePayrollProfiles = mysqlTable("employeePayrollProfiles", {
  id: int("id").autoincrement().primaryKey(),
  operatorId: int("operatorId"),
  userId: int("userId"),
  employeeNumber: varchar("employeeNumber", { length: 40 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  employmentType: mysqlEnum("employmentType", ["full_time", "part_time", "casual", "seasonal"]).notNull(),
  payrollStatus: mysqlEnum("payrollStatus", ["active", "leave", "terminated", "suspended"]).default("active").notNull(),
  payGroupId: int("payGroupId"),
  defaultPayMethod: mysqlEnum("defaultPayMethod", ["hourly", "salary", "mileage", "load", "tonne", "percentage", "piecework", "mixed"]).notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  terminatedAt: timestamp("terminatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payRates = mysqlTable("payRates", {
  id: int("id").autoincrement().primaryKey(),
  rateKey: varchar("rateKey", { length: 120 }).notNull(),
  version: int("version").default(1).notNull(),
  employeePayrollProfileId: int("employeePayrollProfileId"),
  payGroupId: int("payGroupId"),
  earningType: varchar("earningType", { length: 80 }).notNull(),
  calculation: mysqlEnum("calculation", ["hourly", "quantity_times_rate", "percentage", "flat", "formula"]).notNull(),
  rate: double("rate").notNull(),
  rateMillis: int("rateMillis"),
  unit: mysqlEnum("unit", ["hour", "km", "load", "tonne", "m3", "percent", "each"]).notNull(),
  minimumMeasurementAuthority: varchar("minimumMeasurementAuthority", { length: 60 }),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveUntil: timestamp("effectiveUntil"),
  approvedByUserId: int("approvedByUserId").notNull(),
  approvedAt: timestamp("approvedAt").notNull(),
  supersedesRateId: int("supersedesRateId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payPeriods = mysqlTable("payPeriods", {
  id: int("id").autoincrement().primaryKey(),
  periodRef: varchar("periodRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  startsOn: timestamp("startsOn").notNull(),
  endsOn: timestamp("endsOn").notNull(),
  state: mysqlEnum("state", ["draft", "collecting", "review", "approved", "processing", "paid", "closed", "amended"]).default("draft").notNull(),
  lockedAt: timestamp("lockedAt"),
  lockedByUserId: int("lockedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payrollTimeEntries = mysqlTable("payrollTimeEntries", {
  id: int("id").autoincrement().primaryKey(),
  employeePayrollProfileId: int("employeePayrollProfileId").notNull(),
  payPeriodId: int("payPeriodId"),
  activity: mysqlEnum("activity", ["driving", "on_location", "loading", "unloading", "waiting", "standby", "shop", "training", "safety_meeting", "travel", "break", "off_duty"]).notNull(),
  startedAt: timestamp("startedAt").notNull(),
  endedAt: timestamp("endedAt"),
  minutes: int("minutes"),
  source: mysqlEnum("source", ["time_clock", "employee_submitted", "gps_proposed", "dispatch_schedule", "field_ticket", "manual_hr"]).notNull(),
  confirmedByEmployee: boolean("confirmedByEmployee").default(false).notNull(),
  jobId: int("jobId"),
  tripId: int("tripId"),
  unitId: int("unitId"),
  supersededByEntryId: int("supersededByEntryId"),
  status: mysqlEnum("status", ["open", "submitted", "verified", "disputed", "approved", "void"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payrollTimeReconciliations = mysqlTable("payrollTimeReconciliations", {
  id: int("id").autoincrement().primaryKey(),
  employeePayrollProfileId: int("employeePayrollProfileId").notNull(),
  payPeriodId: int("payPeriodId"),
  forDate: timestamp("forDate").notNull(),
  employeeSubmittedMinutes: int("employeeSubmittedMinutes"),
  hosOnDutyMinutes: int("hosOnDutyMinutes"),
  leaseosActivityMinutes: int("leaseosActivityMinutes"),
  varianceMinutes: int("varianceMinutes"),
  outcome: mysqlEnum("outcome", ["match", "within_tolerance", "review", "unresolved"]).default("review").notNull(),
  resolvedByUserId: int("resolvedByUserId"),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNote: text("resolutionNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payrollEarningEvents = mysqlTable("payrollEarningEvents", {
  id: int("id").autoincrement().primaryKey(),
  earningRef: varchar("earningRef", { length: 64 }).notNull().unique(),
  employeePayrollProfileId: int("employeePayrollProfileId").notNull(),
  payPeriodId: int("payPeriodId").notNull(),
  earningType: varchar("earningType", { length: 80 }).notNull(),
  source: mysqlEnum("source", ["approved_timesheet", "trip", "load", "field_ticket", "safety_meeting", "work_order", "manual_hr_adjustment"]).notNull(),
  sourceRecordRef: varchar("sourceRecordRef", { length: 120 }),
  quantity: double("quantity").notNull(),
  unit: mysqlEnum("unit", ["hour", "km", "load", "tonne", "m3", "percent", "each"]).notNull(),
  payRateId: int("payRateId"),
  rateKeyVersion: varchar("rateKeyVersion", { length: 140 }),
  rateApplied: double("rateApplied"),
  rateAppliedMillis: int("rateAppliedMillis"),
  calculatedAmount: double("calculatedAmount"),
  calculatedAmountCents: int("calculatedAmountCents"),
  measurementAuthority: varchar("measurementAuthority", { length: 60 }),
  blockedReason: varchar("blockedReason", { length: 300 }),
  status: mysqlEnum("status", ["pending", "verified", "approved", "held", "paid", "void"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payrollEarningEvidence = mysqlTable("payrollEarningEvidence", {
  id: int("id").autoincrement().primaryKey(),
  payrollEarningEventId: int("payrollEarningEventId").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  evidenceRef: varchar("evidenceRef", { length: 120 }),
  relation: varchar("relation", { length: 60 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payRuns = mysqlTable("payRuns", {
  id: int("id").autoincrement().primaryKey(),
  payRunRef: varchar("payRunRef", { length: 64 }).notNull().unique(),
  payPeriodId: int("payPeriodId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  state: mysqlEnum("state", ["draft", "collecting", "review", "approved", "processing", "paid", "closed", "amended"]).default("draft").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  lockedAt: timestamp("lockedAt"),
  paidAt: timestamp("paidAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payRunLines = mysqlTable("payRunLines", {
  id: int("id").autoincrement().primaryKey(),
  payRunId: int("payRunId").notNull(),
  employeePayrollProfileId: int("employeePayrollProfileId").notNull(),
  lineType: mysqlEnum("lineType", ["earning", "deduction", "reimbursement", "employer_cost"]).notNull(),
  earningType: varchar("earningType", { length: 80 }),
  payrollEarningEventId: int("payrollEarningEventId"),
  quantity: double("quantity"),
  rateApplied: double("rateApplied"),
  rateAppliedMillis: int("rateAppliedMillis"),
  amount: double("amount").notNull(),
  amountCents: int("amountCents"),
  taxRuleId: int("taxRuleId"),
  ruleStatus: mysqlEnum("ruleStatus", ["verified", "unverified", "not_applicable"]).default("unverified").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payrollAdjustments = mysqlTable("payrollAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  adjustmentRef: varchar("adjustmentRef", { length: 64 }).notNull().unique(),
  employeePayrollProfileId: int("employeePayrollProfileId").notNull(),
  originalPayRunId: int("originalPayRunId"),
  appliedPayRunId: int("appliedPayRunId"),
  reason: text("reason").notNull(),
  amount: double("amount").notNull(),
  amountCents: int("amountCents"),
  requestedByUserId: int("requestedByUserId").notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  status: mysqlEnum("status", ["requested", "approved", "declined", "applied"]).default("requested").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const payrollDisputes = mysqlTable("payrollDisputes", {
  id: int("id").autoincrement().primaryKey(),
  disputeRef: varchar("disputeRef", { length: 64 }).notNull().unique(),
  employeePayrollProfileId: int("employeePayrollProfileId").notNull(),
  payPeriodId: int("payPeriodId"),
  payrollTimeEntryId: int("payrollTimeEntryId"),
  payrollEarningEventId: int("payrollEarningEventId"),
  recordedValue: varchar("recordedValue", { length: 120 }),
  claimedValue: varchar("claimedValue", { length: 120 }),
  employeeStatement: text("employeeStatement").notNull(),
  status: mysqlEnum("status", ["open", "information_requested", "approved", "declined", "withdrawn"]).default("open").notNull(),
  resolvedByUserId: int("resolvedByUserId"),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNote: text("resolutionNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const contractorSettlements = mysqlTable("contractorSettlements", {
  id: int("id").autoincrement().primaryKey(),
  settlementRef: varchar("settlementRef", { length: 64 }).notNull().unique(),
  contractorEntityId: int("contractorEntityId").notNull(),
  payingEntityId: int("payingEntityId").notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  grossAmount: double("grossAmount").notNull(),
  grossAmountCents: int("grossAmountCents"),
  deductionTotal: double("deductionTotal").default(0).notNull(),
  deductionTotalCents: int("deductionTotalCents"),
  netAmount: double("netAmount").notNull(),
  netAmountCents: int("netAmountCents"),
  informationReturnAssessment: mysqlEnum("informationReturnAssessment", ["not_assessed", "needs_accountant_review", "rule_unverified", "assessed"]).default("not_assessed").notNull(),
  informationReturnNote: varchar("informationReturnNote", { length: 300 }),
  state: mysqlEnum("state", ["draft", "review", "approved", "paid", "closed"]).default("draft").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const contractorSettlementLines = mysqlTable("contractorSettlementLines", {
  id: int("id").autoincrement().primaryKey(),
  contractorSettlementId: int("contractorSettlementId").notNull(),
  lineType: mysqlEnum("lineType", ["freight", "fuel_advance", "insurance", "equipment_rental", "deduction", "reimbursement", "other"]).notNull(),
  description: varchar("description", { length: 300 }).notNull(),
  quantity: double("quantity"),
  rateApplied: double("rateApplied"),
  rateAppliedMillis: int("rateAppliedMillis"),
  amount: double("amount").notNull(),
  amountCents: int("amountCents"),
  sourceRecordRef: varchar("sourceRecordRef", { length: 120 }),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const personalTaxDocuments = mysqlTable("personalTaxDocuments", {
  id: int("id").autoincrement().primaryKey(),
  ownerUserId: int("ownerUserId").notNull(),
  documentKind: varchar("documentKind", { length: 80 }).notNull(),
  taxYear: int("taxYear"),
  evidenceRecordId: int("evidenceRecordId"),
  sharedWithEntityId: int("sharedWithEntityId"),
  sharedAt: timestamp("sharedAt"),
  sharedByUserId: int("sharedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertFinancialEntities = typeof financialEntities.$inferInsert;
export type InsertTaxRegistrations = typeof taxRegistrations.$inferInsert;
export type InsertTaxRuleSources = typeof taxRuleSources.$inferInsert;
export type InsertTaxRules = typeof taxRules.$inferInsert;
export type InsertExpenseCategories = typeof expenseCategories.$inferInsert;
export type InsertExpenseRecords = typeof expenseRecords.$inferInsert;
export type InsertExpenseAllocations = typeof expenseAllocations.$inferInsert;
export type InsertPayGroups = typeof payGroups.$inferInsert;
export type InsertEmployeePayrollProfiles = typeof employeePayrollProfiles.$inferInsert;
export type InsertPayRates = typeof payRates.$inferInsert;
export type InsertPayPeriods = typeof payPeriods.$inferInsert;
export type InsertPayrollTimeEntries = typeof payrollTimeEntries.$inferInsert;
export type InsertPayrollTimeReconciliations = typeof payrollTimeReconciliations.$inferInsert;
export type InsertPayrollEarningEvents = typeof payrollEarningEvents.$inferInsert;
export type InsertPayrollEarningEvidence = typeof payrollEarningEvidence.$inferInsert;
export type InsertPayRuns = typeof payRuns.$inferInsert;
export type InsertPayRunLines = typeof payRunLines.$inferInsert;
export type InsertPayrollAdjustments = typeof payrollAdjustments.$inferInsert;
export type InsertPayrollDisputes = typeof payrollDisputes.$inferInsert;
export type InsertContractorSettlements = typeof contractorSettlements.$inferInsert;
export type InsertContractorSettlementLines = typeof contractorSettlementLines.$inferInsert;
export type InsertPersonalTaxDocuments = typeof personalTaxDocuments.$inferInsert;

/* ==================================================================
 * B20.8 — External data source registry
 * ================================================================== */

export const externalDataSources = mysqlTable("externalDataSources", {
  id: int("id").autoincrement().primaryKey(),
  sourceKey: varchar("sourceKey", { length: 120 }).notNull().unique(),
  displayName: varchar("displayName", { length: 220 }).notNull(),
  authority: varchar("authority", { length: 220 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 600 }),
  jurisdiction: varchar("jurisdiction", { length: 80 }),
  category: mysqlEnum("category", ["base_map", "road_network", "land_grid", "oilfield_assets", "road_conditions", "weather", "wildfire", "routing_engine", "geocoder", "tiles", "spectrum", "coverage", "other"]).notNull(),
  licenceName: varchar("licenceName", { length: 180 }),
  licenceUrl: varchar("licenceUrl", { length: 600 }),
  attributionRequired: boolean("attributionRequired").default(true).notNull(),
  attributionText: varchar("attributionText", { length: 600 }),
  shareAlikeObligation: boolean("shareAlikeObligation").default(false).notNull(),
  commercialUsePermitted: mysqlEnum("commercialUsePermitted", ["yes", "no", "unknown"]).default("unknown").notNull(),
  redistributionPermitted: mysqlEnum("redistributionPermitted", ["yes", "no", "unknown"]).default("unknown").notNull(),
  rateLimitCalls: int("rateLimitCalls"),
  rateLimitWindowSeconds: int("rateLimitWindowSeconds"),
  requiresApiKey: boolean("requiresApiKey").default(false).notNull(),
  updateIntervalHours: int("updateIntervalHours"),
  retrievedAt: timestamp("retrievedAt"),
  verifiedAt: timestamp("verifiedAt"),
  // v22.20 — who cleared this licence, when, and what they read.
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  reviewNote: varchar("reviewNote", { length: 1000 }),
  verifiedByUserId: int("verifiedByUserId"),
  status: mysqlEnum("status", ["unverified", "verified", "superseded", "withdrawn"]).default("unverified").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const externalDatasetImports = mysqlTable("externalDatasetImports", {
  id: int("id").autoincrement().primaryKey(),
  importRef: varchar("importRef", { length: 64 }).notNull().unique(),
  externalDataSourceId: int("externalDataSourceId").notNull(),
  datasetKey: varchar("datasetKey", { length: 160 }).notNull(),
  datasetVersion: varchar("datasetVersion", { length: 120 }),
  sourceFormat: varchar("sourceFormat", { length: 60 }),
  checksumSha256: varchar("checksumSha256", { length: 64 }),
  importerVersion: varchar("importerVersion", { length: 60 }).notNull(),
  featureCount: int("featureCount"),
  coordinateSystem: varchar("coordinateSystem", { length: 60 }),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveUntil: timestamp("effectiveUntil"),
  retrievedAt: timestamp("retrievedAt").notNull(),
  importedAt: timestamp("importedAt").notNull(),
  importedByUserId: int("importedByUserId"),
  state: mysqlEnum("state", ["pending", "imported", "failed", "superseded", "rolled_back"]).default("pending").notNull(),
  failureReason: text("failureReason"),
  supersedesImportId: int("supersedesImportId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const externalFeedFetches = mysqlTable("externalFeedFetches", {
  id: int("id").autoincrement().primaryKey(),
  externalDataSourceId: int("externalDataSourceId").notNull(),
  feedKey: varchar("feedKey", { length: 160 }).notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  respondedAt: timestamp("respondedAt"),
  httpStatus: int("httpStatus"),
  payloadChecksum: varchar("payloadChecksum", { length: 64 }),
  recordCount: int("recordCount"),
  servedFromCache: boolean("servedFromCache").default(false).notNull(),
  staleSeconds: int("staleSeconds"),
  outcome: mysqlEnum("outcome", ["ok", "rate_limited", "error", "stale_served", "unavailable"]).notNull(),
  detail: varchar("detail", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertExternalDataSources = typeof externalDataSources.$inferInsert;
export type InsertExternalDatasetImports = typeof externalDatasetImports.$inferInsert;
export type InsertExternalFeedFetches = typeof externalFeedFetches.$inferInsert;

/* ==================================================================
 * B20.13 — Funding & Incentives Intelligence
 * ================================================================== */

export const fundingProgramSources = mysqlTable("fundingProgramSources", {
  id: int("id").autoincrement().primaryKey(),
  sourceKey: varchar("sourceKey", { length: 120 }).notNull().unique(),
  authority: varchar("authority", { length: 220 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 600 }),
  retrievedAt: timestamp("retrievedAt"),
  verifiedAt: timestamp("verifiedAt"),
  verifiedByUserId: int("verifiedByUserId"),
  status: mysqlEnum("status", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fundingPrograms = mysqlTable("fundingPrograms", {
  id: int("id").autoincrement().primaryKey(),
  programKey: varchar("programKey", { length: 120 }).notNull(),
  version: int("version").default(1).notNull(),
  officialName: varchar("officialName", { length: 300 }).notNull(),
  governmentLevel: mysqlEnum("governmentLevel", ["federal", "provincial", "municipal", "regional", "industry", "other"]).notNull(),
  country: varchar("country", { length: 8 }).default("CA").notNull(),
  province: varchar("province", { length: 8 }),
  administeringOrganization: varchar("administeringOrganization", { length: 220 }),
  programType: mysqlEnum("programType", ["grant", "loan", "loan_guarantee", "refundable_tax_credit", "non_refundable_tax_credit", "deduction", "rebate", "wage_subsidy", "cost_share", "insurance_risk_management", "equity_investment", "tax_system_grant"]).notNull(),
  deliveryMechanism: mysqlEnum("deliveryMechanism", ["application_intake", "tax_return", "lender", "continuous", "other"]).default("application_intake").notNull(),
  categoryKey: varchar("categoryKey", { length: 80 }).notNull(),
  applicantTypesJson: text("applicantTypesJson"),
  industriesJson: text("industriesJson"),
  exclusionsJson: text("exclusionsJson"),
  parametersJson: text("parametersJson"),
  preApprovalRequired: boolean("preApprovalRequired").default(false).notNull(),
  stackingRule: mysqlEnum("stackingRule", ["unknown", "permitted", "prohibited", "conditional"]).default("unknown").notNull(),
  programStatus: mysqlEnum("programStatus", ["unknown", "open", "closed", "upcoming", "expired", "funding_exhausted", "source_changed"]).default("unknown").notNull(),
  intakeOpensAt: timestamp("intakeOpensAt"),
  intakeClosesAt: timestamp("intakeClosesAt"),
  fundingExhaustionPossible: boolean("fundingExhaustionPossible").default(false).notNull(),
  temporaryProgram: boolean("temporaryProgram").default(false).notNull(),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveUntil: timestamp("effectiveUntil"),
  sourceId: int("sourceId"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "expired", "superseded"]).default("unverified").notNull(),
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fundingOpportunities = mysqlTable("fundingOpportunities", {
  id: int("id").autoincrement().primaryKey(),
  opportunityRef: varchar("opportunityRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  fundingProgramId: int("fundingProgramId").notNull(),
  triggerEvent: varchar("triggerEvent", { length: 80 }),
  triggerRecordRef: varchar("triggerRecordRef", { length: 120 }),
  matchStrength: mysqlEnum("matchStrength", ["strong", "possible", "more_information_required", "excluded"]).notNull(),
  matchReasonsJson: text("matchReasonsJson"),
  missingInformationJson: text("missingInformationJson"),
  estimatedAmount: double("estimatedAmount"),
  estimatedAmountCents: int("estimatedAmountCents"),
  estimateBasis: varchar("estimateBasis", { length: 300 }),
  status: mysqlEnum("status", ["estimated", "potential", "pre_screened", "application_submitted", "approved", "claimed", "received", "declined", "expired", "withdrawn"]).default("estimated").notNull(),
  preApprovalWarning: boolean("preApprovalWarning").default(false).notNull(),
  deadlineAt: timestamp("deadlineAt"),
  assignedToUserId: int("assignedToUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const fundingClaims = mysqlTable("fundingClaims", {
  id: int("id").autoincrement().primaryKey(),
  claimRef: varchar("claimRef", { length: 64 }).notNull().unique(),
  fundingOpportunityId: int("fundingOpportunityId"),
  fundingProgramId: int("fundingProgramId").notNull(),
  expenseRef: varchar("expenseRef", { length: 120 }).notNull(),
  eligibleCost: double("eligibleCost").notNull(),
  eligibleCostCents: int("eligibleCostCents"),
  claimedAmount: double("claimedAmount").notNull(),
  claimedAmountCents: int("claimedAmountCents"),
  claimDate: timestamp("claimDate").notNull(),
  status: mysqlEnum("status", ["draft", "submitted", "approved", "paid", "rejected", "withdrawn"]).default("draft").notNull(),
  evidenceRecordIdsJson: text("evidenceRecordIdsJson"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertFundingProgramSources = typeof fundingProgramSources.$inferInsert;
export type InsertFundingPrograms = typeof fundingPrograms.$inferInsert;
export type InsertFundingOpportunities = typeof fundingOpportunities.$inferInsert;
export type InsertFundingClaims = typeof fundingClaims.$inferInsert;

/* ==================================================================
 * v20.15 — Document extraction and question queue
 * ================================================================== */

export const documentExtractions = mysqlTable("documentExtractions", {
  id: int("id").autoincrement().primaryKey(),
  extractionRef: varchar("extractionRef", { length: 64 }).notNull().unique(),
  evidenceRecordId: int("evidenceRecordId"),
  proposalId: varchar("proposalId", { length: 64 }),
  ocrEngine: varchar("ocrEngine", { length: 80 }).notNull(),
  ocrEngineVersion: varchar("ocrEngineVersion", { length: 40 }),
  documentType: varchar("documentType", { length: 60 }).default("unknown").notNull(),
  classificationConfidence: double("classificationConfidence"),
  classificationSource: mysqlEnum("classificationSource", ["ocr_model", "merchant_memory", "human"]).default("ocr_model").notNull(),
  rawTextHash: varchar("rawTextHash", { length: 64 }),
  contentSha256: varchar("contentSha256", { length: 64 }),
  fieldCount: int("fieldCount").default(0).notNull(),
  autoFiledCount: int("autoFiledCount").default(0).notNull(),
  reviewCount: int("reviewCount").default(0).notNull(),
  askedCount: int("askedCount").default(0).notNull(),
  humanOnlyCount: int("humanOnlyCount").default(0).notNull(),
  extractedAt: timestamp("extractedAt").notNull(),
  extractedByUserId: int("extractedByUserId"),
  status: mysqlEnum("status", ["extracted", "proposed", "committed", "rejected"]).default("extracted").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const assistantQuestions = mysqlTable("assistantQuestions", {
  id: int("id").autoincrement().primaryKey(),
  questionRef: varchar("questionRef", { length: 64 }).notNull().unique(),
  proposalId: varchar("proposalId", { length: 64 }).notNull(),
  fieldKey: varchar("fieldKey", { length: 80 }).notNull(),
  question: varchar("question", { length: 400 }).notNull(),
  reason: mysqlEnum("reason", ["missing_required", "low_confidence", "precision_unresolved", "sensitive_human_only", "ambiguous_classification"]).notNull(),
  optionsJson: text("optionsJson"),
  priority: int("priority").default(50).notNull(),
  askedToUserId: int("askedToUserId"),
  status: mysqlEnum("status", ["pending", "answered", "skipped", "superseded"]).default("pending").notNull(),
  answerValue: text("answerValue"),
  answerSource: mysqlEnum("answerSource", ["typed", "voice", "selected"]),
  answeredByUserId: int("answeredByUserId"),
  answeredAt: timestamp("answeredAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertDocumentExtractions = typeof documentExtractions.$inferInsert;
export type InsertAssistantQuestions = typeof assistantQuestions.$inferInsert;

/* ==================================================================
 * v20.16 — Document fingerprints and merchant memory
 * ================================================================== */

export const documentFingerprints = mysqlTable("documentFingerprints", {
  id: int("id").autoincrement().primaryKey(),
  fingerprintRef: varchar("fingerprintRef", { length: 64 }).notNull().unique(),
  documentType: varchar("documentType", { length: 60 }).notNull(),
  contentSha256: varchar("contentSha256", { length: 64 }),
  structuredKeyHash: varchar("structuredKeyHash", { length: 64 }).notNull(),
  structuredKey: varchar("structuredKey", { length: 400 }).notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  extractionRef: varchar("extractionRef", { length: 64 }),
  proposalId: varchar("proposalId", { length: 64 }),
  targetType: varchar("targetType", { length: 40 }),
  targetRecordId: int("targetRecordId"),
  capturedByUserId: int("capturedByUserId"),
  capturedAt: timestamp("capturedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const merchantMemory = mysqlTable("merchantMemory", {
  id: int("id").autoincrement().primaryKey(),
  vendorNormalized: varchar("vendorNormalized", { length: 200 }).notNull(),
  vendorDisplay: varchar("vendorDisplay", { length: 220 }),
  documentType: varchar("documentType", { length: 60 }).notNull(),
  categoryKey: varchar("categoryKey", { length: 60 }),
  seenCount: int("seenCount").default(0).notNull(),
  confirmedCount: int("confirmedCount").default(0).notNull(),
  rejectedCount: int("rejectedCount").default(0).notNull(),
  lastSeenAt: timestamp("lastSeenAt"),
  lastConfirmedAt: timestamp("lastConfirmedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertDocumentFingerprints = typeof documentFingerprints.$inferInsert;
export type InsertMerchantMemory = typeof merchantMemory.$inferInsert;

/* ==================================================================
 * v20.17 — Remote work evidence
 * ================================================================== */

export const remoteWorkEvidence = mysqlTable("remoteWorkEvidence", {
  id: int("id").autoincrement().primaryKey(),
  evidenceRef: varchar("evidenceRef", { length: 64 }).notNull().unique(),
  userId: int("userId").notNull(),
  homeBaseRef: varchar("homeBaseRef", { length: 120 }).notNull(),
  workLocationRef: varchar("workLocationRef", { length: 120 }).notNull(),
  occurredOn: varchar("occurredOn", { length: 10 }).notNull(),
  distanceKm: double("distanceKm"),
  distanceSource: mysqlEnum("distanceSource", ["route_engine", "geodesic", "operator_confirmed", "unknown"]).default("unknown").notNull(),
  homeLatitude: double("homeLatitude"),
  homeLongitude: double("homeLongitude"),
  workLatitude: double("workLatitude"),
  workLongitude: double("workLongitude"),
  nightsAway: int("nightsAway"),
  conclusion: mysqlEnum("conclusion", ["evidence_available", "insufficient_evidence"]).notNull(),
  insufficiencyReason: varchar("insufficiencyReason", { length: 300 }),
  sourceRecordType: varchar("sourceRecordType", { length: 40 }),
  sourceRecordId: int("sourceRecordId"),
  recordedAt: timestamp("recordedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type InsertRemoteWorkEvidence = typeof remoteWorkEvidence.$inferInsert;

/* ==================================================================
 * v20.18 — Fuel & Energy Ledger
 * ================================================================== */

export const fuelAccounts = mysqlTable("fuelAccounts", {
  id: int("id").autoincrement().primaryKey(),
  accountRef: varchar("accountRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  fuelType: mysqlEnum("fuelType", ["diesel", "gasoline", "def", "propane", "cng", "lng", "electric_charge", "other", "mixed"]).notNull(),
  kind: mysqlEnum("kind", ["fleet", "light_vehicle", "equipment", "bulk_yard", "employee_travel", "contractor_advance", "other"]).notNull(),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fleetFuelCards = mysqlTable("fleetFuelCards", {
  id: int("id").autoincrement().primaryKey(),
  cardRef: varchar("cardRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  providerToken: varchar("providerToken", { length: 120 }),
  lastFour: varchar("lastFour", { length: 4 }).notNull(),
  assignedUnitId: int("assignedUnitId"),
  assignedUserId: int("assignedUserId"),
  fuelAccountId: int("fuelAccountId"),
  status: mysqlEnum("status", ["active", "suspended", "revoked", "expired"]).default("active").notNull(),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fuelTransactions = mysqlTable("fuelTransactions", {
  id: int("id").autoincrement().primaryKey(),
  fuelRef: varchar("fuelRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  expenseRecordId: int("expenseRecordId"),
  evidenceRecordId: int("evidenceRecordId"),
  operatorId: int("operatorId"),
  fueledByUserId: int("fueledByUserId"),
  unitId: int("unitId"),
  trailerId: int("trailerId"),
  equipmentId: int("equipmentId"),
  jobId: int("jobId"),
  tripId: int("tripId"),
  fuelAccountId: int("fuelAccountId"),
  // v21.4 — a dispense from a tank, or a statement line, is a second source for the same transaction.
  bulkFuelTankId: int("bulkFuelTankId"),
  statementLineId: int("statementLineId"),
  fleetCardId: int("fleetCardId"),
  vendorName: varchar("vendorName", { length: 220 }),
  merchantLocation: varchar("merchantLocation", { length: 300 }),
  // v21.3 — where the litres were bought, and how we know.
  jurisdiction: varchar("jurisdiction", { length: 80 }),
  jurisdictionSource: mysqlEnum("jurisdictionSource", ["receipt", "vendor_location", "operator_stated", "fleet_card_statement", "gps", "bulk_tank_location", "unknown"]),
  occurredAt: timestamp("occurredAt").notNull(),
  fuelType: mysqlEnum("fuelType", ["diesel", "gasoline", "def", "propane", "cng", "lng", "electric_charge", "other"]).notNull(),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 12 }),
  unitPriceMillis: int("unitPriceMillis"),
  subtotalCents: int("subtotalCents"),
  taxAmountCents: int("taxAmountCents"),
  totalCents: int("totalCents").notNull(),
  odometerKm: double("odometerKm"),
  engineHours: double("engineHours"),
  unitNumberHint: varchar("unitNumberHint", { length: 40 }),
  cardLastFourHint: varchar("cardLastFourHint", { length: 4 }),
  payerType: mysqlEnum("payerType", ["company", "worker_personal", "contractor", "owner_shareholder", "customer", "unknown"]).default("unknown").notNull(),
  purpose: mysqlEnum("purpose", ["company_vehicle_operation", "company_equipment_operation", "company_business_travel", "employee_business_travel", "contractor_operation", "bulk_tank_purchase", "bulk_tank_dispense", "personal", "unknown"]).default("unknown").notNull(),
  financialTreatment: mysqlEnum("financialTreatment", ["company_operating_expense", "employee_reimbursement_pending", "contractor_reimbursement_pending", "contractor_fuel_advance", "contractor_own_expense", "owner_reimbursement_or_equity_review", "bulk_fuel_inventory", "personal_tax_review", "unknown_review_required"]).default("unknown_review_required").notNull(),
  reimbursementStatus: mysqlEnum("reimbursementStatus", ["not_applicable", "pending", "paid", "denied"]).default("not_applicable").notNull(),
  reimbursedAmountCents: int("reimbursedAmountCents"),
  privateToFueler: boolean("privateToFueler").default(false).notNull(),
  hosRuleConclusion: mysqlEnum("hosRuleConclusion", ["requires_status_review", "consistent", "unknown"]).default("unknown").notNull(),
  classificationReasons: text("classificationReasons"),
  status: mysqlEnum("status", ["draft", "needs_review", "confirmed", "reconciled", "rejected"]).default("draft").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertFuelAccounts = typeof fuelAccounts.$inferInsert;
export type InsertFleetFuelCards = typeof fleetFuelCards.$inferInsert;
export type InsertFuelTransactions = typeof fuelTransactions.$inferInsert;

/* ==================================================================
 * v20.19 — Roadside events, purchasing, Accounts Payable
 * ================================================================== */

export const spendingLimits = mysqlTable("spendingLimits", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId").notNull(),
  role: varchar("role", { length: 40 }).notNull(),
  emergencyPurchaseLimit: double("emergencyPurchaseLimit").notNull(),
  standardPurchaseLimit: double("standardPurchaseLimit").notNull(),
  canApproveUpTo: double("canApproveUpTo").default(0).notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveUntil: timestamp("effectiveUntil"),
  setByUserId: int("setByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const roadsideServiceEvents = mysqlTable("roadsideServiceEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 64 }).notNull().unique(),
  eventType: mysqlEnum("eventType", ["flat_tire", "tire_blowout", "engine_failure", "electrical_failure", "air_system", "brake_issue", "coolant_leak", "hydraulic_leak", "fuel_issue", "def_issue", "frozen_airline", "tow", "boost", "lockout", "collision_recovery", "stuck_recovery", "trailer_failure", "other"]).notNull(),
  unitId: int("unitId").notNull(),
  trailerId: int("trailerId"),
  operatorId: int("operatorId"),
  reportedByUserId: int("reportedByUserId").notNull(),
  jobId: int("jobId"),
  tripId: int("tripId"),
  loadId: int("loadId"),
  latitude: double("latitude"),
  longitude: double("longitude"),
  locationDescription: varchar("locationDescription", { length: 300 }),
  occurredAt: timestamp("occurredAt").notNull(),
  reportedAt: timestamp("reportedAt").notNull(),
  vehicleMovable: mysqlEnum("vehicleMovable", ["yes", "no", "unknown"]).default("unknown").notNull(),
  driverSafe: mysqlEnum("driverSafe", ["yes", "no", "unknown"]).default("unknown").notNull(),
  loadStatus: mysqlEnum("loadStatus", ["empty", "loaded", "unknown"]).default("unknown").notNull(),
  dangerousGoods: mysqlEnum("dangerousGoods", ["yes", "no", "unknown"]).default("unknown").notNull(),
  assistanceRequired: boolean("assistanceRequired").default(false).notNull(),
  customerAffected: mysqlEnum("customerAffected", ["yes", "no", "unknown"]).default("unknown").notNull(),
  driverStatement: text("driverStatement"),
  maintenanceDefectId: int("maintenanceDefectId"),
  assignedVendorId: int("assignedVendorId"),
  estimatedDelayMinutes: int("estimatedDelayMinutes"),
  status: mysqlEnum("status", ["open", "vendor_assigned", "in_repair", "repaired_awaiting_release", "closed", "cancelled"]).default("open").notNull(),
  closedAt: timestamp("closedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const purchaseAuthorizations = mysqlTable("purchaseAuthorizations", {
  id: int("id").autoincrement().primaryKey(),
  authorizationRef: varchar("authorizationRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  vendorId: int("vendorId"),
  vendorNameIfNew: varchar("vendorNameIfNew", { length: 180 }),
  unitId: int("unitId"),
  jobId: int("jobId"),
  roadsideEventId: int("roadsideEventId"),
  workOrderId: int("workOrderId"),
  category: varchar("category", { length: 80 }).notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  estimatedAmount: double("estimatedAmount").notNull(),
  estimatedAmountCents: int("estimatedAmountCents"),
  authorizedMaximum: double("authorizedMaximum"),
  emergency: boolean("emergency").default(false).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  rejectedByUserId: int("rejectedByUserId"),
  rejectedAt: timestamp("rejectedAt"),
  decisionReason: varchar("decisionReason", { length: 400 }),
  status: mysqlEnum("status", ["requested", "approved", "rejected", "expired", "consumed", "cancelled"]).default("requested").notNull(),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const vendorBills = mysqlTable("vendorBills", {
  id: int("id").autoincrement().primaryKey(),
  /** 0137 — who entered the bill; the preparer for separation of duties. NULL on bills that predate this. */
  recordedByUserId: int("recordedByUserId"),
  billRef: varchar("billRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  vendorId: int("vendorId").notNull(),
  vendorInvoiceNumber: varchar("vendorInvoiceNumber", { length: 80 }).notNull(),
  invoiceDate: timestamp("invoiceDate").notNull(),
  serviceDate: timestamp("serviceDate"),
  receivedAt: timestamp("receivedAt").notNull(),
  dueAt: timestamp("dueAt"),
  currency: varchar("currency", { length: 3 }).default("CAD").notNull(),
  subtotalCents: int("subtotalCents"),
  taxAmountCents: int("taxAmountCents"),
  gstTreatment: mysqlEnum("gstTreatment", ["taxable", "zero_rated", "exempt", "unknown"]).default("unknown").notNull(),
  totalCents: int("totalCents").notNull(),
  purchaseAuthorizationId: int("purchaseAuthorizationId"),
  roadsideEventId: int("roadsideEventId"),
  workOrderId: int("workOrderId"),
  unitId: int("unitId"),
  jobId: int("jobId"),
  evidenceRecordId: int("evidenceRecordId"),
  accountingPeriod: varchar("accountingPeriod", { length: 7 }),
  accrualCandidate: boolean("accrualCandidate").default(false).notNull(),
  matchOutcome: mysqlEnum("matchOutcome", ["unmatched", "match", "mismatch", "partial"]).default("unmatched").notNull(),
  matchVariancesJson: text("matchVariancesJson"),
  codingCategory: varchar("codingCategory", { length: 80 }),
  codedByUserId: int("codedByUserId"),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  paymentReleasedByUserId: int("paymentReleasedByUserId"),
  paymentReleasedAt: timestamp("paymentReleasedAt"),
  status: mysqlEnum("status", ["received", "needs_coding", "needs_approval", "missing_receipt", "mismatch", "duplicate_suspected", "ready_to_pay", "paid", "disputed", "cancelled"]).default("received").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const vendorBillLines = mysqlTable("vendorBillLines", {
  id: int("id").autoincrement().primaryKey(),
  vendorBillId: int("vendorBillId").notNull(),
  lineNo: int("lineNo").notNull(),
  lineType: mysqlEnum("lineType", ["part", "labour", "service_call", "freight", "shop_supplies", "environmental_fee", "disposal_fee", "core_charge", "core_credit", "tire_levy", "tax", "warranty_credit", "discount", "other"]).notNull(),
  serviceCode: varchar("serviceCode", { length: 60 }),
  description: varchar("description", { length: 300 }).notNull(),
  quantity: double("quantity").default(1).notNull(),
  unitPriceCents: int("unitPriceCents"),
  amountCents: int("amountCents").notNull(),
  pricingDecisionRef: varchar("pricingDecisionRef", { length: 64 }),
  rateVarianceCents: int("rateVarianceCents"),
  coreStatus: mysqlEnum("coreStatus", ["not_applicable", "open", "credited", "written_off"]).default("not_applicable").notNull(),
  creditedByLineId: int("creditedByLineId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const customerRecoveryProposals = mysqlTable("customerRecoveryProposals", {
  id: int("id").autoincrement().primaryKey(),
  proposalRef: varchar("proposalRef", { length: 64 }).notNull().unique(),
  vendorBillId: int("vendorBillId"),
  expenseRecordId: int("expenseRecordId"),
  jobId: int("jobId").notNull(),
  customerRef: varchar("customerRef", { length: 220 }),
  companyCost: double("companyCost").notNull(),
  companyCostCents: int("companyCostCents"),
  proposedRecovery: double("proposedRecovery").notNull(),
  markupPercent: double("markupPercent"),
  basis: varchar("basis", { length: 400 }).notNull(),
  status: mysqlEnum("status", ["proposed", "review_required", "approved", "declined", "invoiced"]).default("review_required").notNull(),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertSpendingLimits = typeof spendingLimits.$inferInsert;
export type InsertRoadsideServiceEvents = typeof roadsideServiceEvents.$inferInsert;
export type InsertPurchaseAuthorizations = typeof purchaseAuthorizations.$inferInsert;
export type InsertVendorBills = typeof vendorBills.$inferInsert;
export type InsertVendorBillLines = typeof vendorBillLines.$inferInsert;
export type InsertCustomerRecoveryProposals = typeof customerRecoveryProposals.$inferInsert;

/* ==================================================================
 * v20.20 — P4 Secure Field Runtime
 * ================================================================== */

export const fieldDevices = mysqlTable("fieldDevices", {
  id: int("id").autoincrement().primaryKey(),
  deviceRef: varchar("deviceRef", { length: 64 }).notNull().unique(),
  userId: int("userId").notNull(),
  orgRef: varchar("orgRef", { length: 40 }),
  platform: mysqlEnum("platform", ["android", "ios", "windows", "linux", "web", "other"]).notNull(),
  platformDeviceIdHash: varchar("platformDeviceIdHash", { length: 64 }),
  displayName: varchar("displayName", { length: 120 }),
  keyFingerprint: varchar("keyFingerprint", { length: 64 }).notNull(),
  publicKeySpkiBase64: text("publicKeySpkiBase64"),
  keystoreAttestation: mysqlEnum("keystoreAttestation", ["hardware", "software", "unknown", "failed"]).default("unknown").notNull(),
  encryptedStorageAttested: boolean("encryptedStorageAttested").default(false).notNull(),
  appVersion: varchar("appVersion", { length: 40 }),
  status: mysqlEnum("status", ["enrolled", "active", "suspended", "revoked"]).default("enrolled").notNull(),
  enrolledAt: timestamp("enrolledAt").notNull(),
  enrolledByUserId: int("enrolledByUserId").notNull(),
  activatedAt: timestamp("activatedAt"),
  lastSeenAt: timestamp("lastSeenAt"),
  suspendedAt: timestamp("suspendedAt"),
  revokedAt: timestamp("revokedAt"),
  revokedByUserId: int("revokedByUserId"),
  revocationReason: varchar("revocationReason", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const deviceKeyEvents = mysqlTable("deviceKeyEvents", {
  id: int("id").autoincrement().primaryKey(),
  fieldDeviceId: int("fieldDeviceId").notNull(),
  keyFingerprint: varchar("keyFingerprint", { length: 64 }).notNull(),
  publicKeySpkiBase64: text("publicKeySpkiBase64"),
  eventType: mysqlEnum("eventType", ["enrolled", "rotated", "retired", "compromised"]).notNull(),
  validFrom: timestamp("validFrom").notNull(),
  validUntil: timestamp("validUntil"),
  reason: varchar("reason", { length: 300 }),
  recordedByUserId: int("recordedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});


export const deviceSyncNonces = mysqlTable("deviceSyncNonces", {
  id: int("id").autoincrement().primaryKey(),
  fieldDeviceId: int("fieldDeviceId").notNull(),
  orgRef: varchar("orgRef", { length: 40 }).notNull(),
  nonce: varchar("nonce", { length: 120 }).notNull(),
  signedAt: timestamp("signedAt").notNull(),
  packageRef: varchar("packageRef", { length: 64 }).notNull(),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
}, (t) => ({
  deviceNonceUnique: uniqueIndex("deviceSyncNonces_device_nonce_uq").on(t.fieldDeviceId, t.nonce),
}));

export const syncConflicts = mysqlTable("syncConflicts", {
  id: int("id").autoincrement().primaryKey(),
  conflictRef: varchar("conflictRef", { length: 64 }).notNull().unique(),
  fieldDeviceId: int("fieldDeviceId").notNull(),
  syncPackageId: int("syncPackageId"),
  recordType: varchar("recordType", { length: 60 }).notNull(),
  recordRef: varchar("recordRef", { length: 120 }).notNull(),
  deviceBaseVersion: int("deviceBaseVersion").notNull(),
  serverVersion: int("serverVersion").notNull(),
  conflictingFieldsJson: text("conflictingFieldsJson").notNull(),
  deviceValuesJson: text("deviceValuesJson").notNull(),
  serverValuesJson: text("serverValuesJson").notNull(),
  material: boolean("material").default(true).notNull(),
  status: mysqlEnum("status", ["unresolved", "resolved_device", "resolved_server", "resolved_merged", "withdrawn"]).default("unresolved").notNull(),
  resolvedByUserId: int("resolvedByUserId"),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNote: varchar("resolutionNote", { length: 400 }),
  detectedAt: timestamp("detectedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertFieldDevices = typeof fieldDevices.$inferInsert;
export type InsertDeviceKeyEvents = typeof deviceKeyEvents.$inferInsert;
export type InsertSyncConflicts = typeof syncConflicts.$inferInsert;

/* ==================================================================
 * v20.21 — Compliance Master Registry
 * ================================================================== */

export const complianceRequirements = mysqlTable("complianceRequirements", {
  id: int("id").autoincrement().primaryKey(),
  requirementKey: varchar("requirementKey", { length: 120 }).notNull(),
  version: int("version").default(1).notNull(),
  family: varchar("family", { length: 60 }).notNull(),
  packKey: varchar("packKey", { length: 80 }),
  title: varchar("title", { length: 220 }).notNull(),
  subjectType: mysqlEnum("subjectType", ["operator", "unit", "trailer", "carrier", "job", "user", "equipment", "attachment", "work_context"]).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  appliesWhenJson: text("appliesWhenJson"),
  satisfiedByDocTypes: text("satisfiedByDocTypes").notNull(),
  renewalIntervalDays: int("renewalIntervalDays"),
  warnDaysBeforeExpiry: int("warnDaysBeforeExpiry").default(30).notNull(),
  missingSeverity: mysqlEnum("missingSeverity", ["review", "blocked"]).default("review").notNull(),
  sourceAuthority: varchar("sourceAuthority", { length: 220 }),
  sourceUrl: varchar("sourceUrl", { length: 600 }),
  sourceReference: varchar("sourceReference", { length: 300 }),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveUntil: timestamp("effectiveUntil"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded", "withdrawn"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /* ---- 0198 (C1b-2b): who proposed the revision, and what it cites. Rows are immutable. ---- */
  /** The proposer's acting organization, from server scope. NULL on rows written before 0198. */
  orgRef: varchar("orgRef", { length: 64 }),
  proposedByUserId: int("proposedByUserId"),
  instrumentTitle: varchar("instrumentTitle", { length: 400 }),
  /** law | official_guidance | recognized_standard | manufacturer (the knowledge authority level). */
  authorityType: varchar("authorityType", { length: 40 }),
  /** The proposer recorded that the effective date is not known; `effectiveFrom` is the proposal time. */
  effectiveDateUnknown: boolean("effectiveDateUnknown").default(false).notNull(),
  /** sha256 of the revision's content and citation, as proposed. Every verification event repeats it. */
  citationHash: varchar("citationHash", { length: 64 }),
});

/** 0198 (C1b-2b) — every step in a requirement revision's verification. Append-only (triggers). */
export const requirementVerificationEvents = mysqlTable("requirementVerificationEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 64 }).notNull().unique(),
  requirementId: int("requirementId").notNull(),
  requirementKey: varchar("requirementKey", { length: 120 }).notNull(),
  version: int("version").notNull(),
  orgRef: varchar("orgRef", { length: 64 }),
  eventType: mysqlEnum("eventType", ["proposed", "approved", "rejected", "promoted", "withdrawn"]).notNull(),
  targetLevel: varchar("targetLevel", { length: 32 }),
  step: tinyint("step"),
  actorUserId: int("actorUserId").notNull(),
  reason: text("reason"),
  citationHash: varchar("citationHash", { length: 64 }),
  sourceRevisionRef: varchar("sourceRevisionRef", { length: 64 }),
  sourceHash: varchar("sourceHash", { length: 64 }),
  comparisonJson: text("comparisonJson"),
  promotionRef: varchar("promotionRef", { length: 64 }),
  verifierUserIdsJson: text("verifierUserIdsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  requirementIdx: index("requirementVerificationEvents_requirement_idx").on(t.requirementId),
  keyIdx: index("requirementVerificationEvents_key_idx").on(t.requirementKey, t.version),
}));
export type RequirementVerificationEventRow = typeof requirementVerificationEvents.$inferSelect;

/** 0198 (C1b-2b) — citation allowed, or source document required, by authority / domain / jurisdiction. Append-only. */
export const sourceVerificationPolicies = mysqlTable("sourceVerificationPolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyRef: varchar("policyRef", { length: 64 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  issuingAuthority: varchar("issuingAuthority", { length: 220 }),
  domain: varchar("domain", { length: 60 }),
  jurisdiction: varchar("jurisdiction", { length: 80 }),
  mode: mysqlEnum("mode", ["CITATION_ALLOWED", "SOURCE_DOCUMENT_REQUIRED"]).notNull(),
  reason: text("reason").notNull(),
  setByUserId: int("setByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const complianceConsents = mysqlTable("complianceConsents", {
  id: int("id").autoincrement().primaryKey(),
  consentRef: varchar("consentRef", { length: 64 }).notNull().unique(),
  subjectUserId: int("subjectUserId").notNull(),
  consentType: mysqlEnum("consentType", ["driver_abstract", "commercial_driver_abstract", "medical_fitness_confirmation", "experience_record_release", "background_check", "other"]).notNull(),
  purpose: varchar("purpose", { length: 300 }).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  signedAt: timestamp("signedAt").notNull(),
  validUntil: timestamp("validUntil"),
  coveragePeriodFrom: timestamp("coveragePeriodFrom"),
  coveragePeriodTo: timestamp("coveragePeriodTo"),
  signatureEvidenceRecordId: int("signatureEvidenceRecordId"),
  payloadHash: varchar("payloadHash", { length: 64 }),
  withdrawnAt: timestamp("withdrawnAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const writtenProgramVersions = mysqlTable("writtenProgramVersions", {
  id: int("id").autoincrement().primaryKey(),
  programKey: varchar("programKey", { length: 80 }).notNull(),
  version: int("version").notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  programType: mysqlEnum("programType", ["safety", "maintenance", "ohs", "emergency_response", "other"]).notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  supersededAt: timestamp("supersededAt"),
  supersededByVersion: int("supersededByVersion"),
  approvedByUserId: int("approvedByUserId").notNull(),
  approvedAt: timestamp("approvedAt").notNull(),
  reviewDueAt: timestamp("reviewDueAt"),
  applicableBranchesJson: text("applicableBranchesJson"),
  applicableEquipmentJson: text("applicableEquipmentJson"),
  documentEvidenceRecordId: int("documentEvidenceRecordId"),
  contentHash: varchar("contentHash", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const programAcknowledgements = mysqlTable("programAcknowledgements", {
  id: int("id").autoincrement().primaryKey(),
  writtenProgramVersionId: int("writtenProgramVersionId").notNull(),
  userId: int("userId").notNull(),
  acknowledgedAt: timestamp("acknowledgedAt").notNull(),
  method: mysqlEnum("method", ["app", "signature", "training_session"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const carrierProfileReviews = mysqlTable("carrierProfileReviews", {
  id: int("id").autoincrement().primaryKey(),
  reviewRef: varchar("reviewRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  profileObtainedAt: timestamp("profileObtainedAt").notNull(),
  reviewedAt: timestamp("reviewedAt"),
  reviewedByUserId: int("reviewedByUserId"),
  nextReviewDueAt: timestamp("nextReviewDueAt"),
  inspectionsOnProfile: int("inspectionsOnProfile").default(0).notNull(),
  convictionsOnProfile: int("convictionsOnProfile").default(0).notNull(),
  collisionsOnProfile: int("collisionsOnProfile").default(0).notNull(),
  unmatchedExternalEvents: int("unmatchedExternalEvents").default(0).notNull(),
  riskTrend: mysqlEnum("riskTrend", ["improving", "stable", "worsening", "unknown"]).default("unknown").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertComplianceRequirements = typeof complianceRequirements.$inferInsert;
export type InsertComplianceConsents = typeof complianceConsents.$inferInsert;
export type InsertWrittenProgramVersions = typeof writtenProgramVersions.$inferInsert;
export type InsertProgramAcknowledgements = typeof programAcknowledgements.$inferInsert;
export type InsertCarrierProfileReviews = typeof carrierProfileReviews.$inferInsert;

/* ==================================================================
 * v20.22 — Requirement engine, packs, equipment authorization, calibration
 * ================================================================== */

export const compliancePacks = mysqlTable("compliancePacks", {
  id: int("id").autoincrement().primaryKey(),
  packKey: varchar("packKey", { length: 80 }).notNull().unique(),
  title: varchar("title", { length: 220 }).notNull(),
  description: text("description"),
  activatesWhenJson: text("activatesWhenJson"),
  jurisdiction: varchar("jurisdiction", { length: 80 }).default("*").notNull(),
  core: boolean("core").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const companyPackActivations = mysqlTable("companyPackActivations", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId").notNull(),
  packKey: varchar("packKey", { length: 80 }).notNull(),
  activatedAt: timestamp("activatedAt").notNull(),
  activatedByUserId: int("activatedByUserId").notNull(),
  reason: varchar("reason", { length: 300 }),
  deactivatedAt: timestamp("deactivatedAt"),
  deactivatedByUserId: int("deactivatedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const operatorEquipmentAuthorizations = mysqlTable("operatorEquipmentAuthorizations", {
  id: int("id").autoincrement().primaryKey(),
  authorizationRef: varchar("authorizationRef", { length: 64 }).notNull().unique(),
  userId: int("userId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  equipmentType: varchar("equipmentType", { length: 80 }).notNull(),
  attachmentType: varchar("attachmentType", { length: 80 }),
  trainingEvidenceId: int("trainingEvidenceId"),
  competencyEvidenceId: int("competencyEvidenceId"),
  competencyAssessedByUserId: int("competencyAssessedByUserId"),
  competencyAssessedAt: timestamp("competencyAssessedAt"),
  instructionsAcknowledgedAt: timestamp("instructionsAcknowledgedAt"),
  authorizedByUserId: int("authorizedByUserId"),
  authorizedAt: timestamp("authorizedAt"),
  expiresAt: timestamp("expiresAt"),
  status: mysqlEnum("status", ["pending", "authorized", "suspended", "revoked", "expired"]).default("pending").notNull(),
  revokedReason: varchar("revokedReason", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const measurementDevices = mysqlTable("measurementDevices", {
  id: int("id").autoincrement().primaryKey(),
  deviceRef: varchar("deviceRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  deviceType: mysqlEnum("deviceType", ["truck_scale", "onboard_load_sensor", "load_cell", "fuel_meter", "flow_meter", "vacuum_gauge", "pressure_gauge", "torque_wrench", "gas_detector", "sound_meter", "temperature_probe", "hydraulic_gauge", "other"]).notNull(),
  manufacturer: varchar("manufacturer", { length: 120 }),
  model: varchar("model", { length: 120 }),
  serialNumber: varchar("serialNumber", { length: 120 }),
  measures: varchar("measures", { length: 60 }).notNull(),
  unitOfMeasure: varchar("unitOfMeasure", { length: 20 }).notNull(),
  calibrationIntervalDays: int("calibrationIntervalDays"),
  status: mysqlEnum("status", ["active", "out_of_service", "retired"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const calibrationEvents = mysqlTable("calibrationEvents", {
  id: int("id").autoincrement().primaryKey(),
  measurementDeviceId: int("measurementDeviceId").notNull(),
  eventType: mysqlEnum("eventType", ["calibrated", "verified", "failed", "adjusted", "out_of_tolerance_found", "returned_to_service"]).notNull(),
  performedAt: timestamp("performedAt").notNull(),
  performedBy: varchar("performedBy", { length: 180 }),
  certificateEvidenceId: int("certificateEvidenceId"),
  standardReference: varchar("standardReference", { length: 180 }),
  toleranceStated: varchar("toleranceStated", { length: 80 }),
  errorFound: varchar("errorFound", { length: 120 }),
  suspectFrom: timestamp("suspectFrom"),
  validUntil: timestamp("validUntil"),
  notes: text("notes"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const measurementDeviceAssignments = mysqlTable("measurementDeviceAssignments", {
  id: int("id").autoincrement().primaryKey(),
  measurementDeviceId: int("measurementDeviceId").notNull(),
  assignedToType: mysqlEnum("assignedToType", ["unit", "trailer", "facility", "shop", "worker"]).notNull(),
  assignedToId: int("assignedToId").notNull(),
  assignedFrom: timestamp("assignedFrom").notNull(),
  assignedUntil: timestamp("assignedUntil"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertCompliancePacks = typeof compliancePacks.$inferInsert;
export type InsertCompanyPackActivations = typeof companyPackActivations.$inferInsert;
export type InsertOperatorEquipmentAuthorizations = typeof operatorEquipmentAuthorizations.$inferInsert;
export type InsertMeasurementDevices = typeof measurementDevices.$inferInsert;
export type InsertCalibrationEvents = typeof calibrationEvents.$inferInsert;
export type InsertMeasurementDeviceAssignments = typeof measurementDeviceAssignments.$inferInsert;

/* ==================================================================
 * v20.23 — Insurance & Risk
 * ================================================================== */

export const insuranceProviders = mysqlTable("insuranceProviders", {
  id: int("id").autoincrement().primaryKey(),
  providerRef: varchar("providerRef", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 220 }).notNull(),
  role: mysqlEnum("role", ["insurer", "broker", "adjuster", "other"]).notNull(),
  claimsPhone: varchar("claimsPhone", { length: 40 }),
  afterHoursPhone: varchar("afterHoursPhone", { length: 40 }),
  billingContact: varchar("billingContact", { length: 220 }),
  underwriterContact: varchar("underwriterContact", { length: 220 }),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insurancePolicies = mysqlTable("insurancePolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyRef: varchar("policyRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  policyType: mysqlEnum("policyType", ["commercial_auto", "physical_damage", "cargo", "general_liability", "property", "equipment", "pollution_environmental", "garage", "cyber", "professional_liability", "umbrella_excess", "non_owned_auto", "wcb", "surety_bond", "other"]).notNull(),
  insurerId: int("insurerId").notNull(),
  brokerId: int("brokerId"),
  policyNumber: varchar("policyNumber", { length: 120 }).notNull(),
  effectiveAt: timestamp("effectiveAt").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  status: mysqlEnum("status", ["quoted", "binder", "active", "renewal_pending", "cancelled", "expired"]).default("active").notNull(),
  annualPremium: double("annualPremium"),
  annualPremiumCents: int("annualPremiumCents"),
  deductible: double("deductible"),
  deductibleCents: int("deductibleCents"),
  evidenceRecordId: int("evidenceRecordId"),
  coverageVerificationStatus: mysqlEnum("coverageVerificationStatus", ["coverage_verified", "coverage_reported", "coverage_unknown"]).default("coverage_reported").notNull(),
  coverageVerifiedAt: timestamp("coverageVerifiedAt"),
  coverageVerifiedByUserId: int("coverageVerifiedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insurancePolicyCoverages = mysqlTable("insurancePolicyCoverages", {
  id: int("id").autoincrement().primaryKey(),
  insurancePolicyId: int("insurancePolicyId").notNull(),
  coverageType: varchar("coverageType", { length: 80 }).notNull(),
  limitAmount: double("limitAmount"),
  limitAmountCents: int("limitAmountCents"),
  limitBasis: mysqlEnum("limitBasis", ["per_occurrence", "aggregate", "per_vehicle", "per_load", "other"]),
  deductible: double("deductible"),
  deductibleCents: int("deductibleCents"),
  additionalInsuredEndorsement: boolean("additionalInsuredEndorsement").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insuranceCoveredEntities = mysqlTable("insuranceCoveredEntities", {
  id: int("id").autoincrement().primaryKey(),
  insurancePolicyId: int("insurancePolicyId").notNull(),
  entityType: mysqlEnum("entityType", ["unit", "trailer", "equipment", "operator", "branch", "facility", "company"]).notNull(),
  entityId: int("entityId").notNull(),
  coveredFrom: timestamp("coveredFrom").notNull(),
  coveredUntil: timestamp("coveredUntil"),
  statedValue: double("statedValue"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insuranceRequirements = mysqlTable("insuranceRequirements", {
  id: int("id").autoincrement().primaryKey(),
  customerRef: varchar("customerRef", { length: 220 }).notNull(),
  coverageType: varchar("coverageType", { length: 80 }).notNull(),
  minimumLimit: double("minimumLimit"),
  additionalInsuredRequired: boolean("additionalInsuredRequired").default(false).notNull(),
  contractingEntityRef: varchar("contractingEntityRef", { length: 220 }),
  certificateExpiryRequired: boolean("certificateExpiryRequired").default(true).notNull(),
  notes: varchar("notes", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insuranceCertificates = mysqlTable("insuranceCertificates", {
  id: int("id").autoincrement().primaryKey(),
  certificateRef: varchar("certificateRef", { length: 64 }).notNull().unique(),
  insurancePolicyId: int("insurancePolicyId").notNull(),
  recipientCustomerRef: varchar("recipientCustomerRef", { length: 220 }).notNull(),
  issuedAt: timestamp("issuedAt").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  additionalInsuredNamed: boolean("additionalInsuredNamed").default(false).notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  sharedAt: timestamp("sharedAt"),
  sharedByUserId: int("sharedByUserId"),
  supersededByCertificateId: int("supersededByCertificateId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insuranceClaims = mysqlTable("insuranceClaims", {
  id: int("id").autoincrement().primaryKey(),
  claimRef: varchar("claimRef", { length: 64 }).notNull().unique(),
  insurancePolicyId: int("insurancePolicyId").notNull(),
  incidentReportId: int("incidentReportId"),
  roadsideEventId: int("roadsideEventId"),
  unitId: int("unitId"),
  trailerId: int("trailerId"),
  jobId: int("jobId"),
  lossOccurredAt: timestamp("lossOccurredAt").notNull(),
  claimType: mysqlEnum("claimType", ["collision", "cargo", "property", "equipment", "environmental", "theft", "glass", "liability", "other"]).notNull(),
  insurerClaimNumber: varchar("insurerClaimNumber", { length: 120 }),
  status: mysqlEnum("status", ["potential", "reported", "adjuster_assigned", "information_requested", "under_review", "approved", "denied", "settled", "closed"]).default("potential").notNull(),
  deductible: double("deductible"),
  deductibleCents: int("deductibleCents"),
  estimatedLoss: double("estimatedLoss"),
  estimatedLossCents: int("estimatedLossCents"),
  approvedAmount: double("approvedAmount"),
  approvedAmountCents: int("approvedAmountCents"),
  openedByUserId: int("openedByUserId").notNull(),
  openedAt: timestamp("openedAt").notNull(),
  closedAt: timestamp("closedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insuranceClaimCosts = mysqlTable("insuranceClaimCosts", {
  id: int("id").autoincrement().primaryKey(),
  insuranceClaimId: int("insuranceClaimId").notNull(),
  costType: mysqlEnum("costType", ["tow", "repair", "rental_replacement", "cleanup", "cargo_loss", "downtime", "legal", "other"]).notNull(),
  amount: double("amount").notNull(),
  amountCents: int("amountCents"),
  vendorBillId: int("vendorBillId"),
  expenseRecordId: int("expenseRecordId"),
  incurredAt: timestamp("incurredAt").notNull(),
  note: varchar("note", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const insuranceClaimRecoveries = mysqlTable("insuranceClaimRecoveries", {
  id: int("id").autoincrement().primaryKey(),
  insuranceClaimId: int("insuranceClaimId").notNull(),
  recoveryType: mysqlEnum("recoveryType", ["approved", "received", "denied", "adjustment"]).notNull(),
  amount: double("amount").notNull(),
  amountCents: int("amountCents"),
  recordedAt: timestamp("recordedAt").notNull(),
  reference: varchar("reference", { length: 120 }),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertInsuranceProviders = typeof insuranceProviders.$inferInsert;
export type InsertInsurancePolicies = typeof insurancePolicies.$inferInsert;
export type InsertInsurancePolicyCoverages = typeof insurancePolicyCoverages.$inferInsert;
export type InsertInsuranceCoveredEntities = typeof insuranceCoveredEntities.$inferInsert;
export type InsertInsuranceRequirements = typeof insuranceRequirements.$inferInsert;
export type InsertInsuranceCertificates = typeof insuranceCertificates.$inferInsert;
export type InsertInsuranceClaims = typeof insuranceClaims.$inferInsert;
export type InsertInsuranceClaimCosts = typeof insuranceClaimCosts.$inferInsert;
export type InsertInsuranceClaimRecoveries = typeof insuranceClaimRecoveries.$inferInsert;

/* ==================================================================
 * v21.2 — Dispatch enforcement
 * ================================================================== */

export const dispatchEnforcementSettings = mysqlTable("dispatchEnforcementSettings", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId"),
  mode: mysqlEnum("mode", ["off", "advisory", "enforced"]).notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  setByUserId: int("setByUserId").notNull(),
  setAt: timestamp("setAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type InsertDispatchEnforcementSetting = typeof dispatchEnforcementSettings.$inferInsert;

/* ==================================================================
 * v21.3 — IFTA
 * ================================================================== */

export const jurisdictionDistanceRecords = mysqlTable("jurisdictionDistanceRecords", {
  id: int("id").autoincrement().primaryKey(),
  distanceRef: varchar("distanceRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  unitId: int("unitId").notNull(),
  tripId: int("tripId"),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  distanceKm: double("distanceKm").notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  source: mysqlEnum("source", ["gps", "routing", "odometer_split", "operator_stated", "imported", "system_inferred"]).notNull(),
  verificationStatus: mysqlEnum("verificationStatus", ["needs_review", "verified", "rejected"]).default("needs_review").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  recordedByUserId: int("recordedByUserId").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  notes: varchar("notes", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const iftaReturns = mysqlTable("iftaReturns", {
  id: int("id").autoincrement().primaryKey(),
  returnRef: varchar("returnRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  quarter: varchar("quarter", { length: 7 }).notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  status: mysqlEnum("status", ["prepared", "finalized", "filed", "amended"]).default("prepared").notNull(),
  summaryJson: text("summaryJson").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  taxDetermination: mysqlEnum("taxDetermination", ["computed", "unknown"]).notNull(),
  preparedByUserId: int("preparedByUserId").notNull(),
  preparedAt: timestamp("preparedAt").notNull(),
  finalizedByUserId: int("finalizedByUserId"),
  finalizedAt: timestamp("finalizedAt"),
  supersedesReturnId: int("supersedesReturnId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type InsertJurisdictionDistanceRecord = typeof jurisdictionDistanceRecords.$inferInsert;
export type InsertIftaReturn = typeof iftaReturns.$inferInsert;

/* ==================================================================
 * v21.4 — Bulk fuel, statements
 * ================================================================== */

export const bulkFuelTanks = mysqlTable("bulkFuelTanks", {
  id: int("id").autoincrement().primaryKey(),
  tankRef: varchar("tankRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  fuelAccountId: int("fuelAccountId"),
  name: varchar("name", { length: 120 }).notNull(),
  location: varchar("location", { length: 300 }),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  fuelType: mysqlEnum("fuelType", ["diesel", "gasoline", "def", "propane", "other"]).notNull(),
  capacityLitres: double("capacityLitres").notNull(),
  meterDeviceId: int("meterDeviceId"),
  varianceTolerancePct: double("varianceTolerancePct").default(2).notNull(),
  status: mysqlEnum("status", ["active", "out_of_service", "retired"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const bulkFuelDispenses = mysqlTable("bulkFuelDispenses", {
  id: int("id").autoincrement().primaryKey(),
  dispenseRef: varchar("dispenseRef", { length: 64 }).notNull().unique(),
  bulkFuelTankId: int("bulkFuelTankId").notNull(),
  unitId: int("unitId"),
  equipmentId: int("equipmentId"),
  fuelTransactionId: int("fuelTransactionId"),
  litres: double("litres").notNull(),
  quantitySource: mysqlEnum("quantitySource", ["meter", "stick_before_after", "stated"]).notNull(),
  meterBefore: double("meterBefore"),
  meterAfter: double("meterAfter"),
  odometerKm: double("odometerKm"),
  occurredAt: timestamp("occurredAt").notNull(),
  dispensedByUserId: int("dispensedByUserId").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const bulkFuelReadings = mysqlTable("bulkFuelReadings", {
  id: int("id").autoincrement().primaryKey(),
  bulkFuelTankId: int("bulkFuelTankId").notNull(),
  readAt: timestamp("readAt").notNull(),
  litresOnHand: double("litresOnHand").notNull(),
  method: mysqlEnum("method", ["stick", "gauge", "meter_total", "delivery_ticket"]).notNull(),
  readByUserId: int("readByUserId").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fuelStatements = mysqlTable("fuelStatements", {
  id: int("id").autoincrement().primaryKey(),
  statementRef: varchar("statementRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  fuelAccountId: int("fuelAccountId").notNull(),
  provider: varchar("provider", { length: 120 }).notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  lineCount: int("lineCount").default(0).notNull(),
  matchedCount: int("matchedCount").default(0).notNull(),
  varianceCount: int("varianceCount").default(0).notNull(),
  unmatchedCount: int("unmatchedCount").default(0).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull().unique(),
  importedByUserId: int("importedByUserId").notNull(),
  importedAt: timestamp("importedAt").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fuelStatementLines = mysqlTable("fuelStatementLines", {
  id: int("id").autoincrement().primaryKey(),
  fuelStatementId: int("fuelStatementId").notNull(),
  lineNo: int("lineNo").notNull(),
  transactionAt: timestamp("transactionAt").notNull(),
  cardLastFour: varchar("cardLastFour", { length: 4 }),
  merchant: varchar("merchant", { length: 220 }),
  merchantLocation: varchar("merchantLocation", { length: 300 }),
  jurisdiction: varchar("jurisdiction", { length: 80 }),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 12 }),
  total: double("total").notNull(),
  totalCents: int("totalCents"),
  unitHint: varchar("unitHint", { length: 40 }),
  matchedFuelTransactionId: int("matchedFuelTransactionId"),
  matchOutcome: mysqlEnum("matchOutcome", ["match", "match_with_variance", "unmatched", "ambiguous"]).notNull(),
  matchReason: varchar("matchReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertBulkFuelTanks = typeof bulkFuelTanks.$inferInsert;
export type InsertBulkFuelDispenses = typeof bulkFuelDispenses.$inferInsert;
export type InsertBulkFuelReadings = typeof bulkFuelReadings.$inferInsert;
export type InsertFuelStatements = typeof fuelStatements.$inferInsert;
export type InsertFuelStatementLines = typeof fuelStatementLines.$inferInsert;

/* ==================================================================
 * v21.5 — Period close
 * ================================================================== */

export const periodCloses = mysqlTable("periodCloses", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId").notNull(),
  period: varchar("period", { length: 7 }).notNull(),
  action: mysqlEnum("action", ["soft_close", "close", "reopen"]).notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  readinessJson: text("readinessJson"),
  byUserId: int("byUserId").notNull(),
  at: timestamp("at").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type InsertPeriodClose = typeof periodCloses.$inferInsert;

/* ==================================================================
 * v21.8 — GST/HST
 * ================================================================== */

export const gstReturns = mysqlTable("gstReturns", {
  id: int("id").autoincrement().primaryKey(),
  returnRef: varchar("returnRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  period: varchar("period", { length: 7 }).notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  status: mysqlEnum("status", ["prepared", "finalized", "filed", "amended"]).default("prepared").notNull(),
  summaryJson: text("summaryJson").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  determination: mysqlEnum("determination", ["ready", "review", "blocked"]).notNull(),
  netTaxCents: int("netTaxCents"),
  preparedByUserId: int("preparedByUserId").notNull(),
  preparedAt: timestamp("preparedAt").notNull(),
  finalizedByUserId: int("finalizedByUserId"),
  finalizedAt: timestamp("finalizedAt"),
  reviewItemsAcknowledged: text("reviewItemsAcknowledged"),
  supersedesReturnId: int("supersedesReturnId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const gstAdjustments = mysqlTable("gstAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  adjustmentRef: varchar("adjustmentRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  period: varchar("period", { length: 7 }).notNull(),
  line: mysqlEnum("line", ["104", "107"]).notNull(),
  amountCents: int("amountCents").notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  recordedAt: timestamp("recordedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type InsertGstReturn = typeof gstReturns.$inferInsert;
export type InsertGstAdjustment = typeof gstAdjustments.$inferInsert;

/* ==================================================================
 * v21.9 — Bank reconciliation, accounts receivable
 * ================================================================== */

export const bankAccounts = mysqlTable("bankAccounts", {
  id: int("id").autoincrement().primaryKey(),
  accountRef: varchar("accountRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  institution: varchar("institution", { length: 120 }),
  lastFour: varchar("lastFour", { length: 4 }),
  currency: varchar("currency", { length: 3 }).default("CAD").notNull(),
  status: mysqlEnum("status", ["active", "closed"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const bankStatements = mysqlTable("bankStatements", {
  id: int("id").autoincrement().primaryKey(),
  statementRef: varchar("statementRef", { length: 64 }).notNull().unique(),
  bankAccountId: int("bankAccountId").notNull(),
  periodStart: timestamp("periodStart").notNull(),
  periodEnd: timestamp("periodEnd").notNull(),
  openingBalanceCents: int("openingBalanceCents").notNull(),
  closingBalanceCents: int("closingBalanceCents").notNull(),
  lineCount: int("lineCount").default(0).notNull(),
  matchedCount: int("matchedCount").default(0).notNull(),
  unmatchedCount: int("unmatchedCount").default(0).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull().unique(),
  importedByUserId: int("importedByUserId").notNull(),
  importedAt: timestamp("importedAt").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const bankStatementLines = mysqlTable("bankStatementLines", {
  id: int("id").autoincrement().primaryKey(),
  bankStatementId: int("bankStatementId").notNull(),
  lineNo: int("lineNo").notNull(),
  postedAt: timestamp("postedAt").notNull(),
  description: varchar("description", { length: 300 }),
  reference: varchar("reference", { length: 120 }),
  amountCents: int("amountCents").notNull(),
  matchedType: mysqlEnum("matchedType", ["customer_payment", "vendor_bill", "fuel_statement", "transfer", "bank_fee", "other"]),
  matchedId: int("matchedId"),
  matchOutcome: mysqlEnum("matchOutcome", ["matched", "unmatched", "ambiguous", "timing_difference"]).notNull(),
  matchReason: varchar("matchReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const customerPayments = mysqlTable("customerPayments", {
  id: int("id").autoincrement().primaryKey(),
  paymentRef: varchar("paymentRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  customer: varchar("customer", { length: 220 }).notNull(),
  // v21.9.1 — identity, not a name.
  customerAccountId: int("customerAccountId"),
  receivedAt: timestamp("receivedAt").notNull(),
  amountCents: int("amountCents").notNull(),
  method: mysqlEnum("method", ["eft", "cheque", "card", "cash", "other"]).notNull(),
  reference: varchar("reference", { length: 120 }),
  bankStatementLineId: int("bankStatementLineId"),
  status: mysqlEnum("status", ["unapplied", "partially_applied", "applied", "reversed"]).default("unapplied").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const paymentAllocations = mysqlTable("paymentAllocations", {
  id: int("id").autoincrement().primaryKey(),
  customerPaymentId: int("customerPaymentId").notNull(),
  invoiceId: int("invoiceId").notNull(),
  amountCents: int("amountCents").notNull(),
  allocatedByUserId: int("allocatedByUserId").notNull(),
  allocatedAt: timestamp("allocatedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const customerCredits = mysqlTable("customerCredits", {
  id: int("id").autoincrement().primaryKey(),
  creditRef: varchar("creditRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  customer: varchar("customer", { length: 220 }).notNull(),
  // v21.9.1 — identity, not a name.
  customerAccountId: int("customerAccountId"),
  invoiceId: int("invoiceId"),
  amountCents: int("amountCents").notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  status: mysqlEnum("status", ["requested", "approved", "refused"]).default("requested").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const collectionEvents = mysqlTable("collectionEvents", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  eventType: mysqlEnum("eventType", ["reminder_sent", "statement_sent", "call", "promise_to_pay", "dispute_noted", "escalated", "write_off_requested", "write_off_decided"]).notNull(),
  note: varchar("note", { length: 600 }),
  promisedAmountCents: int("promisedAmountCents"),
  promisedAt: timestamp("promisedAt"),
  byUserId: int("byUserId").notNull(),
  at: timestamp("at").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const writeOffRequests = mysqlTable("writeOffRequests", {
  id: int("id").autoincrement().primaryKey(),
  requestRef: varchar("requestRef", { length: 64 }).notNull().unique(),
  invoiceId: int("invoiceId").notNull(),
  amountCents: int("amountCents").notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  status: mysqlEnum("status", ["requested", "approved", "refused"]).default("requested").notNull(),
  decisionReason: varchar("decisionReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertBankAccounts = typeof bankAccounts.$inferInsert;
export type InsertBankStatements = typeof bankStatements.$inferInsert;
export type InsertBankStatementLines = typeof bankStatementLines.$inferInsert;
export type InsertCustomerPayments = typeof customerPayments.$inferInsert;
export type InsertPaymentAllocations = typeof paymentAllocations.$inferInsert;
export type InsertCustomerCredits = typeof customerCredits.$inferInsert;
export type InsertCollectionEvents = typeof collectionEvents.$inferInsert;
export type InsertWriteOffRequests = typeof writeOffRequests.$inferInsert;

/* ==================================================================
 * v21.9.1 — Customer identity
 * ================================================================== */

export const customerAccounts = mysqlTable("customerAccounts", {
  id: int("id").autoincrement().primaryKey(),
  /** 0136 — the client organization a person linked this account to; NULL until someone does. */
  orgRef: varchar("orgRef", { length: 64 }),
  accountRef: varchar("accountRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  name: varchar("name", { length: 220 }).notNull(),
  paymentTermsDays: int("paymentTermsDays").default(30).notNull(),
  creditLimitCents: int("creditLimitCents"),
  requiresPurchaseOrder: boolean("requiresPurchaseOrder").default(false).notNull(),
  requiresAfe: boolean("requiresAfe").default(false).notNull(),
  billingFrequency: mysqlEnum("billingFrequency", ["per_job", "weekly", "monthly"]).default("per_job").notNull(),
  holdReason: varchar("holdReason", { length: 300 }),
  // v21.11 — contract rules: which delays the customer pays for, and the post-site billing basis.
  delayBillingRulesJson: text("delayBillingRulesJson"),
  postSiteBillingRuleJson: text("postSiteBillingRuleJson"),
  status: mysqlEnum("status", ["active", "on_hold", "inactive"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  // 0217 — the account profile: the canonical commercial party. Additive; NULL/defaulted for every prior row.
  customerNumber: varchar("customerNumber", { length: 40 }),
  legalName: varchar("legalName", { length: 220 }),
  tradeName: varchar("tradeName", { length: 220 }),
  customerType: mysqlEnum("customerType", ["producer_operator", "oilfield_service", "prime_contractor", "consultant", "disposal_company", "municipality", "construction", "trucking", "other"]).default("other").notNull(),
  billingAddressJson: text("billingAddressJson"),
  physicalAddressJson: text("physicalAddressJson"),
  province: varchar("province", { length: 8 }),
  country: varchar("country", { length: 2 }).default("CA").notNull(),
  gstNumber: varchar("gstNumber", { length: 20 }),
  taxStatus: mysqlEnum("taxStatus", ["taxable", "zero_rated", "exempt", "unknown"]).default("unknown").notNull(),
  defaultCurrency: varchar("defaultCurrency", { length: 3 }).default("CAD").notNull(),
  requiredReferenceKindsJson: text("requiredReferenceKindsJson"),
  notes: text("notes"),
  createdByUserId: int("createdByUserId"),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  archivedAt: timestamp("archivedAt"),
  archivedByUserId: int("archivedByUserId"),
  archiveReason: varchar("archiveReason", { length: 400 }),
  rowVersion: int("rowVersion").default(1).notNull(),
});
export type InsertCustomerAccount = typeof customerAccounts.$inferInsert;

/* ==================================================================
 * v21.10 — Commercial core, external portals
 * ================================================================== */

export const customerPurchaseOrders = mysqlTable("customerPurchaseOrders", {
  id: int("id").autoincrement().primaryKey(),
  poRef: varchar("poRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  poNumber: varchar("poNumber", { length: 80 }).notNull(),
  afeNumber: varchar("afeNumber", { length: 80 }),
  authorizedCents: int("authorizedCents").notNull(),
  validFrom: timestamp("validFrom").notNull(),
  validTo: timestamp("validTo"),
  status: mysqlEnum("status", ["open", "exhausted", "expired", "closed"]).default("open").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const customerRateCards = mysqlTable("customerRateCards", {
  id: int("id").autoincrement().primaryKey(),
  rateCardRef: varchar("rateCardRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  version: int("version").default(1).notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  status: mysqlEnum("status", ["draft", "approved", "superseded"]).default("draft").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const customerRateCardLines = mysqlTable("customerRateCardLines", {
  id: int("id").autoincrement().primaryKey(),
  rateCardId: int("rateCardId").notNull(),
  serviceCode: varchar("serviceCode", { length: 60 }).notNull(),
  description: varchar("description", { length: 220 }).notNull(),
  unit: mysqlEnum("unit", ["hour", "day", "km", "m3", "tonne", "load", "each"]).notNull(),
  rateCents: int("rateCents").notNull(),
  minimumCents: int("minimumCents"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const externalIdentities = mysqlTable("externalIdentities", {
  id: int("id").autoincrement().primaryKey(),
  identityRef: varchar("identityRef", { length: 64 }).notNull().unique(),
  kind: mysqlEnum("kind", ["customer", "vendor", "facility"]).notNull(),
  customerAccountId: int("customerAccountId"),
  vendorId: int("vendorId"),
  facilityId: int("facilityId"),
  email: varchar("email", { length: 220 }).notNull(),
  displayName: varchar("displayName", { length: 180 }).notNull(),
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  // v21.12 — invitation, expiry, rotation, lockout, MFA. Secrets only as hashes or encrypted.
  invitationTokenHash: varchar("invitationTokenHash", { length: 64 }),
  invitationExpiresAt: timestamp("invitationExpiresAt"),
  acceptedAt: timestamp("acceptedAt"),
  tokenExpiresAt: timestamp("tokenExpiresAt"),
  previousTokenHash: varchar("previousTokenHash", { length: 64 }),
  previousTokenExpiresAt: timestamp("previousTokenExpiresAt"),
  mfaEnabled: boolean("mfaEnabled").default(false).notNull(),
  /**
   * 0049 — legacy inline ciphertext under `LEASEOS_PORTAL_MFA_KEY`. Read-only from S2-D onward:
   * new enrollments write `mfaSecretRef` instead, and this is cleared once migration is verified.
   */
  mfaSecretEnc: varchar("mfaSecretEnc", { length: 400 }),
  /** 0193 — pointer into `encryptedSecrets` under purpose `MFA_SECRET`. Preferred when present. */
  mfaSecretRef: varchar("mfaSecretRef", { length: 64 }),
  failedAttempts: int("failedAttempts").default(0).notNull(),
  lockedUntil: timestamp("lockedUntil"),
  revokedAt: timestamp("revokedAt"),
  revokedReason: varchar("revokedReason", { length: 300 }),
  status: mysqlEnum("status", ["invited", "active", "suspended", "revoked"]).default("invited").notNull(),
  invitedByUserId: int("invitedByUserId").notNull(),
  invitedAt: timestamp("invitedAt").notNull(),
  lastSeenAt: timestamp("lastSeenAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const portalSubmissions = mysqlTable("portalSubmissions", {
  id: int("id").autoincrement().primaryKey(),
  submissionRef: varchar("submissionRef", { length: 64 }).notNull().unique(),
  externalIdentityId: int("externalIdentityId").notNull(),
  kind: mysqlEnum("kind", ["vendor_bill", "disposal_ticket", "invoice_dispute", "po_acknowledgement"]).notNull(),
  payloadJson: text("payloadJson").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  status: mysqlEnum("status", ["submitted", "accepted", "rejected", "duplicate"]).default("submitted").notNull(),
  resultRef: varchar("resultRef", { length: 80 }),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  reviewReason: varchar("reviewReason", { length: 400 }),
  submittedAt: timestamp("submittedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertCustomerPurchaseOrders = typeof customerPurchaseOrders.$inferInsert;
export type InsertCustomerRateCards = typeof customerRateCards.$inferInsert;
export type InsertCustomerRateCardLines = typeof customerRateCardLines.$inferInsert;
export type InsertExternalIdentities = typeof externalIdentities.$inferInsert;
export type InsertPortalSubmissions = typeof portalSubmissions.$inferInsert;

/* ==================================================================
 * v21.11 — Site sign-off and the post-site billing chain
 * ================================================================== */

export const signatoryAuthorities = mysqlTable("signatoryAuthorities", {
  id: int("id").autoincrement().primaryKey(),
  authorityRef: varchar("authorityRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  signatoryName: varchar("signatoryName", { length: 180 }).notNull(),
  signatoryRole: varchar("signatoryRole", { length: 120 }),
  externalIdentityId: int("externalIdentityId"),
  mayConfirmWork: boolean("mayConfirmWork").default(true).notNull(),
  maySignTicket: boolean("maySignTicket").default(true).notNull(),
  mayApproveStandby: boolean("mayApproveStandby").default(false).notNull(),
  extraWorkLimitCents: int("extraWorkLimitCents"),
  mayApproveInvoice: boolean("mayApproveInvoice").default(false).notNull(),
  mayChangeRates: boolean("mayChangeRates").default(false).notNull(),
  // v21.17 — commercial authority: accepting a quote, answering an RFI.
  mayAcceptQuotes: boolean("mayAcceptQuotes").default(false).notNull(),
  mayAnswerRfis: boolean("mayAnswerRfis").default(true).notNull(),
  validTo: timestamp("validTo"),
  status: mysqlEnum("status", ["active", "revoked"]).default("active").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fieldTicketRevisions = mysqlTable("fieldTicketRevisions", {
  id: int("id").autoincrement().primaryKey(),
  documentRef: varchar("documentRef", { length: 80 }).notNull().unique(),
  fieldTicketId: int("fieldTicketId").notNull(),
  revision: int("revision").notNull(),
  kind: mysqlEnum("kind", ["site_signed", "post_site_supplement", "final", "amendment"]).notNull(),
  snapshotJson: text("snapshotJson").notNull(),
  snapshotHash: varchar("snapshotHash", { length: 64 }).notNull(),
  billableHoursSite: double("billableHoursSite"),
  billableHoursPostSite: double("billableHoursPostSite"),
  supersedesRevisionId: int("supersedesRevisionId"),
  generatedByUserId: int("generatedByUserId"),
  generatedAt: timestamp("generatedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const delayEvents = mysqlTable("delayEvents", {
  id: int("id").autoincrement().primaryKey(),
  delayRef: varchar("delayRef", { length: 64 }).notNull().unique(),
  jobId: int("jobId"),
  tripId: int("tripId"),
  unitId: int("unitId"),
  fieldTicketId: int("fieldTicketId"),
  kind: mysqlEnum("kind", ["customer_hold", "disposal_queue", "weather", "road_hazard", "collision", "driver_break", "breakdown", "other"]).notNull(),
  hazardType: varchar("hazardType", { length: 60 }),
  severity: mysqlEnum("severity", ["low", "medium", "high"]).default("medium").notNull(),
  observedAt: timestamp("observedAt").notNull(),
  endedAt: timestamp("endedAt"),
  observedByOperatorId: int("observedByOperatorId"),
  observation: varchar("observation", { length: 600 }).notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  externalSourceStatus: mysqlEnum("externalSourceStatus", ["available", "unavailable", "not_checked"]).default("not_checked").notNull(),
  externalSourceNote: varchar("externalSourceNote", { length: 300 }),
  billingClassification: mysqlEnum("billingClassification", ["billable", "non_billable", "review_required"]).default("review_required").notNull(),
  classificationRuleRef: varchar("classificationRuleRef", { length: 80 }),
  broadcast: boolean("broadcast").default(false).notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertSignatoryAuthorities = typeof signatoryAuthorities.$inferInsert;
export type InsertFieldTicketRevisions = typeof fieldTicketRevisions.$inferInsert;
export type InsertDelayEvents = typeof delayEvents.$inferInsert;

/* ==================================================================
 * v21.12 — Portal hardening, client adjustments, observations, documents
 * ================================================================== */

export const clientAdjustments = mysqlTable("clientAdjustments", {
  id: int("id").autoincrement().primaryKey(),
  adjustmentRef: varchar("adjustmentRef", { length: 64 }).notNull().unique(),
  fieldTicketId: int("fieldTicketId").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  kind: mysqlEnum("kind", ["tip", "crew_bonus", "exceptional_service_bonus", "flat", "percent", "completion_bonus", "callout_bonus", "hour_equivalent"]).notNull(),
  basisJson: text("basisJson").notNull(),
  amountCents: int("amountCents").notNull(),
  hourEquivalentMinutes: int("hourEquivalentMinutes"),
  recipientIntent: mysqlEnum("recipientIntent", ["company", "crew", "named_workers", "operator", "supervisor", "company_crew_split", "unknown"]).default("unknown").notNull(),
  recipientDetailJson: text("recipientDetailJson"),
  reason: varchar("reason", { length: 600 }).notNull(),
  authorizedByExternalIdentityId: int("authorizedByExternalIdentityId"),
  authorizedByName: varchar("authorizedByName", { length: 180 }).notNull(),
  authorizedAt: timestamp("authorizedAt").notNull(),
  revisionId: int("revisionId"),
  payrollTreatment: mysqlEnum("payrollTreatment", ["not_applicable", "awaiting_recipient", "proposed", "decided"]).default("not_applicable").notNull(),
  payrollAdjustmentRef: varchar("payrollAdjustmentRef", { length: 64 }),
  idempotencyHash: varchar("idempotencyHash", { length: 64 }).notNull().unique(),
  status: mysqlEnum("status", ["authorized", "withdrawn"]).default("authorized").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const weatherObservations = mysqlTable("weatherObservations", {
  id: int("id").autoincrement().primaryKey(),
  observationRef: varchar("observationRef", { length: 64 }).notNull().unique(),
  jobId: int("jobId"),
  unitId: int("unitId"),
  fieldTicketId: int("fieldTicketId"),
  observedAt: timestamp("observedAt").notNull(),
  observerType: mysqlEnum("observerType", ["worker", "supervisor", "external_source"]).notNull(),
  observerUserId: int("observerUserId"),
  externalSourceName: varchar("externalSourceName", { length: 120 }),
  conditionsJson: text("conditionsJson").notNull(),
  visibility: mysqlEnum("visibility", ["good", "reduced", "poor", "nil", "unknown"]).default("unknown").notNull(),
  roadState: mysqlEnum("roadState", ["dry", "wet", "snow", "ice", "mud", "flooded", "unknown"]).default("unknown").notNull(),
  severity: mysqlEnum("severity", ["minor", "moderate", "severe"]).notNull(),
  operationalEffect: varchar("operationalEffect", { length: 400 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  evidenceRecordId: int("evidenceRecordId"),
  billingTreatment: mysqlEnum("billingTreatment", ["billable", "non_billable", "review"]).default("review").notNull(),
  billingRuleRef: varchar("billingRuleRef", { length: 80 }),
  customerVisible: boolean("customerVisible").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const roadHazardObservations = mysqlTable("roadHazardObservations", {
  id: int("id").autoincrement().primaryKey(),
  observationRef: varchar("observationRef", { length: 64 }).notNull().unique(),
  jobId: int("jobId"),
  unitId: int("unitId"),
  fieldTicketId: int("fieldTicketId"),
  observedAt: timestamp("observedAt").notNull(),
  reportedByUserId: int("reportedByUserId"),
  hazard: mysqlEnum("hazard", ["snow_ice", "mud", "flooding", "washout", "poor_visibility", "high_wind", "construction", "road_closure", "restricted_access", "soft_road", "steep_grade", "chain_up", "traffic", "collision_ahead", "wildlife", "bridge_restriction", "lease_road_damage", "locked_gate", "customer_traffic_control", "other"]).notNull(),
  severity: mysqlEnum("severity", ["minor", "moderate", "severe"]).notNull(),
  direction: varchar("direction", { length: 40 }),
  routeRef: varchar("routeRef", { length: 120 }),
  description: varchar("description", { length: 600 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  evidenceRecordId: int("evidenceRecordId"),
  billingTreatment: mysqlEnum("billingTreatment", ["billable", "non_billable", "review"]).default("review").notNull(),
  customerVisible: boolean("customerVisible").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const fieldTicketDocuments = mysqlTable("fieldTicketDocuments", {
  id: int("id").autoincrement().primaryKey(),
  documentRef: varchar("documentRef", { length: 64 }).notNull().unique(),
  fieldTicketId: int("fieldTicketId").notNull(),
  revisionId: int("revisionId"),
  invoiceId: int("invoiceId"),
  kind: mysqlEnum("kind", ["site_ticket_r1", "post_site_ticket", "completion_package", "invoice"]).notNull(),
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  sourceSnapshotHash: varchar("sourceSnapshotHash", { length: 64 }).notNull(),
  byteLength: int("byteLength").notNull(),
  generatedByUserId: int("generatedByUserId"),
  generatedAt: timestamp("generatedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const externalAccessLog = mysqlTable("externalAccessLog", {
  id: int("id").autoincrement().primaryKey(),
  externalIdentityId: int("externalIdentityId").notNull(),
  action: mysqlEnum("action", ["view", "download", "sign", "decide", "authorize", "accept_invitation", "mfa_enroll", "mfa_confirm", "token_rotate"]).notNull(),
  recordType: varchar("recordType", { length: 60 }).notNull(),
  recordRef: varchar("recordRef", { length: 120 }).notNull(),
  recordVersion: varchar("recordVersion", { length: 64 }),
  context: varchar("context", { length: 300 }),
  at: timestamp("at").notNull(),
});

export type InsertClientAdjustments = typeof clientAdjustments.$inferInsert;
export type InsertWeatherObservations = typeof weatherObservations.$inferInsert;
export type InsertRoadHazardObservations = typeof roadHazardObservations.$inferInsert;
export type InsertFieldTicketDocuments = typeof fieldTicketDocuments.$inferInsert;
export type InsertExternalAccessLog = typeof externalAccessLog.$inferInsert;

/* ==================================================================
 * v21.14 — Customer alert preferences
 * ================================================================== */

export const CUSTOMER_ALERT_KINDS = ["arrival", "work_start", "delay", "breakdown", "incident_notice", "load_complete", "disposal_complete", "signoff_ready", "r1_available", "r2_available", "document_ready", "dispute_update", "billing_update", "job_complete"] as const;

export const externalAlertPreferences = mysqlTable("externalAlertPreferences", {
  id: int("id").autoincrement().primaryKey(),
  externalIdentityId: int("externalIdentityId").notNull(),
  eventKind: mysqlEnum("eventKind", [...CUSTOMER_ALERT_KINDS]).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type InsertExternalAlertPreference = typeof externalAlertPreferences.$inferInsert;

/* ==================================================================
 * v21.15 — Fleet Shop OS
 * ================================================================== */

export const parts = mysqlTable("parts", {
  id: int("id").autoincrement().primaryKey(),
  partRef: varchar("partRef", { length: 64 }).notNull().unique(),
  partNumber: varchar("partNumber", { length: 80 }).notNull().unique(),
  oemNumber: varchar("oemNumber", { length: 80 }),
  description: varchar("description", { length: 220 }).notNull(),
  category: mysqlEnum("category", ["tire", "filter", "fluid", "belt_hose", "brake", "electrical", "hydraulic", "driveline", "body", "consumable", "other"]).notNull(),
  uom: varchar("uom", { length: 20 }).default("each").notNull(),
  isCore: boolean("isCore").default(false).notNull(),
  coreChargeCents: int("coreChargeCents"),
  minQty: int("minQty"),
  maxQty: int("maxQty"),
  preferredVendorId: int("preferredVendorId"),
  status: mysqlEnum("status", ["active", "obsolete"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const partMovements = mysqlTable("partMovements", {
  id: int("id").autoincrement().primaryKey(),
  movementRef: varchar("movementRef", { length: 64 }).notNull().unique(),
  partId: int("partId").notNull(),
  bin: varchar("bin", { length: 40 }).default("MAIN").notNull(),
  kind: mysqlEnum("kind", ["receive", "issue", "return_to_stock", "adjust_count", "core_out", "core_returned", "warranty_return", "scrap", "transfer_in", "transfer_out"]).notNull(),
  qtySigned: int("qtySigned").notNull(),
  unitCostCents: int("unitCostCents"),
  workOrderId: int("workOrderId"),
  unitId: int("unitId"),
  vendorBillLineId: int("vendorBillLineId"),
  warrantyClaimId: int("warrantyClaimId"),
  reason: varchar("reason", { length: 300 }),
  byUserId: int("byUserId").notNull(),
  at: timestamp("at").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const tires = mysqlTable("tires", {
  id: int("id").autoincrement().primaryKey(),
  tireRef: varchar("tireRef", { length: 64 }).notNull().unique(),
  serial: varchar("serial", { length: 80 }).notNull().unique(),
  brand: varchar("brand", { length: 80 }),
  model: varchar("model", { length: 80 }),
  size: varchar("size", { length: 40 }).notNull(),
  positionType: mysqlEnum("positionType", ["steer", "drive", "trailer", "any"]).default("any").notNull(),
  casingOfTireId: int("casingOfTireId"),
  retreadCount: int("retreadCount").default(0).notNull(),
  purchaseCostCents: int("purchaseCostCents"),
  purchaseVendorBillLineId: int("purchaseVendorBillLineId"),
  status: mysqlEnum("status", ["in_stock", "installed", "removed", "retread_out", "scrapped", "warranty_claim"]).default("in_stock").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const tireInstallations = mysqlTable("tireInstallations", {
  id: int("id").autoincrement().primaryKey(),
  tireId: int("tireId").notNull(),
  unitId: int("unitId").notNull(),
  axlePosition: varchar("axlePosition", { length: 8 }).notNull(),
  installedAt: timestamp("installedAt").notNull(),
  installOdometerKm: int("installOdometerKm"),
  installTreadMm: double("installTreadMm"),
  removedAt: timestamp("removedAt"),
  removeOdometerKm: int("removeOdometerKm"),
  removeTreadMm: double("removeTreadMm"),
  removalReason: mysqlEnum("removalReason", ["worn", "damage", "rotation", "retread", "warranty", "other"]),
  workOrderId: int("workOrderId"),
  byUserId: int("byUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const tireMeasurements = mysqlTable("tireMeasurements", {
  id: int("id").autoincrement().primaryKey(),
  tireId: int("tireId").notNull(),
  installationId: int("installationId"),
  measuredAt: timestamp("measuredAt").notNull(),
  treadMm: double("treadMm"),
  pressureKpa: double("pressureKpa"),
  odometerKm: int("odometerKm"),
  byUserId: int("byUserId").notNull(),
  note: varchar("note", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const warrantyPolicies = mysqlTable("warrantyPolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyRef: varchar("policyRef", { length: 64 }).notNull().unique(),
  subjectType: mysqlEnum("subjectType", ["part", "tire", "unit_component"]).notNull(),
  subjectId: int("subjectId").notNull(),
  unitId: int("unitId"),
  vendorId: int("vendorId"),
  coverageUntil: timestamp("coverageUntil"),
  coverageKm: int("coverageKm"),
  coverageHours: int("coverageHours"),
  terms: varchar("terms", { length: 600 }),
  sourceDocumentEvidenceId: int("sourceDocumentEvidenceId"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const warrantyClaims = mysqlTable("warrantyClaims", {
  id: int("id").autoincrement().primaryKey(),
  claimRef: varchar("claimRef", { length: 64 }).notNull().unique(),
  policyId: int("policyId").notNull(),
  workOrderId: int("workOrderId"),
  partMovementId: int("partMovementId"),
  tireId: int("tireId"),
  claimedCents: int("claimedCents").notNull(),
  reason: varchar("reason", { length: 600 }).notNull(),
  eligibility: mysqlEnum("eligibility", ["eligible", "expired", "unknown"]).notNull(),
  eligibilityReason: varchar("eligibilityReason", { length: 300 }),
  raisedByUserId: int("raisedByUserId").notNull(),
  raisedAt: timestamp("raisedAt").notNull(),
  status: mysqlEnum("status", ["raised", "submitted", "approved", "denied", "credited"]).default("raised").notNull(),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  decisionReason: varchar("decisionReason", { length: 400 }),
  creditVendorBillLineId: int("creditVendorBillLineId"),
  creditedCents: int("creditedCents"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const serializedTools = mysqlTable("serializedTools", {
  id: int("id").autoincrement().primaryKey(),
  toolRef: varchar("toolRef", { length: 64 }).notNull().unique(),
  serial: varchar("serial", { length: 80 }).notNull().unique(),
  description: varchar("description", { length: 220 }).notNull(),
  measurementDeviceId: int("measurementDeviceId"),
  status: mysqlEnum("status", ["available", "checked_out", "out_for_calibration", "retired"]).default("available").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const toolCheckouts = mysqlTable("toolCheckouts", {
  id: int("id").autoincrement().primaryKey(),
  toolId: int("toolId").notNull(),
  workerUserId: int("workerUserId").notNull(),
  checkedOutAt: timestamp("checkedOutAt").notNull(),
  returnedAt: timestamp("returnedAt"),
  returnCondition: mysqlEnum("returnCondition", ["good", "damaged", "needs_calibration"]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const recallNotices = mysqlTable("recallNotices", {
  id: int("id").autoincrement().primaryKey(),
  recallRef: varchar("recallRef", { length: 64 }).notNull().unique(),
  source: varchar("source", { length: 120 }).notNull(),
  sourceRef: varchar("sourceRef", { length: 120 }).notNull(),
  issuedAt: timestamp("issuedAt"),
  summary: varchar("summary", { length: 600 }).notNull(),
  affectedCriteriaJson: text("affectedCriteriaJson"),
  status: mysqlEnum("status", ["open", "scheduled", "completed", "not_applicable"]).default("open").notNull(),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const recallUnitStatus = mysqlTable("recallUnitStatus", {
  id: int("id").autoincrement().primaryKey(),
  recallId: int("recallId").notNull(),
  unitId: int("unitId").notNull(),
  status: mysqlEnum("status", ["unknown", "affected", "not_affected", "completed"]).default("unknown").notNull(),
  workOrderId: int("workOrderId"),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertParts = typeof parts.$inferInsert;
export type InsertPartMovements = typeof partMovements.$inferInsert;
export type InsertTires = typeof tires.$inferInsert;
export type InsertTireInstallations = typeof tireInstallations.$inferInsert;
export type InsertTireMeasurements = typeof tireMeasurements.$inferInsert;
export type InsertWarrantyPolicies = typeof warrantyPolicies.$inferInsert;
export type InsertWarrantyClaims = typeof warrantyClaims.$inferInsert;
export type InsertSerializedTools = typeof serializedTools.$inferInsert;
export type InsertToolCheckouts = typeof toolCheckouts.$inferInsert;
export type InsertRecallNotices = typeof recallNotices.$inferInsert;
export type InsertRecallUnitStatus = typeof recallUnitStatus.$inferInsert;

/* ==================================================================
 * v21.16 — Capital assets, CCA, asset twin
 * ================================================================== */

export const capitalAssets = mysqlTable("capitalAssets", {
  id: int("id").autoincrement().primaryKey(),
  assetRef: varchar("assetRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  kind: mysqlEnum("kind", ["unit", "trailer", "equipment", "building", "leasehold", "other"]).notNull(),
  unitId: int("unitId").unique(),
  trailerId: int("trailerId").unique(),
  description: varchar("description", { length: 220 }).notNull(),
  acquiredAt: timestamp("acquiredAt").notNull(),
  acquisitionCostCents: int("acquisitionCostCents").notNull(),
  acquisitionVendorBillId: int("acquisitionVendorBillId"),
  acquisitionEvidenceRecordId: int("acquisitionEvidenceRecordId"),
  financing: mysqlEnum("financing", ["owned", "financed", "leased"]).default("owned").notNull(),
  lender: varchar("lender", { length: 160 }),
  financedPrincipalCents: int("financedPrincipalCents"),
  ccaClassCandidate: varchar("ccaClassCandidate", { length: 20 }),
  ccaClassSource: mysqlEnum("ccaClassSource", ["accountant", "owner_stated", "system_inferred"]),
  ccaClassVerificationStatus: mysqlEnum("ccaClassVerificationStatus", ["unverified", "verified"]).default("unverified").notNull(),
  ccaClassVerifiedByUserId: int("ccaClassVerifiedByUserId"),
  expectedLifeKm: int("expectedLifeKm"),
  expectedLifeYears: int("expectedLifeYears"),
  status: mysqlEnum("status", ["pending_capital_review", "in_service", "out_of_service", "disposed", "expensed"]).default("pending_capital_review").notNull(),
  capitalReviewedByUserId: int("capitalReviewedByUserId"),
  capitalReviewedAt: timestamp("capitalReviewedAt"),
  capitalReviewReason: varchar("capitalReviewReason", { length: 400 }),
  disposedAt: timestamp("disposedAt"),
  disposalProceedsCents: int("disposalProceedsCents"),
  disposalEvidenceRecordId: int("disposalEvidenceRecordId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const ccaSchedules = mysqlTable("ccaSchedules", {
  id: int("id").autoincrement().primaryKey(),
  scheduleRef: varchar("scheduleRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  fiscalYearEnd: timestamp("fiscalYearEnd").notNull(),
  summaryJson: text("summaryJson").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  determination: mysqlEnum("determination", ["computed", "partial", "unknown"]).notNull(),
  totalCcaClaimCents: int("totalCcaClaimCents"),
  status: mysqlEnum("status", ["prepared", "reviewed", "superseded"]).default("prepared").notNull(),
  preparedByUserId: int("preparedByUserId").notNull(),
  preparedAt: timestamp("preparedAt").notNull(),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  reviewNote: varchar("reviewNote", { length: 400 }),
  supersedesScheduleId: int("supersedesScheduleId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const ccaClassBalances = mysqlTable("ccaClassBalances", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId").notNull(),
  ccaClass: varchar("ccaClass", { length: 20 }).notNull(),
  fiscalYearEnd: timestamp("fiscalYearEnd").notNull(),
  closingUccCents: int("closingUccCents").notNull(),
  fromScheduleId: int("fromScheduleId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertCapitalAssets = typeof capitalAssets.$inferInsert;
export type InsertCcaSchedules = typeof ccaSchedules.$inferInsert;
export type InsertCcaClassBalances = typeof ccaClassBalances.$inferInsert;

/* ==================================================================
 * v21.17 — Commercial project management
 * ================================================================== */

export const quotes = mysqlTable("quotes", {
  id: int("id").autoincrement().primaryKey(),
  quoteRef: varchar("quoteRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  jobId: int("jobId"),
  version: int("version").default(1).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  scope: text("scope"),
  rateCardId: int("rateCardId"),
  subtotalCents: int("subtotalCents").default(0).notNull(),
  validUntil: timestamp("validUntil"),
  status: mysqlEnum("status", ["draft", "issued", "accepted", "declined", "expired", "superseded", "withdrawn"]).default("draft").notNull(),
  snapshotJson: text("snapshotJson"),
  snapshotHash: varchar("snapshotHash", { length: 64 }),
  issuedByUserId: int("issuedByUserId"),
  issuedAt: timestamp("issuedAt"),
  acceptedByName: varchar("acceptedByName", { length: 180 }),
  acceptedByExternalIdentityId: int("acceptedByExternalIdentityId"),
  acceptedAt: timestamp("acceptedAt"),
  acceptanceWithinAuthority: mysqlEnum("acceptanceWithinAuthority", ["yes", "no", "unknown"]),
  supersedesQuoteId: int("supersedesQuoteId"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const quoteLines = mysqlTable("quoteLines", {
  id: int("id").autoincrement().primaryKey(),
  quoteId: int("quoteId").notNull(),
  lineNo: int("lineNo").notNull(),
  serviceCode: varchar("serviceCode", { length: 60 }).notNull(),
  description: varchar("description", { length: 220 }).notNull(),
  quantity: double("quantity").notNull(),
  unit: varchar("unit", { length: 20 }).notNull(),
  rateCents: int("rateCents").notNull(),
  amountCents: int("amountCents").notNull(),
  priceSource: mysqlEnum("priceSource", ["rate_card", "explicit"]).notNull(),
  costCode: varchar("costCode", { length: 40 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const changeOrders = mysqlTable("changeOrders", {
  id: int("id").autoincrement().primaryKey(),
  changeOrderRef: varchar("changeOrderRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  jobId: int("jobId"),
  fieldTicketId: int("fieldTicketId"),
  quoteId: int("quoteId"),
  rfiId: int("rfiId"),
  description: varchar("description", { length: 600 }).notNull(),
  reason: varchar("reason", { length: 600 }).notNull(),
  estimatedCents: int("estimatedCents").notNull(),
  costCode: varchar("costCode", { length: 40 }),
  status: mysqlEnum("status", ["proposed", "authorized", "declined", "withdrawn"]).default("proposed").notNull(),
  snapshotHash: varchar("snapshotHash", { length: 64 }).notNull(),
  authorizedByName: varchar("authorizedByName", { length: 180 }),
  authorizedByExternalIdentityId: int("authorizedByExternalIdentityId"),
  authorizedAt: timestamp("authorizedAt"),
  withinAuthority: mysqlEnum("withinAuthority", ["yes", "no", "unknown"]),
  authorityDetail: varchar("authorityDetail", { length: 300 }),
  proposedByUserId: int("proposedByUserId").notNull(),
  proposedAt: timestamp("proposedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const rfis = mysqlTable("rfis", {
  id: int("id").autoincrement().primaryKey(),
  rfiRef: varchar("rfiRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  jobId: int("jobId"),
  question: varchar("question", { length: 1200 }).notNull(),
  askedByUserId: int("askedByUserId").notNull(),
  askedAt: timestamp("askedAt").notNull(),
  answer: varchar("answer", { length: 2000 }),
  answeredByName: varchar("answeredByName", { length: 180 }),
  answeredByExternalIdentityId: int("answeredByExternalIdentityId"),
  answeredAt: timestamp("answeredAt"),
  affectsScope: boolean("affectsScope"),
  status: mysqlEnum("status", ["open", "answered", "closed"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const projectBudgets = mysqlTable("projectBudgets", {
  id: int("id").autoincrement().primaryKey(),
  budgetRef: varchar("budgetRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  jobId: int("jobId").notNull(),
  quoteId: int("quoteId"),
  version: int("version").default(1).notNull(),
  totalCents: int("totalCents").default(0).notNull(),
  status: mysqlEnum("status", ["draft", "approved", "superseded"]).default("draft").notNull(),
  percentComplete: int("percentComplete"),
  percentCompleteStatedByUserId: int("percentCompleteStatedByUserId"),
  percentCompleteStatedAt: timestamp("percentCompleteStatedAt"),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  supersedesBudgetId: int("supersedesBudgetId"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const budgetLines = mysqlTable("budgetLines", {
  id: int("id").autoincrement().primaryKey(),
  budgetId: int("budgetId").notNull(),
  costCode: varchar("costCode", { length: 40 }).notNull(),
  description: varchar("description", { length: 220 }).notNull(),
  budgetedCents: int("budgetedCents").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertQuotes = typeof quotes.$inferInsert;
export type InsertQuoteLines = typeof quoteLines.$inferInsert;
export type InsertChangeOrders = typeof changeOrders.$inferInsert;
export type InsertRfis = typeof rfis.$inferInsert;
export type InsertProjectBudgets = typeof projectBudgets.$inferInsert;
export type InsertBudgetLines = typeof budgetLines.$inferInsert;

/* ==================================================================
 * v21.18 — Integration gateway
 * ================================================================== */

export const INBOUND_FEEDS = ["gps_position", "fuel_transaction", "eld_duty_status", "vehicle_telemetry", "fault_code", "safety_event", "video_clip", "loadsense_weight", "generic"] as const;

export const integrationClients = mysqlTable("integrationClients", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }),
  clientRef: varchar("clientRef", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  kind: mysqlEnum("kind", ["telematics", "eld", "fuel_card", "accounting", "customer_system", "facility_system", "other"]).notNull(),
  keyHash: varchar("keyHash", { length: 64 }).notNull().unique(),
  scopesJson: text("scopesJson").notNull(),
  status: mysqlEnum("status", ["active", "suspended", "revoked"]).default("active").notNull(),
  failedAttempts: int("failedAttempts").default(0).notNull(),
  lockedUntil: timestamp("lockedUntil"),
  lastSeenAt: timestamp("lastSeenAt"),
  createdByUserId: int("createdByUserId").notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedReason: varchar("revokedReason", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** Authoritative organization ownership for legacy core records that predate tenancy.
 * A record has at most one owner. Absence is not ownership; non-default tenants fail closed. */
export const coreRecordOwnership = mysqlTable("coreRecordOwnership", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }).notNull(),
  recordType: mysqlEnum("recordType", ["unit", "operator", "load", "financial_entity"]).notNull(),
  recordId: int("recordId").notNull(),
  assignedByUserId: int("assignedByUserId").notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
}, (t) => ({
  oneOwnerPerRecord: uniqueIndex("coreRecordOwnership_record_unique").on(t.recordType, t.recordId),
  orgRecordLookup: index("coreRecordOwnership_org_record_idx").on(t.orgRef, t.recordType, t.recordId),
}));

export const inboundEvents = mysqlTable("inboundEvents", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }),
  inboundRef: varchar("inboundRef", { length: 64 }).notNull().unique(),
  clientId: int("clientId").notNull(),
  feed: mysqlEnum("feed", [...INBOUND_FEEDS]).notNull(),
  idempotencyKey: varchar("idempotencyKey", { length: 120 }).notNull(),
  payloadJson: text("payloadJson").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  status: mysqlEnum("status", ["accepted", "rejected", "duplicate"]).notNull(),
  resultKind: varchar("resultKind", { length: 40 }),
  resultRef: varchar("resultRef", { length: 80 }),
  rejectionReason: varchar("rejectionReason", { length: 400 }),
  receivedAt: timestamp("receivedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const webhookSubscriptions = mysqlTable("webhookSubscriptions", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }),
  subscriptionRef: varchar("subscriptionRef", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),
  /**
   * Legacy inline ciphertext under `LEASEOS_PORTAL_MFA_KEY` — the shared key that also protects MFA
   * seeds. 0194 relaxed it to NULL so a canonical-only row becomes representable, but **Release 1
   * still writes it on every creation**: the NULL case is Release 2's, and exists here only so the
   * schema gains the capability one deployment before anything uses it.
   */
  secretEnc: varchar("secretEnc", { length: 400 }),
  /** 0194 — pointer into `encryptedSecrets` under purpose `WEBHOOK_SECRET`. Preferred when present. */
  secretRef: varchar("secretRef", { length: 64 }),
  eventTypesJson: text("eventTypesJson").notNull(),
  status: mysqlEnum("status", ["active", "paused", "revoked"]).default("active").notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const webhookDeliveries = mysqlTable("webhookDeliveries", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }),
  deliveryRef: varchar("deliveryRef", { length: 64 }).notNull().unique(),
  subscriptionId: int("subscriptionId").notNull(),
  eventId: varchar("eventId", { length: 40 }).notNull(),
  eventType: varchar("eventType", { length: 80 }).notNull(),
  attempt: int("attempt").notNull(),
  status: mysqlEnum("status", ["queued", "delivered", "failed", "dead"]).notNull(),
  requestHash: varchar("requestHash", { length: 64 }).notNull(),
  signature: varchar("signature", { length: 64 }).notNull(),
  responseStatus: int("responseStatus"),
  error: varchar("error", { length: 400 }),
  nextAttemptAt: timestamp("nextAttemptAt"),
  // 0185 (SEC-004): the claim on an in-flight ('queued') attempt. See webhookDispatchService.ts.
  claimedAt: timestamp("claimedAt"),
  claimedBy: varchar("claimedBy", { length: 64 }),
  at: timestamp("at").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertIntegrationClients = typeof integrationClients.$inferInsert;
export type InsertInboundEvents = typeof inboundEvents.$inferInsert;
export type InsertWebhookSubscriptions = typeof webhookSubscriptions.$inferInsert;
export type InsertWebhookDeliveries = typeof webhookDeliveries.$inferInsert;

/* ==================================================================
 * v21.19 — Telematics and video safety
 * ================================================================== */

export const telemetrySnapshots = mysqlTable("telemetrySnapshots", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull(),
  recordedAt: timestamp("recordedAt").notNull(),
  odometerKm: double("odometerKm"),
  engineHours: double("engineHours"),
  ptoHours: double("ptoHours"),
  idleMinutes: int("idleMinutes"),
  fuelLevelPct: double("fuelLevelPct"),
  sourceClientId: int("sourceClientId").notNull(),
  inboundEventId: int("inboundEventId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const faultCodes = mysqlTable("faultCodes", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull(),
  protocol: mysqlEnum("protocol", ["j1939", "obd2", "proprietary"]).notNull(),
  code: varchar("code", { length: 40 }).notNull(),
  subcode: varchar("subcode", { length: 20 }),
  description: varchar("description", { length: 300 }),
  occurrenceCount: int("occurrenceCount").default(1).notNull(),
  firstSeenAt: timestamp("firstSeenAt").notNull(),
  lastSeenAt: timestamp("lastSeenAt").notNull(),
  status: mysqlEnum("status", ["active", "cleared", "acknowledged"]).default("active").notNull(),
  severityDetermination: mysqlEnum("severityDetermination", ["unknown", "advisory", "inspection_required", "critical"]).default("unknown").notNull(),
  severitySource: varchar("severitySource", { length: 120 }),
  acknowledgedByUserId: int("acknowledgedByUserId"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  defectId: int("defectId"),
  sourceClientId: int("sourceClientId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const drivingEvents = mysqlTable("drivingEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 64 }).notNull().unique(),
  unitId: int("unitId").notNull(),
  operatorId: int("operatorId"),
  kind: mysqlEnum("kind", ["harsh_brake", "rapid_acceleration", "harsh_cornering", "speeding", "seatbelt", "distraction", "collision_suspected", "other"]).notNull(),
  recordedAt: timestamp("recordedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  magnitude: double("magnitude"),
  magnitudeUnit: varchar("magnitudeUnit", { length: 20 }),
  speedKph: double("speedKph"),
  postedLimitKph: double("postedLimitKph"),
  postedLimitSource: varchar("postedLimitSource", { length: 80 }),
  videoClipRef: varchar("videoClipRef", { length: 200 }),
  videoClipHash: varchar("videoClipHash", { length: 64 }),
  videoStorageKey: varchar("videoStorageKey", { length: 512 }),
  reviewStatus: mysqlEnum("reviewStatus", ["unreviewed", "coached", "dismissed", "escalated"]).default("unreviewed").notNull(),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  reviewNote: varchar("reviewNote", { length: 600 }),
  sourceClientId: int("sourceClientId").notNull(),
  inboundEventId: int("inboundEventId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const videoAccessLog = mysqlTable("videoAccessLog", {
  id: int("id").autoincrement().primaryKey(),
  drivingEventId: int("drivingEventId").notNull(),
  userId: int("userId").notNull(),
  purpose: varchar("purpose", { length: 200 }).notNull(),
  at: timestamp("at").notNull(),
});

export type InsertTelemetrySnapshots = typeof telemetrySnapshots.$inferInsert;
export type InsertFaultCodes = typeof faultCodes.$inferInsert;
export type InsertDrivingEvents = typeof drivingEvents.$inferInsert;
export type InsertVideoAccessLog = typeof videoAccessLog.$inferInsert;

/* ==================================================================
 * v21.20 — Workforce lifecycle
 * ================================================================== */

export const applicants = mysqlTable("applicants", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),   // 0147: NULL = the historical single tenant; the hiring organization otherwise
  applicantRef: varchar("applicantRef", { length: 64 }).notNull().unique(),
  fullName: varchar("fullName", { length: 180 }).notNull(),
  contactJson: text("contactJson"),
  roleApplied: varchar("roleApplied", { length: 120 }).notNull(),
  source: varchar("source", { length: 120 }),
  status: mysqlEnum("status", ["applied", "screening", "interview", "offer", "hired", "declined", "withdrawn"]).default("applied").notNull(),
  hiredUserId: int("hiredUserId"),
  decisionReason: varchar("decisionReason", { length: 400 }),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const applicantScreenings = mysqlTable("applicantScreenings", {
  id: int("id").autoincrement().primaryKey(),
  applicantId: int("applicantId").notNull(),
  kind: mysqlEnum("kind", ["licence_verification", "driver_abstract", "references", "drug_alcohol", "criminal_record", "right_to_work", "medical_fitness", "road_test"]).notNull(),
  required: boolean("required").default(true).notNull(),
  result: mysqlEnum("result", ["pending", "pass", "fail", "not_required"]).default("pending").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  note: varchar("note", { length: 400 }),
  recordedByUserId: int("recordedByUserId"),
  recordedAt: timestamp("recordedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const onboardingPlans = mysqlTable("onboardingPlans", {
  id: int("id").autoincrement().primaryKey(),
  planRef: varchar("planRef", { length: 64 }).notNull().unique(),
  userId: int("userId").notNull().unique(),
  applicantId: int("applicantId"),
  position: varchar("position", { length: 120 }).notNull(),
  startDate: timestamp("startDate").notNull(),
  probationEndsAt: timestamp("probationEndsAt"),
  status: mysqlEnum("status", ["in_progress", "complete", "ended"]).default("in_progress").notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const onboardingTasks = mysqlTable("onboardingTasks", {
  id: int("id").autoincrement().primaryKey(),
  planId: int("planId").notNull(),
  taskCode: varchar("taskCode", { length: 60 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  required: boolean("required").default(true).notNull(),
  dueBy: timestamp("dueBy"),
  credentialDocType: varchar("credentialDocType", { length: 100 }),
  credentialValidDays: int("credentialValidDays"),
  completedAt: timestamp("completedAt"),
  completedByUserId: int("completedByUserId"),
  evidenceRecordId: int("evidenceRecordId"),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  complianceDocumentId: int("complianceDocumentId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const trainingRecords = mysqlTable("trainingRecords", {
  id: int("id").autoincrement().primaryKey(),
  trainingRef: varchar("trainingRef", { length: 64 }).notNull().unique(),
  userId: int("userId").notNull(),
  courseCode: varchar("courseCode", { length: 60 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  provider: varchar("provider", { length: 160 }),
  completedAt: timestamp("completedAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  certificateNumber: varchar("certificateNumber", { length: 120 }),
  evidenceRecordId: int("evidenceRecordId"),
  credentialDocType: varchar("credentialDocType", { length: 100 }),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "rejected"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  complianceDocumentId: int("complianceDocumentId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const competencySignoffs = mysqlTable("competencySignoffs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  competencyCode: varchar("competencyCode", { length: 60 }).notNull(),
  level: mysqlEnum("level", ["trainee", "competent", "senior"]).notNull(),
  signedOffByUserId: int("signedOffByUserId").notNull(),
  signedOffAt: timestamp("signedOffAt").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  note: varchar("note", { length: 400 }),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const probationReviews = mysqlTable("probationReviews", {
  id: int("id").autoincrement().primaryKey(),
  planId: int("planId").notNull(),
  recommendation: mysqlEnum("recommendation", ["confirm", "extend", "end"]).notNull(),
  recommendedByUserId: int("recommendedByUserId").notNull(),
  recommendedAt: timestamp("recommendedAt").notNull(),
  recommendationNote: varchar("recommendationNote", { length: 600 }).notNull(),
  decision: mysqlEnum("decision", ["confirm", "extend", "end"]),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  decisionNote: varchar("decisionNote", { length: 600 }),
  extendedTo: timestamp("extendedTo"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const offboardings = mysqlTable("offboardings", {
  id: int("id").autoincrement().primaryKey(),
  offboardingRef: varchar("offboardingRef", { length: 64 }).notNull().unique(),
  userId: int("userId").notNull(),
  reason: mysqlEnum("reason", ["resigned", "ended_by_company", "contract_end", "retired", "deceased", "other"]).notNull(),
  lastDay: timestamp("lastDay").notNull(),
  status: mysqlEnum("status", ["open", "complete"]).default("open").notNull(),
  rolesRevokedAt: timestamp("rolesRevokedAt"),
  devicesRevokedAt: timestamp("devicesRevokedAt"),
  identitiesRevokedAt: timestamp("identitiesRevokedAt"),
  toolsReturnedAt: timestamp("toolsReturnedAt"),
  finalPayProposedAt: timestamp("finalPayProposedAt"),
  completedByUserId: int("completedByUserId"),
  completedAt: timestamp("completedAt"),
  initiatedByUserId: int("initiatedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertApplicants = typeof applicants.$inferInsert;
export type InsertApplicantScreenings = typeof applicantScreenings.$inferInsert;
export type InsertOnboardingPlans = typeof onboardingPlans.$inferInsert;
export type InsertOnboardingTasks = typeof onboardingTasks.$inferInsert;
export type InsertTrainingRecords = typeof trainingRecords.$inferInsert;
export type InsertCompetencySignoffs = typeof competencySignoffs.$inferInsert;
export type InsertProbationReviews = typeof probationReviews.$inferInsert;
export type InsertOffboardings = typeof offboardings.$inferInsert;

/* ==================================================================
 * v21.21 — Audit packages
 * ================================================================== */

export const auditPackages = mysqlTable("auditPackages", {
  id: int("id").autoincrement().primaryKey(),
  packageRef: varchar("packageRef", { length: 64 }).notNull().unique(),
  kind: mysqlEnum("kind", ["vehicle", "driver", "job", "customer", "incident", "tax", "cor", "insurance", "vendor"]).notNull(),
  subjectType: varchar("subjectType", { length: 40 }).notNull(),
  subjectRef: varchar("subjectRef", { length: 80 }).notNull(),
  periodFrom: timestamp("periodFrom"),
  periodTo: timestamp("periodTo"),
  recipient: varchar("recipient", { length: 200 }).notNull(),
  purpose: varchar("purpose", { length: 400 }).notNull(),
  redactionPolicy: varchar("redactionPolicy", { length: 60 }).notNull(),
  manifestJson: text("manifestJson").notNull(),
  manifestHash: varchar("manifestHash", { length: 64 }).notNull(),
  coverStorageKey: varchar("coverStorageKey", { length: 512 }),
  coverHash: varchar("coverHash", { length: 64 }),
  itemCount: int("itemCount").notNull(),
  redactionCount: int("redactionCount").notNull(),
  missingJson: text("missingJson").notNull(),
  status: mysqlEnum("status", ["prepared", "released", "superseded", "withdrawn"]).default("prepared").notNull(),
  preparedByUserId: int("preparedByUserId").notNull(),
  preparedAt: timestamp("preparedAt").notNull(),
  releasedByUserId: int("releasedByUserId"),
  releasedAt: timestamp("releasedAt"),
  releaseNote: varchar("releaseNote", { length: 600 }),
  gapsAcknowledged: boolean("gapsAcknowledged").default(false).notNull(),
  supersedesPackageId: int("supersedesPackageId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const auditPackageItems = mysqlTable("auditPackageItems", {
  id: int("id").autoincrement().primaryKey(),
  packageId: int("packageId").notNull(),
  seq: int("seq").notNull(),
  itemKind: varchar("itemKind", { length: 60 }).notNull(),
  sourceTable: varchar("sourceTable", { length: 80 }).notNull(),
  sourceId: int("sourceId").notNull(),
  sourceRef: varchar("sourceRef", { length: 120 }),
  title: varchar("title", { length: 220 }).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  redactionsJson: text("redactionsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const auditPackageAccess = mysqlTable("auditPackageAccess", {
  id: int("id").autoincrement().primaryKey(),
  packageId: int("packageId").notNull(),
  userId: int("userId").notNull(),
  action: mysqlEnum("action", ["view", "download", "send"]).notNull(),
  purpose: varchar("purpose", { length: 300 }).notNull(),
  at: timestamp("at").notNull(),
});

export type InsertAuditPackages = typeof auditPackages.$inferInsert;
export type InsertAuditPackageItems = typeof auditPackageItems.$inferInsert;
export type InsertAuditPackageAccess = typeof auditPackageAccess.$inferInsert;

/* ==================================================================
 * v22.0 — Spatial foundation (routing source not loaded)
 * ================================================================== */

export const vehicleProfiles = mysqlTable("vehicleProfiles", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull().unique(),
  heightM: double("heightM").notNull(),
  widthM: double("widthM").notNull(),
  lengthM: double("lengthM").notNull(),
  emptyWeightKg: int("emptyWeightKg").notNull(),
  axleGroupsJson: text("axleGroupsJson").notNull(),
  source: mysqlEnum("source", ["shop_measured", "spec_sheet", "operator_stated"]).notNull(),
  measuredAt: timestamp("measuredAt"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const roadRestrictions = mysqlTable("roadRestrictions", {
  id: int("id").autoincrement().primaryKey(),
  restrictionRef: varchar("restrictionRef", { length: 64 }).notNull().unique(),
  jurisdiction: varchar("jurisdiction", { length: 40 }).notNull(),
  roadRef: varchar("roadRef", { length: 120 }).notNull(),
  segmentId: varchar("segmentId", { length: 80 }).notNull(),
  segmentLabel: varchar("segmentLabel", { length: 220 }).notNull(),
  checkKey: mysqlEnum("checkKey", ["road_weight_restriction", "axle_group_limit", "bridge_capacity", "bridge_axle_limit", "overhead_clearance", "bridge_clearance", "width_restriction", "length_restriction", "truck_route_designation", "dg_corridor", "dg_time_restriction", "seasonal_closure", "road_ban_level", "road_owner_permission", "oversize_corridor_designation", "escort_requirement"]).notNull(),
  limitValue: double("limitValue"),
  textValue: varchar("textValue", { length: 200 }),
  unit: varchar("unit", { length: 20 }),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  source: varchar("source", { length: 220 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 500 }),
  sourceVersion: varchar("sourceVersion", { length: 80 }),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  sourceDocumentEvidenceId: int("sourceDocumentEvidenceId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const routeRequests = mysqlTable("routeRequests", {
  id: int("id").autoincrement().primaryKey(),
  requestRef: varchar("requestRef", { length: 64 }).notNull().unique(),
  tripId: int("tripId"),
  jobId: int("jobId"),
  unitId: int("unitId").notNull(),
  originRef: varchar("originRef", { length: 120 }).notNull(),
  destinationRef: varchar("destinationRef", { length: 120 }).notNull(),
  sourceStatus: mysqlEnum("sourceStatus", ["not_loaded", "configured_not_implemented", "loaded"]).notNull(),
  determination: mysqlEnum("determination", ["unknown", "review", "blocked", "ready"]).notNull(),
  reason: varchar("reason", { length: 400 }).notNull(),
  requestedByUserId: int("requestedByUserId").notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertVehicleProfiles = typeof vehicleProfiles.$inferInsert;
export type InsertRoadRestrictions = typeof roadRestrictions.$inferInsert;
export type InsertRouteRequests = typeof routeRequests.$inferInsert;

/* ==================================================================
 * v22.1 — Customer contract terms
 * ================================================================== */

export const customerContractTerms = mysqlTable("customerContractTerms", {
  id: int("id").autoincrement().primaryKey(),
  termsRef: varchar("termsRef", { length: 64 }).notNull().unique(),
  customerAccountId: int("customerAccountId").notNull(),
  version: int("version").default(1).notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  standbyBillable: mysqlEnum("standbyBillable", ["yes", "no"]).notNull(),
  standbyFreeMinutes: int("standbyFreeMinutes").default(0).notNull(),
  customerHoldBillable: mysqlEnum("customerHoldBillable", ["yes", "no"]).notNull(),
  weatherHoldBillable: mysqlEnum("weatherHoldBillable", ["yes", "no"]).notNull(),
  travelToDisposalBillable: mysqlEnum("travelToDisposalBillable", ["yes", "no"]).notNull(),
  disposalQueueBillable: mysqlEnum("disposalQueueBillable", ["yes", "no"]).notNull(),
  disposalBillable: mysqlEnum("disposalBillable", ["yes", "no"]).notNull(),
  returnTravelBillable: mysqlEnum("returnTravelBillable", ["yes", "no"]).notNull(),
  minimumHours: double("minimumHours"),
  // 0161: may accepted lines bill while others are disputed? NULL = nobody recorded what this
  // contract says, which is not permission — readiness answers REVIEW, never PASS.
  partialAcceptanceBillable: boolean("partialAcceptanceBillable"),
  clausesJson: text("clausesJson").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  sourceDocumentEvidenceId: int("sourceDocumentEvidenceId"),
  status: mysqlEnum("status", ["draft", "approved", "superseded"]).default("draft").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  supersedesTermsId: int("supersedesTermsId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertCustomerContractTerms = typeof customerContractTerms.$inferInsert;

// ---------------------------------------------------------------------------
// v22.7 — Commercial Setup & Rate Resolution
// ---------------------------------------------------------------------------
export const chargeDefinitions = mysqlTable("chargeDefinitions", {
  id: int("id").autoincrement().primaryKey(),
  definitionRef: varchar("definitionRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  rateKind: mysqlEnum("rateKind", ["sell", "vendor_payable", "payroll_reference", "internal_cost"]).notNull(),
  serviceCode: varchar("serviceCode", { length: 60 }).notNull(),
  resourceClass: varchar("resourceClass", { length: 80 }),
  unitId: int("unitId"),
  pricingMethod: mysqlEnum("pricingMethod", ["per_unit", "flat", "minimum_charge", "percentage_markup", "fixed_markup", "multiplier", "formula"]).notNull(),
  unit: mysqlEnum("unit", ["hour", "half_hour", "day", "shift", "load", "km", "mile", "m3", "litre", "kg", "tonne", "acre", "metre", "foot", "piece", "worker", "crew", "each", "none"]).notNull(),
  rateMillis: int("rateMillis"),
  flatCents: int("flatCents"),
  basisPoints: int("basisPoints"),
  multiplierMillis: int("multiplierMillis"),
  formula: varchar("formula", { length: 400 }),
  minimumQuantityMillis: int("minimumQuantityMillis"),
  minimumChargeCents: int("minimumChargeCents"),
  billingIncrementMillis: int("billingIncrementMillis"),
  roundingMode: mysqlEnum("roundingMode", ["nearest", "up", "down"]).default("nearest").notNull(),
  measurementBasis: mysqlEnum("measurementBasis", ["any", "meter", "tank_calibration", "certified_scale", "load_sensor", "facility_ticket", "customer_measurement", "operator_estimate", "manual_entry", "clock", "odometer", "gps"]).default("any").notNull(),
  conditionKey: varchar("conditionKey", { length: 60 }),
  scopeLevel: mysqlEnum("scopeLevel", ["job_override", "change_order", "po_afe", "project_site", "customer_contract", "customer_rate_card", "branch", "company"]).notNull(),
  customerAccountId: int("customerAccountId"),
  vendorId: int("vendorId"),
  projectRef: varchar("projectRef", { length: 80 }),
  siteRef: varchar("siteRef", { length: 120 }),
  contractRef: varchar("contractRef", { length: 80 }),
  jobId: int("jobId"),
  branchCode: varchar("branchCode", { length: 40 }),
  currency: varchar("currency", { length: 8 }).default("CAD").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  version: int("version").default(1).notNull(),
  supersedesDefinitionId: int("supersedesDefinitionId"),
  supersededByDefinitionId: int("supersededByDefinitionId"),
  sourceKind: mysqlEnum("sourceKind", ["human", "ai_extracted", "imported", "negotiated"]).notNull(),
  sourceDocumentEvidenceId: int("sourceDocumentEvidenceId"),
  sourceClause: varchar("sourceClause", { length: 160 }),
  approvalStatus: mysqlEnum("approvalStatus", ["proposed", "approved", "rejected", "superseded"]).default("proposed").notNull(),
  proposedByUserId: int("proposedByUserId").notNull(),
  proposedAt: timestamp("proposedAt").defaultNow().notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  rejectionReason: varchar("rejectionReason", { length: 400 }),
  notes: varchar("notes", { length: 600 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  // 0218 — a rate line is a charge definition on a rate sheet version; the kind and the conditions the resolver reads.
  rateSheetVersionId: int("rateSheetVersionId"),
  lineNo: int("lineNo"),
  lineKind: varchar("lineKind", { length: 40 }),
  label: varchar("label", { length: 220 }),
  applicabilityJson: text("applicabilityJson"),
});
export type ChargeDefinitionRow = typeof chargeDefinitions.$inferSelect;
export type InsertChargeDefinition = typeof chargeDefinitions.$inferInsert;

export const pricingDecisions = mysqlTable("pricingDecisions", {
  id: int("id").autoincrement().primaryKey(),
  decisionRef: varchar("decisionRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  rateKind: mysqlEnum("rateKind", ["sell", "vendor_payable"]).notNull(),
  subjectKind: mysqlEnum("subjectKind", ["field_ticket_line", "vendor_bill_line", "quote_line", "job_estimate", "simulation"]).notNull(),
  subjectRef: varchar("subjectRef", { length: 120 }).notNull(),
  serviceCode: varchar("serviceCode", { length: 60 }).notNull(),
  quantityMillis: int("quantityMillis").notNull(),
  unit: varchar("unit", { length: 20 }).notNull(),
  measurementSource: varchar("measurementSource", { length: 40 }).notNull(),
  measurementEvidenceId: int("measurementEvidenceId"),
  outcome: mysqlEnum("outcome", ["priced", "unknown_rate", "conflict", "conversion_review", "measurement_review"]).notNull(),
  chargeDefinitionId: int("chargeDefinitionId"),
  scopeLevel: varchar("scopeLevel", { length: 40 }),
  rateMillis: int("rateMillis"),
  billableQuantityMillis: int("billableQuantityMillis"),
  minimumApplied: boolean("minimumApplied").default(false).notNull(),
  incrementApplied: boolean("incrementApplied").default(false).notNull(),
  formula: varchar("formula", { length: 400 }).notNull(),
  inputsJson: text("inputsJson").notNull(),
  amountCents: int("amountCents"),
  reasonsJson: text("reasonsJson").notNull(),
  decidedByUserId: int("decidedByUserId").notNull(),
  decidedAt: timestamp("decidedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PricingDecisionRow = typeof pricingDecisions.$inferSelect;
export type InsertPricingDecision = typeof pricingDecisions.$inferInsert;

export const commercialSetupProfiles = mysqlTable("commercialSetupProfiles", {
  id: int("id").autoincrement().primaryKey(),
  financialEntityId: int("financialEntityId").notNull().unique(),
  servicesJson: text("servicesJson").notNull(),
  targetMarginBps: int("targetMarginBps"),
  warningMarginBps: int("warningMarginBps"),
  minimumAuthorityMarginBps: int("minimumAuthorityMarginBps"),
  discountAuthorityJson: text("discountAuthorityJson").notNull(),
  openBookCustomersJson: text("openBookCustomersJson").notNull(),
  setByUserId: int("setByUserId").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CommercialSetupProfileRow = typeof commercialSetupProfiles.$inferSelect;
export type InsertCommercialSetupProfile = typeof commercialSetupProfiles.$inferInsert;

// v22.9 — invoice lines, each naming the ticket line and the pricing decision it came from
export const invoiceLines = mysqlTable("invoiceLines", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  lineNo: int("lineNo").notNull(),
  fieldTicketLineId: int("fieldTicketLineId"),
  pricingDecisionRef: varchar("pricingDecisionRef", { length: 64 }),
  serviceCode: varchar("serviceCode", { length: 60 }),
  description: varchar("description", { length: 300 }).notNull(),
  quantityMillis: int("quantityMillis").notNull(),
  billableQuantityMillis: int("billableQuantityMillis").notNull(),
  unit: varchar("unit", { length: 20 }).notNull(),
  rateMillis: int("rateMillis"),
  amountCents: int("amountCents").notNull(),
  basis: varchar("basis", { length: 160 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type InvoiceLineRow = typeof invoiceLines.$inferSelect;
export type InsertInvoiceLine = typeof invoiceLines.$inferInsert;

// ---------------------------------------------------------------------------
// v22.13 — the mapping foundation: ATS legal subdivisions and Alberta access roads
// ---------------------------------------------------------------------------
export const atsLegalSubdivisions = mysqlTable("atsLegalSubdivisions", {
  id: int("id").autoincrement().primaryKey(),
  pid: varchar("pid", { length: 32 }).notNull().unique(),
  meridian: int("meridian").notNull(),
  rangeNumber: int("rangeNumber").notNull(),
  township: int("township").notNull(),
  sectionNumber: int("sectionNumber").notNull(),
  quarterSection: varchar("quarterSection", { length: 4 }),
  legalSubdivision: int("legalSubdivision"),
  roadAllowance: varchar("roadAllowance", { length: 8 }),
  descriptor: varchar("descriptor", { length: 120 }).notNull(),
  centroidLatitude: double("centroidLatitude").notNull(),
  centroidLongitude: double("centroidLongitude").notNull(),
  minLatitude: double("minLatitude").notNull(),
  minLongitude: double("minLongitude").notNull(),
  maxLatitude: double("maxLatitude").notNull(),
  maxLongitude: double("maxLongitude").notNull(),
  ringJson: text("ringJson").notNull(),
  areaSquareMetres: double("areaSquareMetres"),
  sourceKey: varchar("sourceKey", { length: 120 }).notNull(),
  sourceLayer: varchar("sourceLayer", { length: 180 }).notNull(),
  importRunRef: varchar("importRunRef", { length: 64 }).notNull(),
  retrievedAt: timestamp("retrievedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AtsLegalSubdivisionRow = typeof atsLegalSubdivisions.$inferSelect;
export type InsertAtsLegalSubdivision = typeof atsLegalSubdivisions.$inferInsert;

export const accessRoadSegments = mysqlTable("accessRoadSegments", {
  id: int("id").autoincrement().primaryKey(),
  objectId: int("objectId").notNull().unique(),
  name: varchar("name", { length: 220 }),
  highwayNumber: varchar("highwayNumber", { length: 40 }),
  roadClass: varchar("roadClass", { length: 60 }),
  featureType: int("featureType"),
  featureTypeLabel: varchar("featureTypeLabel", { length: 80 }),
  surfaceKind: mysqlEnum("surfaceKind", ["paved", "gravel", "dry_weather", "winter", "driveway", "ramp", "ferry", "ford", "other", "unknown"]).default("unknown").notNull(),
  lanes: int("lanes"),
  lengthMetres: double("lengthMetres"),
  minLatitude: double("minLatitude").notNull(),
  minLongitude: double("minLongitude").notNull(),
  maxLatitude: double("maxLatitude").notNull(),
  maxLongitude: double("maxLongitude").notNull(),
  pathJson: text("pathJson").notNull(),
  geometrySource: varchar("geometrySource", { length: 40 }),
  geometryDate: timestamp("geometryDate"),
  providerUpdatedAt: timestamp("providerUpdatedAt"),
  sourceKey: varchar("sourceKey", { length: 120 }).notNull(),
  sourceLayer: varchar("sourceLayer", { length: 180 }).notNull(),
  importRunRef: varchar("importRunRef", { length: 64 }).notNull(),
  retrievedAt: timestamp("retrievedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AccessRoadSegmentRow = typeof accessRoadSegments.$inferSelect;
export type InsertAccessRoadSegment = typeof accessRoadSegments.$inferInsert;

export const geoImportRuns = mysqlTable("geoImportRuns", {
  id: int("id").autoincrement().primaryKey(),
  runRef: varchar("runRef", { length: 64 }).notNull().unique(),
  sourceKey: varchar("sourceKey", { length: 120 }).notNull(),
  dataset: mysqlEnum("dataset", ["ats_lsd", "access_roads"]).notNull(),
  endpoint: varchar("endpoint", { length: 600 }).notNull(),
  queryJson: text("queryJson").notNull(),
  featuresFetched: int("featuresFetched").default(0).notNull(),
  rowsWritten: int("rowsWritten").default(0).notNull(),
  rowsSkipped: int("rowsSkipped").default(0).notNull(),
  truncated: boolean("truncated").default(false).notNull(),
  outcome: mysqlEnum("outcome", ["running", "complete", "failed"]).default("running").notNull(),
  failureReason: varchar("failureReason", { length: 600 }),
  startedByUserId: int("startedByUserId").notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  finishedAt: timestamp("finishedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type GeoImportRunRow = typeof geoImportRuns.$inferSelect;
export type InsertGeoImportRun = typeof geoImportRuns.$inferInsert;

// v22.14 — a lease has entrances, not a pin; each carries where it came from and what has actually reached it
export const siteAccessPoints = mysqlTable("siteAccessPoints", {
  id: int("id").autoincrement().primaryKey(),
  accessRef: varchar("accessRef", { length: 64 }).notNull().unique(),
  locationIdentityId: int("locationIdentityId"),
  lsdCanonical: varchar("lsdCanonical", { length: 64 }).notNull(),
  label: varchar("label", { length: 180 }).notNull(),
  accessKind: mysqlEnum("accessKind", ["lease_entrance", "emergency_access", "alternate_entrance", "staging", "unknown"]).default("lease_entrance").notNull(),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  approachRoadObjectId: int("approachRoadObjectId"),
  approachRoadLabel: varchar("approachRoadLabel", { length: 220 }),
  approachSurfaceKind: varchar("approachSurfaceKind", { length: 20 }),
  metresFromParcelCentroid: int("metresFromParcelCentroid"),
  touchesParcel: boolean("touchesParcel").default(false).notNull(),
  gatePresent: mysqlEnum("gatePresent", ["yes", "no", "unknown"]).default("unknown").notNull(),
  turnaroundCapability: mysqlEnum("turnaroundCapability", ["confirmed", "none", "unknown"]).default("unknown").notNull(),
  status: mysqlEnum("status", ["proposed", "confirmed", "rejected", "superseded"]).default("proposed").notNull(),
  preferred: boolean("preferred").default(false).notNull(),
  originKind: mysqlEnum("originKind", ["derived_from_grid", "driver_reported", "office_recorded"]).notNull(),
  originDetail: varchar("originDetail", { length: 400 }),
  proposedByUserId: int("proposedByUserId").notNull(),
  proposedAt: timestamp("proposedAt").defaultNow().notNull(),
  confirmedByUserId: int("confirmedByUserId"),
  confirmedAt: timestamp("confirmedAt"),
  rejectionReason: varchar("rejectionReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type SiteAccessPointRow = typeof siteAccessPoints.$inferSelect;
export type InsertSiteAccessPoint = typeof siteAccessPoints.$inferInsert;

export const siteAccessConfirmations = mysqlTable("siteAccessConfirmations", {
  id: int("id").autoincrement().primaryKey(),
  siteAccessPointId: int("siteAccessPointId").notNull(),
  tripId: int("tripId"),
  unitId: int("unitId"),
  operatorId: int("operatorId"),
  configurationFingerprint: varchar("configurationFingerprint", { length: 120 }),
  outcome: mysqlEnum("outcome", ["reached", "could_not_reach", "reached_with_difficulty"]).notNull(),
  detail: varchar("detail", { length: 400 }),
  observedAt: timestamp("observedAt").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type SiteAccessConfirmationRow = typeof siteAccessConfirmations.$inferSelect;
export type InsertSiteAccessConfirmation = typeof siteAccessConfirmations.$inferInsert;

// v22.15 — structures on a road, and an approved route that knows when it has gone stale
export const structures = mysqlTable("structures", {
  id: int("id").autoincrement().primaryKey(),
  structureRef: varchar("structureRef", { length: 64 }).notNull().unique(),
  kind: mysqlEnum("kind", ["bridge", "culvert", "overhead", "cattle_guard", "ford", "narrow_passage", "other"]).notNull(),
  label: varchar("label", { length: 220 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 60 }).notNull(),
  segmentId: varchar("segmentId", { length: 80 }),
  accessRoadObjectId: int("accessRoadObjectId"),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  clearanceM: double("clearanceM"),
  postedWeightKg: int("postedWeightKg"),
  postedAxleGroupKg: int("postedAxleGroupKg"),
  ratedWeightKg: int("ratedWeightKg"),
  loadRatingClass: varchar("loadRatingClass", { length: 40 }),
  widthM: double("widthM"),
  seasonalVariation: varchar("seasonalVariation", { length: 220 }),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  source: varchar("source", { length: 300 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 600 }),
  sourceVersion: varchar("sourceVersion", { length: 60 }),
  sourceDocumentEvidenceId: int("sourceDocumentEvidenceId"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  supersedesStructureId: int("supersedesStructureId"),
  recordedByUserId: int("recordedByUserId").notNull(),
  notes: varchar("notes", { length: 600 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type StructureRow = typeof structures.$inferSelect;
export type InsertStructure = typeof structures.$inferInsert;

export const routeApprovals = mysqlTable("routeApprovals", {
  id: int("id").autoincrement().primaryKey(),
  approvalRef: varchar("approvalRef", { length: 64 }).notNull().unique(),
  tripId: int("tripId"),
  jobId: int("jobId"),
  unitId: int("unitId").notNull(),
  originRef: varchar("originRef", { length: 120 }).notNull(),
  destinationRef: varchar("destinationRef", { length: 120 }).notNull(),
  // v22.20 — the graph build the route was computed on. NULL on historical
  // approvals means exactly "not recorded"; it is never backfilled with today's
  // build, because inventing provenance is worse than admitting its absence.
  buildRef: varchar("buildRef", { length: 64 }),
  dispatchStatus: varchar("dispatchStatus", { length: 40 }).notNull(),
  segmentIdsJson: text("segmentIdsJson").notNull(),
  fingerprintJson: text("fingerprintJson").notNull(),
  fingerprintHash: varchar("fingerprintHash", { length: 64 }).notNull(),
  explanation: varchar("explanation", { length: 2000 }).notNull(),
  status: mysqlEnum("status", ["approved", "stale", "revoked", "superseded"]).default("approved").notNull(),
  staleReasonsJson: text("staleReasonsJson"),
  stalenessDetectedAt: timestamp("stalenessDetectedAt"),
  // 0165 (§10.4): evidence about what was known, not a gate. Stored rather than re-derived so a
  // 13% approval still reads 13% after the data improves.
  coverageByAxisJson: text("coverageByAxisJson"),
  totalApplicableChecks: int("totalApplicableChecks"),
  totalVerifiedChecks: int("totalVerifiedChecks"),
  // The gate: specific unresolved high-consequence facts on roads this route uses.
  highConsequenceUnresolved: int("highConsequenceUnresolved"),
  secondApprovalRequired: boolean("secondApprovalRequired"),
  secondApprovalReasonsJson: text("secondApprovalReasonsJson"),
  secondApproverUserId: int("secondApproverUserId"),
  secondApprovedAt: timestamp("secondApprovedAt"),
  approvedByUserId: int("approvedByUserId").notNull(),
  approvedAt: timestamp("approvedAt").defaultNow().notNull(),
  revokedByUserId: int("revokedByUserId"),
  revokedAt: timestamp("revokedAt"),
  // 0167: the evaluation this approval was made from, so its evidence stays retrievable after a
  // later evaluation writes a newer set.
  evaluationRef: varchar("evaluationRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RouteApprovalRow = typeof routeApprovals.$inferSelect;
export type InsertRouteApproval = typeof routeApprovals.$inferInsert;

// v22.16 — the first routing graph, built from imported road data
export const roadGraphBuilds = mysqlTable("roadGraphBuilds", {
  id: int("id").autoincrement().primaryKey(),
  buildRef: varchar("buildRef", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 220 }).notNull(),
  minLatitude: double("minLatitude").notNull(),
  minLongitude: double("minLongitude").notNull(),
  maxLatitude: double("maxLatitude").notNull(),
  maxLongitude: double("maxLongitude").notNull(),
  snapToleranceMetres: int("snapToleranceMetres").notNull(),
  segmentsConsidered: int("segmentsConsidered").default(0).notNull(),
  nodeCount: int("nodeCount").default(0).notNull(),
  edgeCount: int("edgeCount").default(0).notNull(),
  componentCount: int("componentCount").default(0).notNull(),
  largestComponentEdges: int("largestComponentEdges").default(0).notNull(),
  isolatedEdges: int("isolatedEdges").default(0).notNull(),
  excludedSurfacesJson: text("excludedSurfacesJson").notNull(),
  sourceRunRefsJson: text("sourceRunRefsJson").notNull(),
  status: mysqlEnum("status", ["building", "current", "superseded", "failed"]).default("building").notNull(),
  failureReason: varchar("failureReason", { length: 400 }),
  builtByUserId: int("builtByUserId").notNull(),
  builtAt: timestamp("builtAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RoadGraphBuildRow = typeof roadGraphBuilds.$inferSelect;
export type InsertRoadGraphBuild = typeof roadGraphBuilds.$inferInsert;

export const roadGraphNodes = mysqlTable("roadGraphNodes", {
  id: int("id").autoincrement().primaryKey(),
  buildRef: varchar("buildRef", { length: 64 }).notNull(),
  nodeKey: varchar("nodeKey", { length: 48 }).notNull(),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  degree: int("degree").default(0).notNull(),
  componentId: int("componentId").default(0).notNull(),
});
export type RoadGraphNodeRow = typeof roadGraphNodes.$inferSelect;
export type InsertRoadGraphNode = typeof roadGraphNodes.$inferInsert;

export const roadGraphEdges = mysqlTable("roadGraphEdges", {
  id: int("id").autoincrement().primaryKey(),
  buildRef: varchar("buildRef", { length: 64 }).notNull(),
  segmentId: varchar("segmentId", { length: 80 }).notNull(),
  accessRoadObjectId: int("accessRoadObjectId").notNull(),
  label: varchar("label", { length: 220 }).notNull(),
  fromNodeKey: varchar("fromNodeKey", { length: 48 }).notNull(),
  toNodeKey: varchar("toNodeKey", { length: 48 }).notNull(),
  lengthMetres: double("lengthMetres").notNull(),
  surfaceKind: varchar("surfaceKind", { length: 20 }).notNull(),
  featureTypeLabel: varchar("featureTypeLabel", { length: 80 }),
  // 0164: which source produced this edge. Without it the path→evaluator conversion had nothing to
  // read and manufactured `ats_road_allowance` for every edge whatever made it.
  sourceKey: varchar("sourceKey", { length: 64 }),
  sourceLayer: varchar("sourceLayer", { length: 160 }),
  sourceFeatureId: varchar("sourceFeatureId", { length: 96 }),
  sourceVersion: varchar("sourceVersion", { length: 96 }),
  componentId: int("componentId").default(0).notNull(),
});
export type RoadGraphEdgeRow = typeof roadGraphEdges.$inferSelect;
export type InsertRoadGraphEdge = typeof roadGraphEdges.$inferInsert;

/* ---- v22.17: communications on the route ---- */

export const radioChannels = mysqlTable("radioChannels", {
  id: int("id").autoincrement().primaryKey(),
  channelKey: varchar("channelKey", { length: 40 }).notNull().unique(),
  alias: varchar("alias", { length: 120 }).notNull(),
  serviceClass: mysqlEnum("serviceClass", ["bc_resource_road", "bc_loading", "land_mobile_b1", "company_private", "operator_private", "cb_grs", "frs_gmrs", "public_safety", "amateur"]).notNull(),
  systemType: mysqlEnum("systemType", ["simplex", "repeater", "trunked", "cb"]).default("simplex").notNull(),
  rxMHz: double("rxMHz"),
  txMHz: double("txMHz"),
  toneRxHz: double("toneRxHz"),
  toneTxHz: double("toneTxHz"),
  bandwidthKHz: double("bandwidthKHz"),
  maxPowerW: double("maxPowerW"),
  licenceRequired: boolean("licenceRequired").default(true).notNull(),
  conditionsJson: text("conditionsJson").notNull(),
  sourceKey: varchar("sourceKey", { length: 60 }).notNull(),
  sourceCitation: varchar("sourceCitation", { length: 400 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 600 }),
  sourceVersion: varchar("sourceVersion", { length: 80 }),
  retrievedAt: timestamp("retrievedAt"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  recordedByUserId: int("recordedByUserId"),
  // v22.18 — Weatheradio was shut down with its frequencies still published.
  // A retired service authorizes nothing, whatever else is on file.
  serviceStatus: mysqlEnum("serviceStatus", ["active", "retired"]).default("active").notNull(),
  retiredNote: varchar("retiredNote", { length: 400 }),
  retiredAt: timestamp("retiredAt"),
  retiredByUserId: int("retiredByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RadioChannelRow = typeof radioChannels.$inferSelect;
export type InsertRadioChannel = typeof radioChannels.$inferInsert;

export const companyRadioAuthorizations = mysqlTable("companyRadioAuthorizations", {
  id: int("id").autoincrement().primaryKey(),
  authorizationRef: varchar("authorizationRef", { length: 64 }).notNull().unique(),
  channelKey: varchar("channelKey", { length: 40 }).notNull(),
  authorized: boolean("authorized").default(false).notNull(),
  licenceRef: varchar("licenceRef", { length: 120 }),
  licenceExpiresAt: timestamp("licenceExpiresAt"),
  provincesJson: text("provincesJson"),
  approvedUnitIdsJson: text("approvedUnitIdsJson"),
  evidenceRecordId: int("evidenceRecordId"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CompanyRadioAuthorizationRow = typeof companyRadioAuthorizations.$inferSelect;
export type InsertCompanyRadioAuthorization = typeof companyRadioAuthorizations.$inferInsert;

export const unitRadioCapabilities = mysqlTable("unitRadioCapabilities", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull().unique(),
  vhf: boolean("vhf").default(false).notNull(),
  uhf: boolean("uhf").default(false).notNull(),
  cb: boolean("cb").default(false).notNull(),
  satellite: boolean("satellite").default(false).notNull(),
  cellular: boolean("cellular").default(false).notNull(),
  programmingProfileRef: varchar("programmingProfileRef", { length: 80 }),
  programmingProfileVersion: varchar("programmingProfileVersion", { length: 40 }),
  programmedChannelKeysJson: text("programmedChannelKeysJson"),
  programmedAt: timestamp("programmedAt"),
  programmedBy: varchar("programmedBy", { length: 200 }),
  configurationHash: varchar("configurationHash", { length: 64 }),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type UnitRadioCapabilityRow = typeof unitRadioCapabilities.$inferSelect;
export type InsertUnitRadioCapability = typeof unitRadioCapabilities.$inferInsert;

export const roadRadioAssignments = mysqlTable("roadRadioAssignments", {
  id: int("id").autoincrement().primaryKey(),
  assignmentRef: varchar("assignmentRef", { length: 64 }).notNull().unique(),
  segmentId: varchar("segmentId", { length: 80 }).notNull(),
  channelKey: varchar("channelKey", { length: 40 }).notNull(),
  roadName: varchar("roadName", { length: 220 }),
  authorityTier: mysqlEnum("authorityTier", ["posted_sign", "operator_instruction", "regulatory_authority", "planning_map", "company_entry", "driver_observation", "community_reference", "unverified_submission"]).notNull(),
  callDirectionLoaded: mysqlEnum("callDirectionLoaded", ["increasing_km", "decreasing_km"]),
  callIntervalKm: double("callIntervalKm"),
  mustCallKmJson: text("mustCallKmJson"),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  permanent: boolean("permanent").default(true).notNull(),
  supersedesAssignmentRef: varchar("supersedesAssignmentRef", { length: 64 }),
  sourceKey: varchar("sourceKey", { length: 60 }).notNull(),
  sourceCitation: varchar("sourceCitation", { length: 400 }),
  observedAt: timestamp("observedAt"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RoadRadioAssignmentRow = typeof roadRadioAssignments.$inferSelect;
export type InsertRoadRadioAssignment = typeof roadRadioAssignments.$inferInsert;

export const radioSignObservations = mysqlTable("radioSignObservations", {
  id: int("id").autoincrement().primaryKey(),
  observationRef: varchar("observationRef", { length: 64 }).notNull().unique(),
  segmentId: varchar("segmentId", { length: 80 }),
  roadName: varchar("roadName", { length: 220 }),
  observedChannelText: varchar("observedChannelText", { length: 120 }).notNull(),
  resolvedChannelKey: varchar("resolvedChannelKey", { length: 40 }),
  latitude: double("latitude").notNull(),
  longitude: double("longitude").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  photoHash: varchar("photoHash", { length: 64 }),
  tripId: int("tripId"),
  note: varchar("note", { length: 400 }),
  status: mysqlEnum("status", ["pending", "confirmed", "rejected"]).default("pending").notNull(),
  decisionNote: varchar("decisionNote", { length: 400 }),
  observedByUserId: int("observedByUserId").notNull(),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  createdAssignmentRef: varchar("createdAssignmentRef", { length: 64 }),
  observedAt: timestamp("observedAt").defaultNow().notNull(),
});
export type RadioSignObservationRow = typeof radioSignObservations.$inferSelect;
export type InsertRadioSignObservation = typeof radioSignObservations.$inferInsert;

export const communicationCoverage = mysqlTable("communicationCoverage", {
  id: int("id").autoincrement().primaryKey(),
  coverageRef: varchar("coverageRef", { length: 64 }).notNull().unique(),
  segmentId: varchar("segmentId", { length: 80 }).notNull(),
  medium: mysqlEnum("medium", ["cellular", "satellite", "radio"]).notNull(),
  state: mysqlEnum("state", ["available", "intermittent", "unavailable"]).notNull(),
  carrier: varchar("carrier", { length: 120 }),
  authorityTier: mysqlEnum("authorityTier", ["posted_sign", "operator_instruction", "regulatory_authority", "planning_map", "company_entry", "driver_observation", "community_reference", "unverified_submission"]).notNull(),
  sourceKey: varchar("sourceKey", { length: 60 }).notNull(),
  sourceCitation: varchar("sourceCitation", { length: 400 }),
  observedAt: timestamp("observedAt"),
  tripId: int("tripId"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CommunicationCoverageRow = typeof communicationCoverage.$inferSelect;
export type InsertCommunicationCoverage = typeof communicationCoverage.$inferInsert;

export const communicationPlans = mysqlTable("communicationPlans", {
  id: int("id").autoincrement().primaryKey(),
  planRef: varchar("planRef", { length: 64 }).notNull().unique(),
  unitId: int("unitId"),
  tripId: int("tripId"),
  jobId: int("jobId"),
  buildRef: varchar("buildRef", { length: 64 }),
  segmentIdsJson: text("segmentIdsJson").notNull(),
  totalKm: double("totalKm").default(0).notNull(),
  verdict: mysqlEnum("verdict", ["covered", "gaps", "unknown"]).notNull(),
  unknownChannelKm: double("unknownChannelKm").default(0).notNull(),
  noCommunicationKm: double("noCommunicationKm").default(0).notNull(),
  zonesJson: text("zonesJson").notNull(),
  coverageJson: text("coverageJson").notNull(),
  ladderJson: text("ladderJson").notNull(),
  mustCallJson: text("mustCallJson").notNull(),
  fingerprintHash: varchar("fingerprintHash", { length: 64 }).notNull(),
  explanation: varchar("explanation", { length: 2000 }).notNull(),
  computedByUserId: int("computedByUserId").notNull(),
  computedAt: timestamp("computedAt").defaultNow().notNull(),
});
export type CommunicationPlanRow = typeof communicationPlans.$inferSelect;
export type InsertCommunicationPlan = typeof communicationPlans.$inferInsert;

/* ---- v22.18: the company's own communication policy ---- */

export const communicationPolicies = mysqlTable("communicationPolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyRef: varchar("policyRef", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 220 }).notNull(),
  scopeType: mysqlEnum("scopeType", ["company", "branch"]).default("company").notNull(),
  scopeRef: varchar("scopeRef", { length: 64 }),
  unknownPlanBlocks: boolean("unknownPlanBlocks").default(false).notNull(),
  requireTransmitAuthorization: boolean("requireTransmitAuthorization").default(false).notNull(),
  toleratedNoCommunicationKm: double("toleratedNoCommunicationKm").default(0).notNull(),
  loneWorkerRequiresSatellite: boolean("loneWorkerRequiresSatellite").default(false).notNull(),
  rationale: varchar("rationale", { length: 1000 }),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  status: mysqlEnum("status", ["proposed", "approved", "superseded", "rejected"]).default("proposed").notNull(),
  supersedesPolicyRef: varchar("supersedesPolicyRef", { length: 64 }),
  proposedByUserId: int("proposedByUserId").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  decisionNote: varchar("decisionNote", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CommunicationPolicyRow = typeof communicationPolicies.$inferSelect;
export type InsertCommunicationPolicy = typeof communicationPolicies.$inferInsert;

/* ---- v22.19: the offline communication package ---- */

export const communicationPackages = mysqlTable("communicationPackages", {
  id: int("id").autoincrement().primaryKey(),
  packageRef: varchar("packageRef", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 220 }).notNull(),
  version: int("version").default(1).notNull(),
  planRef: varchar("planRef", { length: 64 }),
  routeApprovalRef: varchar("routeApprovalRef", { length: 64 }),
  tripId: int("tripId"),
  jobId: int("jobId"),
  unitId: int("unitId"),
  buildRef: varchar("buildRef", { length: 64 }),
  segmentIdsJson: text("segmentIdsJson").notNull(),
  // The database column is LONGTEXT: a sealed package for a long route can
  // exceed the 64 KB a TEXT column holds, and a truncated package is a lie.
  contentJson: text("contentJson").notNull(),
  manifestHash: varchar("manifestHash", { length: 64 }).notNull(),
  dependencyJson: text("dependencyJson").notNull(),
  dependencyHash: varchar("dependencyHash", { length: 64 }).notNull(),
  verdict: mysqlEnum("verdict", ["covered", "gaps", "unknown"]).notNull(),
  totalKm: double("totalKm").default(0).notNull(),
  zoneCount: int("zoneCount").default(0).notNull(),
  channelCount: int("channelCount").default(0).notNull(),
  unverifiedChannelCount: int("unverifiedChannelCount").default(0).notNull(),
  retiredExcludedCount: int("retiredExcludedCount").default(0).notNull(),
  mustCallCount: int("mustCallCount").default(0).notNull(),
  zonesWithoutChannel: int("zonesWithoutChannel").default(0).notNull(),
  status: mysqlEnum("status", ["current", "superseded", "stale"]).default("current").notNull(),
  staleReasonsJson: text("staleReasonsJson"),
  stalenessDetectedAt: timestamp("stalenessDetectedAt"),
  supersedesPackageRef: varchar("supersedesPackageRef", { length: 64 }),
  builtByUserId: int("builtByUserId").notNull(),
  builtAt: timestamp("builtAt").defaultNow().notNull(),
});
export type CommunicationPackageRow = typeof communicationPackages.$inferSelect;
export type InsertCommunicationPackage = typeof communicationPackages.$inferInsert;

export const communicationPackageDownloads = mysqlTable("communicationPackageDownloads", {
  id: int("id").autoincrement().primaryKey(),
  downloadRef: varchar("downloadRef", { length: 64 }).notNull().unique(),
  packageRef: varchar("packageRef", { length: 64 }).notNull(),
  manifestHash: varchar("manifestHash", { length: 64 }).notNull(),
  deviceRef: varchar("deviceRef", { length: 80 }),
  userId: int("userId").notNull(),
  tripId: int("tripId"),
  downloadedAt: timestamp("downloadedAt").defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledgedAt"),
});
export type CommunicationPackageDownloadRow = typeof communicationPackageDownloads.$inferSelect;
export type InsertCommunicationPackageDownload = typeof communicationPackageDownloads.$inferInsert;

/* ---- v22.20: hours of service as versioned rules, not code ---- */

export const hosRuleProfiles = mysqlTable("hosRuleProfiles", {
  id: int("id").autoincrement().primaryKey(),
  profileKey: varchar("profileKey", { length: 60 }).notNull().unique(),
  label: varchar("label", { length: 220 }).notNull(),
  authorityLevel: mysqlEnum("authorityLevel", ["federal", "provincial", "territorial"]).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 8 }),
  latitudeRule: mysqlEnum("latitudeRule", ["north_of_60", "south_of_60"]),
  minimumWeightKg: int("minimumWeightKg"),
  operationClass: varchar("operationClass", { length: 40 }),
  sourceAuthority: varchar("sourceAuthority", { length: 220 }).notNull(),
  sourceCitation: varchar("sourceCitation", { length: 400 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 600 }),
  sourceSection: varchar("sourceSection", { length: 120 }),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  retrievedAt: timestamp("retrievedAt"),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  supersedesProfileKey: varchar("supersedesProfileKey", { length: 60 }),
  recordedByUserId: int("recordedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type HosRuleProfileRow = typeof hosRuleProfiles.$inferSelect;
export type InsertHosRuleProfile = typeof hosRuleProfiles.$inferInsert;

export const hosRuleLimits = mysqlTable("hosRuleLimits", {
  id: int("id").autoincrement().primaryKey(),
  profileKey: varchar("profileKey", { length: 60 }).notNull(),
  limitKey: varchar("limitKey", { length: 60 }).notNull(),
  value: double("value").notNull(),
  sourceSection: varchar("sourceSection", { length: 120 }),
  verificationStatus: mysqlEnum("verificationStatus", ["unverified", "verified", "superseded"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  /** The knowledge version that established this figure, where one exists (0119, ex-0090). */
  establishedByVersionRef: varchar("establishedByVersionRef", { length: 64 }),
  /** Where a reader can go and check it. Null means nobody recorded one. */
  citationUrl: varchar("citationUrl", { length: 1000 }),
  /** The promotion that produced the live figure (0120, ex-0091). */
  currentPromotionRef: varchar("currentPromotionRef", { length: 64 }),
  /** Who recorded the candidate (0124). A second person verifies it. */
  recordedByUserId: int("recordedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type HosRuleLimitRow = typeof hosRuleLimits.$inferSelect;
export type InsertHosRuleLimit = typeof hosRuleLimits.$inferInsert;

/* ---- v22.20 (0081): feed provenance, and the publisher's own statement ---- */

export const externalFeedRuns = mysqlTable("externalFeedRuns", {
  id: int("id").autoincrement().primaryKey(),
  runRef: varchar("runRef", { length: 64 }).notNull().unique(),
  sourceKey: varchar("sourceKey", { length: 60 }).notNull(),
  startedAt: timestamp("startedAt").notNull(),
  finishedAt: timestamp("finishedAt"),
  outcome: mysqlEnum("outcome", ["succeeded", "failed", "refused", "not_modified"]).notNull(),
  refusedBecause: mysqlEnum("refusedBecause", ["not_cleared", "no_credential", "not_due", "quota_exhausted", "withdrawn"]),
  httpStatus: int("httpStatus"),
  recordsSeen: int("recordsSeen").default(0).notNull(),
  recordsAccepted: int("recordsAccepted").default(0).notNull(),
  recordsRejected: int("recordsRejected").default(0).notNull(),
  rejectionsJson: text("rejectionsJson"),
  quotaUsedInWindow: int("quotaUsedInWindow"),
  quotaLimit: int("quotaLimit"),
  responseHash: varchar("responseHash", { length: 64 }),
  sourceVersion: varchar("sourceVersion", { length: 120 }),
  entityTag: varchar("entityTag", { length: 200 }),
  errorText: varchar("errorText", { length: 1000 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ExternalFeedRunRow = typeof externalFeedRuns.$inferSelect;
export type InsertExternalFeedRun = typeof externalFeedRuns.$inferInsert;

export const roadAdvisories = mysqlTable("roadAdvisories", {
  id: int("id").autoincrement().primaryKey(),
  advisoryRef: varchar("advisoryRef", { length: 64 }).notNull().unique(),
  sourceKey: varchar("sourceKey", { length: 60 }).notNull(),
  externalRef: varchar("externalRef", { length: 200 }).notNull(),
  runRef: varchar("runRef", { length: 64 }).notNull(),
  advisoryType: mysqlEnum("advisoryType", ["closure", "incident", "construction", "road_condition", "weather", "restriction", "other"]).notNull(),
  severity: mysqlEnum("severity", ["info", "minor", "major", "closure", "unknown"]).default("unknown").notNull(),
  headline: varchar("headline", { length: 400 }).notNull(),
  detail: varchar("detail", { length: 2000 }),
  roadName: varchar("roadName", { length: 220 }),
  direction: varchar("direction", { length: 60 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  radiusMetres: double("radiusMetres"),
  geometryJson: text("geometryJson"),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  sourceUpdatedAt: timestamp("sourceUpdatedAt"),
  retrievedAt: timestamp("retrievedAt").notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  /** Never false. No writer sets it, and a test holds it that way. */
  advisoryOnly: boolean("advisoryOnly").default(true).notNull(),
  status: mysqlEnum("status", ["active", "superseded", "withdrawn"]).default("active").notNull(),
  supersededByAdvisoryRef: varchar("supersededByAdvisoryRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RoadAdvisoryRow = typeof roadAdvisories.$inferSelect;
export type InsertRoadAdvisory = typeof roadAdvisories.$inferInsert;

/* ---- v22.20 (0082): enforcement as records ---- */

export const enforcementDocumentExtractions = mysqlTable("enforcementDocumentExtractions", {
  id: int("id").autoincrement().primaryKey(),
  extractionRef: varchar("extractionRef", { length: 64 }).notNull().unique(),
  documentKind: varchar("documentKind", { length: 60 }).notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  capturedByUserId: int("capturedByUserId").notNull(),
  capturedAt: timestamp("capturedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  fieldsJson: text("fieldsJson").notNull(),
  extractedCount: int("extractedCount").default(0).notNull(),
  highlightedJson: text("highlightedJson"),
  missingRequiredJson: text("missingRequiredJson"),
  /** Always true. No writer sets it false. */
  requiresConfirmation: boolean("requiresConfirmation").default(true).notNull(),
  status: mysqlEnum("status", ["proposed", "confirmed", "discarded"]).default("proposed").notNull(),
  confirmedEventRef: varchar("confirmedEventRef", { length: 64 }),
  discardedReason: varchar("discardedReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type EnforcementExtractionRow = typeof enforcementDocumentExtractions.$inferSelect;

export const enforcementEvents = mysqlTable("enforcementEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 64 }).notNull().unique(),
  eventType: varchar("eventType", { length: 60 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 40 }).notNull(),
  /** Snapshotted when the stop is confirmed. Reassigning the asset later must not move the policy. */
  tenantId: varchar("tenantId", { length: 40 }),
  branchId: varchar("branchId", { length: 40 }),
  terminalId: varchar("terminalId", { length: 40 }),
  agency: varchar("agency", { length: 200 }).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  locationText: varchar("locationText", { length: 300 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  inspectionReportNumber: varchar("inspectionReportNumber", { length: 120 }),
  inspectionLevel: varchar("inspectionLevel", { length: 20 }),
  inspectionResult: mysqlEnum("inspectionResult", ["pass", "requires_attention", "out_of_service", "unknown"]).default("unknown").notNull(),
  operatorId: int("operatorId"),
  unitId: int("unitId"),
  trailerId: int("trailerId"),
  jobId: int("jobId"),
  tripId: int("tripId"),
  extractionRef: varchar("extractionRef", { length: 64 }),
  evidenceRecordId: int("evidenceRecordId"),
  status: mysqlEnum("status", ["confirmed", "under_review", "resolved", "rescinded"]).default("confirmed").notNull(),
  confirmedByUserId: int("confirmedByUserId").notNull(),
  confirmedAt: timestamp("confirmedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type EnforcementEventRow = typeof enforcementEvents.$inferSelect;

export const enforcementViolations = mysqlTable("enforcementViolations", {
  id: int("id").autoincrement().primaryKey(),
  violationRef: varchar("violationRef", { length: 64 }).notNull().unique(),
  eventRef: varchar("eventRef", { length: 64 }).notNull(),
  system: varchar("system", { length: 60 }).notNull(),
  ownCode: varchar("ownCode", { length: 120 }).notNull(),
  sourceReference: varchar("sourceReference", { length: 400 }),
  description: varchar("description", { length: 1000 }),
  citationIssued: boolean("citationIssued").default(false).notNull(),
  outOfService: boolean("outOfService").default(false).notNull(),
  oosScope: mysqlEnum("oosScope", ["driver", "vehicle", "trailer", "cargo", "carrier"]),
  defectRequired: boolean("defectRequired").default(false).notNull(),
  repairRequired: boolean("repairRequired").default(false).notNull(),
  courtAction: boolean("courtAction").default(false).notNull(),
  defectId: int("defectId"),
  workOrderId: int("workOrderId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type EnforcementViolationRow = typeof enforcementViolations.$inferSelect;

export const enforcementCitations = mysqlTable("enforcementCitations", {
  id: int("id").autoincrement().primaryKey(),
  citationRef: varchar("citationRef", { length: 64 }).notNull().unique(),
  eventRef: varchar("eventRef", { length: 64 }).notNull(),
  violationRef: varchar("violationRef", { length: 64 }),
  citationNumber: varchar("citationNumber", { length: 120 }),
  offenceDescription: varchar("offenceDescription", { length: 600 }),
  fineAmountCents: int("fineAmountCents"),
  responseDueAt: timestamp("responseDueAt"),
  courtAt: timestamp("courtAt"),
  status: mysqlEnum("status", ["scanned", "open", "review_required", "payable", "disputed", "court_pending", "paid", "withdrawn", "dismissed", "convicted", "reduced", "appealed", "closed"]).default("scanned").notNull(),
  disposition: varchar("disposition", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type EnforcementCitationRow = typeof enforcementCitations.$inferSelect;

export const outOfServiceOrders = mysqlTable("outOfServiceOrders", {
  id: int("id").autoincrement().primaryKey(),
  orderRef: varchar("orderRef", { length: 64 }).notNull().unique(),
  eventRef: varchar("eventRef", { length: 64 }).notNull(),
  violationRef: varchar("violationRef", { length: 64 }),
  scope: mysqlEnum("scope", ["driver", "vehicle", "trailer", "cargo", "carrier"]).notNull(),
  subjectRef: varchar("subjectRef", { length: 120 }).notNull(),
  /** Snapshotted when the stop is confirmed. Reassigning the asset later must not move the policy. */
  tenantId: varchar("tenantId", { length: 40 }),
  branchId: varchar("branchId", { length: 40 }),
  terminalId: varchar("terminalId", { length: 40 }),
  issuedAt: timestamp("issuedAt").notNull(),
  issuingAgency: varchar("issuingAgency", { length: 200 }),
  releaseCondition: varchar("releaseCondition", { length: 600 }).notNull(),
  /**
   * The typed act the order demands. NULL means nobody has established which,
   * and is never inferred from the prose in `releaseCondition`.
   */
  requiredFindingType: mysqlEnum("requiredFindingType", ["repair_verification", "reinspection", "inspector_release", "document_confirmation", "waiting_period_complete", "other"]),
  status: mysqlEnum("status", ["active", "released", "rescinded"]).default("active").notNull(),
  releasedAt: timestamp("releasedAt"),
  releasedByUserId: int("releasedByUserId"),
  releaseEvidenceRef: varchar("releaseEvidenceRef", { length: 64 }),
  /** The policy that released it, bound at the moment of release — never reconstructed later. */
  releasePolicyRef: varchar("releasePolicyRef", { length: 64 }),
  releasePolicyVersion: int("releasePolicyVersion"),
  rescindedAt: timestamp("rescindedAt"),
  rescindedByUserId: int("rescindedByUserId"),
  rescissionReason: varchar("rescissionReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OutOfServiceOrderRow = typeof outOfServiceOrders.$inferSelect;

export const oosReleaseFindings = mysqlTable("oosReleaseFindings", {
  id: int("id").autoincrement().primaryKey(),
  findingRef: varchar("findingRef", { length: 64 }).notNull().unique(),
  orderRef: varchar("orderRef", { length: 64 }).notNull(),
  finding: mysqlEnum("finding", ["satisfied", "not_satisfied", "unknown"]).notNull(),
  findingType: mysqlEnum("findingType", ["repair_verification", "reinspection", "inspector_release", "document_confirmation", "waiting_period_complete", "other"]).notNull(),
  evidenceRef: varchar("evidenceRef", { length: 64 }),
  notes: varchar("notes", { length: 1000 }),
  recordedByUserId: int("recordedByUserId").notNull(),
  recordedByRole: varchar("recordedByRole", { length: 60 }).notNull(),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
});
export type OosReleaseFindingRow = typeof oosReleaseFindings.$inferSelect;

/* ---- v22.20 (0084): the release policy, with proposer and approver recorded ---- */

export const oosReleasePolicies = mysqlTable("oosReleasePolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyRef: varchar("policyRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  version: int("version").default(1).notNull(),
  label: varchar("label", { length: 220 }).notNull(),
  scopeType: mysqlEnum("scopeType", ["company", "branch", "terminal"]).default("company").notNull(),
  scopeRef: varchar("scopeRef", { length: 64 }),
  repairerMayRecordRepairVerification: boolean("repairerMayRecordRepairVerification").default(false).notNull(),
  releaserMustDifferFromRepairer: boolean("releaserMustDifferFromRepairer").default(true).notNull(),
  releaserMustDifferFromFindingAuthor: boolean("releaserMustDifferFromFindingAuthor").default(false).notNull(),
  allowedFindingRolesJson: text("allowedFindingRolesJson").notNull(),
  rationale: varchar("rationale", { length: 1000 }),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  status: mysqlEnum("status", ["proposed", "approved", "superseded", "rejected"]).default("proposed").notNull(),
  supersedesPolicyRef: varchar("supersedesPolicyRef", { length: 64 }),
  proposedByUserId: int("proposedByUserId").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  decisionNote: varchar("decisionNote", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OosReleasePolicyRow = typeof oosReleasePolicies.$inferSelect;

/* ---- v22.20 (0086): organizations and memberships ---- */

export const organizations = mysqlTable("organizations", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 220 }).notNull(),
  status: mysqlEnum("status", ["active", "suspended", "closed"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OrganizationRow = typeof organizations.$inferSelect;

export const organizationMemberships = mysqlTable("organizationMemberships", {
  id: int("id").autoincrement().primaryKey(),
  membershipRef: varchar("membershipRef", { length: 64 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 40 }).notNull(),
  userId: int("userId").notNull(),
  membershipType: mysqlEnum("membershipType", ["employee", "contractor", "client", "system"]).default("employee").notNull(),
  status: mysqlEnum("status", ["active", "suspended", "ended"]).default("active").notNull(),
  defaultWorkspace: varchar("defaultWorkspace", { length: 60 }),
  branchId: varchar("branchId", { length: 40 }),
  contractorOrgRef: varchar("contractorOrgRef", { length: 40 }),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type OrganizationMembershipRow = typeof organizationMemberships.$inferSelect;

/* ---- B23.2 (0175): how a person becomes a member of an organization ---- */

/**
 * An invitation is claimed by the TOKEN plus an authenticated openId, never by
 * matching an email address: the OAuth provider returns `email` with no
 * verification flag, so LeaseOS cannot tell a proved address from a typed one.
 * `emailHint` exists so an administrator can see who they meant and send the
 * link somewhere. It decides nothing.
 *
 * Only the SHA-256 of the token is stored. The raw value is returned once, to
 * the administrator who created it.
 */
export const organizationInvitations = mysqlTable("organizationInvitations", {
  id: int("id").autoincrement().primaryKey(),
  invitationRef: varchar("invitationRef", { length: 64 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 40 }).notNull(),
  emailHint: varchar("emailHint", { length: 320 }),
  displayNameHint: varchar("displayNameHint", { length: 180 }),
  tokenDigest: varchar("tokenDigest", { length: 64 }).notNull().unique(),
  /** `expired` is derived from `expiresAt`, never stored — see 0175. */
  status: mysqlEnum("status", ["pending", "accepted", "cancelled"]).default("pending").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  invitedByUserId: int("invitedByUserId").notNull(),
  invitedAt: timestamp("invitedAt").notNull(),
  acceptedAt: timestamp("acceptedAt"),
  acceptedByUserId: int("acceptedByUserId"),
  cancelledAt: timestamp("cancelledAt"),
  cancelledByUserId: int("cancelledByUserId"),
  cancelReason: varchar("cancelReason", { length: 300 }),
  defaultWorkspace: varchar("defaultWorkspace", { length: 60 }),
  /**
   * Persistent generated column: NULL unless the row is pending, so accepted
   * and cancelled rows drop out of the unique index and remain as history.
   * MariaDB has no partial index; this is the same trick as `activeGrantKey`.
   * Never written by the application.
   */
  pendingKey: varchar("pendingKey", { length: 380 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type OrganizationInvitationRow = typeof organizationInvitations.$inferSelect;

/** The roles an invitation confers on acceptance. A child table, not a blob. */
export const organizationInvitationRoles = mysqlTable("organizationInvitationRoles", {
  id: int("id").autoincrement().primaryKey(),
  invitationId: int("invitationId").notNull(),
  role: varchar("role", { length: 40 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/* ---- v22.20 (0087): what a device reports it is holding ---- */

export const deviceSafetyLatches = mysqlTable("deviceSafetyLatches", {
  id: int("id").autoincrement().primaryKey(),
  latchRef: varchar("latchRef", { length: 64 }).notNull().unique(),
  deviceRef: varchar("deviceRef", { length: 64 }),
  reportedByUserId: int("reportedByUserId").notNull(),
  captureLocalId: varchar("captureLocalId", { length: 120 }).notNull(),
  subjectType: mysqlEnum("subjectType", ["driver", "vehicle", "trailer", "cargo", "carrier"]).notNull(),
  subjectRef: varchar("subjectRef", { length: 120 }).notNull(),
  capturedAt: timestamp("capturedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  note: varchar("note", { length: 400 }),
  serverEventRef: varchar("serverEventRef", { length: 64 }),
  serverOrderRef: varchar("serverOrderRef", { length: 64 }),
  state: mysqlEnum("state", ["blocking", "lifted"]).default("blocking").notNull(),
  /** Never set from a device report. Only an authoritative order state sets it. */
  liftAuthority: mysqlEnum("liftAuthority", ["released", "rescinded"]),
  liftedAt: timestamp("liftedAt"),
  reportedAt: timestamp("reportedAt").defaultNow().notNull(),
});
export type DeviceSafetyLatchRow = typeof deviceSafetyLatches.$inferSelect;

/* ---- v22.20 (0088): the grant behind a roadside panel ---- */

export const roadsidePanelGrants = mysqlTable("roadsidePanelGrants", {
  id: int("id").autoincrement().primaryKey(),
  grantRef: varchar("grantRef", { length: 64 }).notNull().unique(),
  unitRef: varchar("unitRef", { length: 120 }).notNull(),
  unitId: int("unitId"),
  issuedByUserId: int("issuedByUserId").notNull(),
  issuedFor: varchar("issuedFor", { length: 220 }).notNull(),
  issuedAt: timestamp("issuedAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedByUserId: int("revokedByUserId"),
  revocationReason: varchar("revocationReason", { length: 400 }),
  viewCount: int("viewCount").default(0).notNull(),
  lastViewedAt: timestamp("lastViewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RoadsidePanelGrantRow = typeof roadsidePanelGrants.$inferSelect;

/* ---- v22.20 (0090): time off ---- */

export const leaveRequests = mysqlTable("leaveRequests", {
  id: int("id").autoincrement().primaryKey(),
  requestRef: varchar("requestRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  userId: int("userId").notNull(),
  category: mysqlEnum("category", ["vacation", "sick", "medical_appointment", "personal", "family_responsibility", "bereavement", "unpaid", "statutory_holiday", "training", "certification_renewal", "court_obligation", "company_authorized", "other"]).notNull(),
  urgency: mysqlEnum("urgency", ["planned", "same_day"]).default("planned").notNull(),
  fromDate: timestamp("fromDate").notNull(),
  toDate: timestamp("toDate").notNull(),
  partialFromTime: varchar("partialFromTime", { length: 5 }),
  partialToTime: varchar("partialToTime", { length: 5 }),
  /** Its own column so the scheduling read can simply not select it. */
  privateNote: varchar("privateNote", { length: 2000 }),
  requestedAt: timestamp("requestedAt").notNull(),
  status: mysqlEnum("status", ["requested", "approved", "declined", "cancelled", "recorded"]).default("requested").notNull(),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  decisionNote: varchar("decisionNote", { length: 600 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type LeaveRequestRow = typeof leaveRequests.$inferSelect;

/* ---- v22.20 (0091): open shifts ---- */

export const shiftPosts = mysqlTable("shiftPosts", {
  id: int("id").autoincrement().primaryKey(),
  postRef: varchar("postRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  title: varchar("title", { length: 220 }).notNull(),
  kind: mysqlEnum("kind", ["open", "assigned"]).default("open").notNull(),
  startsAt: timestamp("startsAt").notNull(),
  endsAt: timestamp("endsAt").notNull(),
  location: varchar("location", { length: 220 }),
  requiredRole: varchar("requiredRole", { length: 60 }).notNull(),
  requiredQualificationsJson: text("requiredQualificationsJson").notNull(),
  seats: int("seats").default(1).notNull(),
  status: mysqlEnum("status", ["open", "filled", "cancelled", "expired"]).default("open").notNull(),
  postedByUserId: int("postedByUserId").notNull(),
  postedAt: timestamp("postedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ShiftPostRow = typeof shiftPosts.$inferSelect;

export const shiftInterests = mysqlTable("shiftInterests", {
  id: int("id").autoincrement().primaryKey(),
  postRef: varchar("postRef", { length: 64 }).notNull(),
  userId: int("userId").notNull(),
  expressedAt: timestamp("expressedAt").notNull(),
  withdrawnAt: timestamp("withdrawnAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type ShiftInterestRow = typeof shiftInterests.$inferSelect;

/* ---- v22.20 (0092): qualifications ---- */

export const qualificationTypes = mysqlTable("qualificationTypes", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 60 }).notNull().unique(),
  label: varchar("label", { length: 220 }).notNull(),
  issuingBody: varchar("issuingBody", { length: 220 }),
  requiresDocument: boolean("requiresDocument").default(true).notNull(),
  renewalMonths: int("renewalMonths"),
  /** What an expiry actually stops, so it blocks the dependency and not the person. */
  blocksCapabilitiesJson: text("blocksCapabilitiesJson").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type QualificationTypeRow = typeof qualificationTypes.$inferSelect;

export const workerQualifications = mysqlTable("workerQualifications", {
  id: int("id").autoincrement().primaryKey(),
  holdingRef: varchar("holdingRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  userId: int("userId").notNull(),
  code: varchar("code", { length: 60 }).notNull(),
  certificateNumber: varchar("certificateNumber", { length: 120 }),
  issuedAt: timestamp("issuedAt"),
  expiresAt: timestamp("expiresAt"),
  verificationState: mysqlEnum("verificationState", ["unverified", "extracted", "verified", "rejected", "superseded"]).default("unverified").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  documentRef: varchar("documentRef", { length: 64 }),
  supersededByHoldingRef: varchar("supersededByHoldingRef", { length: 64 }),
  recordedByUserId: int("recordedByUserId").notNull(),
  recordedAt: timestamp("recordedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type WorkerQualificationRow = typeof workerQualifications.$inferSelect;


/* ---- v22.20 (0093): crews ---- */

export const crews = mysqlTable("crews", {
  id: int("id").autoincrement().primaryKey(),
  crewRef: varchar("crewRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  name: varchar("name", { length: 220 }).notNull(),
  type: mysqlEnum("type", ["permanent", "job", "shift", "site", "unit", "project", "emergency"]).default("permanent").notNull(),
  supervisorUserId: int("supervisorUserId"),
  jobRef: varchar("jobRef", { length: 64 }),
  branchId: varchar("branchId", { length: 40 }),
  state: mysqlEnum("state", ["active", "read_only", "archived"]).default("active").notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CrewRow = typeof crews.$inferSelect;

export const crewMembers = mysqlTable("crewMembers", {
  id: int("id").autoincrement().primaryKey(),
  crewRef: varchar("crewRef", { length: 64 }).notNull(),
  userId: int("userId").notNull(),
  crewRole: mysqlEnum("crewRole", ["supervisor", "driver", "operator", "labourer", "mechanic", "safety", "dispatch", "other"]).default("driver").notNull(),
  source: mysqlEnum("source", ["manual", "dispatch", "job_assignment", "shift_assignment"]).default("manual").notNull(),
  /** Null means no pattern, which is not the same as never working. */
  rotationOnDays: int("rotationOnDays"),
  rotationOffDays: int("rotationOffDays"),
  rotationAnchor: timestamp("rotationAnchor"),
  joinedAt: timestamp("joinedAt").notNull(),
  leftAt: timestamp("leftAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type CrewMemberRow = typeof crewMembers.$inferSelect;

/* ---- v22.20 (0096): message board ---- */

export const messageChannels = mysqlTable("messageChannels", {
  id: int("id").autoincrement().primaryKey(),
  channelRef: varchar("channelRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  type: mysqlEnum("type", ["announcement", "dispatch", "safety", "maintenance", "field_operations", "road_conditions", "training", "general", "job", "client", "private", "emergency"]).notNull(),
  name: varchar("name", { length: 220 }).notNull(),
  jobRef: varchar("jobRef", { length: 64 }),
  /** What makes a channel external. Access is decided here, not per message. */
  clientRef: varchar("clientRef", { length: 64 }),
  crewRef: varchar("crewRef", { length: 64 }),
  archived: boolean("archived").default(false).notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MessageChannelRow = typeof messageChannels.$inferSelect;

export const boardMessages = mysqlTable("boardMessages", {
  id: int("id").autoincrement().primaryKey(),
  messageRef: varchar("messageRef", { length: 64 }).notNull().unique(),
  channelRef: varchar("channelRef", { length: 64 }).notNull(),
  authorUserId: int("authorUserId").notNull(),
  authorRole: varchar("authorRole", { length: 40 }).notNull(),
  priority: mysqlEnum("priority", ["normal", "important", "urgent", "emergency"]).default("normal").notNull(),
  body: varchar("body", { length: 4000 }).notNull(),
  latitude: decimal("latitude", { precision: 9, scale: 6 }),
  longitude: decimal("longitude", { precision: 9, scale: 6 }),
  /** When the device recorded it. Never overwritten by the server's clock. */
  deviceCreatedAt: timestamp("deviceCreatedAt").notNull(),
  serverReceivedAt: timestamp("serverReceivedAt"),
  deviceId: varchar("deviceId", { length: 64 }),
  requiresAcknowledgement: boolean("requiresAcknowledgement").default(false).notNull(),
  withdrawnAt: timestamp("withdrawnAt"),
  withdrawnByUserId: int("withdrawnByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type BoardMessageRow = typeof boardMessages.$inferSelect;

export const messageReceipts = mysqlTable("messageReceipts", {
  id: int("id").autoincrement().primaryKey(),
  messageRef: varchar("messageRef", { length: 64 }).notNull(),
  userId: int("userId").notNull(),
  state: mysqlEnum("state", ["queued_offline", "uploaded", "accepted", "delivered", "opened", "acknowledged", "actioned", "resolved"]).default("accepted").notNull(),
  deliveredAt: timestamp("deliveredAt"),
  openedAt: timestamp("openedAt"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  /** The server witnesses acceptance, so it may record it. */
  acceptedAt: timestamp("acceptedAt"),
  actionedAt: timestamp("actionedAt"),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MessageReceiptRow = typeof messageReceipts.$inferSelect;

/** Revisions 2+. Revision 1 is the original body on `boardMessages`. */
export const messageRevisions = mysqlTable("messageRevisions", {
  id: int("id").autoincrement().primaryKey(),
  messageRef: varchar("messageRef", { length: 64 }).notNull(),
  revision: int("revision").notNull(),
  body: varchar("body", { length: 4000 }).notNull(),
  editedByUserId: int("editedByUserId").notNull(),
  editedAt: timestamp("editedAt").notNull(),
  reason: varchar("reason", { length: 600 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MessageRevisionRow = typeof messageRevisions.$inferSelect;

/* ---- v22.20 (0099): message attachments ---- */

export const messageAttachments = mysqlTable("messageAttachments", {
  id: int("id").autoincrement().primaryKey(),
  attachmentRef: varchar("attachmentRef", { length: 64 }).notNull().unique(),
  messageRef: varchar("messageRef", { length: 64 }).notNull(),
  /** A pointer. Never the referenced record's contents. */
  kind: varchar("kind", { length: 40 }).notNull(),
  objectRef: varchar("objectRef", { length: 120 }).notNull(),
  attachedByUserId: int("attachedByUserId").notNull(),
  attachedAt: timestamp("attachedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type MessageAttachmentRow = typeof messageAttachments.$inferSelect;

/* ---- v22.20 (0100): agent runs ---- */

export const agentRuns = mysqlTable("agentRuns", {
  id: int("id").autoincrement().primaryKey(),
  runRef: varchar("runRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  agentKey: varchar("agentKey", { length: 60 }).notNull(),
  goal: varchar("goal", { length: 600 }).notNull(),
  /** LeaseOS owns this. The model does not invent a status. */
  status: mysqlEnum("status", ["created", "planning", "ready", "executing", "waiting_for_input", "waiting_for_event", "waiting_for_approval", "retry_scheduled", "blocked", "paused", "completed", "failed", "cancelled"]).default("created").notNull(),
  initiatedByUserId: int("initiatedByUserId").notNull(),
  awaitingEvent: varchar("awaitingEvent", { length: 120 }),
  awaitingFilterJson: text("awaitingFilterJson"),
  blockedReason: varchar("blockedReason", { length: 600 }),
  stepsUsed: int("stepsUsed").default(0).notNull(),
  maxSteps: int("maxSteps").default(40).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type AgentRunRow = typeof agentRuns.$inferSelect;

export const agentSteps = mysqlTable("agentSteps", {
  id: int("id").autoincrement().primaryKey(),
  runRef: varchar("runRef", { length: 64 }).notNull(),
  stepNumber: int("stepNumber").notNull(),
  capability: varchar("capability", { length: 80 }).notNull(),
  status: mysqlEnum("status", ["planned", "running", "completed", "blocked", "skipped", "failed"]).default("planned").notNull(),
  reason: varchar("reason", { length: 600 }),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentStepRow = typeof agentSteps.$inferSelect;

export const agentActions = mysqlTable("agentActions", {
  id: int("id").autoincrement().primaryKey(),
  actionRef: varchar("actionRef", { length: 64 }).notNull().unique(),
  runRef: varchar("runRef", { length: 64 }).notNull(),
  stepNumber: int("stepNumber"),
  capability: varchar("capability", { length: 80 }).notNull(),
  actorType: mysqlEnum("actorType", ["user", "agent", "system"]).notNull(),
  actorId: varchar("actorId", { length: 64 }).notNull(),
  /** Both identities survive: the agent acted, the person asked for it. */
  delegatedByUserId: int("delegatedByUserId"),
  targetEntityType: varchar("targetEntityType", { length: 60 }).notNull(),
  targetEntityId: varchar("targetEntityId", { length: 120 }).notNull(),
  payloadHash: varchar("payloadHash", { length: 128 }).notNull(),
  origin: mysqlEnum("origin", ["system", "leaseos_policy", "company_policy", "authorized_user", "workflow_data", "external_content"]).notNull(),
  decision: mysqlEnum("decision", ["allow", "deny", "require_approval", "compliance_block", "stale"]).notNull(),
  decisionReasons: text("decisionReasons").notNull(),
  outcome: mysqlEnum("outcome", ["requested", "accepted", "executed", "verified", "failed"]),
  idempotencyKey: varchar("idempotencyKey", { length: 220 }).notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentActionRow = typeof agentActions.$inferSelect;

export const agentApprovals = mysqlTable("agentApprovals", {
  id: int("id").autoincrement().primaryKey(),
  approvalRef: varchar("approvalRef", { length: 64 }).notNull().unique(),
  runRef: varchar("runRef", { length: 64 }).notNull(),
  capability: varchar("capability", { length: 80 }).notNull(),
  targetEntityId: varchar("targetEntityId", { length: 120 }).notNull(),
  payloadHash: varchar("payloadHash", { length: 128 }).notNull(),
  requestedAt: timestamp("requestedAt").notNull(),
  decidedByUserId: int("decidedByUserId"),
  decidedAt: timestamp("decidedAt"),
  decision: mysqlEnum("decision", ["pending", "approved", "rejected"]).default("pending").notNull(),
  note: varchar("note", { length: 600 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AgentApprovalRow = typeof agentApprovals.$inferSelect;

/* ---- v22.20 (0101): knowledge passages and assistant queries ---- */

export const knowledgePassages = mysqlTable("knowledgePassages", {
  id: int("id").autoincrement().primaryKey(),
  passageRef: varchar("passageRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  documentRef: varchar("documentRef", { length: 64 }).notNull(),
  documentTitle: varchar("documentTitle", { length: 300 }).notNull(),
  section: varchar("section", { length: 120 }),
  page: int("page"),
  body: text("body").notNull(),
  // 0150: why this text may be reproduced, and who said so.
  reproductionBasis: varchar("reproductionBasis", { length: 24 }),   // own_document | licensed_source | unstated (pre-0150 rows)
  sourceId: varchar("sourceId", { length: 64 }),   // 0151: the named source, as the licence registry keys it
  licenceAssessmentRef: varchar("licenceAssessmentRef", { length: 64 }),   // 0151: the assessment that authorized it — stamped by the gate, never typed
  rightsAssertion: varchar("rightsAssertion", { length: 500 }),   // 0151: for an own document, the statement the person made
  loadedByUserId: int("loadedByUserId"),
  revision: varchar("revision", { length: 40 }).notNull(),
  effectiveFrom: timestamp("effectiveFrom"),
  supersededAt: timestamp("supersededAt"),
  /** Null means the document states none, which is not "all of them". */
  jurisdiction: varchar("jurisdiction", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type KnowledgePassageRow = typeof knowledgePassages.$inferSelect;

export const assistantQueries = mysqlTable("assistantQueries", {
  id: int("id").autoincrement().primaryKey(),
  queryRef: varchar("queryRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  askedByUserId: int("askedByUserId").notNull(),
  question: varchar("question", { length: 1000 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 20 }),
  verdict: mysqlEnum("verdict", ["verified", "partially_supported", "insufficient_evidence", "conflicting"]).notNull(),
  passagesRetrieved: int("passagesRetrieved").default(0).notNull(),
  passagesSupporting: int("passagesSupporting").default(0).notNull(),
  citedPassageRefsJson: text("citedPassageRefsJson").notNull(),
  askedAt: timestamp("askedAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AssistantQueryRow = typeof assistantQueries.$inferSelect;

/* ---- v22.20 (0102): retrieval probes ---- */

export const retrievalProbes = mysqlTable("retrievalProbes", {
  id: int("id").autoincrement().primaryKey(),
  probeRef: varchar("probeRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  question: varchar("question", { length: 1000 }).notNull(),
  expectedPassageRefsJson: text("expectedPassageRefsJson").notNull(),
  /** A probe is a claim; it carries the name of whoever made it. */
  authoredByUserId: int("authoredByUserId").notNull(),
  /** A question written from the passage inherits its vocabulary. */
  origin: mysqlEnum("origin", ["authored_from_document", "real_question"]).default("authored_from_document").notNull(),
  /** The recorded ask a real question was copied from. Null when authored. */
  originQueryRef: varchar("originQueryRef", { length: 64 }),
  retiredAt: timestamp("retiredAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RetrievalProbeRow = typeof retrievalProbes.$inferSelect;

export const retrievalMeasurements = mysqlTable("retrievalMeasurements", {
  id: int("id").autoincrement().primaryKey(),
  measurementRef: varchar("measurementRef", { length: 64 }).notNull().unique(),
  tenantId: varchar("tenantId", { length: 40 }),
  k: int("k").notNull(),
  grade: mysqlEnum("grade", ["unmeasured", "insufficient_sample", "poor", "adequate", "good"]).notNull(),
  probeCount: int("probeCount").notNull(),
  realQuestionCount: int("realQuestionCount").default(0).notNull(),
  meanRecallBasisPoints: int("meanRecallBasisPoints"),
  /** A measurement describes the corpus it ran against. */
  corpusPassageCount: int("corpusPassageCount").notNull(),
  /** Identity, where the count and the newest date were only description. */
  corpusHash: varchar("corpusHash", { length: 64 }).default("").notNull(),
  /** Which retriever produced it. A corpus can hold still while this moves. */
  retrieverKey: varchar("retrieverKey", { length: 60 }).default("unknown").notNull(),
  retrieverVersion: varchar("retrieverVersion", { length: 30 }).default("unknown").notNull(),
  corpusNewestPassageAt: timestamp("corpusNewestPassageAt"),
  measuredByUserId: int("measuredByUserId").notNull(),
  measuredAt: timestamp("measuredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type RetrievalMeasurementRow = typeof retrievalMeasurements.$inferSelect;

/* ==================================================================
 * v22.21 — Training Academy
 *
 * Training completion, legal credentials and practical competence are separate
 * facts. Course versions are immutable once published; attempts snapshot the
 * exact policy/question order; certificates may be issued only from reviewed
 * source snapshots and only for employer/company credential boundaries.
 * ================================================================== */

export const academyCourses = mysqlTable("academyCourses", {
  id: int("id").autoincrement().primaryKey(),
  courseCode: varchar("courseCode", { length: 80 }).notNull().unique(),
  title: varchar("title", { length: 220 }).notNull(),
  category: mysqlEnum("category", ["whmis", "tdg", "erg", "commercial_driver", "air_brake", "load_securement", "company", "external_track"]).notNull(),
  credentialBoundary: mysqlEnum("credentialBoundary", ["employer_certificate", "company_certificate", "external_track_only", "knowledge_only"]).notNull(),
  externalCredentialCode: varchar("externalCredentialCode", { length: 100 }),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  regulated: boolean("regulated").default(false).notNull(),
  requiresPractical: boolean("requiresPractical").default(false).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyCourseVersions = mysqlTable("academyCourseVersions", {
  id: int("id").autoincrement().primaryKey(),
  courseId: int("courseId").notNull(),
  versionRef: varchar("versionRef", { length: 96 }).notNull().unique(),
  versionNumber: int("versionNumber").notNull(),
  status: mysqlEnum("status", ["draft", "published", "retired"]).default("draft").notNull(),
  effectiveAt: timestamp("effectiveAt"),
  retiredAt: timestamp("retiredAt"),
  policyJson: text("policyJson").notNull(),
  courseHash: varchar("courseHash", { length: 64 }).notNull(),
  /** 0123 — s.6.2 topic coverage. Aspects are derived from this, never typed by an issuer. */
  tdgMode: mysqlEnum("tdgMode", ["road", "rail", "vessel", "air"]),
  tdgTopicCodesJson: text("tdgTopicCodesJson"),
  tdgTopicReviewStatus: mysqlEnum("tdgTopicReviewStatus", ["unmapped", "draft", "in_review", "approved"]).default("unmapped").notNull(),
  tdgTopicCoverageHash: varchar("tdgTopicCoverageHash", { length: 16 }),
  tdgTopicReviewedHash: varchar("tdgTopicReviewedHash", { length: 16 }),
  tdgTopicAuthoredByUserId: int("tdgTopicAuthoredByUserId"),
  tdgTopicReviewedByUserId: int("tdgTopicReviewedByUserId"),
  tdgTopicReviewedAt: timestamp("tdgTopicReviewedAt"),
  sourceSnapshotRef: varchar("sourceSnapshotRef", { length: 96 }),
  publishedByUserId: int("publishedByUserId"),
  publishedAt: timestamp("publishedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyModules = mysqlTable("academyModules", {
  id: int("id").autoincrement().primaryKey(),
  courseVersionId: int("courseVersionId").notNull(),
  moduleCode: varchar("moduleCode", { length: 80 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  orderIndex: int("orderIndex").notNull(),
  domainCode: varchar("domainCode", { length: 80 }).notNull(),
  requiresCompletion: boolean("requiresCompletion").default(true).notNull(),
  requiresPractical: boolean("requiresPractical").default(false).notNull(),
  estimatedMinutes: int("estimatedMinutes"),
  moduleHash: varchar("moduleHash", { length: 64 }).notNull(),
  /** 0123 — which s.6.2 topics this module teaches; the authored truth the version declaration reconciles against. */
  tdgTopicCodesJson: text("tdgTopicCodesJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyContentBlocks = mysqlTable("academyContentBlocks", {
  id: int("id").autoincrement().primaryKey(),
  moduleId: int("moduleId").notNull(),
  blockCode: varchar("blockCode", { length: 100 }).notNull(),
  orderIndex: int("orderIndex").notNull(),
  kind: mysqlEnum("kind", ["lesson", "callout", "procedure", "scenario", "knowledge_check", "source_note"]).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  bodyJson: text("bodyJson").notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyAssignments = mysqlTable("academyAssignments", {
  id: int("id").autoincrement().primaryKey(),
  assignmentRef: varchar("assignmentRef", { length: 96 }).notNull().unique(),
  userId: int("userId").notNull(),
  courseVersionId: int("courseVersionId").notNull(),
  status: mysqlEnum("status", ["assigned", "in_progress", "assessment_ready", "practical_pending", "completed", "failed", "overdue", "cancelled"]).default("assigned").notNull(),
  assignedByUserId: int("assignedByUserId").notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  dueAt: timestamp("dueAt"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  completionReason: varchar("completionReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyModuleCompletions = mysqlTable("academyModuleCompletions", {
  id: int("id").autoincrement().primaryKey(),
  assignmentId: int("assignmentId").notNull(),
  moduleId: int("moduleId").notNull(),
  courseVersionId: int("courseVersionId").notNull(),
  status: mysqlEnum("status", ["started", "completed", "invalidated"]).default("started").notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  contentVersionHash: varchar("contentVersionHash", { length: 64 }).notNull(),
  evidenceJson: text("evidenceJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyQuestions = mysqlTable("academyQuestions", {
  id: int("id").autoincrement().primaryKey(),
  courseVersionId: int("courseVersionId").notNull(),
  questionCode: varchar("questionCode", { length: 100 }).notNull(),
  bankCode: varchar("bankCode", { length: 80 }).notNull(),
  domainCode: varchar("domainCode", { length: 80 }).notNull(),
  prompt: text("prompt").notNull(),
  optionsJson: text("optionsJson").notNull(),
  correctAnswerJson: text("correctAnswerJson").notNull(),
  explanation: text("explanation"),
  critical: boolean("critical").default(false).notNull(),
  active: boolean("active").default(true).notNull(),
  questionHash: varchar("questionHash", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyAssessments = mysqlTable("academyAssessments", {
  id: int("id").autoincrement().primaryKey(),
  courseVersionId: int("courseVersionId").notNull(),
  assessmentCode: varchar("assessmentCode", { length: 100 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  questionCount: int("questionCount").notNull(),
  passingScorePercent: int("passingScorePercent").notNull(),
  maxAttempts: int("maxAttempts"),
  policyJson: text("policyJson").notNull(),
  domainThresholdsJson: text("domainThresholdsJson"),
  criticalFailurePolicyJson: text("criticalFailurePolicyJson"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyAssessmentAttempts = mysqlTable("academyAssessmentAttempts", {
  id: int("id").autoincrement().primaryKey(),
  attemptRef: varchar("attemptRef", { length: 96 }).notNull().unique(),
  assessmentId: int("assessmentId").notNull(),
  assignmentId: int("assignmentId").notNull(),
  userId: int("userId").notNull(),
  courseVersionId: int("courseVersionId").notNull(),
  status: mysqlEnum("status", ["open", "submitted", "passed", "failed", "void"]).default("open").notNull(),
  attemptNumber: int("attemptNumber").notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  submittedAt: timestamp("submittedAt"),
  scorePercent: int("scorePercent"),
  domainScoresJson: text("domainScoresJson"),
  criticalFailuresJson: text("criticalFailuresJson"),
  policySnapshotJson: text("policySnapshotJson").notNull(),
  questionSetJson: text("questionSetJson").notNull(),
  questionSetHash: varchar("questionSetHash", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyAssessmentItems = mysqlTable("academyAssessmentItems", {
  id: int("id").autoincrement().primaryKey(),
  attemptId: int("attemptId").notNull(),
  questionId: int("questionId").notNull(),
  sequenceIndex: int("sequenceIndex").notNull(),
  domainCode: varchar("domainCode", { length: 80 }).notNull(),
  critical: boolean("critical").default(false).notNull(),
  presentedPromptHash: varchar("presentedPromptHash", { length: 64 }).notNull(),
  answerOrderJson: text("answerOrderJson").notNull(),
  responseJson: text("responseJson"),
  correct: boolean("correct"),
  answeredAt: timestamp("answeredAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyPracticalEvaluations = mysqlTable("academyPracticalEvaluations", {
  id: int("id").autoincrement().primaryKey(),
  evaluationRef: varchar("evaluationRef", { length: 96 }).notNull().unique(),
  assignmentId: int("assignmentId").notNull(),
  courseVersionId: int("courseVersionId").notNull(),
  userId: int("userId").notNull(),
  competencyCode: varchar("competencyCode", { length: 100 }).notNull(),
  evaluatorUserId: int("evaluatorUserId").notNull(),
  status: mysqlEnum("status", ["competent", "needs_practice", "failed", "revoked"]).notNull(),
  rubricJson: text("rubricJson").notNull(),
  evidenceRecordId: int("evidenceRecordId"),
  observedAt: timestamp("observedAt").notNull(),
  signedAt: timestamp("signedAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyQualifications = mysqlTable("academyQualifications", {
  id: int("id").autoincrement().primaryKey(),
  qualificationRef: varchar("qualificationRef", { length: 96 }).notNull().unique(),
  userId: int("userId").notNull(),
  qualificationCode: varchar("qualificationCode", { length: 100 }).notNull(),
  sourceKind: mysqlEnum("sourceKind", ["academy_certificate", "external_credential", "direct_supervision", "company_signoff"]).notNull(),
  status: mysqlEnum("status", ["pending", "current", "expired", "revoked", "rejected"]).default("pending").notNull(),
  courseVersionId: int("courseVersionId"),
  certificateId: int("certificateId"),
  complianceDocumentId: int("complianceDocumentId"),
  validFrom: timestamp("validFrom"),
  expiresAt: timestamp("expiresAt"),
  scopeJson: text("scopeJson"),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyCertificates = mysqlTable("academyCertificates", {
  id: int("id").autoincrement().primaryKey(),
  certificateRef: varchar("certificateRef", { length: 96 }).notNull().unique(),
  userId: int("userId").notNull(),
  courseId: int("courseId").notNull(),
  courseVersionId: int("courseVersionId").notNull(),
  assignmentId: int("assignmentId").notNull(),
  qualificationCode: varchar("qualificationCode", { length: 100 }).notNull(),
  credentialBoundary: mysqlEnum("credentialBoundary", ["employer_certificate", "company_certificate"]).notNull(),
  status: mysqlEnum("status", ["pending_signature", "active", "revoked"]).default("active").notNull(),
  issuedByUserId: int("issuedByUserId").notNull(),
  employeeNameSnapshot: varchar("employeeNameSnapshot", { length: 220 }),
  employerNameSnapshot: varchar("employerNameSnapshot", { length: 220 }),
  employerBusinessAddressSnapshot: varchar("employerBusinessAddressSnapshot", { length: 500 }),
  trainingAspectsJson: text("trainingAspectsJson"),
  issuedAt: timestamp("issuedAt").notNull(),
  finalizedAt: timestamp("finalizedAt"),
  expiresAt: timestamp("expiresAt"),
  retentionUntil: timestamp("retentionUntil"),
  sourceSnapshotRef: varchar("sourceSnapshotRef", { length: 96 }).notNull(),
  regulatoryProfileRef: varchar("regulatoryProfileRef", { length: 96 }),
  regulatoryProfileHash: varchar("regulatoryProfileHash", { length: 64 }),
  statementOfExperienceId: int("statementOfExperienceId"),
  attestationStatement: text("attestationStatement"),
  attestedAt: timestamp("attestedAt"),
  policySnapshotHash: varchar("policySnapshotHash", { length: 64 }).notNull(),
  certificateHash: varchar("certificateHash", { length: 64 }).notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedByUserId: int("revokedByUserId"),
  revocationReason: varchar("revocationReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academySourceRecords = mysqlTable("academySourceRecords", {
  id: int("id").autoincrement().primaryKey(),
  sourceRef: varchar("sourceRef", { length: 96 }).notNull().unique(),
  authority: varchar("authority", { length: 220 }).notNull(),
  sourceTier: mysqlEnum("sourceTier", ["authority", "industry_association", "vendor", "unknown"]).default("unknown").notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 1024 }),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  edition: varchar("edition", { length: 120 }),
  effectiveAt: timestamp("effectiveAt"),
  reviewStatus: mysqlEnum("reviewStatus", ["unreviewed", "reviewed", "superseded", "rejected"]).default("unreviewed").notNull(),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  snapshotHash: varchar("snapshotHash", { length: 64 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyRegulatoryProfiles = mysqlTable("academyRegulatoryProfiles", {
  id: int("id").autoincrement().primaryKey(),
  profileRef: varchar("profileRef", { length: 96 }).notNull().unique(),
  qualificationCode: varchar("qualificationCode", { length: 100 }).notNull(),
  mode: mysqlEnum("mode", ["road", "rail", "vessel", "air", "workplace", "company"]).notNull(),
  profileVersion: int("profileVersion").notNull(),
  credentialBoundary: mysqlEnum("credentialBoundary", ["employer_certificate", "company_certificate"]).notNull(),
  validityMonths: int("validityMonths"),
  retentionMonthsAfterExpiry: int("retentionMonthsAfterExpiry"),
  requiresEmployeeSignature: boolean("requiresEmployeeSignature").default(false).notNull(),
  requiresEmployerSignature: boolean("requiresEmployerSignature").default(false).notNull(),
  requiresReasonableGroundsAttestation: boolean("requiresReasonableGroundsAttestation").default(false).notNull(),
  sourceSnapshotRef: varchar("sourceSnapshotRef", { length: 96 }).notNull(),
  effectiveAt: timestamp("effectiveAt").notNull(),
  supersededAt: timestamp("supersededAt"),
  profileHash: varchar("profileHash", { length: 64 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyCertificateSignatures = mysqlTable("academyCertificateSignatures", {
  id: int("id").autoincrement().primaryKey(),
  signatureRef: varchar("signatureRef", { length: 96 }).notNull().unique(),
  certificateId: int("certificateId").notNull(),
  signerUserId: int("signerUserId").notNull(),
  signerParty: mysqlEnum("signerParty", ["employee", "employer_representative", "self_employed"]).notNull(),
  signerName: varchar("signerName", { length: 220 }).notNull(),
  signerRole: varchar("signerRole", { length: 160 }).notNull(),
  signatureMethod: mysqlEnum("signatureMethod", ["drawn", "electronic_ack", "paper_scan"]).notNull(),
  signatureEvidenceRecordId: int("signatureEvidenceRecordId"),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  signedAt: timestamp("signedAt").notNull(),
  capturedOffline: boolean("capturedOffline").default(false).notNull(),
  invalidatedAt: timestamp("invalidatedAt"),
  invalidationReason: varchar("invalidationReason", { length: 400 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyStatementsOfExperience = mysqlTable("academyStatementsOfExperience", {
  id: int("id").autoincrement().primaryKey(),
  statementRef: varchar("statementRef", { length: 96 }).notNull().unique(),
  userId: int("userId").notNull(),
  qualificationCode: varchar("qualificationCode", { length: 100 }).notNull(),
  experienceFrom: timestamp("experienceFrom").notNull(),
  experienceTo: timestamp("experienceTo").notNull(),
  dutiesJson: text("dutiesJson").notNull(),
  dangerousGoodsScopeJson: text("dangerousGoodsScopeJson"),
  preparedByUserId: int("preparedByUserId").notNull(),
  employerAttestation: text("employerAttestation").notNull(),
  sourceCertificateId: int("sourceCertificateId"),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const complianceKnowledgeItems = mysqlTable("complianceKnowledgeItems", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  category: mysqlEnum("category", ["tdg", "whmis", "erg", "placards", "waste_manifest", "cargo_securement", "company_policy"]).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  summary: text("summary"),
  bodyJson: text("bodyJson"),
  sourceAuthority: varchar("sourceAuthority", { length: 220 }),
  sourceUrl: varchar("sourceUrl", { length: 1024 }),
  regulatoryVersion: varchar("regulatoryVersion", { length: 180 }),
  sourceVerifiedAt: timestamp("sourceVerifiedAt"),
  companyScope: varchar("companyScope", { length: 180 }),
  companySpecific: boolean("companySpecific").default(false).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyDirectSupervisionRecords = mysqlTable("academyDirectSupervisionRecords", {
  id: int("id").autoincrement().primaryKey(),
  supervisionRef: varchar("supervisionRef", { length: 96 }).notNull().unique(),
  traineeUserId: int("traineeUserId").notNull(),
  supervisorUserId: int("supervisorUserId").notNull(),
  jobId: int("jobId").notNull(),
  qualificationCode: varchar("qualificationCode", { length: 100 }).notNull(),
  supervisorQualificationId: int("supervisorQualificationId").notNull(),
  scopeJson: text("scopeJson").notNull(),
  startsAt: timestamp("startsAt").notNull(),
  endsAt: timestamp("endsAt").notNull(),
  physicalPresenceAttested: boolean("physicalPresenceAttested").default(false).notNull(),
  attestedByUserId: int("attestedByUserId"),
  attestedAt: timestamp("attestedAt"),
  status: mysqlEnum("status", ["planned", "active", "closed", "cancelled"]).default("planned").notNull(),
  closedAt: timestamp("closedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyRequirements = mysqlTable("academyRequirements", {
  id: int("id").autoincrement().primaryKey(),
  requirementCode: varchar("requirementCode", { length: 100 }).notNull().unique(),
  title: varchar("title", { length: 240 }).notNull(),
  qualificationCode: varchar("qualificationCode", { length: 100 }).notNull(),
  enforcement: mysqlEnum("enforcement", ["block", "review", "inform"]).default("block").notNull(),
  recoveryPath: varchar("recoveryPath", { length: 500 }),
  conditionsJson: text("conditionsJson"),
  active: boolean("active").default(true).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const academyRequirementBindings = mysqlTable("academyRequirementBindings", {
  id: int("id").autoincrement().primaryKey(),
  bindingRef: varchar("bindingRef", { length: 96 }).notNull().unique(),
  requirementId: int("requirementId").notNull(),
  subjectType: mysqlEnum("subjectType", ["role", "equipment", "job_type", "customer", "site", "jurisdiction", "cargo"]).notNull(),
  subjectCode: varchar("subjectCode", { length: 160 }).notNull(),
  conditionsJson: text("conditionsJson"),
  effectiveAt: timestamp("effectiveAt"),
  expiresAt: timestamp("expiresAt"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyAuditEvents = mysqlTable("academyAuditEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 96 }).notNull().unique(),
  actorUserId: int("actorUserId"),
  subjectType: varchar("subjectType", { length: 80 }).notNull(),
  subjectRef: varchar("subjectRef", { length: 120 }).notNull(),
  eventType: varchar("eventType", { length: 120 }).notNull(),
  eventJson: text("eventJson").notNull(),
  previousHash: varchar("previousHash", { length: 64 }),
  eventHash: varchar("eventHash", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});



/* ==================================================================
 * Project recovery 0109 — LoadSense on the canonical measurement registry
 * ================================================================== */

export const loadSenseCalibrationModels = mysqlTable("loadSenseCalibrationModels", {
  id: int("id").autoincrement().primaryKey(),
  modelRef: varchar("modelRef", { length: 96 }).notNull().unique(),
  measurementDeviceId: int("measurementDeviceId").notNull(),
  calibrationEventId: int("calibrationEventId").notNull(),
  slope: double("slope").notNull(),
  /** Linear intercept. Column renamed from `offset`, a MariaDB reserved word, before first release. */
  interceptOffset: double("interceptOffset").notNull(),
  pointCount: int("pointCount").notNull(),
  rSquared: double("rSquared"),
  pointsJson: text("pointsJson").notNull(),
  status: mysqlEnum("status", ["active", "superseded", "invalidated"]).default("active").notNull(),
  invalidationReason: varchar("invalidationReason", { length: 400 }),
  effectiveAt: timestamp("effectiveAt").notNull(),
  invalidatedAt: timestamp("invalidatedAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const loadSenseGatewayBindings = mysqlTable("loadSenseGatewayBindings", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }).notNull(),
  gatewayDeviceRef: varchar("gatewayDeviceRef", { length: 96 }).notNull(),
  measurementDeviceId: int("measurementDeviceId").notNull(),
  unitId: int("unitId").notNull(),
  trailerId: int("trailerId"),
  tareKg: double("tareKg").notNull(),
  channelConfigJson: text("channelConfigJson"),
  status: mysqlEnum("status", ["active", "suspended", "retired"]).default("active").notNull(),
  boundByUserId: int("boundByUserId").notNull(),
  boundAt: timestamp("boundAt").defaultNow().notNull(),
}, (t) => ({
  gatewayPerOrg: uniqueIndex("loadSenseGatewayBindings_org_gateway_unique").on(t.orgRef, t.gatewayDeviceRef),
}));

export const loadSenseGatewayFrames = mysqlTable("loadSenseGatewayFrames", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 40 }).notNull(),
  sourceClientId: int("sourceClientId").notNull(),
  frameKey: varchar("frameKey", { length: 180 }).notNull().unique(),
  gatewayDeviceRef: varchar("gatewayDeviceRef", { length: 96 }).notNull(),
  sequence: int("sequence").notNull(),
  measurementDeviceId: int("measurementDeviceId"),
  loadId: int("loadId"),
  calibrationModelId: int("calibrationModelId"),
  measuredAt: timestamp("measuredAt").notNull(),
  buffered: boolean("buffered").default(false).notNull(),
  readingsJson: text("readingsJson").notNull(),
  vehicleStateJson: text("vehicleStateJson"),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
});

export const loadSenseWeightSnapshots = mysqlTable("loadSenseWeightSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  snapshotRef: varchar("snapshotRef", { length: 96 }).notNull().unique(),
  loadId: int("loadId").notNull(),
  unitId: int("unitId").notNull(),
  trailerId: int("trailerId"),
  jobId: int("jobId"),
  tripId: int("tripId"),
  measurementDeviceId: int("measurementDeviceId"),
  calibrationModelId: int("calibrationModelId"),
  measurementSource: mysqlEnum("measurementSource", ["estimated", "driver_entered", "loadsense_uncalibrated", "loadsense_calibrated", "certified_scale"]).notNull(),
  tareKg: double("tareKg").notNull(),
  grossKg: double("grossKg").notNull(),
  payloadKg: double("payloadKg").notNull(),
  stable: boolean("stable").notNull(),
  stabilityScore: double("stabilityScore").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  measuredAt: timestamp("measuredAt").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  // 0159: the verdict as decided, not re-derived. A calibration invalidated later must not
  // silently un-make a determination that was legal when the reading was taken.
  legalDetermination: boolean("legalDetermination"),
  legalDeterminationCode: varchar("legalDeterminationCode", { length: 40 }),
  legalDeterminationReason: varchar("legalDeterminationReason", { length: 500 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const loadSenseAxleWeights = mysqlTable("loadSenseAxleWeights", {
  id: int("id").autoincrement().primaryKey(),
  snapshotId: int("snapshotId").notNull(),
  axleGroupKey: varchar("axleGroupKey", { length: 80 }).notNull(),
  label: varchar("label", { length: 160 }).notNull(),
  weightKg: double("weightKg").notNull(),
  configuredLimitKg: double("configuredLimitKg"),
  limitSource: varchar("limitSource", { length: 300 }),
  status: mysqlEnum("status", ["within", "near_limit", "over_limit", "unknown_limit"]).notNull(),
  sourceChannelsJson: text("sourceChannelsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const loadSenseScaleReconciliations = mysqlTable("loadSenseScaleReconciliations", {
  id: int("id").autoincrement().primaryKey(),
  reconciliationRef: varchar("reconciliationRef", { length: 96 }).notNull().unique(),
  snapshotId: int("snapshotId").notNull(),
  certifiedScaleEvidenceId: int("certifiedScaleEvidenceId"),
  certifiedGrossKg: double("certifiedGrossKg").notNull(),
  varianceKg: double("varianceKg").notNull(),
  variancePercent: double("variancePercent").notNull(),
  status: mysqlEnum("status", ["within_tolerance", "review", "recalibration_recommended"]).notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const materialDensityProfiles = mysqlTable("materialDensityProfiles", {
  id: int("id").autoincrement().primaryKey(),
  profileRef: varchar("profileRef", { length: 96 }).notNull().unique(),
  materialCode: varchar("materialCode", { length: 160 }).notNull(),
  densityKgM3: double("densityKgM3").notNull(),
  source: varchar("source", { length: 400 }).notNull(),
  verified: boolean("verified").default(false).notNull(),
  moistureAdjusted: boolean("moistureAdjusted").default(false).notNull(),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveTo: timestamp("effectiveTo"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InsertLoadSenseCalibrationModel = typeof loadSenseCalibrationModels.$inferInsert;
export type InsertLoadSenseGatewayFrame = typeof loadSenseGatewayFrames.$inferInsert;
export type InsertLoadSenseWeightSnapshot = typeof loadSenseWeightSnapshots.$inferInsert;
export type InsertLoadSenseAxleWeight = typeof loadSenseAxleWeights.$inferInsert;
export type InsertLoadSenseScaleReconciliation = typeof loadSenseScaleReconciliations.$inferInsert;
export type InsertMaterialDensityProfile = typeof materialDensityProfiles.$inferInsert;

export type InsertAcademyCourse = typeof academyCourses.$inferInsert;
export type InsertAcademyCourseVersion = typeof academyCourseVersions.$inferInsert;
export type InsertAcademyModule = typeof academyModules.$inferInsert;
export type InsertAcademyContentBlock = typeof academyContentBlocks.$inferInsert;
export type InsertAcademyAssignment = typeof academyAssignments.$inferInsert;
export type InsertAcademyModuleCompletion = typeof academyModuleCompletions.$inferInsert;
export type InsertAcademyQuestion = typeof academyQuestions.$inferInsert;
export type InsertAcademyAssessment = typeof academyAssessments.$inferInsert;
export type InsertAcademyAssessmentAttempt = typeof academyAssessmentAttempts.$inferInsert;
export type InsertAcademyAssessmentItem = typeof academyAssessmentItems.$inferInsert;
export type InsertAcademyPracticalEvaluation = typeof academyPracticalEvaluations.$inferInsert;
export type InsertAcademyQualification = typeof academyQualifications.$inferInsert;
export type InsertAcademyCertificate = typeof academyCertificates.$inferInsert;
export type InsertAcademySourceRecord = typeof academySourceRecords.$inferInsert;
export type InsertAcademyRegulatoryProfile = typeof academyRegulatoryProfiles.$inferInsert;
export type InsertAcademyCertificateSignature = typeof academyCertificateSignatures.$inferInsert;
export type InsertAcademyStatementOfExperience = typeof academyStatementsOfExperience.$inferInsert;
export type ComplianceKnowledgeItem = typeof complianceKnowledgeItems.$inferSelect;
export type InsertComplianceKnowledgeItem = typeof complianceKnowledgeItems.$inferInsert;
export type InsertAcademyDirectSupervisionRecord = typeof academyDirectSupervisionRecords.$inferInsert;
export type InsertAcademyRequirement = typeof academyRequirements.$inferInsert;
export type InsertAcademyRequirementBinding = typeof academyRequirementBindings.$inferInsert;
export type InsertAcademyAuditEvent = typeof academyAuditEvents.$inferInsert;

/* ---- 0115: Contractor & Owner-Operator Operations ---- */
export const organizationRelationships = mysqlTable("organizationRelationships", {
  id: int("id").autoincrement().primaryKey(),
  relationshipRef: varchar("relationshipRef", { length: 64 }).notNull().unique(),
  parentOrgRef: varchar("parentOrgRef", { length: 40 }).notNull(),
  childOrgRef: varchar("childOrgRef", { length: 40 }).notNull(),
  relationshipType: mysqlEnum("relationshipType", ["PRIME_CONTRACTOR","CONTRACTOR","SUBCONTRACTOR","VENDOR","LEASED_OWNER_OPERATOR","INDEPENDENT_CARRIER","EQUIPMENT_PROVIDER"]).notNull(),
  status: mysqlEnum("status", ["pending","active","suspended","ended"]).default("pending").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ pairType: uniqueIndex("organizationRelationships_pair_type_unique").on(t.parentOrgRef,t.childOrgRef,t.relationshipType), parentIdx: index("organizationRelationships_parent_idx").on(t.parentOrgRef,t.status), childIdx: index("organizationRelationships_child_idx").on(t.childOrgRef,t.status) }));

export const contractorBusinessProfiles = mysqlTable("contractorBusinessProfiles", {
  id: int("id").autoincrement().primaryKey(), orgRef: varchar("orgRef", { length: 40 }).notNull().unique(),
  operatingMode: mysqlEnum("operatingMode", ["LEASED_OWNER_OPERATOR","INDEPENDENT_CONTRACTOR","INDEPENDENT_CARRIER","CONTRACTOR_COMPANY"]).notNull(),
  legalName: varchar("legalName", { length: 220 }).notNull(), carrierNumber: varchar("carrierNumber", { length: 80 }),
  status: mysqlEnum("status", ["active","suspended","closed"]).default("active").notNull(), createdByUserId: int("createdByUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const organizationWorkers = mysqlTable("organizationWorkers", {
  id: int("id").autoincrement().primaryKey(), workerRef: varchar("workerRef", { length: 64 }).notNull().unique(), orgRef: varchar("orgRef", { length: 40 }).notNull(), userId: int("userId"), operatorId: int("operatorId"),
  workerType: mysqlEnum("workerType", ["OWNER_DRIVER","EMPLOYEE_DRIVER","CO_DRIVER","SWAMPER","LABORER","EQUIPMENT_OPERATOR","HELPER","SHOP_HAND","MECHANIC","MAINTENANCE_SUPERVISOR","BOOKKEEPER","DISPATCHER","SAFETY_COMPLIANCE","OFFICE_ADMIN"]).notNull(),
  compensationType: mysqlEnum("compensationType", ["HOURLY","SALARY","DAY_RATE","LOAD_RATE","KM_RATE","PERCENTAGE","PIECE_RATE","CONTRACT_RATE"]),
  status: mysqlEnum("status", ["active","inactive","ended"]).default("active").notNull(), effectiveFrom: timestamp("effectiveFrom").notNull(), effectiveTo: timestamp("effectiveTo"), createdByUserId: int("createdByUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ orgIdx: index("organizationWorkers_org_idx").on(t.orgRef,t.status) }));

export const commercialJobChains = mysqlTable("commercialJobChains", {
  id: int("id").autoincrement().primaryKey(), chainRef: varchar("chainRef", { length: 80 }).notNull().unique(), chainNumber: varchar("chainNumber", { length: 120 }).unique(), rootJobId: int("rootJobId").notNull(), parentChainRef: varchar("parentChainRef", { length: 80 }),
  assigningOrgRef: varchar("assigningOrgRef", { length: 40 }).notNull(), performingOrgRef: varchar("performingOrgRef", { length: 40 }).notNull(), customerOrgRef: varchar("customerOrgRef", { length: 40 }), operatingCarrierOrgRef: varchar("operatingCarrierOrgRef", { length: 40 }), equipmentOwnerOrgRef: varchar("equipmentOwnerOrgRef", { length: 40 }),
  relationshipType: mysqlEnum("relationshipType", ["EMPLOYEE","LEASED_OWNER_OPERATOR","INDEPENDENT_CONTRACTOR","SUBCONTRACTOR","INDEPENDENT_CARRIER"]).notNull(), status: mysqlEnum("status", ["assigned","accepted","active","complete","cancelled"]).default("assigned").notNull(), createdByUserId: int("createdByUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ jobIdx: index("commercialJobChains_job_idx").on(t.rootJobId), performingIdx: index("commercialJobChains_performing_idx").on(t.performingOrgRef,t.status) }));

export const jobCrewAssignments = mysqlTable("jobCrewAssignments", {
  id: int("id").autoincrement().primaryKey(), assignmentRef: varchar("assignmentRef", { length: 80 }).notNull().unique(), chainRef: varchar("chainRef", { length: 80 }).notNull(), unitId: int("unitId").notNull(), primaryDriverWorkerRef: varchar("primaryDriverWorkerRef", { length: 64 }).notNull(), coDriverWorkerRef: varchar("coDriverWorkerRef", { length: 64 }), additionalCrewJson: text("additionalCrewJson").notNull(),
  startsAt: timestamp("startsAt").notNull(), endsAt: timestamp("endsAt"), createdByUserId: int("createdByUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ chainIdx: index("jobCrewAssignments_chain_idx").on(t.chainRef), unitIdx: index("jobCrewAssignments_unit_idx").on(t.unitId,t.startsAt) }));

export const privateRateSchedules = mysqlTable("privateRateSchedules", {
  id: int("id").autoincrement().primaryKey(), rateRef: varchar("rateRef", { length: 80 }).notNull().unique(), ownerOrgRef: varchar("ownerOrgRef", { length: 40 }).notNull(), counterpartyOrgRef: varchar("counterpartyOrgRef", { length: 40 }).notNull(), chainRef: varchar("chainRef", { length: 80 }),
  compensationType: mysqlEnum("compensationType", ["HOURLY","SALARY","DAY_RATE","LOAD_RATE","KM_RATE","PERCENTAGE","PIECE_RATE","CONTRACT_RATE"]).notNull(), rateCents: int("rateCents").notNull(), currency: varchar("currency", { length: 3 }).default("CAD").notNull(), effectiveFrom: timestamp("effectiveFrom").notNull(), effectiveTo: timestamp("effectiveTo"), createdByUserId: int("createdByUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ ownerIdx: index("privateRateSchedules_owner_idx").on(t.ownerOrgRef,t.counterpartyOrgRef) }));


/* ---- 0116: Contractor commercial payables & private settlement chain ---- */
export const contractorPayables = mysqlTable("contractorPayables", {
  id: int("id").autoincrement().primaryKey(),
  payableRef: varchar("payableRef", { length: 80 }).notNull().unique(),
  chainRef: varchar("chainRef", { length: 80 }).notNull(),
  payerOrgRef: varchar("payerOrgRef", { length: 40 }).notNull(),
  payeeOrgRef: varchar("payeeOrgRef", { length: 40 }).notNull(),
  rateRef: varchar("rateRef", { length: 80 }).notNull(),
  compensationType: mysqlEnum("compensationType", ["HOURLY","SALARY","DAY_RATE","LOAD_RATE","KM_RATE","PERCENTAGE","PIECE_RATE","CONTRACT_RATE"]).notNull(),
  quantityMillis: int("quantityMillis").notNull(),
  quantityUnit: mysqlEnum("quantityUnit", ["HOUR","DAY","LOAD","KM","PERCENT","PIECE","CONTRACT"]).notNull(),
  rateCentsSnapshot: int("rateCentsSnapshot").notNull(),
  grossAmountCents: int("grossAmountCents").notNull(),
  currency: varchar("currency", { length: 3 }).default("CAD").notNull(),
  evidenceRefsJson: text("evidenceRefsJson").notNull(),
  preparationSource: mysqlEnum("preparationSource", ["HUMAN","AI_SECRETARY"]).default("HUMAN").notNull(),
  state: mysqlEnum("state", ["prepared","review","approved","posted","paid","disputed","void"]).default("prepared").notNull(),
  preparedByUserId: int("preparedByUserId").notNull(),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  postedAt: timestamp("postedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ payerIdx: index("contractorPayables_payer_idx").on(t.payerOrgRef,t.state), payeeIdx: index("contractorPayables_payee_idx").on(t.payeeOrgRef,t.state), chainIdx: index("contractorPayables_chain_idx").on(t.chainRef,t.state) }));

export const contractorPayableEvents = mysqlTable("contractorPayableEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 80 }).notNull().unique(),
  payableRef: varchar("payableRef", { length: 80 }).notNull(),
  actorOrgRef: varchar("actorOrgRef", { length: 40 }).notNull(),
  actorUserId: int("actorUserId").notNull(),
  eventType: mysqlEnum("eventType", ["PREPARED","SUBMITTED_REVIEW","APPROVED","POSTED","PAID","DISPUTED","VOIDED"]).notNull(),
  amountCentsSnapshot: int("amountCentsSnapshot").notNull(),
  note: varchar("note", { length: 500 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ payableIdx: index("contractorPayableEvents_payable_idx").on(t.payableRef,t.createdAt) }));


/* ---- 0117: Human-readable inherited commercial job/load numbers ---- */
export const commercialChainSequences = mysqlTable("commercialChainSequences", {
  scopeRef: varchar("scopeRef", { length: 120 }).primaryKey(),
  nextValue: int("nextValue").default(1).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export const commercialLoadChainRefs = mysqlTable("commercialLoadChainRefs", {
  id: int("id").autoincrement().primaryKey(), loadId: int("loadId").notNull().unique(), chainRef: varchar("chainRef", { length: 80 }).notNull(), loadChainNumber: varchar("loadChainNumber", { length: 140 }).notNull().unique(), createdByUserId: int("createdByUserId").notNull(), createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({ chainIdx: index("commercialLoadChainRefs_chain_idx").on(t.chainRef) }));


/* ---- v22.20 (0118, ex-0089): what LeaseOS has been allowed to read ---- */

/**
 * A source and its licence assessment.
 *
 * Four independent permissions, because "can we use this?" is four legal
 * questions. 511 Alberta is the case that proves it: LeaseOS may link to that
 * course today and may not store a sentence of it.
 */
export const knowledgeSources = mysqlTable("knowledgeSources", {
  id: int("id").autoincrement().primaryKey(),
  sourceId: varchar("sourceId", { length: 64 }).notNull().unique(),
  sourceName: varchar("sourceName", { length: 200 }).notNull(),
  owner: varchar("owner", { length: 200 }).notNull(),
  jurisdiction: varchar("jurisdiction", { length: 16 }).notNull(),
  homeUrl: varchar("homeUrl", { length: 500 }),

  assessmentId: varchar("assessmentId", { length: 64 }),
  assessedAt: date("assessedAt"),
  assessedByUserId: int("assessedByUserId"),
  /** `unassessed` is the default, and it permits nothing. */
  licenceStatus: mysqlEnum("licenceStatus", [
    "unassessed", "blocked_pending_written_permission", "authorized_commercial",
    "authorized_non_commercial_only", "link_and_metadata_only", "prohibited",
  ]).default("unassessed").notNull(),

  linkingAuthorized: boolean("linkingAuthorized").default(false).notNull(),
  metadataOnlyAuthorized: boolean("metadataOnlyAuthorized").default(false).notNull(),
  ragIngestionAuthorized: boolean("ragIngestionAuthorized").default(false).notNull(),
  modelTrainingAuthorized: boolean("modelTrainingAuthorized").default(false).notNull(),
  apiProductionAuthorized: boolean("apiProductionAuthorized").default(false).notNull(),
  /** Meaningless without `permissionDocumentId`; the application enforces the pair. */
  commercialReuseAuthorized: boolean("commercialReuseAuthorized").default(false).notNull(),

  permissionDocumentId: varchar("permissionDocumentId", { length: 64 }),
  permissionScope: json("permissionScope"),
  permissionRecordedByUserId: int("permissionRecordedByUserId"),
  permissionRecordedAt: timestamp("permissionRecordedAt"),

  reasonsJson: json("reasonsJson"),
  conditionsToUnblockJson: json("conditionsToUnblockJson"),
  officialSourcesJson: json("officialSourcesJson"),

  /* 0197: the catalogue half — what the source is. Written by registerCatalogueEntry, which never touches the licence half. */
  sourceKind: mysqlEnum("sourceKind", ["api", "html", "pdf", "xml", "json", "csv", "geojson", "warc", "rss", "sitemap"]),
  authorityLevel: mysqlEnum("authorityLevel", [
    "law", "official_guidance", "recognized_standard", "manufacturer",
    "company_policy", "operational", "unverified",
  ]).default("unverified").notNull(),
  domainsJson: json("domainsJson"),
  topicsJson: json("topicsJson"),
  refreshIntervalHours: int("refreshIntervalHours"),
  crawlPolicyJson: json("crawlPolicyJson"),
  termsUrl: varchar("termsUrl", { length: 500 }),
  accessControlled: boolean("accessControlled").default(false).notNull(),
  robotsStatus: mysqlEnum("robotsStatus", ["unchecked", "fetched", "absent", "unreachable"]).default("unchecked").notNull(),
  robotsCheckedAt: timestamp("robotsCheckedAt"),
  licenceNotes: text("licenceNotes"),
  active: boolean("active").default(true).notNull(),
  deactivatedReason: varchar("deactivatedReason", { length: 300 }),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type KnowledgeSourceRow = typeof knowledgeSources.$inferSelect;

/** A fetched document. Created quarantined, always. */
export const knowledgeDocuments = mysqlTable("knowledgeDocuments", {
  id: int("id").autoincrement().primaryKey(),
  documentRef: varchar("documentRef", { length: 64 }).notNull().unique(),
  sourceId: varchar("sourceId", { length: 64 }).notNull(),
  title: varchar("title", { length: 400 }).notNull(),
  url: varchar("url", { length: 1000 }),
  purpose: mysqlEnum("purpose", [
    "link_only", "metadata_only", "rag_ingestion",
    "api_production", "api_dev_testing", "model_training", "commercial_redisplay",
  ]).notNull(),
  state: mysqlEnum("state", [
    "QUARANTINED", "LICENCE_CHECKED", "PARSED", "CLASSIFIED", "VERIFIED", "PUBLISHED", "REJECTED",
  ]).default("QUARANTINED").notNull(),
  rejectedReason: varchar("rejectedReason", { length: 500 }),
  gateDecisionCode: varchar("gateDecisionCode", { length: 64 }),
  authorityLevel: mysqlEnum("authorityLevel", [
    "law", "official_guidance", "recognized_standard", "manufacturer",
    "company_policy", "operational", "unverified",
  ]).default("unverified").notNull(),
  fetchedAt: timestamp("fetchedAt").notNull(),
  fetchedByUserId: int("fetchedByUserId"),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;

/** Versions, so a rule can be shown as it stood. Nothing is overwritten. */
export const knowledgeVersions = mysqlTable("knowledgeVersions", {
  id: int("id").autoincrement().primaryKey(),
  versionRef: varchar("versionRef", { length: 64 }).notNull().unique(),
  documentRef: varchar("documentRef", { length: 64 }).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveUntil: timestamp("effectiveUntil"),
  publishedAt: timestamp("publishedAt"),
  supersedesVersionRef: varchar("supersedesVersionRef", { length: 64 }),
  supersededByVersionRef: varchar("supersededByVersionRef", { length: 64 }),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /* ---- 0189 (C1b-1): what a rule revision needs to know about its source. ---- */
  citation: varchar("citation", { length: 400 }),
  section: varchar("section", { length: 200 }),
  publicationDate: date("publicationDate"),
  retrievedAt: timestamp("retrievedAt"),
  repealedAt: timestamp("repealedAt"),
  /** candidate | reviewed | verified | superseded | withdrawn. Only `verified` can back a rule. */
  status: varchar("status", { length: 16 }).default("candidate").notNull(),
});
export type KnowledgeVersionRow = typeof knowledgeVersions.$inferSelect;

/**
 * Stored text.
 *
 * A row here is reproduction, whatever the pipeline calls the step, so one may
 * exist only where the source permits it. `authorizedByAssessmentId` records
 * which assessment allowed it, so a later revocation can find its own rows.
 */
export const knowledgeChunks = mysqlTable("knowledgeChunks", {
  id: int("id").autoincrement().primaryKey(),
  chunkRef: varchar("chunkRef", { length: 64 }).notNull().unique(),
  documentRef: varchar("documentRef", { length: 64 }).notNull(),
  versionRef: varchar("versionRef", { length: 64 }),
  ordinal: int("ordinal").notNull(),
  text: text("text").notNull(),
  tokenCount: int("tokenCount"),
  section: varchar("section", { length: 200 }),
  page: int("page"),
  authorizedByAssessmentId: varchar("authorizedByAssessmentId", { length: 64 }).notNull(),
  /* 0197: which retrieval, what the text hashes to, what it is about. Null only on pre-0197 rows. */
  snapshotRef: varchar("snapshotRef", { length: 64 }),
  contentHash: varchar("contentHash", { length: 64 }),
  topicsJson: json("topicsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;

/**
 * One row per retrieval attempt, failures included (0197).
 *
 * Append-only, enforced by triggers: no DELETE, and no UPDATE except recording
 * the extraction outcome once. `contentSha256` is recomputed by LeaseOS from
 * the bytes; the collector's claim is kept in `declaredSha256` for the record.
 */
export const knowledgeSnapshots = mysqlTable("knowledgeSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  snapshotRef: varchar("snapshotRef", { length: 64 }).notNull().unique(),
  sourceId: varchar("sourceId", { length: 64 }).notNull(),
  documentRef: varchar("documentRef", { length: 64 }).notNull(),
  url: varchar("url", { length: 1000 }).notNull(),
  retrievedAt: timestamp("retrievedAt").notNull(),
  collectorKind: mysqlEnum("collectorKind", ["api", "html", "pdf", "browser", "geodata", "sitemap", "rss", "common_crawl"]).notNull(),
  collectorVersion: varchar("collectorVersion", { length: 40 }).notNull(),
  outcome: mysqlEnum("outcome", ["first_seen", "unchanged", "changed", "unavailable", "hash_mismatch"]).notNull(),
  outcomeReason: varchar("outcomeReason", { length: 500 }),
  httpStatus: int("httpStatus"),
  contentType: varchar("contentType", { length: 120 }),
  etag: varchar("etag", { length: 200 }),
  lastModified: varchar("lastModified", { length: 64 }),
  byteLength: bigint("byteLength", { mode: "number" }),
  contentSha256: varchar("contentSha256", { length: 64 }),
  declaredSha256: varchar("declaredSha256", { length: 128 }),
  rawObjectKey: varchar("rawObjectKey", { length: 300 }),
  previousSnapshotRef: varchar("previousSnapshotRef", { length: 64 }),
  versionRef: varchar("versionRef", { length: 64 }),
  publishedAt: timestamp("publishedAt"),
  effectiveFrom: timestamp("effectiveFrom"),
  effectiveUntil: timestamp("effectiveUntil"),
  parserVersion: varchar("parserVersion", { length: 40 }),
  extractionStatus: mysqlEnum("extractionStatus", ["pending", "extracted", "failed", "not_applicable"]).default("pending").notNull(),
  extractionError: varchar("extractionError", { length: 500 }),
  provenanceJson: json("provenanceJson"),
  recordedByUserId: int("recordedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  documentIdx: index("knowledgeSnapshots_document_idx").on(t.documentRef, t.retrievedAt),
  sourceIdx: index("knowledgeSnapshots_source_idx").on(t.sourceId),
}));
export type KnowledgeSnapshotRow = typeof knowledgeSnapshots.$inferSelect;



/* ---- v22.20 (0120, ex-0091): every figure LeaseOS has ever relied on ---- */

/**
 * The promotion ledger.
 *
 * One row per promoted figure, written once and never edited. A correction does
 * not rewrite the row it corrects — it points at it, so the error stays visible.
 * That is stronger audit evidence than a silent 700 → 780.
 *
 * There is deliberately no column for the source text. LeaseOS stores evidence
 * sufficient to relocate and defend a figure; it does not warehouse the source.
 */
export const hosRuleLimitHistory = mysqlTable("hosRuleLimitHistory", {
  id: int("id").autoincrement().primaryKey(),
  promotionRef: varchar("promotionRef", { length: 64 }).notNull().unique(),

  /** HOS rows only (0189): a rule from another family has no profile, limit or figure. */
  profileKey: varchar("profileKey", { length: 60 }),
  limitKey: varchar("limitKey", { length: 60 }),
  value: double("value"),
  unit: varchar("unit", { length: 32 }).notNull(),

  jurisdiction: varchar("jurisdiction", { length: 64 }).notNull(),
  authorityType: mysqlEnum("authorityType", [
    "law", "official_guidance", "recognized_standard", "manufacturer",
  ]).notNull(),
  instrumentTitle: varchar("instrumentTitle", { length: 400 }).notNull(),
  issuingAuthority: varchar("issuingAuthority", { length: 200 }).notNull(),
  sourceSection: varchar("sourceSection", { length: 200 }).notNull(),
  citationUrl: varchar("citationUrl", { length: 1000 }).notNull(),
  instrumentVersion: varchar("instrumentVersion", { length: 120 }),
  consolidationDate: date("consolidationDate"),
  verificationMethod: mysqlEnum("verificationMethod", [
    "OFFICIAL_WEB", "OFFICIAL_PDF", "OFFICIAL_PRINT", "LEGAL_COUNSEL", "REGULATOR_CONFIRMATION",
    // 0198 (C1b-2b): a requirement verified against a named instrument, citation and official URL,
    // without an admitted source document.
    "OFFICIAL_CITATION",
  ]).notNull(),
  establishedByVersionRef: varchar("establishedByVersionRef", { length: 64 }),

  verifiedByUserId: int("verifiedByUserId").notNull(),
  /** When a person checked it. */
  verifiedAt: timestamp("verifiedAt").notNull(),
  /** When the rule legally began. */
  effectiveFrom: timestamp("effectiveFrom"),
  /** When it stopped. */
  effectiveUntil: timestamp("effectiveUntil"),
  /** When LeaseOS stored the verification. */
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),

  status: mysqlEnum("status", ["FUTURE", "CURRENT", "EXPIRED", "REVOKED", "SUPERSEDED"])
    .default("CURRENT").notNull(),
  changeReason: mysqlEnum("changeReason", [
    "INITIAL_VERIFICATION", "VERIFIED_REVISION", "CORRECTED_VERIFICATION",
    "REVOCATION", "REVERIFICATION",
  ]).notNull(),

  correctsPromotionRef: varchar("correctsPromotionRef", { length: 64 }),
  previousPromotionRef: varchar("previousPromotionRef", { length: 64 }),

  /* ---- 0189 (C1b-1): the one rule ledger. Existing rows are `hos_limit`. ---- */
  ruleFamily: varchar("ruleFamily", { length: 40 }).default("hos_limit").notNull(),
  /** `profileKey.limitKey` for HOS; the requirement key for other families. */
  ruleRef: varchar("ruleRef", { length: 160 }),
  domain: varchar("domain", { length: 40 }),
  /** The §4 ladder (`AuthorityClass`). */
  authorityTier: varchar("authorityTier", { length: 40 }),
  dispatchEffect: varchar("dispatchEffect", { length: 16 }),
  /** → `knowledgeVersions.versionRef`; the verified source revision this rule was read from. */
  sourceRevisionRef: varchar("sourceRevisionRef", { length: 64 }),
  /** That revision's `contentHash` when the rule was verified, so a changed source is detectable. */
  sourceHash: varchar("sourceHash", { length: 64 }),
  proposedByUserId: int("proposedByUserId"),
  secondVerifierUserId: int("secondVerifierUserId"),
  secondVerifiedAt: timestamp("secondVerifiedAt"),
  /** A non-numeric rule's content. */
  payloadJson: text("payloadJson"),
  /** 0198: CITATION_VERIFIED or SOURCE_DOCUMENT_VERIFIED for a requirement promotion; NULL for HOS. */
  verificationLevel: varchar("verificationLevel", { length: 32 }),
}, (t) => ({
  familyRuleIdx: index("hosRuleLimitHistory_family_rule_idx").on(t.ruleFamily, t.ruleRef),
}));
export type HosRuleLimitHistoryRow = typeof hosRuleLimitHistory.$inferSelect;


/* ---- v22.21 (0122, recovered from Chat 5 PENDING-6): inspector requests for training records — TDG s.6.7 ---- */

/**
 * A written request from an inspector for a person's training records.
 *
 * The retention chain guards (0121) keep the evidence alive; this is the
 * obligation that consumes it: within 15 days the employer must provide the
 * certificate, the record of training or statement of experience, and a
 * description of the training material used. `requestDatedAt` and
 * `requestReceivedAt` are separate because the clock runs from the request and
 * the two dates can differ — see `_core/inspectorRequest.ts`.
 */
/** 0131 — security incidents and privacy breach assessments (P4.6). Distinct from safety incidentReports. */
export const securityIncidents = mysqlTable("securityIncidents", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  incidentRef: varchar("incidentRef", { length: 64 }).notNull(),
  incidentType: mysqlEnum("incidentType", ["account_compromise", "unauthorized_access", "data_exposure", "malware", "ransomware", "credential_exposure", "cross_tenant_access", "lost_device", "vendor_incident", "availability", "integrity", "privacy", "other"]).notNull(),
  severity: mysqlEnum("severity", ["low", "moderate", "high", "critical"]).default("moderate").notNull(),
  status: mysqlEnum("status", ["open", "triaging", "contained", "investigating", "recovering", "monitoring", "closed"]).default("open").notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  summary: text("summary"),
  discoveredAt: timestamp("discoveredAt").notNull(),
  occurredFrom: timestamp("occurredFrom"),
  occurredTo: timestamp("occurredTo"),
  discoveredByUserId: int("discoveredByUserId").notNull(),
  incidentOwnerUserId: int("incidentOwnerUserId"),
  personalInformationSuspected: boolean("personalInformationSuspected").default(false).notNull(),
  customerDataSuspected: boolean("customerDataSuspected").default(false).notNull(),
  containedAt: timestamp("containedAt"),
  closedAt: timestamp("closedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ orgIdx: index("securityIncidents_org_idx").on(t.orgRef, t.status), ref: uniqueIndex("securityIncidents_ref_unique").on(t.incidentRef) }));
export const securityIncidentEvents = mysqlTable("securityIncidentEvents", {
  id: int("id").autoincrement().primaryKey(),
  securityIncidentId: int("securityIncidentId").notNull(),
  sequence: int("sequence").notNull(),
  eventType: mysqlEnum("eventType", ["discovered", "triage", "evidence_added", "contained", "scope_changed", "customer_identified", "privacy_assessment", "notification_decision", "notification_sent", "recovery", "closed", "reopened"]).notNull(),
  actorUserId: int("actorUserId").notNull(),
  detail: text("detail"),
  evidenceRecordId: int("evidenceRecordId"),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ seq: uniqueIndex("securityIncidentEvents_seq_unique").on(t.securityIncidentId, t.sequence) }));
export const securityIncidentOrganizations = mysqlTable("securityIncidentOrganizations", {
  id: int("id").autoincrement().primaryKey(),
  securityIncidentId: int("securityIncidentId").notNull(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  affectedStatus: mysqlEnum("affectedStatus", ["suspected", "confirmed", "ruled_out"]).default("suspected").notNull(),
  dataCategoriesJson: text("dataCategoriesJson"),
  identifiedAt: timestamp("identifiedAt").defaultNow().notNull(),
}, (t) => ({ unique: uniqueIndex("securityIncidentOrganizations_unique").on(t.securityIncidentId, t.orgRef) }));
export const privacyBreachAssessments = mysqlTable("privacyBreachAssessments", {
  id: int("id").autoincrement().primaryKey(),
  securityIncidentId: int("securityIncidentId").notNull(),
  assessmentNo: int("assessmentNo").notNull(),
  jurisdiction: varchar("jurisdiction", { length: 80 }).notNull(),
  applicableLaw: varchar("applicableLaw", { length: 180 }),
  status: mysqlEnum("status", ["draft", "in_review", "complete", "superseded"]).default("draft").notNull(),
  sensitivity: mysqlEnum("sensitivity", ["low", "moderate", "high", "very_high", "unknown"]).default("unknown").notNull(),
  misuseLikelihood: mysqlEnum("misuseLikelihood", ["low", "moderate", "high", "unknown"]).default("unknown").notNull(),
  harmAssessmentJson: text("harmAssessmentJson"),
  notificationDecision: mysqlEnum("notificationDecision", ["pending", "not_required", "required", "uncertain"]).default("pending").notNull(),
  decisionReason: text("decisionReason"),
  assessedByUserId: int("assessedByUserId"),
  assessedAt: timestamp("assessedAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ no: uniqueIndex("privacyBreachAssessments_no_unique").on(t.securityIncidentId, t.assessmentNo) }));
export const incidentNotificationObligations = mysqlTable("incidentNotificationObligations", {
  id: int("id").autoincrement().primaryKey(),
  securityIncidentId: int("securityIncidentId").notNull(),
  assessmentId: int("assessmentId"),
  recipientType: mysqlEnum("recipientType", ["commissioner", "individuals", "customer_organization", "law_enforcement", "insurer", "vendor", "other"]).notNull(),
  recipientRef: varchar("recipientRef", { length: 220 }),
  basis: varchar("basis", { length: 300 }).notNull(),
  dueAt: timestamp("dueAt"),
  state: mysqlEnum("state", ["required", "sent", "not_required", "withdrawn"]).default("required").notNull(),
  sentAt: timestamp("sentAt"),
  sentByUserId: int("sentByUserId"),
  evidenceRecordId: int("evidenceRecordId"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ openIdx: index("incidentNotificationObligations_open_idx").on(t.state, t.dueAt) }));

/** 0127/0128 — B28 widget dashboards (renumbered from the engine's 0089/0090). */
export const widgetLayouts = mysqlTable("widgetLayouts", {
  id: int("id").autoincrement().primaryKey(),
  layoutRef: varchar("layoutRef", { length: 64 }).notNull(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  userId: int("userId").notNull(),
  roleKey: varchar("roleKey", { length: 64 }).notNull(),
  deviceClass: mysqlEnum("deviceClass", ["phone", "tablet", "desktop"]).default("phone").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  createdByUserId: int("createdByUserId").notNull(),
  revision: int("revision").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({ owner: index("widgetLayouts_owner").on(t.orgRef, t.userId, t.roleKey, t.deviceClass), ownerRef: uniqueIndex("widgetLayouts_owner_ref").on(t.orgRef, t.userId, t.layoutRef) }));
export const widgetLayoutItems = mysqlTable("widgetLayoutItems", {
  id: int("id").autoincrement().primaryKey(),
  layoutId: int("layoutId").notNull(),
  instanceRef: varchar("instanceRef", { length: 64 }).notNull(),
  widgetKey: varchar("widgetKey", { length: 64 }).notNull(),
  variant: varchar("variant", { length: 32 }).notNull(),
  subjectRef: varchar("subjectRef", { length: 120 }),
  position: int("position").notNull(),
  spanColumns: int("spanColumns").default(1).notNull(),
  spanRows: int("spanRows").default(1).notNull(),
  options: json("options"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({ layout: index("widgetLayoutItems_layout").on(t.layoutId, t.position), layoutInstance: uniqueIndex("widgetLayoutItems_layout_instance").on(t.layoutId, t.instanceRef) }));

/** 0125 — paper assessment-sheet registry (Chat 5 PENDING-2/3). */
export const sheetSerialSequences = mysqlTable("sheetSerialSequences", {
  scope: varchar("scope", { length: 120 }).primaryKey(),
  nextValue: bigint("nextValue", { mode: "number" }).default(1).notNull(),
});
export const sheetSerialAllocations = mysqlTable("sheetSerialAllocations", {
  id: int("id").autoincrement().primaryKey(),
  allocationRef: varchar("allocationRef", { length: 26 }).notNull(),
  scope: varchar("scope", { length: 120 }).notNull(),
  firstSequence: bigint("firstSequence", { mode: "number" }).notNull(),
  lastSequence: bigint("lastSequence", { mode: "number" }).notNull(),
  count: int("count").notNull(),
  printBatchRef: varchar("printBatchRef", { length: 64 }),
  allocatedByUserId: int("allocatedByUserId").notNull(),
  state: mysqlEnum("state", ["reserved", "printed", "voided"]).default("reserved").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const academyAssessmentSheets = mysqlTable("academyAssessmentSheets", {
  id: int("id").autoincrement().primaryKey(),
  serial: varchar("serial", { length: 40 }).notNull(),
  ticketCode: varchar("ticketCode", { length: 24 }).notNull(),
  courseVersionRef: varchar("courseVersionRef", { length: 96 }).notNull(),
  itemSetRef: varchar("itemSetRef", { length: 96 }).notNull(),
  itemSetReviewStatus: mysqlEnum("itemSetReviewStatus", ["draft", "in_review", "approved", "retired"]).default("draft").notNull(),
  allocationRef: varchar("allocationRef", { length: 26 }).notNull(),
  state: mysqlEnum("state", ["issued", "printed", "returned", "transcribed", "void"]).default("issued").notNull(),
  voidedReason: varchar("voidedReason", { length: 300 }),
  courseVersionSupersededAt: timestamp("courseVersionSupersededAt"),
  transcribedAt: timestamp("transcribedAt"),
  transcribedByUserId: int("transcribedByUserId"),
  transcriptionRef: varchar("transcriptionRef", { length: 96 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const academyInspectorRequests = mysqlTable("academyInspectorRequests", {
  id: int("id").autoincrement().primaryKey(),
  requestRef: varchar("requestRef", { length: 64 }).notNull().unique(),
  inspectorName: varchar("inspectorName", { length: 220 }),
  issuingAuthority: varchar("issuingAuthority", { length: 220 }).notNull(),
  authorityFileRef: varchar("authorityFileRef", { length: 120 }),
  requestDatedAt: timestamp("requestDatedAt").notNull(),
  requestReceivedAt: timestamp("requestReceivedAt"),
  /** Computed at intake and stored, so the deadline is auditable. */
  dueAt: timestamp("dueAt").notNull(),
  subjectUserId: int("subjectUserId").notNull(),
  certificateId: int("certificateId").notNull(),
  state: mysqlEnum("state", ["received", "assembling", "produced", "incomplete", "withdrawn"]).default("received").notNull(),
  producedAt: timestamp("producedAt"),
  producedByUserId: int("producedByUserId"),
  /** What was handed over, so it can be shown again unchanged. */
  packageHash: varchar("packageHash", { length: 64 }),
  packagePartsJson: text("packagePartsJson"),
  missingPartsJson: text("missingPartsJson"),
  irrecoverable: boolean("irrecoverable").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type AcademyInspectorRequestRow = typeof academyInspectorRequests.$inferSelect;

// ---------------------------------------------------------------------------
// 0133 — P7.1 Commercial Office configuration. bookOrgRef NULL = the platform
// default (the owner's 2026-09-17 decisions); a value = one business's own
// answer, which wins for that business. Every row carries its source.
// ---------------------------------------------------------------------------
export const commercialRoleTypes = mysqlTable("commercialRoleTypes", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  roleKey: varchar("roleKey", { length: 40 }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  builtIn: boolean("builtIn").default(false).notNull(),
  status: mysqlEnum("status", ["active", "retired"]).default("active").notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const organizationCommercialRoles = mysqlTable("organizationCommercialRoles", {
  id: int("id").autoincrement().primaryKey(),
  roleRef: varchar("roleRef", { length: 40 }).notNull().unique(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  roleKey: varchar("roleKey", { length: 40 }).notNull(),
  commercialNumber: varchar("commercialNumber", { length: 40 }),
  status: mysqlEnum("status", ["active", "suspended", "ended"]).default("active").notNull(),
  effectiveFrom: date("effectiveFrom", { mode: "string" }).notNull(),
  effectiveTo: date("effectiveTo", { mode: "string" }),
  note: varchar("note", { length: 500 }),
  assignedByUserId: int("assignedByUserId").notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  endedByUserId: int("endedByUserId"),
  endedAt: timestamp("endedAt"),
});
export const commercialNumberingPolicies = mysqlTable("commercialNumberingPolicies", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  sequenceType: varchar("sequenceType", { length: 24 }).notNull(),
  prefix: varchar("prefix", { length: 12 }).notNull(),
  separator: varchar("separator", { length: 3 }).default("-").notNull(),
  yearDigits: tinyint("yearDigits").default(4).notNull(),
  includeMonth: boolean("includeMonth").default(false).notNull(),
  sequenceDigits: tinyint("sequenceDigits").default(6).notNull(),
  resetPeriod: mysqlEnum("resetPeriod", ["never", "yearly", "monthly"]).default("yearly").notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export const commercialSettings = mysqlTable("commercialSettings", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  accountingTarget: mysqlEnum("accountingTarget", ["none", "quickbooks_online", "sage", "xero", "custom"]).default("quickbooks_online").notNull(),
  accountingTargetLabel: varchar("accountingTargetLabel", { length: 120 }),
  source: varchar("source", { length: 160 }).notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export const commercialApprovalPolicies = mysqlTable("commercialApprovalPolicies", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  category: varchar("category", { length: 40 }).notNull(),
  maxAmountCents: bigint("maxAmountCents", { mode: "number" }),
  approverRole: varchar("approverRole", { length: 40 }).notNull(),
  secondPersonRequired: boolean("secondPersonRequired").default(false).notNull(),
  separationOfDuties: boolean("separationOfDuties").default(true).notNull(),
  status: mysqlEnum("status", ["active", "retired"]).default("active").notNull(),
  source: varchar("source", { length: 200 }).notNull(),
  effectiveFrom: date("effectiveFrom", { mode: "string" }).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const commercialCategoryTypes = mysqlTable("commercialCategoryTypes", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  kind: mysqlEnum("kind", ["document_type", "load_category", "profitability_dimension"]).notNull(),
  categoryKey: varchar("categoryKey", { length: 40 }).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  builtIn: boolean("builtIn").default(false).notNull(),
  status: mysqlEnum("status", ["active", "retired"]).default("active").notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const organizationRecordLinks = mysqlTable("organizationRecordLinks", {
  id: int("id").autoincrement().primaryKey(),
  linkRef: varchar("linkRef", { length: 40 }).notNull().unique(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  recordType: mysqlEnum("recordType", ["vendor", "facility", "job_customer", "customer_account"]).notNull(),
  recordId: int("recordId").notNull(),
  roleKeyRequired: varchar("roleKeyRequired", { length: 40 }).notNull(),
  status: mysqlEnum("status", ["active", "ended"]).default("active").notNull(),
  note: varchar("note", { length: 500 }),
  linkedByUserId: int("linkedByUserId").notNull(),
  linkedAt: timestamp("linkedAt").defaultNow().notNull(),
  endedByUserId: int("endedByUserId"),
  endedAt: timestamp("endedAt"),
  endReason: varchar("endReason", { length: 500 }),
});

// 0135 — P7.3 disposal reconciliation: a facility's statement as evidence, matched line by line.
export const facilityStatements = mysqlTable("facilityStatements", {
  id: int("id").autoincrement().primaryKey(),
  statementRef: varchar("statementRef", { length: 40 }).notNull().unique(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  facilityId: int("facilityId").notNull(),
  facilityOrgRef: varchar("facilityOrgRef", { length: 64 }),
  facilityStatementNumber: varchar("facilityStatementNumber", { length: 80 }),
  periodStart: date("periodStart", { mode: "string" }).notNull(),
  periodEnd: date("periodEnd", { mode: "string" }).notNull(),
  lineCount: int("lineCount").default(0).notNull(),
  matchedCount: int("matchedCount").default(0).notNull(),
  varianceCount: int("varianceCount").default(0).notNull(),
  unmatchedCount: int("unmatchedCount").default(0).notNull(),
  ambiguousCount: int("ambiguousCount").default(0).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  status: mysqlEnum("status", ["open", "closed"]).default("open").notNull(),
  importedByUserId: int("importedByUserId").notNull(),
  importedAt: timestamp("importedAt").defaultNow().notNull(),
  closedByUserId: int("closedByUserId"),
  closedAt: timestamp("closedAt"),
});
export const facilityStatementLines = mysqlTable("facilityStatementLines", {
  id: int("id").autoincrement().primaryKey(),
  facilityStatementId: int("facilityStatementId").notNull(),
  lineNo: int("lineNo").notNull(),
  facilityTicketNumber: varchar("facilityTicketNumber", { length: 80 }),
  receivedAt: timestamp("receivedAt").notNull(),
  material: varchar("material", { length: 120 }),
  quantity: double("quantity").notNull(),
  quantityUnit: varchar("quantityUnit", { length: 16 }).notNull(),
  amountCents: int("amountCents"),
  unitHint: varchar("unitHint", { length: 40 }),
  manifestHint: varchar("manifestHint", { length: 60 }),
  matchedDisposalTicketId: int("matchedDisposalTicketId"),
  matchOutcome: mysqlEnum("matchOutcome", ["match", "match_with_variance", "unmatched", "ambiguous"]).notNull(),
  matchReason: varchar("matchReason", { length: 300 }).notNull(),
  variances: json("variances").$type<string[]>(),
  candidateTicketIds: json("candidateTicketIds").$type<number[]>(),
  resolution: mysqlEnum("resolution", ["accepted", "ticket_needs_correction", "facility_error", "disputed"]),
  resolutionNote: varchar("resolutionNote", { length: 500 }),
  resolvedByUserId: int("resolvedByUserId"),
  resolvedAt: timestamp("resolvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// 0136 — P7.4 approval ledger: the requirement at the time, and each person's approval in order.
export const commercialApprovals = mysqlTable("commercialApprovals", {
  id: int("id").autoincrement().primaryKey(),
  approvalRef: varchar("approvalRef", { length: 40 }).notNull().unique(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  category: varchar("category", { length: 40 }).notNull(),
  subjectType: varchar("subjectType", { length: 40 }).notNull(),
  subjectRef: varchar("subjectRef", { length: 64 }).notNull(),
  amountCents: bigint("amountCents", { mode: "number" }).notNull(),
  preparedByUserId: int("preparedByUserId"),
  requirement: json("requirement").notNull(),
  status: mysqlEnum("status", ["awaiting", "satisfied", "refused", "review"]).default("awaiting").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  satisfiedAt: timestamp("satisfiedAt"),
});
export const commercialApprovalSignatures = mysqlTable("commercialApprovalSignatures", {
  id: int("id").autoincrement().primaryKey(),
  commercialApprovalId: int("commercialApprovalId").notNull(),
  sequence: int("sequence").notNull(),
  userId: int("userId").notNull(),
  rolesAtApproval: json("rolesAtApproval").$type<string[]>().notNull(),
  decision: mysqlEnum("decision", ["approved", "refused"]).notNull(),
  note: varchar("note", { length: 500 }),
  at: timestamp("at").defaultNow().notNull(),
});

// 0138 — P7.6 GL mapping as per-business configuration; nothing seeded.
export const commercialGlAccounts = mysqlTable("commercialGlAccounts", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  code: varchar("code", { length: 32 }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  kind: mysqlEnum("kind", ["revenue", "cost_of_sales", "expense", "asset", "liability", "equity", "tax"]).notNull(),
  status: mysqlEnum("status", ["active", "retired"]).default("active").notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const commercialGlMappings = mysqlTable("commercialGlMappings", {
  id: int("id").autoincrement().primaryKey(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  mappingKind: mysqlEnum("mappingKind", ["service_code", "coding_category", "gst_output", "gst_input"]).notNull(),
  mappingKey: varchar("mappingKey", { length: 80 }).notNull(),
  glAccountCode: varchar("glAccountCode", { length: 32 }).notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// 0139 — facility directory child tables and the licence register.
export const facilitySourceLicences = mysqlTable("facilitySourceLicences", {
  id: int("id").autoincrement().primaryKey(),
  licenceKey: varchar("licenceKey", { length: 40 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  publisher: varchar("publisher", { length: 160 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 1024 }).notNull(),
  cachePermitted: boolean("cachePermitted").notNull(),
  commercialUsePermitted: boolean("commercialUsePermitted").notNull(),
  attributionText: varchar("attributionText", { length: 300 }),
  notes: varchar("notes", { length: 1000 }),
  retrievedAt: date("retrievedAt", { mode: "string" }).notNull(),
  status: mysqlEnum("status", ["confirmed", "unconfirmed", "permission_required"]).notNull(),
});
export const facilityCapabilities = mysqlTable("facilityCapabilities", {
  id: int("id").autoincrement().primaryKey(),
  facilityId: int("facilityId").notNull(),
  wasteCode: varchar("wasteCode", { length: 60 }).notNull(),
  handlingMethod: varchar("handlingMethod", { length: 100 }),
  acceptanceStatus: mysqlEnum("acceptanceStatus", ["verified", "confirmation_required", "not_accepted", "unknown"]).default("unknown").notNull(),
  conditions: text("conditions"),
  evidenceId: int("evidenceId"),
  verifiedAt: timestamp("verifiedAt"),
  expiresAt: timestamp("expiresAt"),
  setByUserId: int("setByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const facilityEvidence = mysqlTable("facilityEvidence", {
  id: int("id").autoincrement().primaryKey(),
  facilityId: int("facilityId").notNull(),
  publisher: varchar("publisher", { length: 220 }).notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  sourceUrl: varchar("sourceUrl", { length: 1024 }).notNull(),
  licenceKey: varchar("licenceKey", { length: 40 }).notNull(),
  claimType: varchar("claimType", { length: 80 }).notNull(),
  claimValue: text("claimValue"),
  cachedContent: boolean("cachedContent").default(false).notNull(),
  retrievedAt: timestamp("retrievedAt").notNull(),
  effectiveAt: timestamp("effectiveAt"),
  expiresAt: timestamp("expiresAt"),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"]).default("low").notNull(),
  reviewState: mysqlEnum("reviewState", ["lead", "reviewed", "rejected", "conflicting"]).default("lead").notNull(),
  reviewedByUserId: int("reviewedByUserId"),
  reviewedAt: timestamp("reviewedAt"),
  reviewNote: varchar("reviewNote", { length: 500 }),
  recordedByUserId: int("recordedByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const facilityAliases = mysqlTable("facilityAliases", {
  id: int("id").autoincrement().primaryKey(),
  facilityId: int("facilityId").notNull(),
  alias: varchar("alias", { length: 220 }).notNull(),
  relationship: varchar("relationship", { length: 80 }),
  sourceUrl: varchar("sourceUrl", { length: 1024 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const loadFacilityAssessments = mysqlTable("loadFacilityAssessments", {
  id: int("id").autoincrement().primaryKey(),
  assessmentRef: varchar("assessmentRef", { length: 40 }).notNull().unique(),
  loadId: int("loadId").notNull(),
  facilityId: int("facilityId").notNull(),
  outcome: mysqlEnum("outcome", ["compatible_verified", "facility_confirmation_required", "incompatible", "insufficient_information"]).notNull(),
  blocking: boolean("blocking").notNull(),
  reasonCodes: json("reasonCodes").$type<string[]>().notNull(),
  evidenceIds: json("evidenceIds").$type<number[]>().notNull(),
  inputSnapshot: json("inputSnapshot").notNull(),
  engineVersion: varchar("engineVersion", { length: 60 }).notNull(),
  assessedAt: timestamp("assessedAt").defaultNow().notNull(),
  assessedByUserId: int("assessedByUserId").notNull(),
});
export const wasteStreamVocabulary = mysqlTable("wasteStreamVocabulary", {
  id: int("id").autoincrement().primaryKey(),
  internalCode: varchar("internalCode", { length: 60 }).notNull().unique(),
  label: varchar("label", { length: 120 }).notNull(),
  aerWasteCode: varchar("aerWasteCode", { length: 120 }),
  albertaWcrClass: varchar("albertaWcrClass", { length: 60 }),
  sourceUrl: varchar("sourceUrl", { length: 1024 }),
  sourceVersion: varchar("sourceVersion", { length: 240 }),
  verificationStatus: mysqlEnum("verificationStatus", ["candidate", "verified", "not_applicable"]).default("candidate").notNull(),
  verifiedByUserId: int("verifiedByUserId"),
  verifiedAt: timestamp("verifiedAt"),
  verificationNote: varchar("verificationNote", { length: 500 }),
});

// 0140 — the driver-facing half of the facility directory.
export const facilityOperatingHours = mysqlTable("facilityOperatingHours", {
  id: int("id").autoincrement().primaryKey(),
  facilityId: int("facilityId").notNull(),
  dayOfWeek: tinyint("dayOfWeek").notNull(),
  opensAt: varchar("opensAt", { length: 5 }),
  closesAt: varchar("closesAt", { length: 5 }),
  closed: boolean("closed").default(false).notNull(),
  note: varchar("note", { length: 300 }),
  source: mysqlEnum("source", ["facility_stated", "website", "regulator", "driver_reported", "unknown"]).default("unknown").notNull(),
  evidenceId: int("evidenceId"),
  statedAt: timestamp("statedAt").notNull(),
  setByUserId: int("setByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const facilityCallAheads = mysqlTable("facilityCallAheads", {
  id: int("id").autoincrement().primaryKey(),
  callAheadRef: varchar("callAheadRef", { length: 40 }).notNull().unique(),
  facilityId: int("facilityId").notNull(),
  loadId: int("loadId"),
  wasteCode: varchar("wasteCode", { length: 60 }),
  calledByUserId: int("calledByUserId").notNull(),
  calledAt: timestamp("calledAt").notNull(),
  phoneUsed: varchar("phoneUsed", { length: 60 }),
  spokeTo: varchar("spokeTo", { length: 160 }),
  outcome: mysqlEnum("outcome", ["accepted", "accepted_with_conditions", "refused", "no_answer", "call_back"]).notNull(),
  conditions: varchar("conditions", { length: 500 }),
  quotedWaitMinutes: int("quotedWaitMinutes"),
  validUntil: timestamp("validUntil"),
  note: varchar("note", { length: 500 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export const facilityWaitReports = mysqlTable("facilityWaitReports", {
  id: int("id").autoincrement().primaryKey(),
  facilityId: int("facilityId").notNull(),
  reportedByUserId: int("reportedByUserId").notNull(),
  reportedAt: timestamp("reportedAt").notNull(),
  waitMinutes: int("waitMinutes").notNull(),
  trucksInQueue: int("trucksInQueue"),
  source: mysqlEnum("source", ["driver_observed", "facility_stated", "dispatcher_relayed"]).notNull(),
  note: varchar("note", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// 0143 — regulator-layer import runs: the layer, the licence, the mapping a person chose, the counts.
export const facilityImportRuns = mysqlTable("facilityImportRuns", {
  id: int("id").autoincrement().primaryKey(),
  importRef: varchar("importRef", { length: 40 }).notNull().unique(),
  source: varchar("source", { length: 40 }).notNull(),
  layerUrl: varchar("layerUrl", { length: 1024 }).notNull(),
  licenceKey: varchar("licenceKey", { length: 40 }).notNull(),
  fieldMapping: json("fieldMapping").notNull(),
  wkid: int("wkid"),
  featureCount: int("featureCount").default(0).notNull(),
  inserted: int("inserted").default(0).notNull(),
  updated: int("updated").default(0).notNull(),
  skipped: int("skipped").default(0).notNull(),
  skipReasons: json("skipReasons").$type<string[]>(),
  startedByUserId: int("startedByUserId").notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  note: varchar("note", { length: 500 }),
});

// 0144 — P7.7 commercial document registry, over the records vault.
export const commercialDocuments = mysqlTable("commercialDocuments", {
  id: int("id").autoincrement().primaryKey(),
  documentRef: varchar("documentRef", { length: 40 }).notNull().unique(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  documentType: varchar("documentType", { length: 40 }).notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  version: int("version").default(1).notNull(),
  supersedesDocumentId: int("supersedesDocumentId"),
  supersededByDocumentId: int("supersededByDocumentId"),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  sourceSnapshotHash: varchar("sourceSnapshotHash", { length: 64 }),
  byteLength: int("byteLength"),
  mimeType: varchar("mimeType", { length: 120 }),
  evidenceRecordId: int("evidenceRecordId"),
  fieldTicketDocumentId: int("fieldTicketDocumentId"),
  storageKey: varchar("storageKey", { length: 512 }),
  counterpartyOrgRef: varchar("counterpartyOrgRef", { length: 64 }),
  issuedAt: timestamp("issuedAt"),
  retentionPolicyId: int("retentionPolicyId"),
  retentionClass: varchar("retentionClass", { length: 80 }),
  retentionAssignedByUserId: int("retentionAssignedByUserId"),
  status: mysqlEnum("status", ["current", "superseded", "withdrawn"]).default("current").notNull(),
  statusReason: varchar("statusReason", { length: 500 }),
  registeredByUserId: int("registeredByUserId").notNull(),
  registeredAt: timestamp("registeredAt").defaultNow().notNull(),
  // DC-B (0195) — provenance and lifecycle. NULL originKind = registered before Document Control
  // kept provenance ("unrecorded"), never a guess. `bookScopeKey` = COALESCE(bookOrgRef,'default')
  // so the control-number unique index can see the single tenant.
  bookScopeKey: varchar("bookScopeKey", { length: 64 }).default("default").notNull(),
  definitionRef: varchar("definitionRef", { length: 64 }),
  definitionKey: varchar("definitionKey", { length: 40 }),
  originKind: mysqlEnum("originKind", ["leaseos_generated", "organization_template", "customer_template", "external_form_rendered", "system_rendered", "external_scanned", "external_digital_import", "reference_document"]),
  issuerKind: mysqlEnum("issuerKind", ["tenant", "customer", "facility", "vendor", "regulator", "government_authority", "manufacturer", "other_third_party", "unknown"]),
  issuerOrgRef: varchar("issuerOrgRef", { length: 64 }),
  issuerFacilityId: int("issuerFacilityId"),
  issuerName: varchar("issuerName", { length: 220 }),
  /** The LeaseOS business number, when the definition's policy mints one or the owning domain did. NULL for every externally issued document. */
  controlNumber: varchar("controlNumber", { length: 64 }),
  controlNumberIssuedAt: timestamp("controlNumberIssuedAt"),
  controlState: mysqlEnum("controlState", ["captured", "needs_classification", "proposed", "confirmed", "issued", "void", "withdrawn"]).default("confirmed").notNull(),
  templateRevisionRef: varchar("templateRevisionRef", { length: 64 }),
  renderManifestHash: varchar("renderManifestHash", { length: 64 }),
  capturedByUserId: int("capturedByUserId"),
  capturedByDeviceRef: varchar("capturedByDeviceRef", { length: 64 }),
  importChannel: mysqlEnum("importChannel", ["device_sync", "office_upload", "portal", "api", "email", "system"]),
  confirmedByUserId: int("confirmedByUserId"),
  confirmedAt: timestamp("confirmedAt"),
  issuedByUserId: int("issuedByUserId"),
  voidedByUserId: int("voidedByUserId"),
  voidedAt: timestamp("voidedAt"),
  voidReason: varchar("voidReason", { length: 500 }),
}, (t) => ({ controlNumber: uniqueIndex("commercialDocuments_control_number").on(t.bookScopeKey, t.controlNumber), state: index("commercialDocuments_state").on(t.bookScopeKey, t.controlState, t.originKind) }));
export const commercialDocumentLinks = mysqlTable("commercialDocumentLinks", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull(),
  recordType: varchar("recordType", { length: 40 }).notNull(),
  recordRef: varchar("recordRef", { length: 80 }).notNull(),
  linkedByUserId: int("linkedByUserId").notNull(),
  linkedAt: timestamp("linkedAt").defaultNow().notNull(),
  // DC-B (0195) — the id beside the ref, the role the record plays, and whether a person or a domain said so.
  recordId: int("recordId"),
  role: varchar("role", { length: 40 }),
  source: mysqlEnum("source", ["human", "domain", "ocr_proposed"]).default("human").notNull(),
  confirmationStatus: mysqlEnum("confirmationStatus", ["proposed", "confirmed"]).default("confirmed").notNull(),
  linkedByDeviceRef: varchar("linkedByDeviceRef", { length: 64 }),
}, (t) => ({ recordId: index("commercialDocumentLinks_record_id").on(t.recordType, t.recordId) }));
export const commercialDocumentDeliveries = mysqlTable("commercialDocumentDeliveries", {
  id: int("id").autoincrement().primaryKey(),
  deliveryRef: varchar("deliveryRef", { length: 40 }).notNull().unique(),
  documentId: int("documentId").notNull(),
  channel: mysqlEnum("channel", ["email", "portal", "print", "api", "courier", "other"]).notNull(),
  recipientOrgRef: varchar("recipientOrgRef", { length: 64 }),
  recipientAddress: varchar("recipientAddress", { length: 300 }),
  status: mysqlEnum("status", ["queued", "sent", "delivered", "failed", "bounced", "acknowledged"]).default("queued").notNull(),
  sentAt: timestamp("sentAt"),
  sentByUserId: int("sentByUserId"),
  deliveredAt: timestamp("deliveredAt"),
  deliveryEvidence: varchar("deliveryEvidence", { length: 300 }),
  failureReason: varchar("failureReason", { length: 500 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** P8.2 (0153) — whether a capability is available to a tenant at all. An ABSENT row is unresolved, not "not entitled". */
export const capabilityEntitlements = mysqlTable("capabilityEntitlements", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  capability: varchar("capability", { length: 64 }).notNull(),
  state: mysqlEnum("state", ["entitled", "not_entitled"]).notNull(),
  reason: mysqlEnum("reason", ["unlicensed", "disabled", "not_in_product_set"]),
  reference: varchar("reference", { length: 128 }),
  effectiveFrom: timestamp("effectiveFrom").notNull().defaultNow(),
  supersededAt: timestamp("supersededAt"),
  setByUserId: int("setByUserId"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** P8.2 (0153) — automation policy, append-only with supersession. An UPDATE would erase the answer to "what mode were we in". */
export const automationPolicies = mysqlTable("automationPolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyVersionId: varchar("policyVersionId", { length: 64 }).notNull(),
  orgRef: varchar("orgRef", { length: 64 }),
  capability: varchar("capability", { length: 64 }).notNull(),
  scope: mysqlEnum("scope", ["tenant", "role", "task", "customer"]).notNull(),
  scopeId: varchar("scopeId", { length: 64 }),
  requestedMode: mysqlEnum("requestedMode", ["AUTO", "HYBRID", "MANUAL"]).notNull(),
  safetyCeilingApplied: mysqlEnum("safetyCeilingApplied", ["AUTO", "HYBRID", "MANUAL"]),
  source: varchar("source", { length: 64 }).notNull(),
  reason: varchar("reason", { length: 500 }),
  actorUserId: int("actorUserId"),
  effectiveFrom: timestamp("effectiveFrom").notNull().defaultNow(),
  supersededAt: timestamp("supersededAt"),
  supersededByVersionId: varchar("supersededByVersionId", { length: 64 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** P8.3 (0155) — a person's statement about a driver's hours when there is no live figure. Stated, never computed. */
export const hosAttestations = mysqlTable("hosAttestations", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  operatorId: int("operatorId").notNull(),
  dutyDate: date("dutyDate").notNull(),
  method: mysqlEnum("method", ["paper_log_reviewed", "driver_declaration"]).notNull(),
  statement: varchar("statement", { length: 500 }).notNull(),
  /** The person's figure, when they gave one. NEVER copied into hoursAvailableMinutes. */
  hoursAvailableMinutesStated: int("hoursAvailableMinutesStated"),
  attestedByUserId: int("attestedByUserId").notNull(),
  attestedAt: timestamp("attestedAt").notNull().defaultNow(),
  supersededAt: timestamp("supersededAt"),
  supersededByAttestationId: int("supersededByAttestationId"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/* ---- P8.5 (0156) — the restricted records vault ---- */

/** The fan-out spine. Derived matters reference the incident root; they never copy its facts. */
export const incidentMatters = mysqlTable("incidentMatters", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  incidentReportId: int("incidentReportId").notNull(),
  matterType: mysqlEnum("matterType", ["INSURANCE_CLAIM", "WCB_CLAIM", "REGULATORY_REPORT", "POLICE_FILE", "CLIENT_NOTICE", "THIRD_PARTY_CLAIM", "INTERNAL_INVESTIGATION", "LITIGATION"]).notNull(),
  /** Book 17 PRV-CLS-001. Stored, never inferred at read time. */
  sensitivityTier: mysqlEnum("sensitivityTier", ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"]).notNull(),
  /** Category-neutral: a number that spells out the category leaks it to anyone who sees it. */
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull(),
  status: mysqlEnum("status", ["PROPOSED", "OPEN", "SUBMITTED", "IN_REVIEW", "CLOSED", "DECLINED", "UNKNOWN"]).notNull().default("PROPOSED"),
  openedAt: timestamp("openedAt"),
  closedAt: timestamp("closedAt"),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** A proposal is raised by a rule and decided by a person. Declining creates no investigation. */
export const investigationProposals = mysqlTable("investigationProposals", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  incidentReportId: int("incidentReportId").notNull(),
  triggerRule: varchar("triggerRule", { length: 80 }).notNull(),
  triggerPolicy: varchar("triggerPolicy", { length: 80 }),
  proposedAt: timestamp("proposedAt").notNull().defaultNow(),
  disposition: mysqlEnum("disposition", ["PENDING", "OPENED", "HANDLED_INTERNALLY", "NOT_WARRANTED", "DEFERRED"]).notNull().default("PENDING"),
  decidedByUserId: int("decidedByUserId"),
  decidedByRole: varchar("decidedByRole", { length: 40 }),
  decidedAt: timestamp("decidedAt"),
  decisionReason: varchar("decisionReason", { length: 500 }),
  matterId: int("matterId"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** Record-scoped, time-limited, non-transferable. A grant opens one record, not the vault. */
export const restrictedAccessGrants = mysqlTable("restrictedAccessGrants", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  userId: int("userId").notNull(),
  recordType: varchar("recordType", { length: 40 }).notNull(),
  recordId: int("recordId").notNull(),
  purpose: varchar("purpose", { length: 500 }).notNull(),
  grantedAt: timestamp("grantedAt").notNull().defaultNow(),
  expiresAt: timestamp("expiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
  revokedByUserId: int("revokedByUserId"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/** Written BEFORE content is served. If this write fails, access fails. */
export const restrictedAccessEvents = mysqlTable("restrictedAccessEvents", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  grantId: int("grantId"),
  userId: int("userId").notNull(),
  recordType: varchar("recordType", { length: 40 }).notNull(),
  recordId: int("recordId").notNull(),
  action: mysqlEnum("action", ["READ", "EXPORT", "PRINT", "GRANT_CREATED", "GRANT_REVOKED", "DENIED"]).notNull(),
  purpose: varchar("purpose", { length: 500 }),
  decisionCode: varchar("decisionCode", { length: 60 }),
  decisionReason: varchar("decisionReason", { length: 500 }),
  occurredAt: timestamp("occurredAt").notNull().defaultNow(),
});

/** P4.6 (0160) — the record that a worker was told what is collected about them. Absence means not notified. */
export const monitoringNotices = mysqlTable("monitoringNotices", {
  id: int("id").autoincrement().primaryKey(),
  orgRef: varchar("orgRef", { length: 64 }),
  subjectUserId: int("subjectUserId").notNull(),
  purpose: mysqlEnum("purpose", ["vehicle_location", "driver_duty_hours", "in_cab_camera", "device_telemetry", "app_usage", "biometric_device_unlock"]).notNull(),
  noticeVersion: varchar("noticeVersion", { length: 40 }).notNull(),
  /** A notice nobody can reproduce proves nothing. */
  noticeTextHash: varchar("noticeTextHash", { length: 128 }).notNull(),
  issuedAt: timestamp("issuedAt").notNull().defaultNow(),
  issuedByUserId: int("issuedByUserId").notNull(),
  /** Null until the person acknowledges. Issued and unacknowledged is a real state, not an error. */
  acknowledgedAt: timestamp("acknowledgedAt"),
  acknowledgementMethod: mysqlEnum("acknowledgementMethod", ["in_app", "signed_document", "verbal_witnessed"]),
  acknowledgementEvidenceRecordId: int("acknowledgementEvidenceRecordId"),
  supersededAt: timestamp("supersededAt"),
  supersededByNoticeId: int("supersededByNoticeId"),
  withdrawnAt: timestamp("withdrawnAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

/**
 * 0162 (P3.1) — overriding a manifest reference-versus-print contradiction. Append-only: both
 * conflicting facts are recorded and neither is changed, and a withdrawal is a second row.
 */
export const manifestReconciliationOverrides = mysqlTable("manifestReconciliationOverrides", {
  id: int("id").autoincrement().primaryKey(),
  overrideRef: varchar("overrideRef", { length: 64 }).notNull().unique(),
  manifestId: int("manifestId").notNull(),
  manifestRevisionHash: varchar("manifestRevisionHash", { length: 128 }),
  amendmentCountAtOverride: int("amendmentCountAtOverride").notNull().default(0),
  factKey: varchar("factKey", { length: 40 }).notNull(),
  canonicalValue: varchar("canonicalValue", { length: 300 }),
  printedValue: varchar("printedValue", { length: 300 }),
  referenceId: int("referenceId"),
  requestedByUserId: int("requestedByUserId").notNull(),
  authorizedByUserId: int("authorizedByUserId").notNull(),
  authorityRole: varchar("authorityRole", { length: 80 }).notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  state: mysqlEnum("state", ["granted", "withdrawn"]).default("granted").notNull(),
  supersedesOverrideId: int("supersedesOverrideId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 0163 (P4.2): an immutable record of one calibration sweep. Written once; a second look is a second sweep. */
export const calibrationSweeps = mysqlTable("calibrationSweeps", {
  id: int("id").autoincrement().primaryKey(),
  sweepRef: varchar("sweepRef", { length: 64 }).notNull().unique(),
  measurementDeviceId: int("measurementDeviceId").notNull(),
  calibrationEventId: int("calibrationEventId").notNull(),
  suspectFrom: timestamp("suspectFrom").notNull(),
  suspectTo: timestamp("suspectTo").notNull(),
  eventType: varchar("eventType", { length: 40 }).notNull(),
  errorFound: varchar("errorFound", { length: 300 }),
  determinationsInQuestion: int("determinationsInQuestion").default(0).notNull(),
  measurementsInQuestion: int("measurementsInQuestion").default(0).notNull(),
  explanation: varchar("explanation", { length: 1000 }).notNull(),
  runByUserId: int("runByUserId").notNull(),
  runAt: timestamp("runAt").defaultNow().notNull(),
  state: mysqlEnum("state", ["open", "triaged"]).default("open").notNull(),
  triagedByUserId: int("triagedByUserId"),
  triagedAt: timestamp("triagedAt"),
  triageNote: varchar("triageNote", { length: 1000 }),
});

/** 0163: one reading inside the window, recorded as it stood — never re-derived later. */
export const calibrationSweepFindings = mysqlTable("calibrationSweepFindings", {
  id: int("id").autoincrement().primaryKey(),
  sweepId: int("sweepId").notNull(),
  snapshotId: int("snapshotId").notNull(),
  snapshotRef: varchar("snapshotRef", { length: 64 }).notNull(),
  measuredAt: timestamp("measuredAt").notNull(),
  loadId: int("loadId"),
  wasLegalDetermination: boolean("wasLegalDetermination").notNull(),
  determinationBasis: varchar("determinationBasis", { length: 500 }),
});

/* ==================================================================
 * DC-A (0178) — Document Control: the definition registry and the
 * catalog's provenance. A definition says how a class of controlled record
 * behaves; it is not the document and not the template. Vocabularies are
 * mirrored in server/_core/documentDefinitions.ts and held in step by test.
 * ================================================================== */

export const documentDefinitions = mysqlTable("documentDefinitions", {
  id: int("id").autoincrement().primaryKey(),
  definitionRef: varchar("definitionRef", { length: 64 }).notNull().unique(),
  /** NULL = platform-provided; a tenant row with the same key is an overlay of the columns it may change. */
  orgRef: varchar("orgRef", { length: 64 }),
  /** COALESCE(orgRef, 'platform'), maintained by the write path so the unique index can see NULL tenancy. */
  scopeKey: varchar("scopeKey", { length: 64 }).notNull(),
  definitionKey: varchar("definitionKey", { length: 40 }).notNull(),
  definitionVersion: int("definitionVersion").default(1).notNull(),
  status: mysqlEnum("status", ["draft", "active", "retired"]).default("active").notNull(),
  supersedesDefinitionId: int("supersedesDefinitionId"),
  documentClass: mysqlEnum("documentClass", ["operational_form", "controlled_credential", "financial_commercial", "regulated_record", "reference_document", "incident_evidence", "unclassified"]).notNull(),
  displayName: varchar("displayName", { length: 200 }).notNull(),
  description: text("description"),
  primaryDomainOwner: varchar("primaryDomainOwner", { length: 40 }).notNull(),
  allowedOriginsJson: text("allowedOriginsJson").notNull(),
  numberingPolicy: mysqlEnum("numberingPolicy", ["leaseos_series", "leaseos_series_optional", "domain_managed", "external_only", "archival_only"]).notNull(),
  numberSeriesType: varchar("numberSeriesType", { length: 24 }),
  externalReferencePolicy: mysqlEnum("externalReferencePolicy", ["forbidden", "optional", "required"]).default("optional").notNull(),
  allowedExternalReferenceTypesJson: text("allowedExternalReferenceTypesJson").notNull(),
  leaseosTemplateAvailable: boolean("leaseosTemplateAvailable").default(false).notNull(),
  customTemplateAllowed: boolean("customTemplateAllowed").default(true).notNull(),
  importAllowed: boolean("importAllowed").default(true).notNull(),
  requiredFieldsJson: text("requiredFieldsJson").notNull(),
  optionalFieldsJson: text("optionalFieldsJson").notNull(),
  allowedLinkKindsJson: text("allowedLinkKindsJson").notNull(),
  signaturePolicy: mysqlEnum("signaturePolicy", ["none", "optional", "required_single", "required_multi", "domain_managed"]).default("optional").notNull(),
  revisionPolicy: mysqlEnum("revisionPolicy", ["immutable_supersede", "amend_with_reason", "domain_managed", "reference_versioned"]).default("immutable_supersede").notNull(),
  printPolicy: mysqlEnum("printPolicy", ["not_printable", "printable", "controlled_copy"]).default("printable").notNull(),
  extractionProfileKey: varchar("extractionProfileKey", { length: 40 }),
  /** NULL = UNCONFIGURED: retained indefinitely, never disposition-eligible, surfaced as a finding. No default period is ever applied. */
  retentionPolicyId: int("retentionPolicyId"),
  workflowKey: varchar("workflowKey", { length: 40 }),
  readCategory: varchar("readCategory", { length: 40 }).notNull(),
  sensitivityTier: mysqlEnum("sensitivityTier", ["INTERNAL", "CONFIDENTIAL", "RESTRICTED", "HIGHLY_RESTRICTED"]).default("INTERNAL").notNull(),
  jurisdictionsJson: text("jurisdictionsJson").notNull(),
  jurisdictionPolicy: mysqlEnum("jurisdictionPolicy", ["universal", "configurable_verify_by_jurisdiction"]).default("universal").notNull(),
  regulatoryBasis: mysqlEnum("regulatoryBasis", ["not_inferred_from_template", "verified_source_cited"]).default("not_inferred_from_template").notNull(),
  representationPolicy: mysqlEnum("representationPolicy", ["internal_record", "official_external_record", "attach_official_record_required"]).default("internal_record").notNull(),
  representationNotice: varchar("representationNotice", { length: 300 }),
  industriesJson: text("industriesJson").notNull(),
  packKey: varchar("packKey", { length: 24 }),
  /** The supplied catalog's own key when it differs from ours (an aliased kind), or equals it. */
  sourcePackageKey: varchar("sourcePackageKey", { length: 80 }),
  source: varchar("source", { length: 160 }).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  activatedAt: timestamp("activatedAt"),
  retiredAt: timestamp("retiredAt"),
  retiredByUserId: int("retiredByUserId"),
}, (t) => ({ scopeKeyVersion: uniqueIndex("documentDefinitions_scope_key_version").on(t.scopeKey, t.definitionKey, t.definitionVersion), keyStatus: index("documentDefinitions_key_status").on(t.definitionKey, t.status) }));

/** Every artifact the supplied catalog carried, by SHA-256, with where it came from and which family it belongs to. */
export const documentSourceArtifacts = mysqlTable("documentSourceArtifacts", {
  id: int("id").autoincrement().primaryKey(),
  artifactRef: varchar("artifactRef", { length: 40 }).notNull().unique(),
  sha256: varchar("sha256", { length: 64 }).notNull().unique(),
  sourceCollection: varchar("sourceCollection", { length: 120 }).notNull(),
  sourcePath: varchar("sourcePath", { length: 512 }).notNull(),
  fileName: varchar("fileName", { length: 220 }).notNull(),
  extension: varchar("extension", { length: 10 }).notNull(),
  byteLength: int("byteLength").notNull(),
  role: mysqlEnum("role", ["printable_template", "editable_template_source", "render_template_source", "engine_definition_or_reference", "reference"]).notNull(),
  titleCandidate: varchar("titleCandidate", { length: 220 }),
  templateCodeDetected: varchar("templateCodeDetected", { length: 40 }),
  revisionDetected: varchar("revisionDetected", { length: 20 }),
  pages: int("pages"),
  /** The definition the artifact's family resolves to (after aliasing), when it belongs to one. */
  definitionKey: varchar("definitionKey", { length: 40 }),
  sourcePackageKey: varchar("sourcePackageKey", { length: 80 }),
  variantNo: int("variantNo"),
  /** Where the bytes live in the repository's seed data, when they do; the seeder recomputes the hash from here. */
  repositoryPath: varchar("repositoryPath", { length: 512 }),
  storageKey: varchar("storageKey", { length: 512 }),
  hashVerifiedAt: timestamp("hashVerifiedAt"),
  importBatchRef: varchar("importBatchRef", { length: 40 }).notNull(),
  importedByUserId: int("importedByUserId"),
  importedAt: timestamp("importedAt").defaultNow().notNull(),
}, (t) => ({ family: index("documentSourceArtifacts_family").on(t.definitionKey, t.variantNo) }));

export type InsertDocumentDefinition = typeof documentDefinitions.$inferInsert;
export type InsertDocumentSourceArtifact = typeof documentSourceArtifacts.$inferInsert;

/* ==================================================================
 * DC-B (0195) — Document Control: the 0144 register becomes origin-aware. The
 * columns below are added to commercialDocuments and commercialDocumentLinks
 * by 0195 (see the ALTER statements there); the two new tables carry external
 * identifiers and the append-only timeline.
 * ================================================================== */

/** Identifiers another issuer assigned to a document, scoped by that issuer. Facility A's #12345 and Facility B's #12345 both exist. */
export const documentExternalReferences = mysqlTable("documentExternalReferences", {
  id: int("id").autoincrement().primaryKey(),
  referenceRef: varchar("referenceRef", { length: 40 }).notNull().unique(),
  bookOrgRef: varchar("bookOrgRef", { length: 64 }),
  /** COALESCE(bookOrgRef, 'default'), maintained by the write path so an index can see the single tenant. */
  bookScopeKey: varchar("bookScopeKey", { length: 64 }).notNull(),
  documentId: int("documentId").notNull(),
  referenceType: varchar("referenceType", { length: 40 }).notNull(),
  referenceValue: varchar("referenceValue", { length: 120 }).notNull(),
  referenceValueRaw: varchar("referenceValueRaw", { length: 120 }).notNull(),
  issuerKind: mysqlEnum("issuerKind", ["tenant", "customer", "facility", "vendor", "regulator", "government_authority", "manufacturer", "other_third_party", "unknown"]).notNull(),
  issuerOrgRef: varchar("issuerOrgRef", { length: 64 }),
  issuerFacilityId: int("issuerFacilityId"),
  issuerName: varchar("issuerName", { length: 220 }),
  issuerScopeKey: varchar("issuerScopeKey", { length: 160 }).notNull(),
  source: mysqlEnum("source", ["ocr_proposed", "human_entered", "portal_submitted", "api_imported", "domain_mirrored"]).notNull(),
  confirmationStatus: mysqlEnum("confirmationStatus", ["proposed", "confirmed", "rejected"]).default("proposed").notNull(),
  confirmedByUserId: int("confirmedByUserId"),
  confirmedAt: timestamp("confirmedAt"),
  /** Set when the value is a mirror of a column another domain owns; the row is then read-only here. */
  mirrorOfTable: varchar("mirrorOfTable", { length: 40 }),
  mirrorOfId: int("mirrorOfId"),
  mirrorOfColumn: varchar("mirrorOfColumn", { length: 40 }),
  duplicateOfDocumentId: int("duplicateOfDocumentId"),
  duplicateOverrideReason: varchar("duplicateOverrideReason", { length: 300 }),
  createdByUserId: int("createdByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  perDocument: uniqueIndex("documentExternalReferences_document_issuer_value").on(t.documentId, t.referenceType, t.issuerScopeKey, t.referenceValue),
  lookup: index("documentExternalReferences_lookup").on(t.bookScopeKey, t.referenceType, t.referenceValue),
}));

/** Append-only. The timeline of a controlled document is read from here, never inferred from the row's final state. */
export const documentControlEvents = mysqlTable("documentControlEvents", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull(),
  sequence: int("sequence").notNull(),
  eventType: varchar("eventType", { length: 60 }).notNull(),
  actorUserId: int("actorUserId"),
  actorSource: mysqlEnum("actorSource", ["human", "system", "ai", "integration", "external"]).notNull(),
  deviceRef: varchar("deviceRef", { length: 64 }),
  previousState: varchar("previousState", { length: 40 }),
  newState: varchar("newState", { length: 40 }),
  detailJson: text("detailJson"),
  occurredAt: timestamp("occurredAt").notNull(),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
}, (t) => ({ seq: uniqueIndex("documentControlEvents_seq_unique").on(t.documentId, t.sequence) }));

export type InsertDocumentExternalReference = typeof documentExternalReferences.$inferInsert;
export type InsertDocumentControlEvent = typeof documentControlEvents.$inferInsert;

/* ==================================================================
 * DC-C (0196) — controlled numbering: the ledger around the one counter.
 * trackingSequences gains orgRef/scopeKey (declared on that table); these two
 * tables hold device blocks and one row per minted number.
 * ================================================================== */

/** A contiguous range cut from the row-locked counter for one enrolled device to issue offline. Never recycled. */
export const numberBlocks = mysqlTable("numberBlocks", {
  id: int("id").autoincrement().primaryKey(),
  allocationRef: varchar("allocationRef", { length: 40 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 64 }),
  scopeKey: varchar("scopeKey", { length: 64 }).notNull(),
  sequenceType: varchar("sequenceType", { length: 24 }).notNull(),
  branch: varchar("branch", { length: 12 }).default("").notNull(),
  periodKey: varchar("periodKey", { length: 16 }).notNull(),
  firstSequence: bigint("firstSequence", { mode: "number" }).notNull(),
  lastSequence: bigint("lastSequence", { mode: "number" }).notNull(),
  count: int("count").notNull(),
  deviceRef: varchar("deviceRef", { length: 64 }).notNull(),
  allocatedByUserId: int("allocatedByUserId").notNull(),
  state: mysqlEnum("state", ["active", "exhausted", "retired", "device_lost"]).default("active").notNull(),
  retiredByUserId: int("retiredByUserId"),
  retiredAt: timestamp("retiredAt"),
  retireReason: varchar("retireReason", { length: 300 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({ range: uniqueIndex("numberBlocks_range_unique").on(t.scopeKey, t.sequenceType, t.branch, t.periodKey, t.firstSequence), device: index("numberBlocks_device").on(t.deviceRef, t.state) }));

/** One row per minted number, written in the same transaction as the counter bump and the record. Every gap is a row with a reason. */
export const numberAllocations = mysqlTable("numberAllocations", {
  id: int("id").autoincrement().primaryKey(),
  allocationRef: varchar("allocationRef", { length: 40 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 64 }),
  scopeKey: varchar("scopeKey", { length: 64 }).notNull(),
  sequenceType: varchar("sequenceType", { length: 24 }).notNull(),
  branch: varchar("branch", { length: 12 }).default("").notNull(),
  periodKey: varchar("periodKey", { length: 16 }).notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  formattedNumber: varchar("formattedNumber", { length: 64 }).notNull(),
  blockId: int("blockId"),
  deviceRef: varchar("deviceRef", { length: 64 }),
  state: mysqlEnum("state", ["reserved", "issued", "voided", "damaged", "lost", "unused_retired"]).notNull(),
  recordType: varchar("recordType", { length: 40 }),
  recordId: int("recordId"),
  idempotencyKey: varchar("idempotencyKey", { length: 120 }),
  reservedByUserId: int("reservedByUserId"),
  reservedAt: timestamp("reservedAt").defaultNow().notNull(),
  issuedAt: timestamp("issuedAt"),
  closedByUserId: int("closedByUserId"),
  closedAt: timestamp("closedAt"),
  reasonCode: mysqlEnum("reasonCode", ["record_insert_failed", "cancelled_before_issue", "duplicate_issue", "printed_and_spoiled", "device_lost", "device_retired", "damaged_in_field", "migration_gap", "other"]),
  reasonText: varchar("reasonText", { length: 300 }),
}, (t) => ({ sequence: uniqueIndex("numberAllocations_sequence_unique").on(t.scopeKey, t.sequenceType, t.branch, t.periodKey, t.sequence), idempotency: uniqueIndex("numberAllocations_idempotency_unique").on(t.scopeKey, t.sequenceType, t.idempotencyKey), record: index("numberAllocations_record").on(t.recordType, t.recordId), state: index("numberAllocations_state").on(t.scopeKey, t.sequenceType, t.periodKey, t.state) }));

export type InsertNumberBlock = typeof numberBlocks.$inferInsert;
export type InsertNumberAllocation = typeof numberAllocations.$inferInsert;
/* ---- S1-A (0175): a session is a row, so a session can be revoked ---- */

/**
 * One login, and every credential it goes on to mint.
 *
 * Before this table `verifySession` was a stateless `jwtVerify` against a token minted with
 * `expiresInMs: ONE_YEAR_MS`. Logout cleared the cookie and nothing else, so a copy taken out of
 * the browser kept working for the rest of its year — there was no record to revoke.
 *
 * `refreshVerifierHash` is a SHA-256; the verifier the client holds is never stored, following the
 * rule `externalIdentityPolicy` already states for portal bearer tokens. `absoluteExpiresAt` is
 * written once at login and never moved, because an expiry that advanced on use would mean "thirty
 * days after you stop". `appId` is kept so a refresh cannot cross the surface the family was minted
 * for — the same distinction `sdk.verifySession` enforces for access tokens.
 */
export const sessionFamilies = mysqlTable("sessionFamilies", {
  id: int("id").autoincrement().primaryKey(),
  familyRef: varchar("familyRef", { length: 64 }).notNull().unique(),
  openId: varchar("openId", { length: 191 }).notNull(),
  appId: varchar("appId", { length: 128 }),
  /** Reserved. A session proves identity; acting scope is still resolved per request. */
  tenantContext: varchar("tenantContext", { length: 64 }),
  refreshVerifierHash: varchar("refreshVerifierHash", { length: 64 }).notNull(),
  rotationCounter: int("rotationCounter").default(0).notNull(),
  /** S1 records what a login reached; S6 enforces step-up against it. No stored credential is implied. */
  authAssurance: mysqlEnum("authAssurance", ["single_factor", "mfa"]).default("single_factor").notNull(),
  mfaCompletedAt: timestamp("mfaCompletedAt"),
  /** Reserved for S4/S6: revoking a lost phone must not mean deleting the account. */
  deviceRef: varchar("deviceRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastUsedAt: timestamp("lastUsedAt"),
  absoluteExpiresAt: timestamp("absoluteExpiresAt").notNull(),
  revokedAt: timestamp("revokedAt"),
  revokeReason: mysqlEnum("revokeReason", [
    "logout", "revoked_all", "device_revoked", "reuse_detected", "credential_change", "admin", "expired",
  ]),
  userAgentHash: varchar("userAgentHash", { length: 64 }),
  ipHash: varchar("ipHash", { length: 64 }),
}, t => ({
  ownerIdx: index("sessionFamilies_openId_idx").on(t.openId, t.revokedAt),
  verifierIdx: index("sessionFamilies_verifier_idx").on(t.refreshVerifierHash),
}));

/**
 * S2-B — the one place reversible ciphertext lives.
 *
 * Split from the records that use it so a metadata read never touches a secret: callers hold a
 * `secretRef`, and only `server/secretStore.ts` resolves one. `keyId` names the key that encrypted
 * this row — never key material — so a row written under a retired key stays readable and a rewrap
 * can find what still references one.
 */
export const encryptedSecrets = mysqlTable("encryptedSecrets", {
  id: int("id").autoincrement().primaryKey(),
  /** Opaque, random, stable across rewrap. Never derived from the plaintext. */
  secretRef: varchar("secretRef", { length: 64 }).notNull().unique(),
  purpose: mysqlEnum("purpose", ["MFA_SECRET", "WEBHOOK_SECRET", "PROVIDER_CREDENTIAL", "INTEGRATION_SECRET"]).notNull(),
  keyId: varchar("keyId", { length: 64 }).notNull(),
  /** `text`, not varchar: a MUTUAL_TLS certificate and key will not fit in 400 characters. */
  envelope: text("envelope").notNull(),
  status: mysqlEnum("status", ["active", "disabled"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  rewrappedAt: timestamp("rewrappedAt"),
  disabledAt: timestamp("disabledAt"),
  /** Set by S2-D/S2-E when a legacy inline value is moved here; NULL for natively created secrets. */
  sourceTable: varchar("sourceTable", { length: 64 }),
  sourceColumn: varchar("sourceColumn", { length: 64 }),
}, t => ({
  purposeKeyIdx: index("encryptedSecrets_purpose_key_idx").on(t.purpose, t.keyId),
  sourceIdx: index("encryptedSecrets_source_idx").on(t.sourceTable, t.sourceColumn),
}));

/**
 * S2-C — provider credential metadata. There is no column here capable of holding a secret.
 *
 * Joins `externalDataSources.sourceKey` on `providerKey`, which already carries the licensing
 * dimensions — so "configured" and "permitted" stay separate questions. PLATFORM rows have no
 * `orgRef`; TENANT rows must have one, enforced by a CHECK in migration 0192 rather than by service
 * code, because a malformed row is what a resolver would otherwise have to guess about.
 */
export const providerCredentials = mysqlTable("providerCredentials", {
  id: int("id").autoincrement().primaryKey(),
  credentialRef: varchar("credentialRef", { length: 64 }).notNull().unique(),
  providerKey: varchar("providerKey", { length: 120 }).notNull(),
  environment: mysqlEnum("environment", ["production", "staging", "sandbox"]).default("production").notNull(),
  authScheme: mysqlEnum("authScheme", ["NONE", "API_KEY", "STATIC_BEARER", "OAUTH2_CLIENT_CREDENTIALS", "OAUTH2_REFRESH", "SIGNED_REQUEST", "MUTUAL_TLS"]).notNull(),
  ownership: mysqlEnum("ownership", ["PLATFORM", "TENANT"]).notNull(),
  /** NULL exactly when ownership = PLATFORM. */
  orgRef: varchar("orgRef", { length: 64 }),
  /**
   * Generated, never written by application code: `COALESCE(orgRef, '~platform')`. It exists only
   * so the scope UNIQUE below covers platform rows too — MariaDB allows unlimited NULLs in a
   * composite UNIQUE, which would let two active platform credentials for one provider coexist and
   * make resolution depend on row order.
   */
  orgScope: varchar("orgScope", { length: 64 }).generatedAlwaysAs(sql`COALESCE(\`orgRef\`, '~platform')`, {
    mode: "stored",
  }),
  /** The provider's own account/client id. Not secret — an OAuth client id is public. */
  externalAccountId: varchar("externalAccountId", { length: 200 }),
  /** Pointer into encryptedSecrets; NULL is legitimate for authScheme NONE. */
  secretRef: varchar("secretRef", { length: 64 }),
  status: mysqlEnum("status", ["active", "disabled", "rotating", "revoked", "expired"]).default("active").notNull(),
  /** Tracks the provider's value. A master-key rewrap does NOT touch this. */
  credentialVersion: int("credentialVersion").default(1).notNull(),
  /** Truncated hash, so an operator can recognise a key without the system disclosing it. */
  fingerprint: varchar("fingerprint", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt"),
  rotatedAt: timestamp("rotatedAt"),
  expiresAt: timestamp("expiresAt"),
  lastUsedAt: timestamp("lastUsedAt"),
  createdByUserId: int("createdByUserId"),
  disabledByUserId: int("disabledByUserId"),
  disabledReason: varchar("disabledReason", { length: 300 }),
}, t => ({
  scopeUnique: uniqueIndex("providerCredentials_scope_unique").on(t.providerKey, t.environment, t.ownership, t.orgScope),
  providerStatusIdx: index("providerCredentials_provider_status_idx").on(t.providerKey, t.status),
  tenantIdx: index("providerCredentials_tenant_idx").on(t.orgRef, t.providerKey),
}));

/* ---- LA-1a (0202/0203): the Live Assist session spine ---- */

/**
 * One Live Assist session: a unit of work a person opened on purpose, owned by one user and one
 * organization. Not a login session — identity is `sessionFamilies`; acting organization is resolved
 * per request. `orgRef` is written from `resolveActingScope` and never from input.
 *
 * `openMarker` is 1 while the session is active or paused and NULL once it stops; the unique index on
 * (orgRef, userId, openMarker) makes "one open session per person" a database fact rather than a race.
 * `startKey` is the client's retry key for `start`, unique per (orgRef, userId), never globally.
 *
 * Deadlines are the server's: `idleDeadlineAt` moves on heartbeat, `hardDeadlineAt` never moves, and
 * `purgeAfter` is derived when the session stops. The work counters exist for the checkpoint that first
 * submits a frame; LA-1a writes none of them.
 *
 * LA-1a carve-out only (docs/live-assist/LA1A_OWNER_RULING.md): no column here holds an image, a frame,
 * a storage key or model output.
 */
export const liveAssistSessions = mysqlTable("liveAssistSessions", {
  id: int("id").autoincrement().primaryKey(),
  sessionRef: varchar("sessionRef", { length: 40 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  userId: int("userId").notNull(),
  startKey: varchar("startKey", { length: 64 }).notNull(),
  source: mysqlEnum("source", ["photo", "camera", "screen", "video"]).notNull(),
  state: mysqlEnum("state", ["active", "paused", "ended", "expired"]).notNull(),
  openMarker: tinyint("openMarker"),
  policySnapshotJson: text("policySnapshotJson").notNull(),
  startedAt: timestamp("startedAt").notNull(),
  lastHeartbeatAt: timestamp("lastHeartbeatAt").notNull(),
  idleDeadlineAt: timestamp("idleDeadlineAt").notNull(),
  hardDeadlineAt: timestamp("hardDeadlineAt").notNull(),
  pausedAt: timestamp("pausedAt"),
  endedAt: timestamp("endedAt"),
  endReason: mysqlEnum("endReason", ["user_end", "idle_timeout", "budget_spent", "policy_disabled"]),
  purgeAfter: timestamp("purgeAfter"),
  transientPurgedAt: timestamp("transientPurgedAt"),
  previousSessionRef: varchar("previousSessionRef", { length: 40 }),
  framesSubmitted: int("framesSubmitted").default(0).notNull(),
  bytesSubmitted: bigint("bytesSubmitted", { mode: "number" }).default(0).notNull(),
  inferenceCalls: int("inferenceCalls").default(0).notNull(),
  inputTokens: int("inputTokens").default(0).notNull(),
  outputTokens: int("outputTokens").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  startKeyUnique: uniqueIndex("liveAssistSessions_startKey_unique").on(t.orgRef, t.userId, t.startKey),
  openUnique: uniqueIndex("liveAssistSessions_open_unique").on(t.orgRef, t.userId, t.openMarker),
  ownerIdx: index("liveAssistSessions_owner_idx").on(t.orgRef, t.userId, t.startedAt),
  deadlineIdx: index("liveAssistSessions_deadline_idx").on(t.state, t.idleDeadlineAt),
  purgeIdx: index("liveAssistSessions_purge_idx").on(t.transientPurgedAt, t.purgeAfter),
}));
export type LiveAssistSessionRow = typeof liveAssistSessions.$inferSelect;

/**
 * Transient conversation state for one session (design §6.3, D-05). Nothing writes it before LA-1b; the
 * purge that removes it exists first, so no row can ever be written that nothing will remove.
 */
export const liveAssistTurns = mysqlTable("liveAssistTurns", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  seq: int("seq").notNull(),
  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
  channel: mysqlEnum("channel", ["text", "voice"]).notNull(),
  text: text("text").notNull(),
  frameHashesJson: text("frameHashesJson"),
  redactionFlagsJson: text("redactionFlagsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  seqUnique: uniqueIndex("liveAssistTurns_seq_unique").on(t.sessionId, t.seq),
  sessionIdx: index("liveAssistTurns_session_idx").on(t.orgRef, t.sessionId),
}));

/**
 * Identity of an image a session looked at — hashes and dimensions, never bytes (design §7.1).
 * `savedEvidenceRecordId` is set only when a person deliberately saves the original as evidence; the
 * purge never removes a row that carries one.
 */
export const liveAssistFrames = mysqlTable("liveAssistFrames", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  frameSeq: int("frameSeq").notNull(),
  kind: mysqlEnum("kind", ["context", "inspect", "crop"]).notNull(),
  frameHash: varchar("frameHash", { length: 64 }).notNull(),
  originalHash: varchar("originalHash", { length: 64 }),
  perceptualHash: varchar("perceptualHash", { length: 16 }),
  width: int("width").notNull(),
  height: int("height").notNull(),
  byteSize: int("byteSize").notNull(),
  regionJson: text("regionJson"),
  markedByUser: boolean("markedByUser").default(false).notNull(),
  savedEvidenceRecordId: int("savedEvidenceRecordId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  seqUnique: uniqueIndex("liveAssistFrames_seq_unique").on(t.sessionId, t.frameSeq),
  sessionIdx: index("liveAssistFrames_session_idx").on(t.orgRef, t.sessionId),
}));

/** What an answer said it saw, and how sure (design §11). Transient; nothing writes it before LA-1b. */
export const liveAssistObservations = mysqlTable("liveAssistObservations", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  turnId: int("turnId"),
  frameHash: varchar("frameHash", { length: 64 }),
  kind: mysqlEnum("kind", ["identified", "read_text", "condition", "guidance_step"]).notNull(),
  statement: varchar("statement", { length: 600 }).notNull(),
  certainty: mysqlEnum("certainty", ["visible_clearly", "visible_partially", "not_visible", "inferred"]).notNull(),
  requestedView: mysqlEnum("requestedView", ["closer", "wider", "other_side", "more_light", "hold_steady", "freeze", "region", "context_question"]),
  requestedRegionJson: text("requestedRegionJson"),
  safetyClass: mysqlEnum("safetyClass", ["none", "advise_qualified_inspection", "stop_work_escalate"]).default("none").notNull(),
  overreachFlagsJson: text("overreachFlagsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  sessionIdx: index("liveAssistObservations_session_idx").on(t.orgRef, t.sessionId),
}));

/**
 * The lifecycle record: metadata only, append-only (0203 triggers). `actorUserId` NULL means the server
 * itself acted — a deadline passed, or the purge ran. Never a frame, a turn, an observation or text a
 * person typed.
 */
export const liveAssistEvents = mysqlTable("liveAssistEvents", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  actorUserId: int("actorUserId"),
  eventType: mysqlEnum("eventType", [
    "session_started", "session_paused", "session_resumed", "session_ended", "session_expired", "session_transient_purged",
  ]).notNull(),
  endReason: mysqlEnum("endReason", ["user_end", "idle_timeout", "budget_spent", "policy_disabled"]),
  detail: varchar("detail", { length: 200 }),
  occurredAt: timestamp("occurredAt").defaultNow().notNull(),
}, (t) => ({
  orgIdx: index("liveAssistEvents_org_idx").on(t.orgRef, t.occurredAt),
  sessionIdx: index("liveAssistEvents_session_idx").on(t.sessionId),
}));
export type LiveAssistEventRow = typeof liveAssistEvents.$inferSelect;

/**
 * An organization's Live Assist policy. A change is a new row; the old one is superseded, never edited
 * in place, so which policy governed a past session stays answerable. `currentMarker` (1 on the current
 * row, NULL on superseded ones) with its unique index makes two concurrent changes collide instead of
 * both becoming current.
 */
export const liveAssistPolicies = mysqlTable("liveAssistPolicies", {
  id: int("id").autoincrement().primaryKey(),
  policyRef: varchar("policyRef", { length: 64 }).notNull().unique(),
  orgRef: varchar("orgRef", { length: 64 }).notNull(),
  enabled: boolean("enabled").notNull(),
  sourcesAllowedJson: text("sourcesAllowedJson").notNull(),
  idleSeconds: int("idleSeconds").notNull(),
  maxSessionMinutes: int("maxSessionMinutes").notNull(),
  retentionHours: int("retentionHours").notNull(),
  maxSessionsPerUserPerDay: int("maxSessionsPerUserPerDay").notNull(),
  dailySpendCeilingCents: int("dailySpendCeilingCents"),
  setByUserId: int("setByUserId").notNull(),
  currentMarker: tinyint("currentMarker"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  supersededAt: timestamp("supersededAt"),
}, (t) => ({
  currentUnique: uniqueIndex("liveAssistPolicies_current_unique").on(t.orgRef, t.currentMarker),
}));
export type LiveAssistPolicyRow = typeof liveAssistPolicies.$inferSelect;
/** 0217 — a person at the customer, keyed to the account; roles are rows (customerContactRoles). */
export const customerContacts = mysqlTable("customerContacts", {
  id: int("id").autoincrement().primaryKey(),
  contactRef: varchar("contactRef", { length: 40 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  displayName: varchar("displayName", { length: 180 }).notNull(),
  title: varchar("title", { length: 120 }),
  company: varchar("company", { length: 220 }),
  phone: varchar("phone", { length: 60 }),
  mobile: varchar("mobile", { length: 60 }),
  email: varchar("email", { length: 220 }),
  preferredChannel: mysqlEnum("preferredChannel", ["phone", "sms", "email", "portal"]),
  externalIdentityId: int("externalIdentityId"),
  signatoryAuthorityId: int("signatoryAuthorityId"),
  status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  notes: varchar("notes", { length: 600 }),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  rowVersion: int("rowVersion").default(1).notNull(),
});

/** 0217 — one role a contact holds for the account, effective-dated; ended, never deleted. */
export const customerContactRoles = mysqlTable("customerContactRoles", {
  id: int("id").autoincrement().primaryKey(),
  contactId: int("contactId").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  roleKey: varchar("roleKey", { length: 40 }).notNull(),
  isPrimary: boolean("isPrimary").default(false).notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  status: mysqlEnum("status", ["active", "ended"]).default("active").notNull(),
  assignedByUserId: int("assignedByUserId").notNull(),
  assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  endedByUserId: int("endedByUserId"),
  endedAt: timestamp("endedAt"),
});

/** 0217 — the commercial change ledger: append-only, written in the change's own transaction. */
export const commercialAuditEvents = mysqlTable("commercialAuditEvents", {
  id: int("id").autoincrement().primaryKey(),
  eventRef: varchar("eventRef", { length: 64 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  subjectType: mysqlEnum("subjectType", ["customer_account", "customer_contact", "customer_contract", "rate_sheet", "rate_sheet_version", "rate_line", "job_commercial_context", "job_commercial_snapshot", "customer_purchase_order"]).notNull(),
  subjectRef: varchar("subjectRef", { length: 80 }).notNull(),
  subjectId: int("subjectId"),
  eventType: varchar("eventType", { length: 60 }).notNull(),
  fromStatus: varchar("fromStatus", { length: 40 }),
  toStatus: varchar("toStatus", { length: 40 }),
  changesJson: text("changesJson"),
  relatedRef: varchar("relatedRef", { length: 80 }),
  jobId: int("jobId"),
  reason: varchar("reason", { length: 500 }),
  actorUserId: int("actorUserId").notNull(),
  actorRole: varchar("actorRole", { length: 60 }).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** 0218 — a contract with a lifecycle; its billability rules live in customerContractTerms (termsId). */
export const customerContracts = mysqlTable("customerContracts", {
  id: int("id").autoincrement().primaryKey(),
  contractRef: varchar("contractRef", { length: 40 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  contractNumber: varchar("contractNumber", { length: 80 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  contractType: mysqlEnum("contractType", ["msa", "rate_agreement", "service_agreement", "work_order", "purchase_order", "framework", "other"]).default("msa").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  status: mysqlEnum("status", ["draft", "pending_approval", "active", "suspended", "expired", "terminated", "superseded"]).default("draft").notNull(),
  poRequirement: mysqlEnum("poRequirement", ["inherit", "required", "not_required"]).default("inherit").notNull(),
  requiredReferenceKindsJson: text("requiredReferenceKindsJson"),
  customerReferencesJson: text("customerReferencesJson"),
  paymentTermsDays: int("paymentTermsDays"),
  billingInstructions: text("billingInstructions"),
  notes: text("notes"),
  termsId: int("termsId"),
  renewalKind: mysqlEnum("renewalKind", ["none", "manual", "auto"]).default("manual").notNull(),
  renewalNoticeDays: int("renewalNoticeDays"),
  version: int("version").default(1).notNull(),
  supersedesContractId: int("supersedesContractId"),
  supersededByContractId: int("supersededByContractId"),
  submittedByUserId: int("submittedByUserId"),
  submittedAt: timestamp("submittedAt"),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  approvalNote: varchar("approvalNote", { length: 400 }),
  activatedAt: timestamp("activatedAt"),
  suspendedAt: timestamp("suspendedAt"),
  suspendedByUserId: int("suspendedByUserId"),
  suspensionReason: varchar("suspensionReason", { length: 400 }),
  terminatedAt: timestamp("terminatedAt"),
  terminatedByUserId: int("terminatedByUserId"),
  terminationReason: varchar("terminationReason", { length: 400 }),
  expiredAt: timestamp("expiredAt"),
  usedOperationallyAt: timestamp("usedOperationallyAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  rowVersion: int("rowVersion").default(1).notNull(),
});

/** 0218 — a customer's rate sheet: the document whose versions group charge definitions. */
export const rateSheets = mysqlTable("rateSheets", {
  id: int("id").autoincrement().primaryKey(),
  rateSheetRef: varchar("rateSheetRef", { length: 40 }).notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  contractId: int("contractId"),
  name: varchar("name", { length: 220 }).notNull(),
  sheetNumber: varchar("sheetNumber", { length: 80 }),
  currency: varchar("currency", { length: 3 }).default("CAD").notNull(),
  status: mysqlEnum("status", ["active", "retired"]).default("active").notNull(),
  notes: text("notes"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  rowVersion: int("rowVersion").default(1).notNull(),
});

/** 0218 — one approved-as-a-unit revision of a sheet; its lines are chargeDefinitions rows. */
export const rateSheetVersions = mysqlTable("rateSheetVersions", {
  id: int("id").autoincrement().primaryKey(),
  versionRef: varchar("versionRef", { length: 40 }).notNull().unique(),
  rateSheetId: int("rateSheetId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  version: int("version").notNull(),
  effectiveFrom: timestamp("effectiveFrom").notNull(),
  effectiveTo: timestamp("effectiveTo"),
  status: mysqlEnum("status", ["draft", "pending_approval", "approved", "rejected", "superseded", "retired"]).default("draft").notNull(),
  contentHash: varchar("contentHash", { length: 64 }),
  notes: text("notes"),
  supersedesVersionId: int("supersedesVersionId"),
  supersededByVersionId: int("supersededByVersionId"),
  submittedByUserId: int("submittedByUserId"),
  submittedAt: timestamp("submittedAt"),
  approvedByUserId: int("approvedByUserId"),
  approvedAt: timestamp("approvedAt"),
  rejectedByUserId: int("rejectedByUserId"),
  rejectedAt: timestamp("rejectedAt"),
  rejectionReason: varchar("rejectionReason", { length: 400 }),
  usedOperationallyAt: timestamp("usedOperationallyAt"),
  createdByUserId: int("createdByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  rowVersion: int("rowVersion").default(1).notNull(),
});

/** 0219 — the job's live commercial assignment: customer, bill-to, contract, sheet, PO. */
export const jobCommercialContexts = mysqlTable("jobCommercialContexts", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull().unique(),
  financialEntityId: int("financialEntityId").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  billToCustomerAccountId: int("billToCustomerAccountId"),
  contractId: int("contractId"),
  rateSheetId: int("rateSheetId"),
  pinnedRateSheetVersionId: int("pinnedRateSheetVersionId"),
  purchaseOrderId: int("purchaseOrderId"),
  referenceWaiverReason: varchar("referenceWaiverReason", { length: 400 }),
  referenceWaivedByUserId: int("referenceWaivedByUserId"),
  referenceWaivedAt: timestamp("referenceWaivedAt"),
  notes: varchar("notes", { length: 600 }),
  currentSnapshotId: int("currentSnapshotId"),
  setByUserId: int("setByUserId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  rowVersion: int("rowVersion").default(1).notNull(),
});

/** 0219 — the other companies and people on a job, as references. */
export const jobCommercialParties = mysqlTable("jobCommercialParties", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  partyRole: varchar("partyRole", { length: 40 }).notNull(),
  customerAccountId: int("customerAccountId"),
  contactId: int("contactId"),
  orgRef: varchar("orgRef", { length: 64 }),
  freeText: varchar("freeText", { length: 220 }),
  status: mysqlEnum("status", ["active", "ended"]).default("active").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
  endedByUserId: int("endedByUserId"),
  endedAt: timestamp("endedAt"),
});

/** 0219 — PO, work order, AFE, cost centre and the customer's other references, one row per kind. */
export const jobCommercialReferences = mysqlTable("jobCommercialReferences", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  referenceKind: varchar("referenceKind", { length: 40 }).notNull(),
  referenceValue: varchar("referenceValue", { length: 120 }).notNull(),
  customerPurchaseOrderId: int("customerPurchaseOrderId"),
  source: mysqlEnum("source", ["office", "dispatch", "customer_portal", "field", "import"]).default("office").notNull(),
  status: mysqlEnum("status", ["active", "ended"]).default("active").notNull(),
  recordedByUserId: int("recordedByUserId").notNull(),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
  endedByUserId: int("endedByUserId"),
  endedAt: timestamp("endedAt"),
});

/** 0219 — the immutable commercial basis of a job; billing reads this and never the live sheet. */
export const jobCommercialSnapshots = mysqlTable("jobCommercialSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  snapshotRef: varchar("snapshotRef", { length: 40 }).notNull().unique(),
  jobId: int("jobId").notNull(),
  financialEntityId: int("financialEntityId").notNull(),
  sequenceNo: int("sequenceNo").notNull(),
  reason: mysqlEnum("reason", ["activation", "correction", "manual"]).notNull(),
  status: mysqlEnum("status", ["current", "superseded"]).default("current").notNull(),
  capturedByUserId: int("capturedByUserId").notNull(),
  capturedAt: timestamp("capturedAt").notNull(),
  customerAccountId: int("customerAccountId").notNull(),
  customerAccountRef: varchar("customerAccountRef", { length: 64 }).notNull(),
  customerNumber: varchar("customerNumber", { length: 40 }),
  customerName: varchar("customerName", { length: 220 }).notNull(),
  billToCustomerAccountId: int("billToCustomerAccountId").notNull(),
  contractId: int("contractId"),
  contractRef: varchar("contractRef", { length: 40 }),
  contractNumber: varchar("contractNumber", { length: 80 }),
  contractVersion: int("contractVersion"),
  termsId: int("termsId"),
  termsRef: varchar("termsRef", { length: 64 }),
  termsVersion: int("termsVersion"),
  rateSheetId: int("rateSheetId"),
  rateSheetVersionId: int("rateSheetVersionId"),
  rateSheetVersionRef: varchar("rateSheetVersionRef", { length: 40 }),
  rateSheetVersion: int("rateSheetVersion"),
  rateSheetContentHash: varchar("rateSheetContentHash", { length: 64 }),
  purchaseOrderId: int("purchaseOrderId"),
  poRef: varchar("poRef", { length: 64 }),
  poNumber: varchar("poNumber", { length: 80 }),
  paymentTermsDays: int("paymentTermsDays").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  poRequired: boolean("poRequired").notNull(),
  billingInstructions: text("billingInstructions"),
  payloadJson: text("payloadJson").notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  supersedesSnapshotId: int("supersedesSnapshotId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
