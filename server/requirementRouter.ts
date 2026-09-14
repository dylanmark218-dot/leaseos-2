/**
 * Requirement engine, packs, equipment authorization, calibration — the API.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import {
  calibrationEvents, companyPackActivations, complianceDocuments, disposalTickets, invoices, loads,
  measurementDevices, operatorEquipmentAuthorizations,
} from "../drizzle/schema";
import {
  calibrationEffectOnUse, calibrationImpact, calibrationStatus, equipmentAuthorization, evaluateWorkContext, packsActivatedBy,
  type CalibrationEvent, type DependentMeasurement, type MeasurementUse, type WorkContext,
} from "./_core/requirementEngine";
import { COMPLIANCE_PACK_SEEDS, COMPLIANCE_REQUIREMENT_SEEDS, EQUIPMENT_REQUIREMENT_SEEDS } from "./_core/complianceRequirementSeeds";
import type { Credential } from "./_core/compliancePassport";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function activePacksFor(entityId: number, profile: { jurisdiction: string; attributes: Record<string, unknown> }): Promise<Set<string>> {
  const auto = packsActivatedBy(profile, COMPLIANCE_PACK_SEEDS);
  const db = await getDb();
  const explicit = db
    ? (await db.select({ packKey: companyPackActivations.packKey }).from(companyPackActivations)
        .where(and(eq(companyPackActivations.financialEntityId, entityId), isNull(companyPackActivations.deactivatedAt)))).map(r => r.packKey)
    : [];
  return new Set([...auto, ...explicit]);
}

async function credentialsFor(ownerType: string, ownerId: number): Promise<Credential[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.ownerType, ownerType as never), eq(complianceDocuments.ownerId, ownerId)));
  return rows.map(r => ({ docType: r.docType, requirementKey: r.requirementKey, issuedAt: r.issuedAt, expiresAt: r.expiresAt, verificationStatus: r.verificationStatus, privateDetail: r.privateDetail, jurisdiction: r.jurisdiction }));
}

const ATTRS = z.record(z.string(), z.unknown()).default({});

export const requirementRouter = router({
  packActivate: roleProcedure("compliance.packActivate")
    .input(z.object({ financialEntityId: z.number().int().positive(), packKey: z.string().min(2).max(80), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (!COMPLIANCE_PACK_SEEDS.some(p => p.packKey === input.packKey)) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown pack" });
      await db.insert(companyPackActivations).values({ financialEntityId: input.financialEntityId, packKey: input.packKey, activatedAt: new Date(), activatedByUserId: ctx.user.id, reason: input.reason ?? null });
      return { packKey: input.packKey, requirementsInPack: EQUIPMENT_REQUIREMENT_SEEDS.filter(r => r.packKey === input.packKey).length };
    }),

  /** WHO + WHAT + WHERE + WHEN + ... = AUTHORIZED / REVIEW / BLOCKED / UNKNOWN. */
  workAuthorization: roleProcedure("compliance.workAuthorization")
    .input(z.object({
      financialEntityId: z.number().int().positive(), jurisdiction: z.string().min(2).max(80),
      companyAttributes: ATTRS, at: z.coerce.date().optional(),
      worker: z.object({ id: z.number().int().positive(), attributes: ATTRS }).nullable(),
      equipment: z.object({ id: z.number().int().positive(), equipmentType: z.string().min(1).max(80), attributes: ATTRS }).nullable(),
      attachments: z.array(z.object({ id: z.number().int().positive(), attachmentType: z.string().min(1).max(80), attributes: ATTRS })).default([]),
      work: z.object({ workType: z.string().min(1).max(80), attributes: ATTRS }),
      site: z.object({ id: z.number().int().positive().nullable(), attributes: ATTRS }).nullable().optional(),
      cargo: z.object({ classification: z.string().nullable(), dangerousGoods: z.boolean() }).nullable().optional(),
      customer: z.object({ ref: z.string().nullable(), requiredDocTypes: z.array(z.string()).optional() }).nullable().optional(),
    }))
    .query(async ({ input }) => {
      const activePacks = await activePacksFor(input.financialEntityId, { jurisdiction: input.jurisdiction, attributes: input.companyAttributes });
      const ctx: WorkContext = {
        jurisdiction: input.jurisdiction, at: input.at ?? new Date(),
        worker: input.worker ? { ...input.worker, credentials: await credentialsFor("operator", input.worker.id) } : null,
        equipment: input.equipment ? { ...input.equipment, credentials: await credentialsFor("equipment", input.equipment.id) } : null,
        attachments: await Promise.all(input.attachments.map(async a => ({ ...a, credentials: await credentialsFor("equipment", a.id) }))),
        work: input.work, site: input.site ?? null, cargo: input.cargo ?? null, customer: input.customer ?? null,
      };
      const result = evaluateWorkContext({ ctx, requirements: [...COMPLIANCE_REQUIREMENT_SEEDS, ...EQUIPMENT_REQUIREMENT_SEEDS], activePacks });
      return { ...result, activePacks: Array.from(activePacks).sort() };
    }),

  /** The employer's act. All four elements are recorded; authorization is their conjunction. */
  authorize: roleProcedure("equipment.authorize")
    .input(z.object({
      userId: z.number().int().positive(), financialEntityId: z.number().int().positive(),
      equipmentType: z.string().min(1).max(80), attachmentType: z.string().max(80).nullable().optional(),
      trainingEvidenceId: z.number().int().positive().nullable().optional(), competencyEvidenceId: z.number().int().positive().nullable().optional(),
      competencyAssessedAt: z.coerce.date().nullable().optional(), instructionsAcknowledgedAt: z.coerce.date().nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const now = new Date();
      const complete = input.trainingEvidenceId != null && (input.competencyEvidenceId != null || input.competencyAssessedAt != null) && input.instructionsAcknowledgedAt != null;
      const authorizationRef = ref("EQA");
      await db.insert(operatorEquipmentAuthorizations).values({
        authorizationRef, userId: input.userId, financialEntityId: input.financialEntityId, equipmentType: input.equipmentType, attachmentType: input.attachmentType ?? null,
        trainingEvidenceId: input.trainingEvidenceId ?? null, competencyEvidenceId: input.competencyEvidenceId ?? null,
        competencyAssessedByUserId: input.competencyAssessedAt ? ctx.user.id : null, competencyAssessedAt: input.competencyAssessedAt ?? null,
        instructionsAcknowledgedAt: input.instructionsAcknowledgedAt ?? null,
        // The employer's authorization is this call, by this person — but only
        // when the other three elements are on record. Otherwise it is pending.
        authorizedByUserId: complete ? ctx.user.id : null, authorizedAt: complete ? now : null,
        expiresAt: input.expiresAt ?? null, status: complete ? "authorized" : "pending",
      });
      return { authorizationRef, status: complete ? ("authorized" as const) : ("pending" as const), note: complete ? undefined : "Pending: training, competency and instruction acknowledgement must all be on record before the employer's authorization takes effect" };
    }),
});

export const calibrationRouter = router({
  deviceRegister: roleProcedure("calibration.deviceRegister")
    .input(z.object({
      financialEntityId: z.number().int().positive(),
      deviceType: z.enum(["truck_scale","onboard_load_sensor","load_cell","fuel_meter","flow_meter","vacuum_gauge","pressure_gauge","torque_wrench","gas_detector","sound_meter","temperature_probe","hydraulic_gauge","other"]),
      manufacturer: z.string().max(120).nullable().optional(), model: z.string().max(120).nullable().optional(), serialNumber: z.string().max(120).nullable().optional(),
      measures: z.string().min(1).max(60), unitOfMeasure: z.string().min(1).max(20), calibrationIntervalDays: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const deviceRef = ref("MD");
      const ins = await db.insert(measurementDevices).values({ deviceRef, ...input, manufacturer: input.manufacturer ?? null, model: input.model ?? null, serialNumber: input.serialNumber ?? null, calibrationIntervalDays: input.calibrationIntervalDays ?? null });
      return { deviceRef, deviceId: Number(ins[0]?.insertId ?? 0) };
    }),

  eventRecord: roleProcedure("calibration.eventRecord")
    .input(z.object({
      deviceRef: z.string().min(1).max(64),
      eventType: z.enum(["calibrated","verified","failed","adjusted","out_of_tolerance_found","returned_to_service"]),
      performedAt: z.coerce.date(), performedBy: z.string().max(180).nullable().optional(), certificateEvidenceId: z.number().int().positive().nullable().optional(),
      standardReference: z.string().max(180).nullable().optional(), toleranceStated: z.string().max(80).nullable().optional(), errorFound: z.string().max(120).nullable().optional(),
      suspectFrom: z.coerce.date().nullable().optional(), validUntil: z.coerce.date().nullable().optional(), notes: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const dev = (await db.select().from(measurementDevices).where(eq(measurementDevices.deviceRef, input.deviceRef)).limit(1))[0];
      if (!dev) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      if ((input.eventType === "failed" || input.eventType === "out_of_tolerance_found") && !input.suspectFrom) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A failure finding needs suspectFrom — from when was the device suspect? That bounds the impact analysis." });
      }
      await db.insert(calibrationEvents).values({ measurementDeviceId: dev.id, eventType: input.eventType, performedAt: input.performedAt, performedBy: input.performedBy ?? null, certificateEvidenceId: input.certificateEvidenceId ?? null, standardReference: input.standardReference ?? null, toleranceStated: input.toleranceStated ?? null, errorFound: input.errorFound ?? null, suspectFrom: input.suspectFrom ?? null, validUntil: input.validUntil ?? null, notes: input.notes ?? null, recordedByUserId: ctx.user.id });
      if (input.eventType === "failed" || input.eventType === "out_of_tolerance_found") await db.update(measurementDevices).set({ status: "out_of_service" }).where(eq(measurementDevices.id, dev.id));
      if (input.eventType === "returned_to_service") await db.update(measurementDevices).set({ status: "active" }).where(eq(measurementDevices.id, dev.id));
      const events = await db.select().from(calibrationEvents).where(eq(calibrationEvents.measurementDeviceId, dev.id));
      const state = calibrationStatus({ events: events as CalibrationEvent[], intervalDays: dev.calibrationIntervalDays, now: new Date() });
      const uses: MeasurementUse[] = ["billing", "weight_compliance", "dispatch_availability", "safety_reading"];
      return { deviceRef: dev.deviceRef, state, effects: Object.fromEntries(uses.map(u => [u, calibrationEffectOnUse(state, u)])) };
    }),

  /** Which records depended on a device found wrong. */
  impact: roleProcedure("calibration.impact")
    .input(z.object({ deviceRef: z.string().min(1).max(64) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const dev = (await db.select().from(measurementDevices).where(eq(measurementDevices.deviceRef, input.deviceRef)).limit(1))[0];
      if (!dev) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      const events = await db.select().from(calibrationEvents).where(eq(calibrationEvents.measurementDeviceId, dev.id)).orderBy(desc(calibrationEvents.performedAt));
      const finding = events.find(e => e.eventType === "failed" || e.eventType === "out_of_tolerance_found");
      if (!finding) return { deviceRef: dev.deviceRef, finding: null, impact: null };
      const rts = events.find(e => e.eventType === "returned_to_service" && e.performedAt > finding.performedAt);

      const loadRows = await db.select({ id: loads.id, createdAt: loads.createdAt, billingBookId: loads.billingBookId }).from(loads).where(eq(loads.measurementDeviceId, dev.id));
      const ticketRows = await db.select({ id: disposalTickets.id, createdAt: disposalTickets.createdAt, scaleInAt: disposalTickets.scaleInAt }).from(disposalTickets).where(eq(disposalTickets.measurementDeviceId, dev.id));
      const bookIds = Array.from(new Set(loadRows.map(l => l.billingBookId).filter((x): x is number => x != null)));
      const invoiceRows = bookIds.length ? await db.select({ invoiceNumber: invoices.invoiceNumber, billingBookId: invoices.billingBookId }).from(invoices) : [];
      const invoicesByBook = new Map<number, string[]>();
      for (const inv of invoiceRows) if (inv.billingBookId != null && bookIds.includes(inv.billingBookId)) invoicesByBook.set(inv.billingBookId, [...(invoicesByBook.get(inv.billingBookId) ?? []), inv.invoiceNumber]);

      const dependents: DependentMeasurement[] = [
        ...loadRows.map(l => ({ recordType: "load" as const, recordId: l.id, measuredAt: l.createdAt, downstream: { billingBookIds: l.billingBookId ? [l.billingBookId] : [], invoiceRefs: l.billingBookId ? invoicesByBook.get(l.billingBookId) ?? [] : [] } })),
        ...ticketRows.map(t => ({ recordType: "disposal_ticket" as const, recordId: t.id, measuredAt: t.scaleInAt ?? t.createdAt, downstream: {} })),
      ];
      const impact = calibrationImpact({ finding: finding as CalibrationEvent, dependents, returnedToServiceAt: rts?.performedAt ?? null });
      return { deviceRef: dev.deviceRef, finding: { eventType: finding.eventType, performedAt: finding.performedAt, suspectFrom: finding.suspectFrom, errorFound: finding.errorFound }, impact };
    }),
});
