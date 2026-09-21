import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  calibrationEffectOnUse, calibrationImpact, calibrationStatus, equipmentAuthorization, evaluateWorkContext,
  flattenContext, packsActivatedBy, requirementsInForce, type CalibrationEvent, type EquipmentAuthorizationRecord, type WorkContext,
} from "./_core/requirementEngine";
import type { Credential, Requirement } from "./_core/compliancePassport";
import { COMPLIANCE_PACK_SEEDS, COMPLIANCE_REQUIREMENT_SEEDS, EQUIPMENT_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { authorize, type DomainRole } from "./_core/recordsAuthorization";

const NOW = new Date("2026-09-10T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const cred = (docType: string, over: Partial<Credential> = {}): Credential => ({ docType, expiresAt: days(400), verificationStatus: "verified", privateDetail: false, ...over });
const verified = (r: Requirement): Requirement => ({ ...r, verificationStatus: "verified" });

/* ------------------------------------------------------------------ */
/* Packs                                                                */
/* ------------------------------------------------------------------ */

describe("a hydrovac company and a crane company get different rules from the same core", () => {
  it("activates packs by company profile", () => {
    const hydrovac = packsActivatedBy({ jurisdiction: "CA-AB", attributes: { activities: ["hydrovac"], billsByMeasurement: true } }, COMPLIANCE_PACK_SEEDS);
    expect(hydrovac).toContain("core.ab_carrier");
    expect(hydrovac).toContain("ab.powered_mobile_equipment");
    expect(hydrovac).toContain("ab.confined_space");
    expect(hydrovac).toContain("ab.ground_disturbance");
    expect(hydrovac).toContain("measurement.billing_devices");
    expect(hydrovac).not.toContain("ab.lifting_devices");
    expect(hydrovac).not.toContain("ab.pressure_equipment");

    const crane = packsActivatedBy({ jurisdiction: "CA-AB", attributes: { activities: ["lifting"] } }, COMPLIANCE_PACK_SEEDS);
    expect(crane).toContain("ab.lifting_devices");
    expect(crane).not.toContain("ab.ground_disturbance");
  });

  it("puts only in-force requirements in front of a company", () => {
    const all = [...COMPLIANCE_REQUIREMENT_SEEDS, ...EQUIPMENT_REQUIREMENT_SEEDS];
    const forTrucking = requirementsInForce(all, new Set(["core.ab_carrier"]));
    expect(forTrucking.some(r => r.requirementKey === "ab.lifting.logbook")).toBe(false);
    expect(forTrucking.some(r => r.requirementKey === "ab.driver.licence.class1")).toBe(true); // core, no pack
    const forCrane = requirementsInForce(all, new Set(["core.ab_carrier", "ab.lifting_devices"]));
    expect(forCrane.some(r => r.requirementKey === "ab.lifting.logbook")).toBe(true);
  });

  it("seeds every pack requirement unverified", () => {
    expect(EQUIPMENT_REQUIREMENT_SEEDS.length).toBeGreaterThan(8);
    expect(EQUIPMENT_REQUIREMENT_SEEDS.every(r => r.verificationStatus === "unverified" && r.packKey)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Work context                                                         */
/* ------------------------------------------------------------------ */

const ctx = (over: Partial<WorkContext> = {}): WorkContext => ({
  jurisdiction: "CA-AB", at: NOW,
  worker: { id: 9, attributes: { licenceClassRequired: "1" }, credentials: [cred("driver_licence"), cred("equipment_operator_authorization")] },
  equipment: { id: 42, equipmentType: "excavator_over_35t", attributes: { poweredMobile: true }, credentials: [cred("pre_use_inspection", { expiresAt: days(0.5) })] },
  attachments: [], work: { workType: "excavation" }, site: null, cargo: null, customer: null, ...over,
});

describe("who + what equipment + what work + where = what is required", () => {
  const reqs = [...COMPLIANCE_REQUIREMENT_SEEDS, ...EQUIPMENT_REQUIREMENT_SEEDS].map(verified);
  const packs = new Set(["core.ab_carrier", "ab.powered_mobile_equipment", "ab.confined_space", "ab.ground_disturbance"]);

  it("flattens the combination into one attribute bag", () => {
    const f = flattenContext(ctx({ attachments: [{ id: 1, attachmentType: "hydraulic_breaker" }] }));
    expect(f["equipment.poweredMobile"]).toBe(true);
    expect(f.equipmentType).toBe("excavator_over_35t");
    expect(f.attachmentTypes).toEqual(["hydraulic_breaker"]);
    expect(f.workType).toBe("excavation");
  });

  it("authorizes a credentialed worker on inspected powered equipment", () => {
    const r = evaluateWorkContext({ ctx: ctx(), requirements: reqs, activePacks: packs });
    expect(r.verdict, r.reasons.join(" | ")).toBe("authorized");
    expect(r.parts.worker).toBe("ready");
    expect(r.parts.equipment).toBe("ready");
    expect(r.parts.context).toBe("ready");
  });

  it("blocks ground disturbance without a utility locate, and confined-space entry without a permit", () => {
    const gd = evaluateWorkContext({ ctx: ctx({ work: { workType: "ground_disturbance" } }), requirements: reqs, activePacks: packs });
    expect(gd.verdict).toBe("blocked");
    expect(gd.reasons.join(" ")).toContain("Utility owner contacted");
    const cs = evaluateWorkContext({ ctx: ctx({ work: { workType: "confined_space_entry" } }), requirements: reqs, activePacks: packs });
    expect(cs.verdict).toBe("blocked");
    expect(cs.reasons.join(" ")).toContain("entry permit");
  });

  it("does not apply a pack's requirement to a company that has not activated it", () => {
    const withoutGd = new Set(["core.ab_carrier", "ab.powered_mobile_equipment"]);
    const r = evaluateWorkContext({ ctx: ctx({ work: { workType: "ground_disturbance" } }), requirements: reqs, activePacks: withoutGd });
    expect(r.verdict).toBe("authorized");
  });

  it("is UNKNOWN on the unverified seeds, whatever the credentials", () => {
    const r = evaluateWorkContext({ ctx: ctx(), requirements: [...COMPLIANCE_REQUIREMENT_SEEDS, ...EQUIPMENT_REQUIREMENT_SEEDS], activePacks: packs });
    expect(r.verdict).toBe("unknown");
  });

  it("holds a customer-required document at review, separately from the law", () => {
    const r = evaluateWorkContext({ ctx: ctx({ customer: { ref: "ACME", requiredDocTypes: ["acme_site_orientation"] } }), requirements: reqs, activePacks: packs });
    expect(r.verdict).toBe("review");
    expect(r.reasons.join(" ")).toContain("customer: requires acme_site_orientation");
  });

  it("blocks when the pre-use inspection lapsed", () => {
    const r = evaluateWorkContext({ ctx: ctx({ equipment: { id: 42, equipmentType: "excavator_over_35t", attributes: { poweredMobile: true }, credentials: [cred("pre_use_inspection", { expiresAt: days(-1) })] } }), requirements: reqs, activePacks: packs });
    expect(r.verdict).toBe("blocked");
    expect(r.parts.equipment).toBe("blocked");
  });
});

/* ------------------------------------------------------------------ */
/* Equipment authorization — four elements                             */
/* ------------------------------------------------------------------ */

const rec = (over: Partial<EquipmentAuthorizationRecord> = {}): EquipmentAuthorizationRecord => ({
  equipmentType: "excavator_over_35t", trainingEvidenceId: 1, competencyEvidenceId: 2, instructionsAcknowledgedAt: days(-30), authorizedByUserId: 5, authorizedAt: days(-30), expiresAt: days(300), status: "authorized", ...over,
});

describe("trained, competent, familiar with instructions, employer-authorized", () => {
  it("authorizes only when all four are on record", () => {
    expect(equipmentAuthorization({ records: [rec()], equipmentType: "excavator_over_35t", attachmentTypes: [], now: NOW }).verdict).toBe("authorized");
    for (const gap of [{ trainingEvidenceId: null }, { competencyEvidenceId: null, competencyAssessedAt: null }, { instructionsAcknowledgedAt: null }, { authorizedByUserId: null, authorizedAt: null }] as const) {
      const v = equipmentAuthorization({ records: [rec(gap)], equipmentType: "excavator_over_35t", attachmentTypes: [], now: NOW });
      expect(v.verdict, JSON.stringify(gap)).toBe("blocked");
      expect(v.reason).toContain("all four elements are required");
    }
  });

  it("is per exact equipment type — a skid steer does not authorize an excavator", () => {
    const v = equipmentAuthorization({ records: [rec({ equipmentType: "skid_steer" })], equipmentType: "excavator_over_35t", attachmentTypes: [], now: NOW });
    expect(v.verdict).toBe("blocked");
    expect(v.reason).toContain("No authorization on record for excavator_over_35t");
  });

  it("is per attachment — a bucket does not authorize a personnel basket", () => {
    const records = [rec(), rec({ attachmentType: "bucket" })];
    expect(equipmentAuthorization({ records, equipmentType: "excavator_over_35t", attachmentTypes: ["bucket"], now: NOW }).verdict).toBe("authorized");
    const v = equipmentAuthorization({ records, equipmentType: "excavator_over_35t", attachmentTypes: ["personnel_basket"], now: NOW });
    expect(v.verdict).toBe("blocked");
    expect(v.reason).toContain("Not authorized on attachment personnel_basket");
  });

  it("blocks suspended, revoked and expired; reviews when expiring", () => {
    expect(equipmentAuthorization({ records: [rec({ status: "suspended" })], equipmentType: "excavator_over_35t", attachmentTypes: [], now: NOW }).verdict).toBe("blocked");
    expect(equipmentAuthorization({ records: [rec({ expiresAt: days(-1) })], equipmentType: "excavator_over_35t", attachmentTypes: [], now: NOW }).verdict).toBe("blocked");
    expect(equipmentAuthorization({ records: [rec({ expiresAt: days(10) })], equipmentType: "excavator_over_35t", attachmentTypes: [], now: NOW }).verdict).toBe("review");
  });
});

/* ------------------------------------------------------------------ */
/* Calibration                                                          */
/* ------------------------------------------------------------------ */

describe("one expiry, different consequences", () => {
  const cal = (over: Partial<CalibrationEvent> = {}): CalibrationEvent => ({ eventType: "calibrated", performedAt: days(-100), ...over });

  it("derives status from the latest good event and the interval", () => {
    expect(calibrationStatus({ events: [cal()], intervalDays: 180, now: NOW }).status).toBe("current");
    expect(calibrationStatus({ events: [cal({ performedAt: days(-170) })], intervalDays: 180, now: NOW }).status).toBe("due_soon");
    expect(calibrationStatus({ events: [cal({ performedAt: days(-200) })], intervalDays: 180, now: NOW }).status).toBe("expired");
    expect(calibrationStatus({ events: [], intervalDays: 180, now: NOW }).status).toBe("unknown");
    expect(calibrationStatus({ events: [cal()], intervalDays: null, now: NOW }).status).toBe("unknown");
  });

  it("voids a calibration on a failure until returned to service", () => {
    const failed = calibrationStatus({ events: [cal(), cal({ eventType: "out_of_tolerance_found", performedAt: days(-5) })], intervalDays: 180, now: NOW });
    expect(failed.status).toBe("failed");
    const back = calibrationStatus({ events: [cal(), cal({ eventType: "out_of_tolerance_found", performedAt: days(-5) }), cal({ eventType: "returned_to_service", performedAt: days(-1) })], intervalDays: 180, now: NOW });
    expect(back.status).toBe("current");
  });

  it("puts billing on hold and makes weight uncertifiable, while dispatch is only reviewed", () => {
    const expired = calibrationStatus({ events: [cal({ performedAt: days(-200) })], intervalDays: 180, now: NOW });
    expect(calibrationEffectOnUse(expired, "billing").effect).toBe("hold");
    expect(calibrationEffectOnUse(expired, "weight_compliance").effect).toBe("cannot_certify");
    expect(calibrationEffectOnUse(expired, "dispatch_availability").effect).toBe("review");
    expect(calibrationEffectOnUse(expired, "safety_reading").effect).toBe("review");
    const failed = calibrationStatus({ events: [cal({ eventType: "failed", performedAt: days(-1) })], intervalDays: 180, now: NOW });
    expect(calibrationEffectOnUse(failed, "safety_reading").effect).toBe("hold");
    const current = calibrationStatus({ events: [cal()], intervalDays: 180, now: NOW });
    expect(calibrationEffectOnUse(current, "billing").effect).toBe("ok");
  });

  it("bounds the impact window from suspectFrom, not from the finding", () => {
    const finding: CalibrationEvent = { eventType: "out_of_tolerance_found", performedAt: days(0), suspectFrom: days(-21) };
    const impact = calibrationImpact({
      finding, returnedToServiceAt: null,
      dependents: [
        { recordType: "load", recordId: 1, measuredAt: days(-30), downstream: { invoiceRefs: ["INV-1"] } },   // before window
        { recordType: "load", recordId: 2, measuredAt: days(-14), downstream: { invoiceRefs: ["INV-2"], billingBookIds: [7] } },
        { recordType: "disposal_ticket", recordId: 3, measuredAt: days(-3), downstream: { permitRefs: ["PRM-9"] } },
        { recordType: "load", recordId: 4, measuredAt: days(1), downstream: { invoiceRefs: ["INV-4"] } },     // after
      ],
    });
    expect(impact.affected.map(a => a.recordId)).toEqual([2, 3]);
    expect(impact.invoiceRefs).toEqual(["INV-2"]);
    expect(impact.permitRefs).toEqual(["PRM-9"]);
    expect(impact.summary).toContain("2 measurement(s)");
  });
});

/* ------------------------------------------------------------------ */
/* Permissions and the flow                                             */
/* ------------------------------------------------------------------ */

const ALL_ROLES: DomainRole[] = ["driver","dispatcher","mechanic","shop_lead","safety","office","management","hr","legal","auditor","bookkeeper","payroll_admin","tax_preparer","controller","external_accountant"];

describe("who activates a pack, who authorizes equipment", () => {
  it("reserves pack activation to management and controller, equipment authorization to safety and management", () => {
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "compliance.pack.manage" }).allowed).sort()).toEqual(["controller", "management"]);
    expect(ALL_ROLES.filter(r => authorize({ userId: 1, roles: [r], permission: "equipment.authorize" }).allowed).sort()).toEqual(["management", "safety"]);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let userSeq = 330000 + Math.floor(Math.random() * 50000);
const nextUser = () => userSeq++;
const key = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 6 }); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
async function withRole(role: DomainRole) { const id = nextUser(); await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("a scale found wrong for three weeks", () => {
  it("answers which loads and invoices depended on it", async () => {
    const shopLead = await withRole("shop_lead");
    const mechanic = await withRole("mechanic");
    const entityId = 800000 + Math.floor(Math.random() * 90000);

    const dev = await callerFor(mechanic).calibration.deviceRegister({ financialEntityId: entityId, deviceType: "truck_scale", measures: "gross_weight", unitOfMeasure: "kg", calibrationIntervalDays: 180 });
    await callerFor(mechanic).calibration.eventRecord({ deviceRef: dev.deviceRef, eventType: "calibrated", performedAt: new Date("2026-06-12T00:00:00Z") });

    // Three loads measured on it: one before the suspect window, two inside.
    const bookId = 500000 + Math.floor(Math.random() * 90000);
    const mk = async (createdAt: string, withBook: boolean) => {
      const [r] = await pool.execute<mysql.ResultSetHeader>(
        "INSERT INTO loads (loadNumber, jobId, measurementMethod, measurementDeviceId, chainState, billingBookId, createdAt) VALUES (?, 1, 'scale', ?, 'weighed', ?, ?)",
        [key("LD").slice(0, 40), dev.deviceId, withBook ? bookId : null, createdAt]
      );
      return Number(r.insertId);
    };
    const before = await mk("2026-08-01 10:00:00", false);
    const inside1 = await mk("2026-08-25 10:00:00", true);
    const inside2 = await mk("2026-09-05 10:00:00", true);
    const invNo = key("INV").slice(0, 40);
    await pool.execute("INSERT INTO invoices (invoiceNumber, billingBookId, jobId, customer, subtotalCents, taxCents, totalCents, currency, status) VALUES (?, ?, 1, 'C', 100, 5, 105, 'CAD', 'draft')", [invNo, bookId]);

    // A failure finding must say from when the device was suspect.
    await expect(callerFor(mechanic).calibration.eventRecord({ deviceRef: dev.deviceRef, eventType: "out_of_tolerance_found", performedAt: new Date("2026-09-10T00:00:00Z"), errorFound: "+2.4% at 20 t" })).rejects.toThrow(/suspectFrom/);
    const ev = await callerFor(mechanic).calibration.eventRecord({ deviceRef: dev.deviceRef, eventType: "out_of_tolerance_found", performedAt: new Date("2026-09-10T00:00:00Z"), suspectFrom: new Date("2026-08-20T00:00:00Z"), errorFound: "+2.4% at 20 t" });
    expect(ev.state.status).toBe("failed");
    expect(ev.effects.billing.effect).toBe("hold");
    expect(ev.effects.weight_compliance.effect).toBe("cannot_certify");
    expect(ev.effects.dispatch_availability.effect).toBe("review");

    // The mechanic cannot run the impact analysis; the shop lead can.
    await expect(callerFor(mechanic).calibration.impact({ deviceRef: dev.deviceRef })).rejects.toBeTruthy();
    const imp = await callerFor(shopLead).calibration.impact({ deviceRef: dev.deviceRef });
    expect(imp.impact).not.toBeNull();
    const ids = imp.impact!.affected.map(a => a.recordId).sort();
    expect(ids).toEqual([inside1, inside2].sort());
    expect(ids).not.toContain(before);
    expect(imp.impact!.invoiceRefs).toEqual([invNo]);
    expect(imp.impact!.billingBookIds).toEqual([bookId]);

    const [devRow] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM measurementDevices WHERE deviceRef = ?", [dev.deviceRef]);
    expect(devRow[0].status).toBe("out_of_service");
  });

  it("records an employer authorization as pending until all four elements exist", async () => {
    const safety = await withRole("safety");
    const entityId = 810000 + Math.floor(Math.random() * 90000);
    const partial = await callerFor(safety).requirement.authorize({ userId: 77, financialEntityId: entityId, equipmentType: "hydrovac", trainingEvidenceId: 1 });
    expect(partial.status).toBe("pending");
    expect(partial.note).toContain("all be on record");
    const full = await callerFor(safety).requirement.authorize({ userId: 77, financialEntityId: entityId, equipmentType: "hydrovac", trainingEvidenceId: 1, competencyAssessedAt: new Date(), instructionsAcknowledgedAt: new Date() });
    expect(full.status).toBe("authorized");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, authorizedByUserId FROM operatorEquipmentAuthorizations WHERE authorizationRef = ?", [full.authorizationRef]);
    expect(rows[0].status).toBe("authorized");
    expect(Number(rows[0].authorizedByUserId)).toBe(safety);
  });

  it("evaluates a work context through the API with packs from the profile", async () => {
    const dispatcher = await withRole("dispatcher");
    const r = await callerFor(dispatcher).requirement.workAuthorization({
      financialEntityId: 1, jurisdiction: "CA-AB", companyAttributes: { activities: ["hydrovac"] },
      worker: { id: 999999, attributes: {} }, equipment: { id: 999999, equipmentType: "hydrovac", attributes: { poweredMobile: true } },
      work: { workType: "ground_disturbance", attributes: {} },
    });
    expect(r.activePacks).toContain("ab.ground_disturbance");
    // Seeds are unverified: unknown, not authorized — and blocked beats it if
    // a verified rule were missing evidence. With no credentials on record at
    // all and unverified rules, the honest answer is unknown.
    expect(["unknown", "blocked"]).toContain(r.verdict);
  });
});
