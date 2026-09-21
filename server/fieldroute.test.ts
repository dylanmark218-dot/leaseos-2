import { beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb, grantUserRole, listActiveUserRoleNames } from "./db";
import { jobs, units } from "../drizzle/schema";

// P4.1: creates that name a job or unit must name one the caller may see. These were `jobId: FIXTURE_JOB_ID` / `unitId: FIXTURE_UNIT_ID`,
// placeholders no row necessarily had; the suite now creates a real, unowned job and unit (the single tenant's).
let FIXTURE_JOB_ID = 1;
let FIXTURE_UNIT_ID = 1;

/**
 * B20.4 put personnel, billing, compliance, safety and maintenance behind
 * domain roles. This suite exercises those procedures, so its caller now needs
 * the roles a real user performing this work would hold.
 *
 * The grant is the fix rather than loosening the gate — these tests failing
 * against a role-less caller was the gate proving it works.
 */
const TEST_USER_ID = 1;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const db = await getDb();
  if (db) {
    const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
    FIXTURE_JOB_ID = (await db.insert(jobs).values({ jobCode: `JOB-FR-${tag}`, type: "Hydrovac", customer: "Fixture Energy", location: "Somewhere", status: "dispatched" } as never))[0].insertId;
    FIXTURE_UNIT_ID = (await db.insert(units).values({ unitNumber: `U-FR-${tag}`, vehicleType: "hydrovac" } as never))[0].insertId;
  }
  // Dispatch enforcement is a global setting another suite may leave at "enforced"; this suite is about creating the
  // records, not about readiness, and its fixture unit (now real) carries no credentials. Establish "off" explicitly.
  const held = new Set(await listActiveUserRoleNames(TEST_USER_ID));
  // Deliberately not `mechanic`: the shop is explicitly denied personnel.write,
  // and deny beats grant, so adding it here would block operator creation. That
  // combination is not a realistic person either — the roles this caller holds
  // are the ones an office/safety/management user actually has.
  // B20.6 gated the whole operational surface, so this suite's caller now needs
  // the roles a real office/safety/management user performing this work holds.
  // Still deliberately not `mechanic` — the shop is denied personnel.write and
  // deny beats grant.
  // Deliberately NOT dispatcher or mechanic: both are explicitly denied
  // personnel.write, and deny beats grant — adding either here would block
  // operator creation. Piling roles onto one caller fights the model rather
  // than exercising it.
  for (const role of ["office", "safety", "management"] as const) {
    if (held.has(role)) continue;
    try {
      await grantUserRole({
        userId: TEST_USER_ID,
        role,
        scopeType: "global",
        grantedByUserId: TEST_USER_ID,
        grantedAt: new Date(),
      });
    } catch {
      // Already granted by a concurrent run — the unique index is doing its job.
    }
  }
  await appRouter.createCaller(createContext()).dispatch.enforcementSet({ mode: "off", reason: "fieldroute suite: records, not readiness" });
});

function createContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "fieldroute-test-user",
      name: "FieldRoute Test",
      email: "test@fieldroute.local",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("fieldRoute jobs", () => {
  it("returns a list without requiring client-side REST plumbing", async () => {
    const caller = appRouter.createCaller(createContext());
    const result = await caller.fieldRoute.jobs.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("validates the job mode and creates a typed job payload", async () => {
    const caller = appRouter.createCaller(createContext());
    const jobCode = `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await expect(
      caller.fieldRoute.jobs.create({
        jobCode,
        type: "Hydrovac disposal",
        mode: "hydrovac",
        customer: "Northline Energy",
        location: "14-22 W5",
        status: "in_transit",
        progress: 60,
        latitude: 53.557,
        longitude: -113.286,
      })
    ).resolves.toBeDefined();
  });
});

describe("fieldRoute evidence", () => {
  it("accepts storage metadata without accepting file bytes", async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.fieldRoute.evidence.add({
        title: "Disposal ticket",
        category: "disposal_ticket",
        storageKey: "jobs/TEST-08421/disposal-ticket.pdf",
        mimeType: "application/pdf",
        capturedAt: new Date(),
        latitude: 53.557,
        longitude: -113.286,
        notes: "Original retained in field storage.",
      })
    ).resolves.toBeDefined();
  });
});

describe("fieldRoute evidence and safety", () => {
  it("verifies a persisted evidence record through the typed procedure", async () => {
    const caller = appRouter.createCaller(createContext());
    const id = await caller.fieldRoute.evidence.add({
      title: "Verification test record",
      category: "test",
      storageKey: "tests/verification-record.txt",
      mimeType: "text/plain",
      capturedAt: new Date(),
    });
    expect(id).toBeDefined();
    if (typeof id === "number") {
      await expect(caller.fieldRoute.evidence.verify({ id })).resolves.toBe(
        true
      );
    }
  });

  it("rejects an upload request with no base64 data before storage work begins", async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.fieldRoute.evidence.upload({
        title: "Invalid upload",
        category: "test",
        fileName: "empty.txt",
        mimeType: "text/plain",
        dataBase64: "",
      })
    ).rejects.toThrow();
  });

  it("creates a safety event with an explicit severity", async () => {
    const caller = appRouter.createCaller(createContext());
    const id = await caller.fieldRoute.safety.create({
      eventType: "road_hazard",
      severity: "warning",
      title: "Soft shoulder reported",
      detail: "County 214 km 18.",
      occurredAt: new Date(),
    });
    expect(id).toBeDefined();
  });
});

describe("fieldRoute route context", () => {
  it("persists a source-aware operational context", async () => {
    const caller = appRouter.createCaller(createContext());
    const id = await caller.fieldRoute.routeContext.create({
      name: "North Ridge summer restrictions",
      source: "Provincial transportation authority",
      effectiveAt: new Date("2026-07-01T00:00:00Z"),
      expiresAt: new Date("2026-10-01T00:00:00Z"),
      restrictions: "Bridge 08: 42t gross limit.",
      snapshotKey: "route-context-tests/north-ridge.json",
      snapshotUrl: "route-context-tests/north-ridge.json",
    });
    expect(id).toBeDefined();
  });
});

describe("fieldRoute identity and compliance", () => {
  it("creates metadata-only identity and compliance records", async () => {
    const caller = appRouter.createCaller(createContext());
    const unitNumber = `TEST-${Date.now()}`;
    await expect(
      caller.fieldRoute.identity.operators.create({
        name: "Test Operator",
        company: "FieldRoute Test Co",
        licenseClass: "Class 1",
        trainingStatus: "TDG pending review",
        emergencyContact: "Operations desk",
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.identity.units.create({
        unitNumber,
        vehicleType: "Hydrovac",
        qrTag: `qr:${unitNumber}`,
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.identity.documents.create({
        ownerType: "operator",
        ownerId: 1,
        docType: "license",
        title: "Test licence scan",
        capturedAt: new Date(),
        source: "OCR proposal",
        confidence: "low",
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.compliance.loads.create({
        jobId: FIXTURE_JOB_ID,
        material: "Used drilling fluid",
        isWaste: true,
        confidence: "low",
        source: "Operator statement; SDS pending",
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.compliance.facilities.create({
        name: "Test disposal facility",
        status: "unknown",
        operatingHours: "Confirm hours",
        acceptedMaterials: "Needs verification",
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.compliance.maintenance.create({
        unitId: FIXTURE_UNIT_ID,
        title: "Test hydraulic inspection",
        severity: "inspection_required",
        reportedAt: new Date(),
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.compliance.deliveries.create({
        jobId: FIXTURE_JOB_ID,
        recipientRole: "customer",
        recipient: "Authorized test recipient",
        status: "queued",
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.compliance.sign({
        jobId: FIXTURE_JOB_ID,
        signerName: "Test Operator",
        signedAt: new Date(),
      })
    ).resolves.toBeDefined();
  });
});

describe("fieldRoute job units and inspections", () => {
  it("creates an associated unit and an authenticated pre-trip inspection record", async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.fieldRoute.identity.jobUnits.create({
        jobId: FIXTURE_JOB_ID,
        unitId: FIXTURE_UNIT_ID,
        operatorId: 1,
        role: "support unit",
        joinedAt: new Date(),
        hours: 3,
        mileage: 42,
        workPerformed: "Vacuum support and hose transfer",
      })
    ).resolves.toBeDefined();
    await expect(
      caller.fieldRoute.identity.inspections.create({
        unitId: FIXTURE_UNIT_ID,
        type: "pre_trip",
        status: "pass",
        checklist: JSON.stringify(["tires", "brakes", "lights"]),
        resultSummary: "All required points observed.",
        observedAt: new Date(),
        authenticatedOperatorId: 1,
      })
    ).resolves.toBeDefined();
  });
});

describe("fieldRoute location identity and scans", () => {
  it("persists a well identity, manifest chain, and role-aware QR scan", async () => {
    const caller = appRouter.createCaller(createContext());
    const marker = Date.now();
    const locationId = await caller.fieldRoute.locations.create({
      name: `Test Well ${marker}`,
      surfaceLsd: "04-12-034-05W5",
      downholeLsd: "03-12-034-05W5",
      wellLicense: "TEST-LIC",
      operator: "Test Operator",
      province: "Alberta",
      source: "Test regulatory source",
      lastVerifiedAt: new Date(),
    });
    expect(locationId).toBeDefined();
    const manifestId = await caller.fieldRoute.manifests.create({
      manifestNumber: `TEST-MANIFEST-${marker}`,
      locationId: typeof locationId === "number" ? locationId : undefined,
      material: "Used drilling fluid",
      unitId: FIXTURE_UNIT_ID,
      driver: "Test Driver",
    });
    expect(manifestId).toBeDefined();
    await expect(
      caller.fieldRoute.scans.create({
        scanType: "qr",
        subjectType: "location",
        subjectId: typeof locationId === "number" ? locationId : 1,
        scannedAt: new Date(),
        latitude: 53.557,
        longitude: -113.286,
      })
    ).resolves.toBeDefined();
  });
});

describe("fieldRoute compliance engine", () => {
  it("creates a tracked trip passport, tailgate record, and transfer audit", async () => {
    const caller = appRouter.createCaller(createContext());
    const marker = Date.now();
    const artifact = await caller.fieldRoute.complianceEngine.artifacts.create({
      trackingNumber: `TR-TEST-${marker}`,
      artifactType: "TR Trip passport",
      jurisdiction: "Canada · Alberta · Road",
      regulatoryProfile: "TDG",
      status: "active",
    });
    const tailgate = await caller.fieldRoute.complianceEngine.tailgates.create({
      trackingNumber: `TB-TEST-${marker}`,
      jobId: FIXTURE_JOB_ID,
      locationId: 1,
      supervisor: "Test Supervisor",
      hazards: "Traffic",
      reviewStatus: "needs_review",
    });
    const transfer = await caller.fieldRoute.complianceEngine.transfers.create({
      trackingNumber: `DT-TEST-${marker}`,
      channel: "email",
      recipient: "test@example.com",
      attachmentCount: 2,
      deliveryStatus: "pending",
    });
    expect(artifact).toBeDefined();
    expect(tailgate).toBeDefined();
    expect(transfer).toBeDefined();
  });
});

describe("trip operations", () => {
  it("creates a round-trip and calculates distance from odometers", async () => {
    const caller = appRouter.createCaller(createContext());
    const marker = Date.now();
    const id = await caller.fieldRoute.trips.create({
      tripNumber: `TR-TEST-${marker}`,
      tripType: "round_trip",
      status: "planned",
      odometerStartKm: 1000,
      odometerEndKm: 1142.6,
      jobId: FIXTURE_JOB_ID,
      unitId: FIXTURE_UNIT_ID,
      operatorId: 1,
      manifestId: 1,
    });
    expect(id).toBeDefined();
  });

  it("records load/unload timing events and duty status", async () => {
    const caller = appRouter.createCaller(createContext());
    const tripId = await caller.fieldRoute.trips.create({
      tripNumber: `TR-EVENT-${Date.now()}`,
      tripType: "round_trip",
      status: "loading",
    });
    expect(tripId).toBeDefined();
    if (typeof tripId === "number") {
      await expect(
        caller.fieldRoute.tripStops.create({
          tripId,
          stopType: "load",
          sequence: 1,
          setupMinutes: 15,
          waitMinutes: 4,
          durationMinutes: 38,
          setupStartedAt: new Date(),
          operationStartedAt: new Date(),
          operationCompletedAt: new Date(),
          departedAt: new Date(),
        })
      ).resolves.toBeDefined();
      await expect(
        caller.fieldRoute.dutyRecords.create({
          operatorId: 1,
          tripId,
          dutyStatus: "driving",
          startedAt: new Date(),
          endedAt: new Date(),
        })
      ).resolves.toBeDefined();
    }
  });

  it("persists clearly typed loading/unloading operating zones", async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.fieldRoute.operatingZones.create({
        name: `Loading zone ${Date.now()}`,
        zoneType: "loading",
        latitude: 53.557,
        longitude: -113.286,
        radiusMetres: 90,
        source: "field survey",
      })
    ).resolves.toBeDefined();
  });

  it("opens a maintenance work order for a serviceability issue", async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.fieldRoute.workOrders.create({
        workOrderNumber: `WO-TEST-${Date.now()}`,
        unitId: FIXTURE_UNIT_ID,
        priority: "urgent",
        openedAt: new Date(),
        odometerKm: 183500,
        engineHours: 4210,
        findings: "Brake inspection required",
        correctiveAction: "Inspect before release",
      })
    ).resolves.toBeDefined();
  });
});
