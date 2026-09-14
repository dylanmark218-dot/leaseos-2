// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import { boolean, double, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var jobs = mysqlTable("jobs", {
  id: int("id").autoincrement().primaryKey(),
  jobCode: varchar("jobCode", { length: 32 }).notNull().unique(),
  type: varchar("type", { length: 120 }).notNull(),
  mode: mysqlEnum("mode", ["general", "hydrovac", "recovery", "transport"]).default("general").notNull(),
  customer: varchar("customer", { length: 160 }).notNull(),
  location: varchar("location", { length: 220 }).notNull(),
  vehicle: varchar("vehicle", { length: 120 }),
  driver: varchar("driver", { length: 120 }),
  status: mysqlEnum("status", ["dispatched", "in_transit", "loading", "on_site", "awaiting_docs", "complete"]).default("dispatched").notNull(),
  progress: int("progress").default(0).notNull(),
  eta: varchar("eta", { length: 32 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var evidenceRecords = mysqlTable("evidenceRecords", {
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
  status: mysqlEnum("status", ["needs_review", "verified", "unverified"]).default("needs_review").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var routeContexts = mysqlTable("routeContexts", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  source: varchar("source", { length: 220 }).notNull(),
  effectiveAt: timestamp("effectiveAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  verifiedAt: timestamp("verifiedAt"),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"]).default("medium").notNull(),
  restrictions: text("restrictions"),
  snapshotKey: varchar("snapshotKey", { length: 512 }),
  snapshotUrl: varchar("snapshotUrl", { length: 1024 }),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var safetyEvents = mysqlTable("safetyEvents", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  eventType: varchar("eventType", { length: 80 }).notNull(),
  severity: mysqlEnum("severity", ["info", "warning", "critical"]).default("info").notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  detail: text("detail"),
  occurredAt: timestamp("occurredAt").notNull(),
  status: mysqlEnum("status", ["open", "acknowledged", "resolved"]).default("open").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var checklistItems = mysqlTable("checklistItems", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  title: varchar("title", { length: 220 }).notNull(),
  completed: boolean("completed").default(false).notNull(),
  completedAt: timestamp("completedAt"),
  completedBy: int("completedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var operators = mysqlTable("operators", {
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
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var units = mysqlTable("units", {
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
  inspectionStatus: mysqlEnum("inspectionStatus", ["current", "due", "blocked"]).default("current").notNull(),
  maintenanceStatus: mysqlEnum("maintenanceStatus", ["clear", "review", "blocked"]).default("clear").notNull(),
  qrTag: varchar("qrTag", { length: 120 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var jobUnits = mysqlTable("jobUnits", {
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
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var complianceDocuments = mysqlTable("complianceDocuments", {
  id: int("id").autoincrement().primaryKey(),
  ownerType: mysqlEnum("ownerType", ["operator", "unit", "job"]).notNull(),
  ownerId: int("ownerId").notNull(),
  docType: varchar("docType", { length: 100 }).notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: varchar("storageUrl", { length: 1024 }),
  capturedAt: timestamp("capturedAt").notNull(),
  expiresAt: timestamp("expiresAt"),
  verificationStatus: mysqlEnum("verificationStatus", ["needs_review", "verified", "rejected"]).default("needs_review").notNull(),
  source: varchar("source", { length: 220 }),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"]).default("medium").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var loadProfiles = mysqlTable("loadProfiles", {
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
  classificationStatus: mysqlEnum("classificationStatus", ["needs_verification", "verified", "blocked"]).default("needs_verification").notNull(),
  source: varchar("source", { length: 220 }),
  confidence: mysqlEnum("confidence", ["low", "medium", "high"]).default("low").notNull(),
  verifiedAt: timestamp("verifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var facilities = mysqlTable("facilities", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 220 }).notNull(),
  status: mysqlEnum("status", ["unknown", "open", "closed"]).default("unknown").notNull(),
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
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var inspections = mysqlTable("inspections", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull(),
  type: mysqlEnum("type", ["training", "pre_trip", "post_trip"]).notNull(),
  status: mysqlEnum("status", ["pass", "fail", "needs_maintenance", "not_applicable"]).default("pass").notNull(),
  checklist: text("checklist"),
  resultSummary: text("resultSummary"),
  observedAt: timestamp("observedAt").notNull(),
  authenticatedOperatorId: int("authenticatedOperatorId"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var maintenanceDefects = mysqlTable("maintenanceDefects", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId").notNull(),
  title: varchar("title", { length: 220 }).notNull(),
  severity: mysqlEnum("severity", ["advisory", "inspection_required", "critical"]).default("advisory").notNull(),
  status: mysqlEnum("status", ["open", "in_progress", "resolved"]).default("open").notNull(),
  detail: text("detail"),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: varchar("storageUrl", { length: 1024 }),
  reportedAt: timestamp("reportedAt").notNull(),
  reportedBy: int("reportedBy"),
  workOrderNumber: varchar("workOrderNumber", { length: 80 }),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var deliveries = mysqlTable("deliveries", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  recipientRole: varchar("recipientRole", { length: 80 }).notNull(),
  recipient: varchar("recipient", { length: 220 }).notNull(),
  status: mysqlEnum("status", ["queued", "delivered", "failed"]).default("queued").notNull(),
  deliveredAt: timestamp("deliveredAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var signatureAudits = mysqlTable("signatureAudits", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId").notNull(),
  signerName: varchar("signerName", { length: 180 }).notNull(),
  authMethod: varchar("authMethod", { length: 120 }).notNull(),
  signedAt: timestamp("signedAt").notNull(),
  documentHash: varchar("documentHash", { length: 180 }),
  status: mysqlEnum("status", ["pending", "authenticated", "invalidated"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var locationIdentities = mysqlTable("locationIdentities", {
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
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var manifests = mysqlTable("manifests", {
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
  status: mysqlEnum("status", ["draft", "verified", "complete"]).default("draft").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var scanAudits = mysqlTable("scanAudits", {
  id: int("id").autoincrement().primaryKey(),
  scanType: mysqlEnum("scanType", ["qr", "nfc"]).notNull(),
  subjectType: mysqlEnum("subjectType", ["unit", "location", "manifest"]).notNull(),
  subjectId: int("subjectId").notNull(),
  accessRole: mysqlEnum("accessRole", ["inspection", "driver", "mechanic", "dispatcher", "admin"]).notNull(),
  scannedAt: timestamp("scannedAt").notNull(),
  latitude: double("latitude"),
  longitude: double("longitude"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var complianceArtifacts = mysqlTable("complianceArtifacts", {
  id: int("id").autoincrement().primaryKey(),
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull().unique(),
  artifactType: varchar("artifactType", { length: 40 }).notNull(),
  jobId: int("jobId"),
  locationId: int("locationId"),
  manifestId: int("manifestId"),
  status: mysqlEnum("status", ["active", "completed", "archived", "legal_hold"]).default("active").notNull(),
  jurisdiction: varchar("jurisdiction", { length: 100 }),
  regulatoryProfile: varchar("regulatoryProfile", { length: 180 }),
  regulatoryVersion: varchar("regulatoryVersion", { length: 100 }),
  retentionUntil: timestamp("retentionUntil"),
  metadata: text("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var tailgateMeetings = mysqlTable("tailgateMeetings", {
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
  reviewStatus: mysqlEnum("reviewStatus", ["needs_review", "approved"]).default("needs_review").notNull(),
  startedAt: timestamp("startedAt"),
  endedAt: timestamp("endedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var transferAcknowledgements = mysqlTable("transferAcknowledgements", {
  id: int("id").autoincrement().primaryKey(),
  trackingNumber: varchar("trackingNumber", { length: 40 }).notNull(),
  channel: mysqlEnum("channel", ["email", "portal", "api", "download"]).notNull(),
  recipient: varchar("recipient", { length: 220 }).notNull(),
  deliveryStatus: mysqlEnum("deliveryStatus", ["pending", "confirmed", "failed", "opened"]).default("pending").notNull(),
  messageId: varchar("messageId", { length: 180 }),
  attachmentCount: int("attachmentCount").default(0).notNull(),
  acknowledgedBy: varchar("acknowledgedBy", { length: 180 }),
  acknowledgedAt: timestamp("acknowledgedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var billingRateCards = mysqlTable("billingRateCards", {
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
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var jobChargeLines = mysqlTable("jobChargeLines", {
  id: int("id").autoincrement().primaryKey(),
  jobId: int("jobId"),
  description: varchar("description", { length: 220 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  unitRate: int("unitRate").default(0).notNull(),
  amount: int("amount").default(0).notNull(),
  source: varchar("source", { length: 80 }).default("rate_card").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});
var vendors = mysqlTable("vendors", {
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
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var unitSafetyPlans = mysqlTable("unitSafetyPlans", {
  id: int("id").autoincrement().primaryKey(),
  unitId: int("unitId"),
  unitLabel: varchar("unitLabel", { length: 120 }).notNull(),
  hazardSummary: text("hazardSummary"),
  shutdownProcedure: text("shutdownProcedure"),
  requiredPpe: text("requiredPpe"),
  sdsReferences: text("sdsReferences"),
  emergencyContacts: text("emergencyContacts"),
  version: int("version").default(1).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var routeDecisions = mysqlTable("routeDecisions", {
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
  riskLevel: mysqlEnum("riskLevel", ["low", "moderate", "high", "blocked"]).default("moderate").notNull(),
  source: varchar("source", { length: 180 }),
  confidence: varchar("confidence", { length: 40 }),
  driverAcknowledged: int("driverAcknowledged").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull()
});

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  try {
    const values = { openId: user.openId };
    const updateSet = {};
    const textFields = ["name", "email", "loginMethod"];
    textFields.forEach((field) => {
      const value = user[field];
      if (value !== void 0) {
        values[field] = value ?? null;
        updateSet[field] = value ?? null;
      }
    });
    if (user.lastSignedIn !== void 0) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== void 0) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }
    if (!values.lastSignedIn) values.lastSignedIn = /* @__PURE__ */ new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = /* @__PURE__ */ new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : void 0;
}
async function listJobs() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobs).orderBy(desc(jobs.updatedAt)).limit(100);
}
async function getJobByCode(jobCode) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(jobs).where(eq(jobs.jobCode, jobCode)).limit(1);
  return result[0];
}
async function createJob(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(jobs).values(input);
  return result[0]?.insertId;
}
async function listEvidenceRecords() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(evidenceRecords).orderBy(desc(evidenceRecords.capturedAt)).limit(100);
}
async function createEvidenceRecord(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(evidenceRecords).values(input);
  return result[0]?.insertId;
}
async function verifyEvidenceRecord(id) {
  const db = await getDb();
  if (!db) return false;
  await db.update(evidenceRecords).set({ status: "verified" }).where(eq(evidenceRecords.id, id));
  return true;
}
async function listRouteContexts() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(routeContexts).orderBy(desc(routeContexts.verifiedAt)).limit(100);
}
async function createRouteContext(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(routeContexts).values(input);
  return result[0]?.insertId;
}
async function listSafetyEvents() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(safetyEvents).orderBy(desc(safetyEvents.occurredAt)).limit(100);
}
async function createSafetyEvent(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(safetyEvents).values(input);
  return result[0]?.insertId;
}
async function listRouteDecisions() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(routeDecisions).orderBy(desc(routeDecisions.createdAt)).limit(100);
}
async function createRouteDecision(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(routeDecisions).values(input);
  return result[0]?.insertId;
}
async function listBillingRateCards() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(billingRateCards).orderBy(desc(billingRateCards.updatedAt)).limit(100);
}
async function createBillingRateCard(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(billingRateCards).values(input);
  return result[0]?.insertId;
}
async function listJobChargeLines(jobId) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobChargeLines).where(jobId ? eq(jobChargeLines.jobId, jobId) : void 0).orderBy(desc(jobChargeLines.createdAt)).limit(100);
}
async function createJobChargeLine(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(jobChargeLines).values(input);
  return result[0]?.insertId;
}
async function listVendors() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(vendors).orderBy(vendors.name).limit(100);
}
async function createVendor(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(vendors).values(input);
  return result[0]?.insertId;
}
async function listUnitSafetyPlans() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(unitSafetyPlans).orderBy(desc(unitSafetyPlans.updatedAt)).limit(100);
}
async function createUnitSafetyPlan(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(unitSafetyPlans).values(input);
  return result[0]?.insertId;
}
async function updateBillingRateCard(id, input) {
  const db = await getDb();
  if (!db) return false;
  await db.update(billingRateCards).set(input).where(eq(billingRateCards.id, id));
  return true;
}
async function updateVendor(id, input) {
  const db = await getDb();
  if (!db) return false;
  await db.update(vendors).set(input).where(eq(vendors.id, id));
  return true;
}
async function updateUnitSafetyPlan(id, input) {
  const db = await getDb();
  if (!db) return false;
  await db.update(unitSafetyPlans).set(input).where(eq(unitSafetyPlans.id, id));
  return true;
}
async function listComplianceArtifacts() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(complianceArtifacts).orderBy(desc(complianceArtifacts.createdAt)).limit(100);
}
async function createComplianceArtifact(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(complianceArtifacts).values(input);
  return result[0]?.insertId;
}
async function listTailgateMeetings() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(tailgateMeetings).orderBy(desc(tailgateMeetings.createdAt)).limit(100);
}
async function createTailgateMeeting(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(tailgateMeetings).values(input);
  return result[0]?.insertId;
}
async function listTransferAcknowledgements() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(transferAcknowledgements).orderBy(desc(transferAcknowledgements.createdAt)).limit(100);
}
async function createTransferAcknowledgement(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(transferAcknowledgements).values(input);
  return result[0]?.insertId;
}
async function acknowledgeTransfer(id, acknowledgedBy) {
  const db = await getDb();
  if (!db) return false;
  await db.update(transferAcknowledgements).set({ deliveryStatus: "confirmed", acknowledgedBy, acknowledgedAt: /* @__PURE__ */ new Date() }).where(eq(transferAcknowledgements.id, id));
  return true;
}
async function listLocationIdentities() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(locationIdentities).orderBy(desc(locationIdentities.lastVerifiedAt)).limit(100);
}
async function createLocationIdentity(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(locationIdentities).values(input);
  return result[0]?.insertId;
}
async function listManifests() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(manifests).orderBy(desc(manifests.createdAt)).limit(100);
}
async function createManifest(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(manifests).values(input);
  return result[0]?.insertId;
}
async function listScanAudits() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scanAudits).orderBy(desc(scanAudits.scannedAt)).limit(100);
}
async function createScanAudit(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(scanAudits).values(input);
  return result[0]?.insertId;
}
async function listJobUnits() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(jobUnits).orderBy(desc(jobUnits.joinedAt)).limit(100);
}
async function createJobUnit(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(jobUnits).values(input);
  return result[0]?.insertId;
}
async function listInspections() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(inspections).orderBy(desc(inspections.observedAt)).limit(100);
}
async function createInspection(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(inspections).values(input);
  return result[0]?.insertId;
}
async function listComplianceDocuments() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(complianceDocuments).orderBy(desc(complianceDocuments.createdAt)).limit(100);
}
async function createComplianceDocument(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(complianceDocuments).values(input);
  return result[0]?.insertId;
}
async function reviewComplianceDocument(id, status) {
  const db = await getDb();
  if (!db) return false;
  await db.update(complianceDocuments).set({ verificationStatus: status }).where(eq(complianceDocuments.id, id));
  return true;
}
async function listOperators() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(operators).orderBy(desc(operators.updatedAt)).limit(100);
}
async function createOperator(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(operators).values(input);
  return result[0]?.insertId;
}
async function listUnits() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(units).orderBy(units.unitNumber).limit(100);
}
async function createUnit(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(units).values(input);
  return result[0]?.insertId;
}
async function listLoadProfiles() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(loadProfiles).orderBy(desc(loadProfiles.createdAt)).limit(100);
}
async function createLoadProfile(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(loadProfiles).values(input);
  return result[0]?.insertId;
}
async function listFacilities() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(facilities).orderBy(facilities.name).limit(100);
}
async function createFacility(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(facilities).values(input);
  return result[0]?.insertId;
}
async function listMaintenanceDefects() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(maintenanceDefects).orderBy(desc(maintenanceDefects.reportedAt)).limit(100);
}
async function createMaintenanceDefect(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(maintenanceDefects).values(input);
  return result[0]?.insertId;
}
async function listDeliveries() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(deliveries).orderBy(desc(deliveries.createdAt)).limit(100);
}
async function createDelivery(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(deliveries).values(input);
  return result[0]?.insertId;
}
async function createSignatureAudit(input) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.insert(signatureAudits).values(input);
  return result[0]?.insertId;
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/routers.ts
import { TRPCError as TRPCError3 } from "@trpc/server";
import { z as z2 } from "zod";

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/storage.ts
function getForgeConfig() {
  const forgeUrl = ENV.forgeApiUrl;
  const forgeKey = ENV.forgeApiKey;
  if (!forgeUrl || !forgeKey) {
    throw new Error(
      "Storage config missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }
  return { forgeUrl: forgeUrl.replace(/\/+$/, ""), forgeKey };
}
function normalizeKey(relKey) {
  return relKey.replace(/^\/+/, "");
}
function appendHashSuffix(relKey) {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}
async function storagePut(relKey, data, contentType = "application/octet-stream") {
  const { forgeUrl, forgeKey } = getForgeConfig();
  const key = appendHashSuffix(normalizeKey(relKey));
  const presignUrl = new URL("v1/storage/presign/put", forgeUrl + "/");
  presignUrl.searchParams.set("path", key);
  const presignResp = await fetch(presignUrl, {
    headers: { Authorization: `Bearer ${forgeKey}` }
  });
  if (!presignResp.ok) {
    const msg = await presignResp.text().catch(() => presignResp.statusText);
    throw new Error(`Storage presign failed (${presignResp.status}): ${msg}`);
  }
  const { url: s3Url } = await presignResp.json();
  if (!s3Url) throw new Error("Forge returned empty presign URL");
  const blob = typeof data === "string" ? new Blob([data], { type: contentType }) : new Blob([data], { type: contentType });
  const uploadResp = await fetch(s3Url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob
  });
  if (!uploadResp.ok) {
    throw new Error(`Storage upload to S3 failed (${uploadResp.status})`);
  }
  return { key, url: `/manus-storage/${key}` };
}

// server/routers.ts
var jobInput = z2.object({
  jobCode: z2.string().min(1).max(32),
  type: z2.string().min(1).max(120),
  mode: z2.enum(["general", "hydrovac", "recovery", "transport"]).default("general"),
  customer: z2.string().min(1).max(160),
  location: z2.string().min(1).max(220),
  vehicle: z2.string().max(120).optional(),
  driver: z2.string().max(120).optional(),
  status: z2.enum(["dispatched", "in_transit", "loading", "on_site", "awaiting_docs", "complete"]).default("dispatched"),
  progress: z2.number().int().min(0).max(100).default(0),
  eta: z2.string().max(32).optional(),
  latitude: z2.number().optional(),
  longitude: z2.number().optional()
});
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  fieldRoute: router({
    jobs: router({
      list: protectedProcedure.query(() => listJobs()),
      byCode: protectedProcedure.input(z2.object({ jobCode: z2.string().min(1) })).query(({ input }) => getJobByCode(input.jobCode)),
      create: protectedProcedure.input(jobInput).mutation(({ input }) => createJob(input))
    }),
    evidence: router({
      list: protectedProcedure.query(() => listEvidenceRecords()),
      upload: protectedProcedure.input(z2.object({
        title: z2.string().min(1).max(220),
        category: z2.string().min(1).max(80),
        fileName: z2.string().min(1).max(220),
        mimeType: z2.string().min(1).max(120),
        dataBase64: z2.string().min(1),
        latitude: z2.number().optional(),
        longitude: z2.number().optional(),
        notes: z2.string().optional()
      })).mutation(async ({ ctx, input }) => {
        const fileBuffer = Buffer.from(input.dataBase64, "base64");
        if (fileBuffer.byteLength > 15 * 1024 * 1024) {
          throw new TRPCError3({ code: "BAD_REQUEST", message: "Evidence files must be 15 MB or smaller." });
        }
        const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
        const stored = await storagePut(`${ctx.user.id}/evidence/${Date.now()}-${safeName}`, fileBuffer, input.mimeType);
        const id = await createEvidenceRecord({
          title: input.title,
          category: input.category,
          storageKey: stored.key,
          storageUrl: stored.url,
          mimeType: input.mimeType,
          capturedAt: /* @__PURE__ */ new Date(),
          capturedBy: ctx.user.id,
          latitude: input.latitude,
          longitude: input.longitude,
          status: "needs_review",
          notes: input.notes
        });
        return { id, ...stored };
      }),
      add: protectedProcedure.input(z2.object({
        jobId: z2.number().int().optional(),
        title: z2.string().min(1).max(220),
        category: z2.string().min(1).max(80),
        storageKey: z2.string().max(512).optional(),
        storageUrl: z2.string().max(1024).optional(),
        mimeType: z2.string().max(120).optional(),
        capturedAt: z2.coerce.date(),
        capturedBy: z2.number().int().optional(),
        latitude: z2.number().optional(),
        longitude: z2.number().optional(),
        status: z2.enum(["needs_review", "verified", "unverified"]).default("needs_review"),
        notes: z2.string().optional()
      })).mutation(({ input }) => createEvidenceRecord(input)),
      verify: protectedProcedure.input(z2.object({ id: z2.number().int().positive() })).mutation(({ input }) => verifyEvidenceRecord(input.id))
    }),
    routeContext: router({
      list: protectedProcedure.query(() => listRouteContexts()),
      create: protectedProcedure.input(z2.object({
        name: z2.string().min(1).max(180),
        source: z2.string().min(1).max(220),
        effectiveAt: z2.coerce.date(),
        expiresAt: z2.coerce.date().optional(),
        verifiedAt: z2.coerce.date().optional(),
        confidence: z2.enum(["low", "medium", "high"]).default("medium"),
        restrictions: z2.string().optional(),
        snapshotKey: z2.string().max(512).optional(),
        snapshotUrl: z2.string().max(1024).optional()
      })).mutation(({ input }) => createRouteContext(input))
    }),
    routeDecisions: router({
      list: protectedProcedure.query(() => listRouteDecisions()),
      create: protectedProcedure.input(z2.object({ tripId: z2.string().min(1).max(40), selectedRoute: z2.string().min(1).max(180), alternatives: z2.string().optional(), vehicleType: z2.string().min(1).max(100), gvwTonnes: z2.number().int().positive(), axleCount: z2.number().int().positive(), heightMetres: z2.number().int().positive(), widthMetres: z2.number().int().positive(), lengthMetres: z2.number().int().positive(), hazmatClass: z2.string().max(40).optional(), quantity: z2.string().max(80).optional(), riskLevel: z2.enum(["low", "moderate", "high", "blocked"]).default("moderate"), source: z2.string().max(180).optional(), confidence: z2.string().max(40).optional(), driverAcknowledged: z2.number().int().default(0) })).mutation(({ input }) => createRouteDecision(input))
    }),
    billing: router({
      rateCards: router({
        list: protectedProcedure.query(() => listBillingRateCards()),
        create: protectedProcedure.input(z2.object({ name: z2.string().min(1).max(160), unitType: z2.string().min(1).max(100), hourlyRate: z2.number().int().nonnegative().default(0), dailyRate: z2.number().int().nonnegative().default(0), jumpHourRate: z2.number().int().nonnegative().default(0), disposalRate: z2.number().int().nonnegative().default(0), specialtyEquipmentRate: z2.number().int().nonnegative().default(0), currency: z2.string().length(3).default("CAD"), active: z2.number().int().default(1) })).mutation(({ input }) => createBillingRateCard(input)),
        update: protectedProcedure.input(z2.object({ id: z2.number().int().positive(), hourlyRate: z2.number().int().nonnegative().optional(), dailyRate: z2.number().int().nonnegative().optional(), jumpHourRate: z2.number().int().nonnegative().optional(), disposalRate: z2.number().int().nonnegative().optional(), specialtyEquipmentRate: z2.number().int().nonnegative().optional() })).mutation(({ input }) => {
          const { id, ...values } = input;
          return updateBillingRateCard(id, values);
        })
      }),
      lines: router({
        list: protectedProcedure.input(z2.object({ jobId: z2.number().int().optional() }).optional()).query(({ input }) => listJobChargeLines(input?.jobId)),
        create: protectedProcedure.input(z2.object({ jobId: z2.number().int().optional(), description: z2.string().min(1).max(220), quantity: z2.number().int().positive(), unitRate: z2.number().int().nonnegative(), source: z2.string().max(80).default("rate_card") })).mutation(({ input }) => createJobChargeLine({ ...input, amount: input.quantity * input.unitRate }))
      })
    }),
    vendors: router({
      list: protectedProcedure.query(() => listVendors()),
      update: protectedProcedure.input(z2.object({ id: z2.number().int().positive(), phone: z2.string().max(40).optional(), emergencyPhone: z2.string().max(40).optional(), availability: z2.string().max(100).optional(), notes: z2.string().optional() })).mutation(({ input }) => {
        const { id, ...values } = input;
        return updateVendor(id, values);
      }),
      create: protectedProcedure.input(z2.object({ name: z2.string().min(1).max(180), category: z2.string().min(1).max(100), contactName: z2.string().max(160).optional(), phone: z2.string().max(40).optional(), emergencyPhone: z2.string().max(40).optional(), email: z2.string().email().optional(), coverageArea: z2.string().max(220).optional(), availability: z2.string().max(100).optional(), notes: z2.string().optional() })).mutation(({ input }) => createVendor(input))
    }),
    unitSafety: router({
      list: protectedProcedure.query(() => listUnitSafetyPlans()),
      update: protectedProcedure.input(z2.object({ id: z2.number().int().positive(), hazardSummary: z2.string().optional(), shutdownProcedure: z2.string().optional(), requiredPpe: z2.string().optional(), sdsReferences: z2.string().optional(), emergencyContacts: z2.string().optional(), version: z2.number().int().optional() })).mutation(({ input }) => {
        const { id, ...values } = input;
        return updateUnitSafetyPlan(id, values);
      }),
      create: protectedProcedure.input(z2.object({ unitId: z2.number().int().optional(), unitLabel: z2.string().min(1).max(120), hazardSummary: z2.string().optional(), shutdownProcedure: z2.string().optional(), requiredPpe: z2.string().optional(), sdsReferences: z2.string().optional(), emergencyContacts: z2.string().optional(), version: z2.number().int().default(1) })).mutation(({ input }) => createUnitSafetyPlan(input))
    }),
    complianceEngine: router({
      artifacts: router({
        list: protectedProcedure.query(() => listComplianceArtifacts()),
        create: protectedProcedure.input(z2.object({ trackingNumber: z2.string().min(1).max(40), artifactType: z2.string().min(1).max(40), jobId: z2.number().int().optional(), locationId: z2.number().int().optional(), manifestId: z2.number().int().optional(), status: z2.enum(["active", "completed", "archived", "legal_hold"]).default("active"), jurisdiction: z2.string().max(100).optional(), regulatoryProfile: z2.string().max(180).optional(), regulatoryVersion: z2.string().max(100).optional(), retentionUntil: z2.coerce.date().optional(), metadata: z2.string().optional() })).mutation(({ input }) => createComplianceArtifact(input))
      }),
      tailgates: router({
        list: protectedProcedure.query(() => listTailgateMeetings()),
        create: protectedProcedure.input(z2.object({ trackingNumber: z2.string().min(1).max(40), jobId: z2.number().int().optional(), locationId: z2.number().int().optional(), supervisor: z2.string().max(180).optional(), operators: z2.string().optional(), units: z2.string().optional(), hazards: z2.string().optional(), ppe: z2.string().optional(), controls: z2.string().optional(), voiceTranscript: z2.string().optional(), reviewStatus: z2.enum(["needs_review", "approved"]).default("needs_review"), startedAt: z2.coerce.date().optional(), endedAt: z2.coerce.date().optional() })).mutation(({ input }) => createTailgateMeeting(input))
      }),
      transfers: router({
        list: protectedProcedure.query(() => listTransferAcknowledgements()),
        create: protectedProcedure.input(z2.object({ trackingNumber: z2.string().min(1).max(40), channel: z2.enum(["email", "portal", "api", "download"]), recipient: z2.string().min(1).max(220), deliveryStatus: z2.enum(["pending", "confirmed", "failed", "opened"]).default("pending"), messageId: z2.string().max(180).optional(), attachmentCount: z2.number().int().default(0), acknowledgedBy: z2.string().max(180).optional(), acknowledgedAt: z2.coerce.date().optional() })).mutation(({ input }) => createTransferAcknowledgement(input)),
        acknowledge: protectedProcedure.input(z2.object({ id: z2.number().int().positive(), acknowledgedBy: z2.string().min(1).max(180) })).mutation(({ input }) => acknowledgeTransfer(input.id, input.acknowledgedBy))
      })
    }),
    locations: router({
      list: protectedProcedure.query(() => listLocationIdentities()),
      create: protectedProcedure.input(z2.object({ name: z2.string().min(1).max(180), surfaceLsd: z2.string().min(1).max(80), downholeLsd: z2.string().max(80).optional(), uwi: z2.string().max(120).optional(), wellLicense: z2.string().max(100).optional(), operator: z2.string().max(180).optional(), lease: z2.string().max(180).optional(), field: z2.string().max(160).optional(), province: z2.string().max(100).optional(), accessRoad: z2.string().max(220).optional(), gate: z2.string().max(180).optional(), hazards: z2.string().optional(), emergencyInfo: z2.string().optional(), surfaceLatitude: z2.number().optional(), surfaceLongitude: z2.number().optional(), downholeLatitude: z2.number().optional(), downholeLongitude: z2.number().optional(), source: z2.string().max(220).optional(), lastVerifiedAt: z2.coerce.date().optional() })).mutation(({ input }) => createLocationIdentity(input))
    }),
    manifests: router({
      list: protectedProcedure.query(() => listManifests()),
      create: protectedProcedure.input(z2.object({ manifestNumber: z2.string().min(1).max(80), locationId: z2.number().int().optional(), jobId: z2.number().int().optional(), material: z2.string().max(220).optional(), unNumber: z2.string().max(40).optional(), unitId: z2.number().int().optional(), trailer: z2.string().max(100).optional(), driver: z2.string().max(180).optional(), route: z2.string().max(220).optional(), facility: z2.string().max(220).optional(), scaleTickets: z2.string().optional(), evidenceRefs: z2.string().optional(), signatureRefs: z2.string().optional(), status: z2.enum(["draft", "verified", "complete"]).default("draft") })).mutation(({ input }) => createManifest(input))
    }),
    scans: router({
      list: protectedProcedure.query(() => listScanAudits()),
      create: protectedProcedure.input(z2.object({ scanType: z2.enum(["qr", "nfc"]), subjectType: z2.enum(["unit", "location", "manifest"]), subjectId: z2.number().int(), accessRole: z2.enum(["inspection", "driver", "mechanic", "dispatcher", "admin"]), scannedAt: z2.coerce.date(), latitude: z2.number().optional(), longitude: z2.number().optional() })).mutation(({ input }) => createScanAudit(input))
    }),
    identity: router({
      operators: router({
        list: protectedProcedure.query(() => listOperators()),
        create: protectedProcedure.input(z2.object({
          userId: z2.number().int().optional(),
          name: z2.string().min(1).max(180),
          company: z2.string().max(180).optional(),
          licenseNumber: z2.string().max(100).optional(),
          licenseClass: z2.string().max(40).optional(),
          licenseExpiresAt: z2.coerce.date().optional(),
          restrictions: z2.string().optional(),
          trainingStatus: z2.string().max(120).optional(),
          certifications: z2.string().optional(),
          insurance: z2.string().optional(),
          emergencyContact: z2.string().max(220).optional()
        })).mutation(({ input }) => createOperator(input))
      }),
      units: router({
        list: protectedProcedure.query(() => listUnits()),
        create: protectedProcedure.input(z2.object({
          unitNumber: z2.string().min(1).max(40),
          vin: z2.string().max(80).optional(),
          plate: z2.string().max(40).optional(),
          vehicleType: z2.string().min(1).max(120),
          company: z2.string().max(180).optional(),
          weightKg: z2.number().int().optional(),
          axles: z2.number().int().optional(),
          dimensions: z2.string().max(160).optional(),
          equipment: z2.string().optional(),
          inspectionStatus: z2.enum(["current", "due", "blocked"]).default("current"),
          maintenanceStatus: z2.enum(["clear", "review", "blocked"]).default("clear"),
          qrTag: z2.string().max(120).optional()
        })).mutation(({ input }) => createUnit(input))
      }),
      jobUnits: router({
        list: protectedProcedure.query(() => listJobUnits()),
        create: protectedProcedure.input(z2.object({ jobId: z2.number().int(), unitId: z2.number().int(), operatorId: z2.number().int().optional(), role: z2.string().min(1).max(100), joinedAt: z2.coerce.date(), departedAt: z2.coerce.date().optional(), hours: z2.number().int().optional(), mileage: z2.number().int().optional(), workPerformed: z2.string().optional() })).mutation(({ input }) => createJobUnit(input))
      }),
      inspections: router({
        list: protectedProcedure.query(() => listInspections()),
        create: protectedProcedure.input(z2.object({ unitId: z2.number().int(), type: z2.enum(["training", "pre_trip", "post_trip"]), status: z2.enum(["pass", "fail", "needs_maintenance", "not_applicable"]).default("pass"), checklist: z2.string().optional(), resultSummary: z2.string().optional(), observedAt: z2.coerce.date(), authenticatedOperatorId: z2.number().int().optional() })).mutation(({ input }) => createInspection(input))
      }),
      documents: router({
        list: protectedProcedure.query(() => listComplianceDocuments()),
        create: protectedProcedure.input(z2.object({ ownerType: z2.enum(["operator", "unit", "job"]), ownerId: z2.number().int(), docType: z2.string().min(1).max(100), title: z2.string().min(1).max(220), storageKey: z2.string().max(512).optional(), storageUrl: z2.string().max(1024).optional(), capturedAt: z2.coerce.date(), expiresAt: z2.coerce.date().optional(), verificationStatus: z2.enum(["needs_review", "verified", "rejected"]).default("needs_review"), source: z2.string().max(220).optional(), confidence: z2.enum(["low", "medium", "high"]).default("medium") })).mutation(({ input }) => createComplianceDocument(input)),
        review: protectedProcedure.input(z2.object({ id: z2.number().int().positive(), status: z2.enum(["verified", "rejected"]) })).mutation(({ input }) => reviewComplianceDocument(input.id, input.status))
      })
    }),
    compliance: router({
      loads: router({
        list: protectedProcedure.query(() => listLoadProfiles()),
        create: protectedProcedure.input(z2.object({ jobId: z2.number().int(), material: z2.string().min(1).max(220), isWaste: z2.boolean().default(false), composition: z2.string().optional(), sdsStorageKey: z2.string().max(512).optional(), sdsStorageUrl: z2.string().max(1024).optional(), unNumber: z2.string().max(40).optional(), properShippingName: z2.string().max(220).optional(), dgClass: z2.string().max(40).optional(), packingGroup: z2.string().max(40).optional(), quantity: z2.string().max(80).optional(), transportMode: z2.string().max(80).optional(), jurisdiction: z2.string().max(120).optional(), classificationStatus: z2.enum(["needs_verification", "verified", "blocked"]).default("needs_verification"), source: z2.string().max(220).optional(), confidence: z2.enum(["low", "medium", "high"]).default("low"), verifiedAt: z2.coerce.date().optional() })).mutation(({ input }) => createLoadProfile(input))
      }),
      facilities: router({
        list: protectedProcedure.query(() => listFacilities()),
        create: protectedProcedure.input(z2.object({ name: z2.string().min(1).max(220), status: z2.enum(["unknown", "open", "closed"]).default("unknown"), operatingHours: z2.string().max(120).optional(), acceptedMaterials: z2.string().optional(), restrictions: z2.string().optional(), phone: z2.string().max(60).optional(), emergencyPhone: z2.string().max(60).optional(), gateInstructions: z2.string().optional(), requiredDocuments: z2.string().optional(), lastVerifiedAt: z2.coerce.date().optional(), latitude: z2.number().optional(), longitude: z2.number().optional() })).mutation(({ input }) => createFacility(input))
      }),
      maintenance: router({
        list: protectedProcedure.query(() => listMaintenanceDefects()),
        create: protectedProcedure.input(z2.object({ unitId: z2.number().int(), title: z2.string().min(1).max(220), severity: z2.enum(["advisory", "inspection_required", "critical"]).default("advisory"), status: z2.enum(["open", "in_progress", "resolved"]).default("open"), detail: z2.string().optional(), storageKey: z2.string().max(512).optional(), storageUrl: z2.string().max(1024).optional(), reportedAt: z2.coerce.date(), reportedBy: z2.number().int().optional(), workOrderNumber: z2.string().max(80).optional(), completedAt: z2.coerce.date().optional() })).mutation(({ input }) => createMaintenanceDefect(input))
      }),
      deliveries: router({
        list: protectedProcedure.query(() => listDeliveries()),
        create: protectedProcedure.input(z2.object({ jobId: z2.number().int(), recipientRole: z2.string().min(1).max(80), recipient: z2.string().min(1).max(220), status: z2.enum(["queued", "delivered", "failed"]).default("queued"), deliveredAt: z2.coerce.date().optional() })).mutation(({ input }) => createDelivery(input))
      }),
      sign: protectedProcedure.input(z2.object({ jobId: z2.number().int(), signerName: z2.string().min(1).max(180), authMethod: z2.string().min(1).max(120), signedAt: z2.coerce.date(), documentHash: z2.string().max(180).optional(), status: z2.enum(["pending", "authenticated", "invalidated"]).default("pending") })).mutation(({ input }) => createSignatureAudit(input))
    }),
    safety: router({
      list: protectedProcedure.query(() => listSafetyEvents()),
      create: protectedProcedure.input(z2.object({
        jobId: z2.number().int().optional(),
        eventType: z2.string().min(1).max(80),
        severity: z2.enum(["info", "warning", "critical"]).default("info"),
        title: z2.string().min(1).max(220),
        detail: z2.string().optional(),
        occurredAt: z2.coerce.date(),
        status: z2.enum(["open", "acknowledged", "resolved"]).default("open")
      })).mutation(({ input }) => createSafetyEvent(input))
    })
  })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
startServer().catch(console.error);
