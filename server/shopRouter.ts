/**
 * Fleet Shop — the API.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { evaluateMechanicRelease } from "./_core/mechanicRelease";
import { appendWorkOrderRelease } from "./recordsService";
import { actingScopeFor, getDb, unitInScope, workOrderInScope } from "./db";
import { partMovements, parts, recallNotices, recallUnitStatus, serializedTools, tireInstallations, tireMeasurements, tires, toolCheckouts, vendorBillLines, warrantyClaims, warrantyPolicies, workOrders, maintenanceDefects } from "../drizzle/schema";
import { claimDecision, claimEligibility, countAdjustment, installDecision, issueDecision, reorderFindings, signedQty, stockPositions, tireRun, treadStatus, workOrderCost, type Movement } from "./_core/fleetShop";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const TREAD_LIMIT_MM = { steer: 4.0, drive: 2.4, trailer: 2.4, any: 2.4 } as const; // configuration, not regulation: the shop's own thresholds
const KIND = z.enum(["receive", "issue", "return_to_stock", "core_out", "core_returned", "warranty_return", "scrap", "transfer_in", "transfer_out"]);

async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
async function partByNumber(partNumber: string) { const db = await dbOrThrow(); const p = (await db.select().from(parts).where(eq(parts.partNumber, partNumber)).limit(1))[0]; if (!p) throw new TRPCError({ code: "NOT_FOUND", message: `Part ${partNumber} not found` }); return p; }
async function positionsFor(partId: number) { const db = await dbOrThrow(); const rows = await db.select().from(partMovements).where(eq(partMovements.partId, partId)); return stockPositions(rows.map(r => ({ partId: r.partId, bin: r.bin, kind: r.kind, qtySigned: r.qtySigned, unitCostCents: r.unitCostCents, at: r.at }) as Movement)); }
async function move(args: { partId: number; bin: string; kind: Movement["kind"]; qty: number; unitCostCents?: number | null; workOrderId?: number | null; unitId?: number | null; vendorBillLineId?: number | null; warrantyClaimId?: number | null; reason?: string | null; byUserId: number; at?: Date }) {
  const db = await dbOrThrow();
  const movementRef = ref("MOV");
  await db.insert(partMovements).values({ movementRef, partId: args.partId, bin: args.bin, kind: args.kind, qtySigned: args.kind === "adjust_count" ? args.qty : signedQty(args.kind, args.qty), unitCostCents: args.unitCostCents ?? null, workOrderId: args.workOrderId ?? null, unitId: args.unitId ?? null, vendorBillLineId: args.vendorBillLineId ?? null, warrantyClaimId: args.warrantyClaimId ?? null, reason: args.reason ?? null, byUserId: args.byUserId, at: args.at ?? new Date() });
  return movementRef;
}

export const shopRouter = router({
  partCreate: roleProcedure("shop.partCreate")
    .input(z.object({ partNumber: z.string().min(1).max(80), oemNumber: z.string().max(80).nullable().optional(), description: z.string().min(1).max(220), category: z.enum(["tire", "filter", "fluid", "belt_hose", "brake", "electrical", "hydraulic", "driveline", "body", "consumable", "other"]), uom: z.string().max(20).default("each"), isCore: z.boolean().default(false), coreChargeCents: z.number().int().nonnegative().nullable().optional(), minQty: z.number().int().nonnegative().nullable().optional(), maxQty: z.number().int().nonnegative().nullable().optional(), preferredVendorId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      if (input.isCore && input.coreChargeCents == null) throw new TRPCError({ code: "BAD_REQUEST", message: "A core part needs its core charge" });
      if (input.minQty != null && input.maxQty != null && input.maxQty < input.minQty) throw new TRPCError({ code: "BAD_REQUEST", message: "Maximum below minimum" });
      const partRef = ref("PART");
      await db.insert(parts).values({ partRef, partNumber: input.partNumber, oemNumber: input.oemNumber ?? null, description: input.description, category: input.category, uom: input.uom, isCore: input.isCore, coreChargeCents: input.coreChargeCents ?? null, minQty: input.minQty ?? null, maxQty: input.maxQty ?? null, preferredVendorId: input.preferredVendorId ?? null });
      return { partRef, partNumber: input.partNumber };
    }),

  /** Stock arrives with its cost, ideally from the vendor bill line that carries it. */
  partReceive: roleProcedure("shop.partReceive")
    .input(z.object({ partNumber: z.string().min(1).max(80), bin: z.string().max(40).default("MAIN"), qty: z.number().int().positive(), unitCostCents: z.number().int().nonnegative(), vendorBillLineId: z.number().int().positive().nullable().optional(), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const p = await partByNumber(input.partNumber);
      if (input.vendorBillLineId) { const db = await dbOrThrow(); const l = (await db.select({ id: vendorBillLines.id, lineType: vendorBillLines.lineType }).from(vendorBillLines).where(eq(vendorBillLines.id, input.vendorBillLineId)).limit(1))[0]; if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "Vendor bill line not found" }); if (l.lineType !== "part") throw new TRPCError({ code: "BAD_REQUEST", message: `Bill line is ${l.lineType}, not a part` }); }
      const movementRef = await move({ partId: p.id, bin: input.bin, kind: "receive", qty: input.qty, unitCostCents: input.unitCostCents, vendorBillLineId: input.vendorBillLineId ?? null, reason: input.reason ?? null, byUserId: ctx.user.id });
      const pos = (await positionsFor(p.id)).find(x => x.bin === input.bin)!;
      return { movementRef, onHandQty: pos.onHandQty, avgUnitCostCents: pos.avgUnitCostCents };
    }),

  /** Issue to a work order: refused beyond on-hand, by the shortfall. A core part also records the core going out. */
  partIssue: roleProcedure("shop.partIssue")
    .input(z.object({ partNumber: z.string().min(1).max(80), bin: z.string().max(40).default("MAIN"), qty: z.number().int().positive(), workOrderNumber: z.string().min(1).max(64), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
      const db = await dbOrThrow();
      const p = await partByNumber(input.partNumber);
      const wo = (await db.select({ id: workOrders.id, unitId: workOrders.unitId, status: workOrders.status }).from(workOrders).where(eq(workOrders.workOrderNumber, input.workOrderNumber)).limit(1))[0];
      if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "Work order not found" });
      if (wo.status === "closed" || wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Work order is ${wo.status}` });
      const pos = (await positionsFor(p.id)).find(x => x.bin === input.bin) ?? { onHandQty: 0, avgUnitCostCents: null };
      const d = issueDecision({ onHandQty: pos.onHandQty, qty: input.qty, partNumber: p.partNumber });
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusal! });
      const movementRef = await move({ partId: p.id, bin: input.bin, kind: "issue", qty: input.qty, unitCostCents: pos.avgUnitCostCents, workOrderId: wo.id, unitId: wo.unitId, reason: input.reason ?? null, byUserId: ctx.user.id });
      let coreRef: string | null = null;
      if (p.isCore) coreRef = await move({ partId: p.id, bin: input.bin, kind: "core_out", qty: input.qty, workOrderId: wo.id, unitId: wo.unitId, reason: `Core out with ${movementRef}`, byUserId: ctx.user.id });
      return { movementRef, coreMovementRef: coreRef, onHandQty: pos.onHandQty - input.qty, issuedAtAvgCostCents: pos.avgUnitCostCents };
    }),

  partReturn: roleProcedure("shop.partReturn")
    .input(z.object({ partNumber: z.string().min(1).max(80), bin: z.string().max(40).default("MAIN"), qty: z.number().int().positive(), workOrderNumber: z.string().max(64).optional(), reason: z.string().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
      const p = await partByNumber(input.partNumber);
      const movementRef = await move({ partId: p.id, bin: input.bin, kind: "return_to_stock", qty: input.qty, reason: input.reason, byUserId: ctx.user.id });
      return { movementRef };
    }),

  coreReturn: roleProcedure("shop.coreReturn")
    .input(z.object({ partNumber: z.string().min(1).max(80), bin: z.string().max(40).default("MAIN"), qty: z.number().int().positive(), vendorBillLineId: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const p = await partByNumber(input.partNumber);
      const pos = (await positionsFor(p.id)).find(x => x.bin === input.bin);
      if (!pos || pos.coresOutstanding < input.qty) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${pos?.coresOutstanding ?? 0} core(s) outstanding; ${input.qty} returned` });
      const movementRef = await move({ partId: p.id, bin: input.bin, kind: "core_returned", qty: input.qty, vendorBillLineId: input.vendorBillLineId ?? null, byUserId: ctx.user.id });
      return { movementRef, coresOutstanding: pos.coresOutstanding - input.qty };
    }),

  /** A physical count: the record is adjusted to what was counted, and the variance is kept as the movement. */
  partCount: roleProcedure("shop.partCount")
    .input(z.object({ partNumber: z.string().min(1).max(80), bin: z.string().max(40).default("MAIN"), countedQty: z.number().int().nonnegative(), reason: z.string().min(3).max(300) }))
    .mutation(async ({ ctx, input }) => {
      const p = await partByNumber(input.partNumber);
      const pos = (await positionsFor(p.id)).find(x => x.bin === input.bin) ?? { onHandQty: 0 };
      const c = countAdjustment(pos.onHandQty, input.countedQty);
      if (c.qtySigned === 0) return { movementRef: null, variance: 0, finding: null };
      const movementRef = await move({ partId: p.id, bin: input.bin, kind: "adjust_count", qty: c.qtySigned, reason: `${input.reason} — ${c.finding}`, byUserId: ctx.user.id });
      return { movementRef, variance: c.variance, finding: c.finding };
    }),

  stock: roleProcedure("shop.stock").input(z.object({ partNumber: z.string().max(80).optional() })).query(async ({ input }) => {
    const db = await dbOrThrow();
    const ps = input.partNumber ? [await partByNumber(input.partNumber)] : await db.select().from(parts).where(eq(parts.status, "active"));
    const moves = ps.length ? await db.select().from(partMovements).where(inArray(partMovements.partId, ps.map(p => p.id))) : [];
    const positions = stockPositions(moves.map(r => ({ partId: r.partId, bin: r.bin, kind: r.kind, qtySigned: r.qtySigned, unitCostCents: r.unitCostCents, at: r.at }) as Movement));
    return { positions: positions.map(x => ({ ...x, partNumber: ps.find(p => p.id === x.partId)!.partNumber })), reorder: reorderFindings(ps, positions) };
  }),

  tireRegister: roleProcedure("shop.tireRegister")
    .input(z.object({ serial: z.string().min(1).max(80), brand: z.string().max(80).optional(), model: z.string().max(80).optional(), size: z.string().min(1).max(40), positionType: z.enum(["steer", "drive", "trailer", "any"]).default("any"), purchaseCostCents: z.number().int().nonnegative().nullable().optional(), purchaseVendorBillLineId: z.number().int().positive().nullable().optional(), casingOfSerial: z.string().max(80).optional() }))
    .mutation(async ({ input }) => {
      const db = await dbOrThrow();
      let casingOfTireId: number | null = null, retreadCount = 0;
      if (input.casingOfSerial) { const c = (await db.select().from(tires).where(eq(tires.serial, input.casingOfSerial)).limit(1))[0]; if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Casing tire not found" }); casingOfTireId = c.id; retreadCount = c.retreadCount + 1; await db.update(tires).set({ status: "retread_out" }).where(eq(tires.id, c.id)); }
      const tireRef = ref("TIRE");
      await db.insert(tires).values({ tireRef, serial: input.serial, brand: input.brand ?? null, model: input.model ?? null, size: input.size, positionType: input.positionType, casingOfTireId, retreadCount, purchaseCostCents: input.purchaseCostCents ?? null, purchaseVendorBillLineId: input.purchaseVendorBillLineId ?? null });
      return { tireRef, serial: input.serial, retreadCount };
    }),

  tireInstall: roleProcedure("shop.tireInstall")
    .input(z.object({ serial: z.string().min(1).max(80), unitId: z.number().int().positive(), axlePosition: z.string().min(2).max(8), installedAt: z.coerce.date(), installOdometerKm: z.number().int().nonnegative().nullable().optional(), installTreadMm: z.number().nonnegative().nullable().optional(), workOrderNumber: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
      const db = await dbOrThrow();
      const t = (await db.select().from(tires).where(eq(tires.serial, input.serial)).limit(1))[0];
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tire not found" });
      const open = await db.select().from(tireInstallations).where(and(eq(tireInstallations.unitId, input.unitId), isNull(tireInstallations.removedAt)));
      const mine = (await db.select({ id: tireInstallations.id }).from(tireInstallations).where(and(eq(tireInstallations.tireId, t.id), isNull(tireInstallations.removedAt))))[0];
      const d = installDecision({ tireStatus: t.status, positionType: t.positionType, axlePosition: input.axlePosition, occupiedPositions: open.map(o => o.axlePosition), tireCurrentlyInstalled: !!mine });
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      const wo = input.workOrderNumber ? (await db.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.workOrderNumber, input.workOrderNumber)).limit(1))[0] : undefined;
      const ins = await db.insert(tireInstallations).values({ tireId: t.id, unitId: input.unitId, axlePosition: input.axlePosition, installedAt: input.installedAt, installOdometerKm: input.installOdometerKm ?? null, installTreadMm: input.installTreadMm ?? null, workOrderId: wo?.id ?? null, byUserId: ctx.user.id });
      await db.update(tires).set({ status: "installed" }).where(eq(tires.id, t.id));
      return { installationId: Number(ins[0]?.insertId ?? 0), findings: input.installOdometerKm == null ? ["No install odometer — this tire's kilometres will be UNKNOWN"] : [] };
    }),

  tireRemove: roleProcedure("shop.tireRemove")
    .input(z.object({ serial: z.string().min(1).max(80), removedAt: z.coerce.date(), removeOdometerKm: z.number().int().nonnegative().nullable().optional(), removeTreadMm: z.number().nonnegative().nullable().optional(), removalReason: z.enum(["worn", "damage", "rotation", "retread", "warranty", "other"]), workOrderNumber: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
      const db = await dbOrThrow();
      const t = (await db.select().from(tires).where(eq(tires.serial, input.serial)).limit(1))[0];
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tire not found" });
      const inst = (await db.select().from(tireInstallations).where(and(eq(tireInstallations.tireId, t.id), isNull(tireInstallations.removedAt))).limit(1))[0];
      if (!inst) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Tire is not installed" });
      await db.update(tireInstallations).set({ removedAt: input.removedAt, removeOdometerKm: input.removeOdometerKm ?? null, removeTreadMm: input.removeTreadMm ?? null, removalReason: input.removalReason }).where(eq(tireInstallations.id, inst.id));
      await db.update(tires).set({ status: input.removalReason === "warranty" ? "warranty_claim" : input.removalReason === "retread" ? "retread_out" : "removed" }).where(eq(tires.id, t.id));
      const run = tireRun({ installOdometerKm: inst.installOdometerKm, removeOdometerKm: input.removeOdometerKm ?? null, installTreadMm: inst.installTreadMm, removeTreadMm: input.removeTreadMm ?? null, purchaseCostCents: t.purchaseCostCents });
      return { installationId: inst.id, ...run };
    }),

  tireMeasure: roleProcedure("shop.tireMeasure")
    .input(z.object({ serial: z.string().min(1).max(80), measuredAt: z.coerce.date(), treadMm: z.number().nonnegative().nullable().optional(), pressureKpa: z.number().nonnegative().nullable().optional(), odometerKm: z.number().int().nonnegative().nullable().optional(), note: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const t = (await db.select().from(tires).where(eq(tires.serial, input.serial)).limit(1))[0];
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tire not found" });
      const inst = (await db.select({ id: tireInstallations.id }).from(tireInstallations).where(and(eq(tireInstallations.tireId, t.id), isNull(tireInstallations.removedAt))).limit(1))[0];
      await db.insert(tireMeasurements).values({ tireId: t.id, installationId: inst?.id ?? null, measuredAt: input.measuredAt, treadMm: input.treadMm ?? null, pressureKpa: input.pressureKpa ?? null, odometerKm: input.odometerKm ?? null, byUserId: ctx.user.id, note: input.note ?? null });
      return { treadStatus: treadStatus(input.treadMm ?? null, TREAD_LIMIT_MM[t.positionType]), limitMm: TREAD_LIMIT_MM[t.positionType] };
    }),

  tireHistory: roleProcedure("shop.tireHistory").input(z.object({ serial: z.string().min(1).max(80) })).query(async ({ input }) => {
    const db = await dbOrThrow();
    const t = (await db.select().from(tires).where(eq(tires.serial, input.serial)).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tire not found" });
    const [insts, meas] = await Promise.all([db.select().from(tireInstallations).where(eq(tireInstallations.tireId, t.id)).orderBy(tireInstallations.installedAt), db.select().from(tireMeasurements).where(eq(tireMeasurements.tireId, t.id)).orderBy(tireMeasurements.measuredAt)]);
    const runs = insts.map(i => ({ unitId: i.unitId, axlePosition: i.axlePosition, installedAt: i.installedAt, removedAt: i.removedAt, removalReason: i.removalReason, ...tireRun({ installOdometerKm: i.installOdometerKm, removeOdometerKm: i.removeOdometerKm, installTreadMm: i.installTreadMm, removeTreadMm: i.removeTreadMm, purchaseCostCents: t.purchaseCostCents }) }));
    const totalKm = runs.reduce((a, r) => a + (r.kmRun ?? 0), 0);
    const kmKnown = runs.every(r => r.kmRun != null) && runs.length > 0;
    return { tire: { serial: t.serial, size: t.size, status: t.status, retreadCount: t.retreadCount, purchaseCostCents: t.purchaseCostCents }, installations: runs, measurements: meas.map(m => ({ measuredAt: m.measuredAt, treadMm: m.treadMm, pressureKpa: m.pressureKpa, odometerKm: m.odometerKm, status: treadStatus(m.treadMm, TREAD_LIMIT_MM[t.positionType]) })), lifetime: { kmRun: kmKnown ? totalKm : null, costPerKmCents: kmKnown && totalKm > 0 && t.purchaseCostCents != null ? Math.round(t.purchaseCostCents / totalKm * 100) / 100 : null, determination: kmKnown && t.purchaseCostCents != null && totalKm > 0 ? "computed" : "unknown" } };
  }),

  warrantyPolicyRecord: roleProcedure("shop.warrantyPolicyRecord")
    .input(z.object({ subjectType: z.enum(["part", "tire", "unit_component"]), subjectId: z.number().int().positive(), unitId: z.number().int().positive().nullable().optional(), vendorId: z.number().int().positive().nullable().optional(), coverageUntil: z.coerce.date().nullable().optional(), coverageKm: z.number().int().positive().nullable().optional(), coverageHours: z.number().int().positive().nullable().optional(), terms: z.string().max(600).optional(), sourceDocumentEvidenceId: z.number().int().positive().nullable().optional(), verified: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      const db = await dbOrThrow();
      if (input.verified && !input.sourceDocumentEvidenceId) throw new TRPCError({ code: "BAD_REQUEST", message: "A verified policy needs its source document in the evidence vault" });
      const policyRef = ref("WPOL");
      await db.insert(warrantyPolicies).values({ policyRef, subjectType: input.subjectType, subjectId: input.subjectId, unitId: input.unitId ?? null, vendorId: input.vendorId ?? null, coverageUntil: input.coverageUntil ?? null, coverageKm: input.coverageKm ?? null, coverageHours: input.coverageHours ?? null, terms: input.terms ?? null, sourceDocumentEvidenceId: input.sourceDocumentEvidenceId ?? null, verificationStatus: input.verified ? "verified" : "unverified", verifiedByUserId: input.verified ? ctx.user.id : null, recordedByUserId: ctx.user.id });
      return { policyRef, verificationStatus: input.verified ? "verified" as const : "unverified" as const };
    }),

  warrantyClaimRaise: roleProcedure("shop.warrantyClaimRaise")
    .input(z.object({ policyRef: z.string().min(1).max(64), workOrderNumber: z.string().max(64).optional(), tireSerial: z.string().max(80).optional(), claimedCents: z.number().int().positive(), reason: z.string().min(10).max(600), kmSincePurchase: z.number().int().nonnegative().nullable().optional(), hoursSincePurchase: z.number().int().nonnegative().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
      const db = await dbOrThrow();
      const pol = (await db.select().from(warrantyPolicies).where(eq(warrantyPolicies.policyRef, input.policyRef)).limit(1))[0];
      if (!pol) throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found" });
      const el = claimEligibility({ policy: pol, at: new Date(), kmSincePurchase: input.kmSincePurchase ?? null, hoursSincePurchase: input.hoursSincePurchase ?? null });
      const wo = input.workOrderNumber ? (await db.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.workOrderNumber, input.workOrderNumber)).limit(1))[0] : undefined;
      const tire = input.tireSerial ? (await db.select({ id: tires.id }).from(tires).where(eq(tires.serial, input.tireSerial)).limit(1))[0] : undefined;
      const claimRef = ref("WCLM");
      await db.insert(warrantyClaims).values({ claimRef, policyId: pol.id, workOrderId: wo?.id ?? null, tireId: tire?.id ?? null, claimedCents: input.claimedCents, reason: input.reason, eligibility: el.eligibility, eligibilityReason: el.reason, raisedByUserId: ctx.user.id, raisedAt: new Date() });
      return { claimRef, ...el };
    }),

  /** Decided by someone other than the raiser; approval needs known eligibility; a credit reconciles to the bill line that carries it. */
  warrantyClaimDecide: roleProcedure("shop.warrantyClaimDecide")
    .input(z.object({ claimRef: z.string().min(1).max(64), decision: z.enum(["approved", "denied"]), reason: z.string().min(5).max(400), creditVendorBillLineId: z.number().int().positive().nullable().optional(), creditedCents: z.number().int().positive().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const c = (await db.select().from(warrantyClaims).where(eq(warrantyClaims.claimRef, input.claimRef)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Claim not found" });
      if (c.status !== "raised" && c.status !== "submitted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Claim is ${c.status}` });
      const d = claimDecision({ raisedByUserId: c.raisedByUserId, deciderUserId: ctx.user.id, decision: input.decision, eligibility: c.eligibility });
      if (!d.permitted) throw new TRPCError({ code: d.refusals[0]?.includes("raised the claim") ? "FORBIDDEN" : "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      let status: "approved" | "denied" | "credited" = input.decision;
      if (input.decision === "approved" && input.creditVendorBillLineId) {
        const l = (await db.select({ lineType: vendorBillLines.lineType, amountCents: vendorBillLines.amountCents }).from(vendorBillLines).where(eq(vendorBillLines.id, input.creditVendorBillLineId)).limit(1))[0];
        if (!l || l.lineType !== "warranty_credit") throw new TRPCError({ code: "BAD_REQUEST", message: "Credit must reference a warranty_credit bill line" });
        status = "credited";
      }
      await db.update(warrantyClaims).set({ status, decidedByUserId: ctx.user.id, decidedAt: new Date(), decisionReason: input.reason, creditVendorBillLineId: input.creditVendorBillLineId ?? null, creditedCents: status === "credited" ? input.creditedCents ?? c.claimedCents : null }).where(eq(warrantyClaims.id, c.id));
      return { claimRef: c.claimRef, status };
    }),

  toolRegister: roleProcedure("shop.toolRegister").input(z.object({ serial: z.string().min(1).max(80), description: z.string().min(1).max(220), measurementDeviceId: z.number().int().positive().nullable().optional() })).mutation(async ({ input }) => {
    const db = await dbOrThrow();
    const toolRef = ref("TOOL");
    await db.insert(serializedTools).values({ toolRef, serial: input.serial, description: input.description, measurementDeviceId: input.measurementDeviceId ?? null });
    return { toolRef };
  }),
  toolCheckout: roleProcedure("shop.toolCheckout").input(z.object({ serial: z.string().min(1).max(80), workerUserId: z.number().int().positive() })).mutation(async ({ input }) => {
    const db = await dbOrThrow();
    const t = (await db.select().from(serializedTools).where(eq(serializedTools.serial, input.serial)).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
    if (t.status !== "available") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Tool is ${t.status.replace(/_/g, " ")}` });
    await db.insert(toolCheckouts).values({ toolId: t.id, workerUserId: input.workerUserId, checkedOutAt: new Date() });
    await db.update(serializedTools).set({ status: "checked_out" }).where(eq(serializedTools.id, t.id));
    return { toolRef: t.toolRef, status: "checked_out" as const };
  }),
  toolReturn: roleProcedure("shop.toolReturn").input(z.object({ serial: z.string().min(1).max(80), condition: z.enum(["good", "damaged", "needs_calibration"]) })).mutation(async ({ input }) => {
    const db = await dbOrThrow();
    const t = (await db.select().from(serializedTools).where(eq(serializedTools.serial, input.serial)).limit(1))[0];
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
    const open = (await db.select().from(toolCheckouts).where(and(eq(toolCheckouts.toolId, t.id), isNull(toolCheckouts.returnedAt))).orderBy(desc(toolCheckouts.id)).limit(1))[0];
    if (!open) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Tool is not checked out" });
    await db.update(toolCheckouts).set({ returnedAt: new Date(), returnCondition: input.condition }).where(eq(toolCheckouts.id, open.id));
    const status = input.condition === "needs_calibration" ? "out_for_calibration" as const : input.condition === "damaged" ? "retired" as const : "available" as const;
    await db.update(serializedTools).set({ status }).where(eq(serializedTools.id, t.id));
    return { toolRef: t.toolRef, status };
  }),

  /** A recall is external data. Recorded unverified; verified by a person with the notice on file. */
  recallRecord: roleProcedure("shop.recallRecord").input(z.object({ source: z.string().min(1).max(120), sourceRef: z.string().min(1).max(120), issuedAt: z.coerce.date().nullable().optional(), summary: z.string().min(10).max(600), affectedCriteria: z.record(z.string(), z.unknown()).optional(), unitIds: z.array(z.number().int().positive()).max(500).default([]) })).mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      for (const uid of input.unitIds) if (!(await unitInScope(uid, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${uid} not found` });
    const db = await dbOrThrow();
    const dup = (await db.select({ recallRef: recallNotices.recallRef }).from(recallNotices).where(and(eq(recallNotices.source, input.source), eq(recallNotices.sourceRef, input.sourceRef))).limit(1))[0];
    if (dup) return { recallRef: dup.recallRef, duplicate: true as const };
    const recallRef = ref("RECALL");
    const ins = await db.insert(recallNotices).values({ recallRef, source: input.source, sourceRef: input.sourceRef, issuedAt: input.issuedAt ?? null, summary: input.summary, affectedCriteriaJson: input.affectedCriteria ? JSON.stringify(input.affectedCriteria) : null, recordedByUserId: ctx.user.id });
    const id = Number(ins[0]?.insertId ?? 0);
    for (const u of input.unitIds) await db.insert(recallUnitStatus).values({ recallId: id, unitId: u, status: "unknown" });
    return { recallRef, duplicate: false as const, verificationStatus: "unverified" as const, unitsMarkedUnknown: input.unitIds.length };
  }),

  /**
   * Move a work order forward.
   *
   * Also missing: the shop bridge opens work orders and nothing could advance
   * one, so a release was refused for an open work order that had no way to stop
   * being open. Forward only — a closed work order is not reopened by editing a
   * status, and "the repair went backwards" is a new work order, not an undo.
   */
  workOrderAdvance: roleProcedure("shop.workOrderAdvance")
    .input(z.object({
      workOrderId: z.number().int().positive(),
      to: z.enum(["in_progress", "waiting_parts", "ready_for_service", "closed"]),
      note: z.string().max(400).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await workOrderInScope(input.workOrderId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderId} not found` });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const wo = (await db.select().from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1))[0];
      if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "No such work order" });
      const order = ["draft", "open", "in_progress", "waiting_parts", "ready_for_service", "closed"];
      const from = order.indexOf(wo.status);
      const to = order.indexOf(input.to);
      // waiting_parts sits beside in_progress rather than after it, so moving
      // back to in_progress from waiting_parts is forward in the real sense.
      const sideways = wo.status === "waiting_parts" && input.to === "in_progress";
      if (wo.status === "closed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A closed work order is not reopened by changing a status — raise a new one" });
      if (wo.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A cancelled work order is not reopened by changing a status — raise a new one" });
      if (to <= from && !sideways) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A work order does not move from ${wo.status} back to ${input.to}` });
      /*
       * 0199 — the move leaves a trace. `startedAt` is set the first time work starts and `completedAt`
       * the first time it reaches ready-for-service or closed; neither is ever moved. The note was
       * accepted and thrown away; it is now appended to the findings with who and when, until the
       * defect history table (maintenance checkpoint 2) carries it as its own row.
       */
      const now = new Date();
      const set: Partial<typeof workOrders.$inferInsert> = { status: input.to };
      if (input.to === "in_progress" && !wo.startedAt) set.startedAt = now;
      if ((input.to === "ready_for_service" || input.to === "closed") && !wo.completedAt) set.completedAt = now;
      if (input.note?.trim()) set.findings = `${wo.findings ? `${wo.findings}\n` : ""}[${now.toISOString()} ${wo.status} → ${input.to}, user ${ctx.user.id}] ${input.note.trim()}`;
      await db.update(workOrders).set(set).where(eq(workOrders.id, input.workOrderId));
      return { workOrderId: input.workOrderId, from: wo.status, to: input.to };
    }),

  /**
   * Record a mechanic's release of a work order.
   *
   * This did not exist. `appendWorkOrderRelease` was a service function no
   * endpoint called, so the shop's completion step had no API surface and the
   * end-to-end enforcement test had to invoke it directly — the one step of the
   * chain that did not run through the product.
   *
   * The technician is the request context, never the request body. "Who signed
   * this release" is exactly the fact a client must not be able to assert: a
   * release attributed to somebody who did not give it is worse than no release
   * at all, because it looks like accountability.
   *
   * The decision itself is `evaluateMechanicRelease`, which already scales its
   * evidence requirements with defect severity. Nothing is re-decided here.
   */
  workOrderRelease: roleProcedure("shop.workOrderRelease")
    .input(z.object({
      workOrderId: z.number().int().positive(),
      releaseType: z.enum(["full", "restricted", "revoked"]),
      repairSummary: z.string().min(5).max(2000),
      testProcedure: z.string().max(2000).optional(),
      testResult: z.enum(["pass", "fail", "not_required"]).optional(),
      roadTestPerformed: z.boolean().default(false),
      roadTestNotes: z.string().max(2000).optional(),
      restrictionDetail: z.string().max(2000).optional(),
      technicianCertificationRef: z.string().max(120).optional(),
      resolvedDefectIds: z.array(z.number().int().positive()).max(50).default([]),
      releasedAt: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await workOrderInScope(input.workOrderId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderId} not found` });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const wo = (await db.select().from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1))[0];
      if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "No such work order" });

      // The severity the release is judged against comes from the defect the
      // work order is for, not from the person releasing it.
      const defect = wo.defectId
        ? (await db.select().from(maintenanceDefects).where(eq(maintenanceDefects.id, wo.defectId)).limit(1))[0]
        : null;
      const defectSeverity = (defect?.severity ?? "advisory") as "advisory" | "inspection_required" | "critical";

      const decision = evaluateMechanicRelease({
        workOrderStatus: wo.status,
        defectSeverity,
        releaseType: input.releaseType,
        repairSummary: input.repairSummary,
        testProcedure: input.testProcedure ?? null,
        testResult: input.testResult ?? null,
        roadTestPerformed: input.roadTestPerformed,
        technicianUserId: ctx.user.id,
        technicianIdentifier: `TECH-${ctx.user.id}`,
        restrictionDetail: input.restrictionDetail ?? null,
      });
      if (!decision.valid) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.blockers.map(b => b.label).join(" · ") });
      }

      const releaseId = await appendWorkOrderRelease({
        workOrderId: input.workOrderId, unitId: wo.unitId, releaseType: input.releaseType,
        restrictionDetail: input.restrictionDetail ?? null,
        repairSummary: input.repairSummary, testProcedure: input.testProcedure ?? null,
        testResult: input.testResult ?? null, roadTestPerformed: input.roadTestPerformed,
        roadTestNotes: input.roadTestNotes ?? null,
        technicianUserId: ctx.user.id, technicianIdentifier: `TECH-${ctx.user.id}`,
        technicianCertificationRef: input.technicianCertificationRef ?? null,
        releasedAt: input.releasedAt, resolvedDefectIds: JSON.stringify(input.resolvedDefectIds),
      });

      return {
        releaseId: releaseId ?? null, workOrderId: input.workOrderId, unitId: wo.unitId,
        releaseType: input.releaseType, defectSeverity,
        mechanicReleaseGiven: decision.mechanicReleaseGiven,
        unitDispatchable: decision.unitDispatchable,
        restricted: decision.restricted,
        technicianUserId: ctx.user.id,
        note: "Recorded as given by the authenticated technician. A mechanic release says the unit is mechanically sound; it does not lift a government out-of-service order.",
      };
    }),

  recallVerify: roleProcedure("shop.recallVerify").input(z.object({ recallRef: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const r = (await db.select().from(recallNotices).where(eq(recallNotices.recallRef, input.recallRef)).limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Recall not found" });
    if (r.recordedByUserId === ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "The person who recorded the recall may not verify it" });
    await db.update(recallNotices).set({ verificationStatus: "verified", verifiedByUserId: ctx.user.id, verifiedAt: new Date() }).where(eq(recallNotices.id, r.id));
    return { recallRef: r.recallRef, verificationStatus: "verified" as const };
  }),
  recallUnitDecide: roleProcedure("shop.recallUnitDecide").input(z.object({ recallRef: z.string().min(1).max(64), unitId: z.number().int().positive(), status: z.enum(["affected", "not_affected", "completed"]), workOrderNumber: z.string().max(64).optional() })).mutation(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
    const db = await dbOrThrow();
    const r = (await db.select().from(recallNotices).where(eq(recallNotices.recallRef, input.recallRef)).limit(1))[0];
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Recall not found" });
    if (r.verificationStatus !== "verified" && input.status === "not_affected") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A unit is not cleared of an unverified recall — verify the notice first" });
    const wo = input.workOrderNumber ? (await db.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.workOrderNumber, input.workOrderNumber)).limit(1))[0] : undefined;
    if (input.status === "completed" && !wo) throw new TRPCError({ code: "BAD_REQUEST", message: "Completion needs the work order that did the work" });
    const cur = (await db.select({ id: recallUnitStatus.id }).from(recallUnitStatus).where(and(eq(recallUnitStatus.recallId, r.id), eq(recallUnitStatus.unitId, input.unitId))).limit(1))[0];
    if (cur) await db.update(recallUnitStatus).set({ status: input.status, workOrderId: wo?.id ?? null, decidedByUserId: ctx.user.id, decidedAt: new Date() }).where(eq(recallUnitStatus.id, cur.id));
    else await db.insert(recallUnitStatus).values({ recallId: r.id, unitId: input.unitId, status: input.status, workOrderId: wo?.id ?? null, decidedByUserId: ctx.user.id, decidedAt: new Date() });
    return { recallRef: r.recallRef, unitId: input.unitId, status: input.status };
  }),

  workOrderCost: roleProcedure("shop.workOrderCost").input(z.object({ workOrderNumber: z.string().min(1).max(64), labourRateCentsPerHour: z.number().int().positive().nullable().optional() })).query(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (input.workOrderNumber && !(await workOrderInScope(input.workOrderNumber, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderNumber} not found` });
    const db = await dbOrThrow();
    const wo = (await db.select().from(workOrders).where(eq(workOrders.workOrderNumber, input.workOrderNumber)).limit(1))[0];
    if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "Work order not found" });
    const issues = await db.select().from(partMovements).where(and(eq(partMovements.workOrderId, wo.id), eq(partMovements.kind, "issue")));
    return { workOrderNumber: wo.workOrderNumber, unitId: wo.unitId, ...workOrderCost({ laborMinutes: wo.laborMinutes ?? 0, labourRateCentsPerHour: input.labourRateCentsPerHour ?? null, issues: issues.map(i => ({ qty: -i.qtySigned, unitCostCents: i.unitCostCents })) }) };
  }),

  /** What a unit has cost the shop: work orders' parts and labour, tires by run. Every unknown is named; nothing is filled in. */
  unitCost: roleProcedure("shop.unitCost").input(z.object({ unitId: z.number().int().positive(), labourRateCentsPerHour: z.number().int().positive().nullable().optional() })).query(async ({ ctx, input }) => {
      // P4.1: the unit (or the work order's unit) must be in the caller's scope; otherwise it does not exist here.
      const scope = await actingScopeFor(ctx.user.id);
      if (!(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
    const db = await dbOrThrow();
    const wos = await db.select().from(workOrders).where(eq(workOrders.unitId, input.unitId));
    const issues = wos.length ? await db.select().from(partMovements).where(and(inArray(partMovements.workOrderId, wos.map(w => w.id)), eq(partMovements.kind, "issue"))) : [];
    const perWo = wos.map(w => ({ workOrderNumber: w.workOrderNumber, ...workOrderCost({ laborMinutes: w.laborMinutes ?? 0, labourRateCentsPerHour: input.labourRateCentsPerHour ?? null, issues: issues.filter(i => i.workOrderId === w.id).map(i => ({ qty: -i.qtySigned, unitCostCents: i.unitCostCents })) }) }));
    const insts = await db.select().from(tireInstallations).where(eq(tireInstallations.unitId, input.unitId));
    const tireIds = Array.from(new Set(insts.map(i => i.tireId)));
    const tireRows = tireIds.length ? await db.select().from(tires).where(inArray(tires.id, tireIds)) : [];
    const tireRuns = insts.map(i => { const t = tireRows.find(x => x.id === i.tireId)!; return { serial: t.serial, axlePosition: i.axlePosition, ...tireRun({ installOdometerKm: i.installOdometerKm, removeOdometerKm: i.removeOdometerKm, installTreadMm: i.installTreadMm, removeTreadMm: i.removeTreadMm, purchaseCostCents: t.purchaseCostCents }) }; });
    const reasons = Array.from(new Set([...perWo.flatMap(w => w.reasons), ...tireRuns.flatMap(t => t.reasons)]));
    const partsCents = perWo.reduce((a, w) => a + w.partsCents, 0);
    const labourCents = perWo.every(w => w.labourCents != null) ? perWo.reduce((a, w) => a + (w.labourCents ?? 0), 0) : null;
    return { unitId: input.unitId, workOrders: perWo, tires: tireRuns, totals: { partsCents, labourCents, shopCents: labourCents == null ? null : partsCents + labourCents, determination: reasons.length ? "partial" as const : "computed" as const }, reasons };
  }),
});
