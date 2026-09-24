/**
 * Integration gateway — the internal API (clients, webhooks, deliveries) and
 * the inbound API for machines (`inboundRouter`, gated by integrationProcedure).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { integrationProcedure, roleProcedure, router, type IntegrationContext } from "./_core/trpc";
import { toCents } from "./_core/money";
import { getDb } from "./db";
import { INBOUND_FEEDS, drivingEvents, dutyRecords, faultCodes, fuelTransactions, inboundEvents, integrationClients, operators, telemetrySnapshots, units, webhookDeliveries, webhookSubscriptions, loadSenseGatewayFrames, loadSenseGatewayBindings, loadSenseCalibrationModels, loadSenseWeightSnapshots, loadSenseAxleWeights, measurementDevices, calibrationEvents, loads, financialEntities, coreRecordOwnership } from "../drizzle/schema";
import { intakeDecision, type Feed } from "./_core/integrationGateway";
import { dispatchWebhooks } from "./webhookDispatchService";
import { encryptSecret, mfaKey } from "./_core/externalIdentityPolicy";
import { resolveActingScope } from "./_core/actingScope";
import { frameKey, validateGatewayFrame } from "./_core/loadSenseProtocol";
import { applyCalibration, assessWeightStability, buildWeightSnapshot, fitMultiPointCalibration, legalAxleDetermination } from "./_core/loadSense";
import { assignRecordOwner, recordBelongsToOrganization, type OwnedRecordType } from "./_core/coreRecordOwnership";
import { OutboundRefused, validateOutboundUrl } from "./_core/outboundHttp";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
const integ = (ctx: unknown) => (ctx as { integration: IntegrationContext }).integration;

export { setWebhookPoster, type Poster } from "./webhookDispatchService";

export const integrationRouter = router({
  /** Bind a legacy core record to this organization. Ownership cannot be moved here. */
  ownershipAssign: roleProcedure("integration.ownershipAssign")
    .input(z.object({ recordType: z.enum(["unit", "operator", "load", "financial_entity"]), recordId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const exists = input.recordType === "unit"
        ? (await db.select({ id: units.id }).from(units).where(eq(units.id, input.recordId)).limit(1))[0]
        : input.recordType === "operator"
          ? (await db.select({ id: operators.id }).from(operators).where(eq(operators.id, input.recordId)).limit(1))[0]
          : input.recordType === "load"
            ? (await db.select({ id: loads.id }).from(loads).where(eq(loads.id, input.recordId)).limit(1))[0]
            : (await db.select({ id: financialEntities.id }).from(financialEntities).where(eq(financialEntities.id, input.recordId)).limit(1))[0];
      if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "Core record not found" });
      try {
        const status = await assignRecordOwner(db, { orgRef, recordType: input.recordType as OwnedRecordType, recordId: input.recordId, assignedByUserId: ctx.user.id });
        return { orgRef, recordType: input.recordType, recordId: input.recordId, status };
      } catch (e) {
        if (e instanceof Error && e.message === "RECORD_OWNED_BY_ANOTHER_ORGANIZATION") throw new TRPCError({ code: "CONFLICT", message: "Record already belongs to another organization" });
        throw e;
      }
    }),

  ownershipList: roleProcedure("integration.ownershipList")
    .input(z.object({ recordType: z.enum(["unit", "operator", "load", "financial_entity"]).optional() }))
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const rows = input.recordType
        ? await db.select().from(coreRecordOwnership).where(and(eq(coreRecordOwnership.orgRef, orgRef), eq(coreRecordOwnership.recordType, input.recordType)))
        : await db.select().from(coreRecordOwnership).where(eq(coreRecordOwnership.orgRef, orgRef));
      return { ownership: rows.map(r => ({ recordType: r.recordType, recordId: r.recordId, assignedAt: r.assignedAt })) };
    }),

  loadSenseBindGateway: roleProcedure("integration.loadSenseBindGateway")
    .input(z.object({ gatewayDeviceRef: z.string().min(1).max(96), measurementDeviceId: z.number().int().positive(), unitId: z.number().int().positive(), trailerId: z.number().int().positive().optional(), tareKg: z.number().nonnegative(), channelConfig: z.record(z.string(), z.object({ label: z.string().min(1).max(160), configuredLimitKg: z.number().positive().optional(), limitSource: z.string().max(300).optional() })).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const unitOwned = await recordBelongsToOrganization(db, orgRef, "unit", input.unitId);
      const device = (await db.select({ id: measurementDevices.id, financialEntityId: measurementDevices.financialEntityId, status: measurementDevices.status, deviceType: measurementDevices.deviceType }).from(measurementDevices).where(eq(measurementDevices.id, input.measurementDeviceId)).limit(1))[0];
      const deviceOwned = device ? await recordBelongsToOrganization(db, orgRef, "financial_entity", device.financialEntityId) : false;
      if (!unitOwned || !device || !deviceOwned || device.status !== "active" || !["onboard_load_sensor", "load_cell"].includes(device.deviceType)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Gateway binding requires an owned unit and an active owned LoadSense-capable measurement device" });
      const existing = (await db.select({ id: loadSenseGatewayBindings.id }).from(loadSenseGatewayBindings).where(and(eq(loadSenseGatewayBindings.orgRef, orgRef), eq(loadSenseGatewayBindings.gatewayDeviceRef, input.gatewayDeviceRef))).limit(1))[0];
      const values = { measurementDeviceId: input.measurementDeviceId, unitId: input.unitId, trailerId: input.trailerId ?? null, tareKg: input.tareKg, channelConfigJson: input.channelConfig ? JSON.stringify(input.channelConfig) : null, status: "active" as const, boundByUserId: ctx.user.id };
      if (existing) await db.update(loadSenseGatewayBindings).set(values).where(eq(loadSenseGatewayBindings.id, existing.id));
      else await db.insert(loadSenseGatewayBindings).values({ orgRef, gatewayDeviceRef: input.gatewayDeviceRef, ...values });
      return { gatewayDeviceRef: input.gatewayDeviceRef, orgRef, status: "active" as const };
    }),

  loadSenseCalibrate: roleProcedure("integration.loadSenseCalibrate")
    .input(z.object({ measurementDeviceId: z.number().int().positive(), calibrationEventId: z.number().int().positive(), points: z.array(z.object({ rawValue: z.number(), knownWeightKg: z.number().nonnegative() })).min(2).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const device = (await db.select({ financialEntityId: measurementDevices.financialEntityId }).from(measurementDevices).where(eq(measurementDevices.id, input.measurementDeviceId)).limit(1))[0];
      if (!device || !(await recordBelongsToOrganization(db, orgRef, "financial_entity", device.financialEntityId))) throw new TRPCError({ code: "NOT_FOUND", message: "Measurement device not found in this organization" });
      const event = (await db.select().from(calibrationEvents).where(and(eq(calibrationEvents.id, input.calibrationEventId), eq(calibrationEvents.measurementDeviceId, input.measurementDeviceId))).limit(1))[0];
      if (!event || !["calibrated", "verified", "adjusted", "returned_to_service"].includes(event.eventType)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A successful calibration/verification event for this device is required" });
      const fit = fitMultiPointCalibration(input.points);
      if (fit.rSquared != null && fit.rSquared < 0.98) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Calibration fit R² ${fit.rSquared.toFixed(4)} is below 0.98` });
      await db.update(loadSenseCalibrationModels).set({ status: "superseded", invalidatedAt: new Date(), invalidationReason: "Superseded by a newer server-approved calibration model" }).where(and(eq(loadSenseCalibrationModels.measurementDeviceId, input.measurementDeviceId), eq(loadSenseCalibrationModels.status, "active")));
      const modelRef = ref("LSCAL");
      await db.insert(loadSenseCalibrationModels).values({ modelRef, measurementDeviceId: input.measurementDeviceId, calibrationEventId: input.calibrationEventId, slope: fit.slope, interceptOffset: fit.offset, pointCount: fit.pointCount, rSquared: fit.rSquared ?? null, pointsJson: JSON.stringify(input.points), status: "active", effectiveAt: event.performedAt, createdByUserId: ctx.user.id });
      return { modelRef, slope: fit.slope, offset: fit.offset, pointCount: fit.pointCount, rSquared: fit.rSquared ?? null, note: "Calibration authorizes LoadSense measurement classification only; it does not grant billing or certified-scale authority." };
    }),

  /** Register a machine. The key is shown once and stored only as a hash. Scopes are the feeds it may send. */
  clientRegister: roleProcedure("integration.clientRegister")
    .input(z.object({ name: z.string().min(1).max(160), kind: z.enum(["telematics", "eld", "fuel_card", "accounting", "customer_system", "facility_system", "other"]), scopes: z.array(z.enum(INBOUND_FEEDS)).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const key = randomBytes(32).toString("base64url");
      const clientRef = ref("INTG");
      await db.insert(integrationClients).values({ orgRef, clientRef, name: input.name, kind: input.kind, keyHash: sha(key), scopesJson: JSON.stringify(input.scopes), createdByUserId: ctx.user.id });
      return { clientRef, key, scopes: input.scopes, note: "Shown once. Stored only as a hash." };
    }),

  clientRevoke: roleProcedure("integration.clientRevoke").input(z.object({ clientRef: z.string().min(1).max(64), reason: z.string().min(5).max(300) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
    const c = (await db.select({ id: integrationClients.id }).from(integrationClients).where(and(eq(integrationClients.clientRef, input.clientRef), eq(integrationClients.orgRef, orgRef))).limit(1))[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Client not found in active organization" });
    await db.update(integrationClients).set({ status: "revoked", revokedAt: new Date(), revokedReason: input.reason }).where(and(eq(integrationClients.id, c.id), eq(integrationClients.orgRef, orgRef)));
    return { clientRef: input.clientRef, status: "revoked" as const };
  }),

  inboundList: roleProcedure("integration.inboundList").input(z.object({ clientRef: z.string().max(64).optional(), limit: z.number().int().positive().max(500).default(100) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
    const c = input.clientRef ? (await db.select({ id: integrationClients.id }).from(integrationClients).where(and(eq(integrationClients.clientRef, input.clientRef), eq(integrationClients.orgRef, orgRef))).limit(1))[0] : undefined;
    const rows = c ? await db.select().from(inboundEvents).where(and(eq(inboundEvents.clientId, c.id), eq(inboundEvents.orgRef, orgRef))).orderBy(desc(inboundEvents.id)).limit(input.limit) : await db.select().from(inboundEvents).where(eq(inboundEvents.orgRef, orgRef)).orderBy(desc(inboundEvents.id)).limit(input.limit);
    return { events: rows.map(r => ({ inboundRef: r.inboundRef, feed: r.feed, idempotencyKey: r.idempotencyKey, status: r.status, resultKind: r.resultKind, resultRef: r.resultRef, rejectionReason: r.rejectionReason, receivedAt: r.receivedAt })) };
  }),

  /** Subscribe a URL to outbox event types. The signing secret is shown once and stored encrypted under the server key. */
  webhookSubscribe: roleProcedure("integration.webhookSubscribe")
    .input(z.object({ name: z.string().min(1).max(160), url: z.string().url().max(500), eventTypes: z.array(z.string().min(1).max(80)).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const key = mfaKey();
      if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Webhook secrets need LEASEOS_PORTAL_MFA_KEY on the server; it is not configured" });
      if (!/^https:\/\//.test(input.url)) throw new TRPCError({ code: "BAD_REQUEST", message: "Webhooks are delivered over https only" });
      // Static policy now, so a private or loopback destination is refused when it is
      // saved; delivery re-checks the resolved address at connect time.
      try { validateOutboundUrl(input.url); } catch (e) { if (e instanceof OutboundRefused) throw new TRPCError({ code: "BAD_REQUEST", message: e.message }); throw e; }
      const secret = randomBytes(32).toString("base64url");
      const subscriptionRef = ref("WH");
      await db.insert(webhookSubscriptions).values({ orgRef, subscriptionRef, name: input.name, url: input.url, secretEnc: encryptSecret(secret, key), eventTypesJson: JSON.stringify(input.eventTypes), createdByUserId: ctx.user.id });
      return { subscriptionRef, secret, note: "Shown once. Verify deliveries with HMAC-SHA256 over `timestamp.body` using this secret; reject timestamps older than five minutes." };
    }),

  webhookSetStatus: roleProcedure("integration.webhookSetStatus").input(z.object({ subscriptionRef: z.string().min(1).max(64), status: z.enum(["active", "paused", "revoked"]) })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
    const s = (await db.select({ id: webhookSubscriptions.id, status: webhookSubscriptions.status }).from(webhookSubscriptions).where(and(eq(webhookSubscriptions.subscriptionRef, input.subscriptionRef), eq(webhookSubscriptions.orgRef, orgRef))).limit(1))[0];
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Subscription not found" });
    if (s.status === "revoked") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A revoked subscription is not reactivated — subscribe again" });
    await db.update(webhookSubscriptions).set({ status: input.status }).where(and(eq(webhookSubscriptions.id, s.id), eq(webhookSubscriptions.orgRef, orgRef)));
    return { subscriptionRef: input.subscriptionRef, status: input.status };
  }),

  /**
   * Dispatch: for every active subscription, deliver every outbox event of a
   * subscribed type that has not yet been delivered or is due for retry. Each
   * attempt is a row; a delivery past its attempts is dead until a person
   * re-queues it. This is the worker's step, callable from the office.
   */
  /** Dispatch: the worker's step, callable from the office. Every attempt is a row; a delivery past its attempts is dead until a person re-queues it. */
  webhookDispatch: roleProcedure("integration.webhookDispatch").input(z.object({ maxEvents: z.number().int().positive().max(500).default(100), now: z.coerce.date().optional() })).mutation(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
    const r = await dispatchWebhooks({ maxEvents: input.maxEvents, now: input.now, orgRef });
    if (r.skipped?.includes("LEASEOS_PORTAL_MFA_KEY")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Webhook secrets cannot be read without LEASEOS_PORTAL_MFA_KEY" });
    return { attempted: r.attempted, results: r.results };
  }),

  deliveries: roleProcedure("integration.deliveries").input(z.object({ subscriptionRef: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    const db = await dbOrThrow();
    const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
    const s = (await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(and(eq(webhookSubscriptions.subscriptionRef, input.subscriptionRef), eq(webhookSubscriptions.orgRef, orgRef))).limit(1))[0];
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Subscription not found" });
    const rows = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, s.id), eq(webhookDeliveries.orgRef, orgRef))).orderBy(desc(webhookDeliveries.id)).limit(200);
    return { deliveries: rows.map(d => ({ deliveryRef: d.deliveryRef, eventId: d.eventId, eventType: d.eventType, attempt: d.attempt, status: d.status, responseStatus: d.responseStatus, error: d.error, nextAttemptAt: d.nextAttemptAt, at: d.at })) };
  }),
});

/** The inbound API: what a machine calls. */
export const inboundRouter = router({
  me: integrationProcedure("inbound.me").query(async ({ ctx }) => { const i = integ(ctx); return { clientRef: i.clientRef, orgRef: i.orgRef, kind: i.kind, scopes: i.scopes, name: i.name }; }),

  /** One event in: idempotent by the client's key, hashed, accepted only in scope and well-formed, and becoming a PROPOSAL where it becomes anything. */
  ingest: integrationProcedure("inbound.ingest")
    .input(z.object({ feed: z.enum(INBOUND_FEEDS), idempotencyKey: z.string().min(1).max(120), payload: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      const i = integ(ctx);
      const db = await dbOrThrow();
      const payloadJson = JSON.stringify(input.payload);
      const payloadHash = sha(payloadJson);
      const dup = (await db.select({ inboundRef: inboundEvents.inboundRef, status: inboundEvents.status, resultRef: inboundEvents.resultRef, payloadHash: inboundEvents.payloadHash }).from(inboundEvents).where(and(eq(inboundEvents.clientId, i.clientId), eq(inboundEvents.idempotencyKey, input.idempotencyKey))).limit(1))[0];
      if (dup) return { inboundRef: dup.inboundRef, status: "duplicate" as const, resultRef: dup.resultRef, note: dup.payloadHash === payloadHash ? "Already received; same content." : "Already received with DIFFERENT content under the same key — the first stays; send a new key if this is a new event." };
      const d = intakeDecision({ feed: input.feed as Feed, scopes: i.scopes, payload: input.payload });
      const inboundRef = ref("IN");
      const receivedAt = new Date();
      if (!d.accepted) {
        await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: d.refusals.join("; ").slice(0, 400), receivedAt });
        return { inboundRef, status: "rejected" as const, refusals: d.refusals };
      }
      let resultKind: string | null = null, resultRef: string | null = null;
      const p = input.payload;

      if (input.feed === "loadsense_weight") {
        const checked = validateGatewayFrame(p);
        if (!checked.ok || !checked.frame) {
          await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: checked.errors.join("; ").slice(0, 400), receivedAt });
          return { inboundRef, status: "rejected" as const, refusals: checked.errors };
        }
        const f = checked.frame;
        if (f.loadId != null && !(await recordBelongsToOrganization(db, i.orgRef, "load", f.loadId))) {
          await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: "Load is not owned by this organization", receivedAt });
          return { inboundRef, status: "rejected" as const, refusals: ["Load is not owned by this organization"] };
        }
        const measuredAt = new Date(f.measuredAt);
        const binding = (await db.select().from(loadSenseGatewayBindings).where(and(eq(loadSenseGatewayBindings.orgRef, i.orgRef), eq(loadSenseGatewayBindings.gatewayDeviceRef, f.gatewayDeviceId), eq(loadSenseGatewayBindings.status, "active"))).limit(1))[0];
        if (binding && !(await recordBelongsToOrganization(db, i.orgRef, "unit", binding.unitId))) {
          await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: "LoadSense gateway binding no longer points to an owned unit", receivedAt });
          return { inboundRef, status: "rejected" as const, refusals: ["LoadSense gateway binding no longer points to an owned unit"] };
        }
        const model = binding ? (await db.select().from(loadSenseCalibrationModels).where(and(eq(loadSenseCalibrationModels.measurementDeviceId, binding.measurementDeviceId), eq(loadSenseCalibrationModels.status, "active"))).orderBy(desc(loadSenseCalibrationModels.effectiveAt)).limit(1))[0] : undefined;
        const calibrationEvent = model ? (await db.select().from(calibrationEvents).where(eq(calibrationEvents.id, model.calibrationEventId)).limit(1))[0] : undefined;
        const calibrationCurrent = !!(model && calibrationEvent && model.effectiveAt.getTime() <= measuredAt.getTime() && (!calibrationEvent.validUntil || calibrationEvent.validUntil.getTime() >= measuredAt.getTime()) && !["failed", "out_of_tolerance_found"].includes(calibrationEvent.eventType));
        const scopedFrameKey = `${i.orgRef}:${frameKey(f)}`;
        const prior = (await db.select({ id: loadSenseGatewayFrames.id }).from(loadSenseGatewayFrames).where(eq(loadSenseGatewayFrames.frameKey, scopedFrameKey)).limit(1))[0];
        if (!prior) await db.insert(loadSenseGatewayFrames).values({ orgRef: i.orgRef, sourceClientId: i.clientId, frameKey: scopedFrameKey, gatewayDeviceRef: f.gatewayDeviceId, sequence: f.sequence, measurementDeviceId: binding?.measurementDeviceId ?? null, loadId: f.loadId ?? null, calibrationModelId: calibrationCurrent ? model!.id : null, measuredAt, buffered: f.buffered, readingsJson: JSON.stringify(f.readings), vehicleStateJson: f.vehicle ? JSON.stringify(f.vehicle) : null, receivedAt });

        let snapshotRef: string | null = null;
        let snapshotVerdict: ReturnType<typeof legalAxleDetermination> | null = null;
        if (!prior && binding && f.loadId != null && calibrationCurrent && model) {
          const vehicleComplete = !!f.vehicle && [f.vehicle.speedKph, f.vehicle.pitchDeg, f.vehicle.rollDeg, f.vehicle.accelerationMps2].every(v => typeof v === "number" && Number.isFinite(v));
          const stability = vehicleComplete ? assessWeightStability(f.vehicle!) : { stable: false, score: 0, reasons: ["Vehicle stability telemetry incomplete"] };
          let config: Record<string, { label?: string; configuredLimitKg?: number; limitSource?: string }> = {};
          try { config = binding.channelConfigJson ? JSON.parse(binding.channelConfigJson) : {}; } catch { config = {}; }
          const axleGroups = Object.entries(f.readings).map(([channel, raw]) => ({ axleGroupKey: channel, label: config[channel]?.label ?? channel, weightKg: applyCalibration(raw, { slope: model.slope, offset: model.interceptOffset, pointCount: model.pointCount, rSquared: model.rSquared ?? undefined }), configuredLimitKg: config[channel]?.configuredLimitKg ?? null, limitSource: config[channel]?.limitSource ?? null, sourceChannels: [channel] }));
          const draft = buildWeightSnapshot({ loadId: f.loadId, unitId: binding.unitId, trailerId: binding.trailerId, tareKg: binding.tareKg, axleGroups, measurementSource: "loadsense_calibrated", calibrationId: model.modelRef, stability, measuredAt });
          /*
           * P4.2 (0159) — decide whether this reading may stand as a legal axle determination, and
           * store the decision rather than the sentence. Everything it rests on is frozen on the
           * snapshot except one thing: a calibration model can be invalidated later, and
           * re-deriving at read time would make a reading that was legal in March stop having been
           * legal in June. "Was it legal when taken?" and "is the calibration still trusted?" are
           * different questions; the second is answered by sweeping calibrationModelId.
           */
          const determination = snapshotVerdict = legalAxleDetermination({
            source: "loadsense_calibrated",
            calibration: model
              ? { verifiedAt: model.effectiveAt, expiresAt: calibrationEvent?.validUntil ?? null, invalidatedAt: model.invalidatedAt, status: model.status }
              : null,
            stability,
            readingAt: measuredAt,
          });
          snapshotRef = ref("LSW");
          const ins = await db.insert(loadSenseWeightSnapshots).values({ snapshotRef, legalDetermination: determination.legal, legalDeterminationCode: determination.legal ? null : determination.code, legalDeterminationReason: determination.legal ? determination.basis : determination.reason, loadId: f.loadId, unitId: binding.unitId, trailerId: binding.trailerId, measurementDeviceId: binding.measurementDeviceId, calibrationModelId: model.id, measurementSource: "loadsense_calibrated", tareKg: draft.tareKg, grossKg: draft.grossKg, payloadKg: draft.payloadKg, stable: draft.stable, stabilityScore: draft.stabilityScore, measuredAt, payloadHash: draft.payloadHash });
          const snapshotId = Number(ins[0]?.insertId ?? 0);
          if (snapshotId > 0) for (const axle of draft.axleGroups) await db.insert(loadSenseAxleWeights).values({ snapshotId, axleGroupKey: axle.axleGroupKey, label: axle.label, weightKg: axle.weightKg, configuredLimitKg: axle.configuredLimitKg ?? null, limitSource: axle.limitSource ?? null, status: axle.status, sourceChannelsJson: JSON.stringify(axle.sourceChannels ?? []) });
        }
        resultKind = snapshotRef ? "loadSenseWeightSnapshot" : "loadSenseGatewayFrame"; resultRef = snapshotRef ?? scopedFrameKey;
        await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "accepted", resultKind, resultRef, receivedAt });
        const classification = snapshotRef ? "server-calibrated LoadSense snapshot" : binding ? "raw LoadSense evidence; no current usable calibration/load" : "raw LoadSense evidence; gateway not bound";
        // The authority line is now produced by the rule, not asserted beside it. It still says
        // not_granted in every case the rule refuses — which is the point: the sentence and the
        // behaviour can no longer drift apart.
        const authority = snapshotVerdict == null
          ? "Billing authority: not_granted. Certified-scale authority: not_granted."
          : snapshotVerdict.legal
            ? `Legal axle determination: granted. ${snapshotVerdict.basis} Billing authority: not_granted until a person accepts it.`
            : `Legal axle determination: not_granted (${snapshotVerdict.code}). ${snapshotVerdict.reason} Still usable for ${snapshotVerdict.stillUsableFor}.`;
        return { inboundRef, status: "accepted" as const, becomes: d.becomes, note: `${classification}. ${authority}`, resultRef };
      }

      if (input.feed === "fuel_transaction") {
        const unit = (await db.select({ id: units.id }).from(units).where(eq(units.unitNumber, String(p.unitRef))).limit(1))[0];
        const financialEntityId = typeof p.financialEntityId === "number" ? p.financialEntityId : 0;
        const financial = financialEntityId > 0 ? (await db.select({ id: financialEntities.id }).from(financialEntities).where(eq(financialEntities.id, financialEntityId)).limit(1))[0] : undefined;
        if (!unit || !(await recordBelongsToOrganization(db, i.orgRef, "unit", unit.id)) || !financial || !(await recordBelongsToOrganization(db, i.orgRef, "financial_entity", financial.id))) {
          await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: "Unit or financial entity is absent or not owned by this organization", receivedAt });
          return { inboundRef, status: "rejected" as const, refusals: ["Unit or financial entity is absent or not owned by this organization"] };
        }
        const fuelRef = ref("FUEL");
        await db.insert(fuelTransactions).values({ fuelRef, financialEntityId, unitId: unit.id, vendorName: typeof p.vendorName === "string" ? p.vendorName.slice(0, 220) : `${i.name} feed`, jurisdiction: typeof p.jurisdiction === "string" ? p.jurisdiction : null, jurisdictionSource: typeof p.jurisdiction === "string" ? "fleet_card_statement" : "unknown", occurredAt: new Date(String(p.occurredAt)), fuelType: (["diesel", "gasoline", "def", "propane", "cng", "lng", "electric_charge", "other"].includes(String(p.fuelType)) ? String(p.fuelType) : "other") as never, quantity: p.quantity as number, quantityUnit: typeof p.quantityUnit === "string" ? p.quantityUnit.slice(0, 12) : "L", totalCents: toCents(p.total as number)!, odometerKm: typeof p.odometerKm === "number" ? p.odometerKm : null, payerType: "company", purpose: "company_vehicle_operation", financialTreatment: "company_operating_expense", reimbursementStatus: "not_applicable", privateToFueler: false, hosRuleConclusion: "unknown", status: "needs_review" } as never);
        resultKind = "fuelTransaction"; resultRef = fuelRef;
      } else if (input.feed === "eld_duty_status") {
        const op = (await db.select({ id: operators.id }).from(operators).where(eq(operators.name, String(p.operatorRef))).limit(1))[0];
        if (!op || !(await recordBelongsToOrganization(db, i.orgRef, "operator", op.id))) { await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: `Operator ${String(p.operatorRef)} is not on record for this organization`, receivedAt }); return { inboundRef, status: "rejected" as const, refusals: [`Operator ${String(p.operatorRef)} is not on record for this organization`] }; }
        const ins = await db.insert(dutyRecords).values({ operatorId: op.id, dutyStatus: p.dutyStatus as never, startedAt: new Date(String(p.startedAt)), endedAt: typeof p.endedAt === "string" ? new Date(p.endedAt) : null, latitude: typeof p.latitude === "number" ? p.latitude : null, longitude: typeof p.longitude === "number" ? p.longitude : null, jurisdiction: typeof p.jurisdiction === "string" ? p.jurisdiction : null, source: `integration:${i.clientRef}` } as never);
        resultKind = "dutyRecord"; resultRef = String(Number(ins[0]?.insertId ?? 0));
      } else if (input.feed === "gps_position") { resultKind = "positionEvidence"; resultRef = inboundRef; }
      else if (input.feed === "vehicle_telemetry" || input.feed === "fault_code" || input.feed === "safety_event" || input.feed === "video_clip") {
        const unit = typeof p.unitRef === "string" ? (await db.select({ id: units.id }).from(units).where(eq(units.unitNumber, p.unitRef)).limit(1))[0] : undefined;
        const unitOwned = unit ? await recordBelongsToOrganization(db, i.orgRef, "unit", unit.id) : false;
        if (input.feed !== "video_clip" && (!unit || !unitOwned)) { await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "rejected", rejectionReason: `Unit ${String(p.unitRef)} is not on record for this organization`, receivedAt }); return { inboundRef, status: "rejected" as const, refusals: [`Unit ${String(p.unitRef)} is not on record for this organization`] }; }
        // the inbound row first, so the record it becomes can name it
        const pre = await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "accepted", receivedAt });
        const inboundEventId = Number(pre[0]?.insertId ?? 0);
        if (input.feed === "vehicle_telemetry") {
          const ins = await db.insert(telemetrySnapshots).values({ unitId: unit!.id, recordedAt: new Date(String(p.recordedAt)), odometerKm: typeof p.odometerKm === "number" ? p.odometerKm : null, engineHours: typeof p.engineHours === "number" ? p.engineHours : null, ptoHours: typeof p.ptoHours === "number" ? p.ptoHours : null, idleMinutes: typeof p.idleMinutes === "number" ? Math.round(p.idleMinutes) : null, fuelLevelPct: typeof p.fuelLevelPct === "number" ? p.fuelLevelPct : null, sourceClientId: i.clientId, inboundEventId });
          resultKind = "telemetrySnapshot"; resultRef = String(Number(ins[0]?.insertId ?? 0));
        } else if (input.feed === "fault_code") {
          const seenAt = new Date(String(p.seenAt)); const sub = typeof p.subcode === "string" ? p.subcode.slice(0, 20) : null;
          const cur = (await db.select().from(faultCodes).where(and(eq(faultCodes.unitId, unit!.id), eq(faultCodes.protocol, p.protocol as never), eq(faultCodes.code, String(p.code).slice(0, 40)), sub == null ? isNull(faultCodes.subcode) : eq(faultCodes.subcode, sub))).limit(1))[0];
          if (cur) { await db.update(faultCodes).set({ occurrenceCount: cur.occurrenceCount + 1, lastSeenAt: seenAt > cur.lastSeenAt ? seenAt : cur.lastSeenAt, status: cur.status === "cleared" ? "active" : cur.status }).where(eq(faultCodes.id, cur.id)); resultKind = "faultCode"; resultRef = String(cur.id); }
          else { const ins = await db.insert(faultCodes).values({ unitId: unit!.id, protocol: p.protocol as never, code: String(p.code).slice(0, 40), subcode: sub, description: typeof p.description === "string" ? p.description.slice(0, 300) : null, firstSeenAt: seenAt, lastSeenAt: seenAt, sourceClientId: i.clientId }); resultKind = "faultCode"; resultRef = String(Number(ins[0]?.insertId ?? 0)); }
        } else if (input.feed === "safety_event") {
          const eventRef = ref("DRV");
          await db.insert(drivingEvents).values({ eventRef, unitId: unit!.id, operatorId: null, kind: p.kind as never, recordedAt: new Date(String(p.recordedAt)), latitude: typeof p.latitude === "number" ? p.latitude : null, longitude: typeof p.longitude === "number" ? p.longitude : null, magnitude: typeof p.magnitude === "number" ? p.magnitude : null, magnitudeUnit: typeof p.magnitudeUnit === "string" ? p.magnitudeUnit.slice(0, 20) : null, speedKph: typeof p.speedKph === "number" ? p.speedKph : null, postedLimitKph: typeof p.postedLimitKph === "number" ? p.postedLimitKph : null, postedLimitSource: typeof p.postedLimitKph === "number" ? `${i.name} feed — unverified` : null, sourceClientId: i.clientId, inboundEventId });
          resultKind = "drivingEvent"; resultRef = eventRef;
        } else {
          const candidateEvent = typeof p.eventRef === "string" ? (await db.select({ id: drivingEvents.id, eventRef: drivingEvents.eventRef, unitId: drivingEvents.unitId, sourceClientId: drivingEvents.sourceClientId }).from(drivingEvents).where(eq(drivingEvents.eventRef, p.eventRef)).limit(1))[0] : undefined;
          const eventSource = candidateEvent?.sourceClientId ? (await db.select({ orgRef: integrationClients.orgRef }).from(integrationClients).where(eq(integrationClients.id, candidateEvent.sourceClientId)).limit(1))[0] : undefined;
          const eventUnitOwned = candidateEvent?.unitId ? await recordBelongsToOrganization(db, i.orgRef, "unit", candidateEvent.unitId) : false;
          const ev = candidateEvent && (eventSource?.orgRef === i.orgRef || eventUnitOwned) ? candidateEvent : undefined;
          if (ev) { await db.update(drivingEvents).set({ videoClipRef: String(p.clipRef).slice(0, 200), videoClipHash: String(p.clipHash).toLowerCase() }).where(eq(drivingEvents.id, ev.id)); resultKind = "drivingEvent"; resultRef = ev.eventRef; }
          else if (unit && unitOwned) { const eventRef = ref("DRV"); await db.insert(drivingEvents).values({ eventRef, unitId: unit.id, kind: "other", recordedAt: new Date(String(p.recordedAt)), videoClipRef: String(p.clipRef).slice(0, 200), videoClipHash: String(p.clipHash).toLowerCase(), sourceClientId: i.clientId, inboundEventId }); resultKind = "drivingEvent"; resultRef = eventRef; }
          else { await db.update(inboundEvents).set({ status: "rejected", rejectionReason: "Neither the event nor the unit is on record" }).where(eq(inboundEvents.id, inboundEventId)); return { inboundRef, status: "rejected" as const, refusals: ["Neither the event nor the unit is on record"] }; }
        }
        await db.update(inboundEvents).set({ resultKind, resultRef }).where(eq(inboundEvents.id, inboundEventId));
        return { inboundRef, status: "accepted" as const, becomes: d.becomes, note: d.note, resultRef };
      }
      await db.insert(inboundEvents).values({ orgRef: i.orgRef, inboundRef, clientId: i.clientId, feed: input.feed, idempotencyKey: input.idempotencyKey, payloadJson, payloadHash, status: "accepted", resultKind, resultRef, receivedAt });
      return { inboundRef, status: "accepted" as const, becomes: d.becomes, note: d.note, resultRef };
    }),
});
