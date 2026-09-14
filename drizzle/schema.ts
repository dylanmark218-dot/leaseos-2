import {
  boolean,
  double,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

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
  ownerType: mysqlEnum("ownerType", ["operator", "unit", "job"]).notNull(),
  ownerId: int("ownerId").notNull(),
  docType: varchar("docType", { length: 100 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: varchar("storageUrl", { length: 1024 }),
  capturedAt: timestamp("capturedAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  verificationStatus: mysqlEnum("verificationStatus", [
    "needs_review",
    "verified",
    "rejected",
  ])
    .default("needs_review")
    .notNull(),
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
  downholeLsd: varchar("downholeLsd", { length: 80 }),
  uwi: varchar("uwi", { length: 120 }),
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
  status: mysqlEnum("status", ["draft", "verified", "complete"])
    .default("draft")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
});

export const operatingZones = mysqlTable("operatingZones", {
  id: int("id").autoincrement().primaryKey(),
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
  name: varchar("name", { length: 180 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  contactName: varchar("contactName", { length: 160 }),
  phone: varchar("phone", { length: 40 }),
  emergencyPhone: varchar("emergencyPhone", { length: 40 }),
  email: varchar("email", { length: 220 }),
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
    "gauge",
    "estimate",
    "customer_stated",
    "unknown",
  ])
    .default("unknown")
    .notNull(),
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
  tripId: int("tripId"),
  loadId: int("loadId"),
  billingBookId: int("billingBookId"),
  siteLocationId: int("siteLocationId"),
  operatorId: int("operatorId"),
  unitId: int("unitId"),
  serviceDescription: varchar("serviceDescription", { length: 220 }),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
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
  description: varchar("description", { length: 220 }).notNull(),
  quantity: double("quantity"),
  quantityUnit: varchar("quantityUnit", { length: 30 }),
  measurementMethod: mysqlEnum("measurementMethod", [
    "meter",
    "scale",
    "gauge",
    "estimate",
    "customer_stated",
    "system_timed",
    "unknown",
  ])
    .default("unknown")
    .notNull(),
  sourceTrackingNumber: varchar("sourceTrackingNumber", { length: 64 }),
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
  result: mysqlEnum("result", [
    "accepted",
    "partially_accepted",
    "refused",
    "no_representative",
  ]).notNull(),
  signerName: varchar("signerName", { length: 180 }),
  signerCompany: varchar("signerCompany", { length: 180 }),
  signerRole: varchar("signerRole", { length: 120 }),
  signerPhone: varchar("signerPhone", { length: 60 }),
  // The sentence the signer actually agreed to — site, window, quantities.
  // "John Smith signed" on its own proves very little.
  signedScopeStatement: text("signedScopeStatement"),
  signatureStorageKey: varchar("signatureStorageKey", { length: 512 }),
  signatureMethod: mysqlEnum("signatureMethod", [
    "drawn",
    "device_auth",
    "pin",
    "paper_scan",
  ]),
  payloadHash: varchar("payloadHash", { length: 128 }),
  refusalReason: text("refusalReason"),
  capturedAt: timestamp("capturedAt").notNull(),
  capturedLatitude: double("capturedLatitude"),
  capturedLongitude: double("capturedLongitude"),
  capturedOffline: boolean("capturedOffline").default(false).notNull(),
  witnessedByOperatorId: int("witnessedByOperatorId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// Service timeline. Where an event is already captured on a tripStop it points
// back via sourceTripStopId rather than being retyped — standby, extra service
// and customer instructions are the events that have nowhere else to live.
export const fieldTicketEvents = mysqlTable("fieldTicketEvents", {
  id: int("id").autoincrement().primaryKey(),
  fieldTicketId: int("fieldTicketId").notNull(),
  eventType: varchar("eventType", { length: 60 }).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  endedAt: timestamp("endedAt"),
  durationMinutes: double("durationMinutes"),
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
  billingBookId: int("billingBookId").notNull(),
  jobId: int("jobId"),
  customer: varchar("customer", { length: 220 }).notNull(),
  afeNumber: varchar("afeNumber", { length: 80 }),
  purchaseOrder: varchar("purchaseOrder", { length: 80 }),
  subtotalCents: int("subtotalCents").default(0).notNull(),
  taxCents: int("taxCents").default(0).notNull(),
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
    postingId: int("postingId").notNull(),
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
    fingerprint: varchar("fingerprint", { length: 32 }).notNull(),
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
  jobId: int("jobId"),
  tripId: int("tripId"),
  unitId: int("unitId"),
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
