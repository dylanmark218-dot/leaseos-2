/**
 * v22.20 (0086) — the enforcement surface, at last reachable from a client.
 *
 * One rule governs every resolver here: **the client supplies observations, and
 * the server supplies facts.**
 *
 * A client may say which document it scanned, which violation it read off it,
 * which order it is asking about. It may not say who it is, which organization
 * it acts for, what role it holds, or — above all — which repairs were done.
 * `repairs` was a parameter of `releaseOutOfServiceOrder` from the day that
 * function was written, and a client that could pass its own would be a client
 * that says "here are my repairs, trust me" and frees a prohibited truck. They
 * are loaded here from `workOrderReleases`, which the shop owns.
 *
 * The resolvers are deliberately thin: validate, derive, call one core
 * function, return. Every decision that matters — consequences, scope
 * selection, the dominance rule, who may release — already lives in `_core`
 * with its own tests, and none of it is re-implemented here.
 */
import { TRPCError } from "@trpc/server";
import type { DbOrTx, Tx } from "./_core/dbTypes";
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { requireCallerUnits } from "./unitScope";
import {
  deviceSafetyLatches, enforcementDocumentExtractions, enforcementEvents, enforcementViolations,
  oosReleaseFindings, oosReleasePolicies, outOfServiceOrders, roadsidePanelGrants, scanAudits, workOrderReleases,
} from "../drizzle/schema";
import { affectedRows, confirmEnforcementEvent, releaseOutOfServiceOrder, type ConfirmInput } from "./_core/enforcementCommit";
import { reviewExtraction, type RepairRecord } from "./_core/enforcement";
import { mayRecordFinding, selectPolicyForScope, type FindingType, type ScopedPolicy } from "./_core/oosReleasePolicy";
import { resolveActingScope } from "./_core/actingScope";
import { enqueueEnforcementEvent } from "./_core/enforcementOutbox";
import { buildRoadsidePanel, checkPanelAccess, panelLines, type PanelItem, type WithheldItem } from "./_core/roadsidePanel";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const SCOPE = z.enum(["driver", "vehicle", "trailer", "cargo", "carrier"]);
const FINDING_TYPE = z.enum(["repair_verification", "reinspection", "inspector_release", "document_confirmation", "waiting_period_complete", "other"]);

/**
 * The repairs behind an order, read from the shop's own records.
 *
 * Never a parameter. A release that trusted the caller's account of what was
 * fixed would be a release with no mechanic in it.
 */
async function repairsForOrder(d: DbOrTx, orderRef: string): Promise<RepairRecord[]> {
  const order = (await d.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, orderRef)).limit(1))[0];
  if (!order) return [];
  const violations = await d.select().from(enforcementViolations).where(eq(enforcementViolations.eventRef, order.eventRef));
  const workOrderIds = violations.map((v: { workOrderId: number | null }) => v.workOrderId).filter((n: number | null): n is number => n != null);
  if (!workOrderIds.length) return [];
  const releases = await d.select().from(workOrderReleases).where(inArray(workOrderReleases.workOrderId, workOrderIds));
  return releases
    // A superseded release is not the current account of the repair.
    .filter((r: { supersededByReleaseId: number | null }) => r.supersededByReleaseId == null)
    .map((r: Record<string, unknown>) => ({
      workOrderRef: String(r.workOrderId),
      repairCompletedAt: (r.releasedAt as Date | null) ?? null,
      repairCompletedByUserId: (r.technicianUserId as number | null) ?? null,
      // The shop's own test result, not an assertion by whoever is releasing.
      functionalTestPassed: r.testResult === "pass",
      /**
       * `workOrderReleases` carries no evidence-record column, so this read
       * `r.evidenceRecordId` — which is undefined on every row. The effect was
       * that `afterEvidenceRef` was always null, the release gate always found
       * "no after-repair evidence", and no out-of-service order could ever be
       * released through the product. Found by the end-to-end test, which is
       * what an end-to-end test is for.
       *
       * The mechanic's signed release row IS the after-repair record — it
       * carries the repair summary, the test procedure, the result, the road
       * test and the technician. Referencing it is honest; inventing a column
       * would not have been.
       */
      afterEvidenceRef: `workOrderRelease:${r.id}`,
    }));
}

/** The caller's strongest role, for the policy's finding-role check. */
function roleOf(ctx: { roles?: readonly string[] }): string | null {
  return ctx.roles?.[0] ?? null;
}

async function scopedPolicies(d: DbOrTx): Promise<ScopedPolicy[]> {
  const rows = await d.select().from(oosReleasePolicies).where(eq(oosReleasePolicies.status, "approved"));
  return rows.map((r: Record<string, unknown>) => ({
    policyRef: r.policyRef as string, version: r.version as number,
    scopeType: r.scopeType as "company" | "branch" | "terminal", scopeRef: (r.scopeRef as string | null) ?? null,
    tenantId: (r.tenantId as string | null) ?? null,
    effectiveFrom: r.effectiveFrom as Date, effectiveTo: (r.effectiveTo as Date | null) ?? null,
    repairerMayRecordRepairVerification: !!r.repairerMayRecordRepairVerification,
    releaserMustDifferFromRepairer: !!r.releaserMustDifferFromRepairer,
    releaserMustDifferFromFindingAuthor: !!r.releaserMustDifferFromFindingAuthor,
    allowedFindingRoles: JSON.parse(r.allowedFindingRolesJson as string),
    approvedByUserId: (r.approvedByUserId as number) ?? 0,
    approvedAt: (r.approvedAt as Date) ?? (r.effectiveFrom as Date),
  }));
}

export const enforcementRouter = router({
  /**
   * Record a scanned document. Changes no compliance state whatsoever — the
   * office learns a stop happened; nothing is decided.
   */
  extractionRecord: roleProcedure("enforcement.extractionRecord")
    .input(z.object({
      documentKind: z.string().min(2).max(60),
      evidenceRecordId: z.number().int().positive().optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      fields: z.array(z.object({ field: z.string().min(1).max(60), value: z.string().max(400).nullable(), confidence: z.number().min(0).max(1) })).max(100),
      capturedAt: z.coerce.date(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const review = reviewExtraction(input.fields);
      const extractionRef = ref("EXTR");
      await d.insert(enforcementDocumentExtractions).values({
        extractionRef, documentKind: input.documentKind, evidenceRecordId: input.evidenceRecordId ?? null,
        capturedByUserId: ctx.user.id, capturedAt: input.capturedAt,
        latitude: input.latitude ?? null, longitude: input.longitude ?? null,
        fieldsJson: JSON.stringify(input.fields), extractedCount: review.extracted,
        highlightedJson: JSON.stringify(review.highlighted), missingRequiredJson: JSON.stringify(review.missingRequired),
        requiresConfirmation: true, status: "proposed",
      });
      return { extractionRef, ...review };
    }),

  /**
   * Confirm a stop. The organization, the confirming person and the commit are
   * all the server's; the violations read off the document are the caller's.
   */
  eventConfirm: roleProcedure("enforcement.eventConfirm")
    .input(z.object({
      extractionRef: z.string().max(64).optional(),
      eventType: z.string().min(2).max(60),
      jurisdiction: z.string().min(2).max(40),
      agency: z.string().min(2).max(200),
      occurredAt: z.coerce.date(),
      locationText: z.string().max(300).optional(),
      inspectionReportNumber: z.string().max(120).optional(),
      inspectionLevel: z.string().max(20).optional(),
      inspectionResult: z.enum(["pass", "requires_attention", "out_of_service", "unknown"]),
      operatorId: z.number().int().positive().optional(),
      unitId: z.number().int().positive().optional(),
      trailerId: z.number().int().positive().optional(),
      jobId: z.number().int().positive().optional(),
      branchId: z.string().max(40).optional(),
      terminalId: z.string().max(40).optional(),
      subjectRefs: z.object({ driver: z.string().max(120).optional(), vehicle: z.string().max(120).optional(), trailer: z.string().max(120).optional(), cargo: z.string().max(120).optional(), carrier: z.string().max(120).optional() }).default({}),
      violations: z.array(z.object({
        system: z.string().min(2).max(60),
        ownCode: z.string().min(2).max(120),
        sourceReference: z.string().max(400).optional(),
        description: z.string().max(1000).optional(),
        citationIssued: z.boolean().default(false),
        outOfService: z.boolean().default(false),
        oosScope: SCOPE.nullable().default(null),
        defectRequired: z.boolean().default(false),
        repairRequired: z.boolean().default(false),
        courtAction: z.boolean().default(false),
        citationNumber: z.string().max(120).optional(),
        fineAmountCents: z.number().int().nonnegative().optional(),
        releaseCondition: z.string().max(600).optional(),
        requiredFindingType: FINDING_TYPE.optional(),
      })).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      // CP1.5 — the event carries the caller's tenant, but the defect and work order it files are keyed
      // to the unit, and a critical one grounds that truck in readiness. The unit and the trailer must be
      // the caller's organization's, checked before the transaction opens, so a refusal writes nothing.
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId, trailerId: input.trailerId });
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const confirm: ConfirmInput = {
        extractionRef: input.extractionRef ?? null, eventType: input.eventType, jurisdiction: input.jurisdiction,
        agency: input.agency, occurredAt: input.occurredAt, locationText: input.locationText ?? null,
        inspectionReportNumber: input.inspectionReportNumber ?? null, inspectionLevel: input.inspectionLevel ?? null,
        inspectionResult: input.inspectionResult, operatorId: input.operatorId ?? null, unitId: input.unitId ?? null,
        trailerId: input.trailerId ?? null, jobId: input.jobId ?? null,
        // Organization from the server; the caller may narrow within it, never leave it.
        tenantId: acting.tenantId,
        branchId: input.branchId ?? null,
        terminalId: input.terminalId ?? null,
        subjectRefFor: scope => (scope ? input.subjectRefs[scope] ?? null : null),
        violations: input.violations.map((v, i) => ({ ...v, violationRef: `${i}`, sourceReference: v.sourceReference ?? null, oosScope: v.oosScope ?? null })),
        confirmedByUserId: ctx.user.id,
        // A real outbox row, inside the same transaction as the order.
        enqueue: async (tx, e) => {
          await enqueueEnforcementEvent(tx, {
            tenantId: acting.tenantId, branchId: input.branchId ?? null,
            actorUserId: ctx.user.id, occurredAt: input.occurredAt,
            payload: { ...e, unitId: input.unitId ?? null, operatorId: input.operatorId ?? null },
          });
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await d.transaction((tx: Tx) => confirmEnforcementEvent(tx, confirm));
    }),

  /**
   * Record a release finding. The author and their role come from the request
   * context, and whether that role may record this kind of finding is the
   * approved policy's answer for the order's own scope.
   */
  findingRecord: roleProcedure("enforcement.findingRecord")
    .input(z.object({
      orderRef: z.string().min(1).max(64),
      finding: z.enum(["satisfied", "not_satisfied", "unknown"]),
      findingType: FINDING_TYPE,
      evidenceRef: z.string().max(64).optional(),
      notes: z.string().max(1000).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const actingForFinding = await resolveActingScope(d, ctx.user.id);
      const order = (await d.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, input.orderRef)).limit(1))[0];
      if (!order || order.tenantId !== actingForFinding.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such out-of-service order" });
      if (order.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That order is ${order.status}` });

      const role = roleOf(ctx);
      if (!role) throw new TRPCError({ code: "FORBIDDEN", message: "No effective role — a finding is recorded by somebody in a role, not by an anonymous caller" });

      const selection = selectPolicyForScope(await scopedPolicies(d), { tenantId: order.tenantId ?? null, branchId: order.branchId ?? null, terminalId: order.terminalId ?? null }, input.at);
      if (!selection.policy) throw new TRPCError({ code: "PRECONDITION_FAILED", message: selection.reason });

      const repairs = await repairsForOrder(d, input.orderRef);
      const permitted = mayRecordFinding({
        policy: selection.policy, findingType: input.findingType as FindingType, role, userId: ctx.user.id,
        repairedByUserIds: repairs.map(r => r.repairCompletedByUserId).filter((n): n is number => n != null),
      });
      if (!permitted.allowed) throw new TRPCError({ code: "FORBIDDEN", message: permitted.reason });

      const findingRef = ref("FIND");
      await d.insert(oosReleaseFindings).values({
        findingRef, orderRef: input.orderRef, finding: input.finding, findingType: input.findingType,
        evidenceRef: input.evidenceRef ?? null, notes: input.notes ?? null,
        recordedByUserId: ctx.user.id, recordedByRole: role, recordedAt: input.at,
      });
      return { findingRef, orderRef: input.orderRef, finding: input.finding, recordedByRole: role, note: "Recorded. A finding is not a release — the order still has to be released by somebody entitled to release it." };
    }),

  /**
   * Release an order.
   *
   * The caller names the order and nothing else that matters. The repairs are
   * the shop's records, the releaser is the request context, the policy is
   * selected from the order's own scope, and the dominance rule is read from
   * the order's required act. None of it is negotiable from the client.
   */
  orderRelease: roleProcedure("enforcement.orderRelease")
    .input(z.object({
      orderRef: z.string().min(1).max(64),
      releaseEvidenceRef: z.string().max(64).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const target = (await d.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.orderRef, input.orderRef)).limit(1))[0];
      if (!target || target.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such out-of-service order" });
      const repairs = await repairsForOrder(d, input.orderRef);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outcome = await d.transaction((tx: Tx) => releaseOutOfServiceOrder(tx, {
        orderRef: input.orderRef, repairs,
        releasedByUserId: ctx.user.id, releaseEvidenceRef: input.releaseEvidenceRef ?? null, at: input.at,
      }));
      if (!outcome.released) throw new TRPCError({ code: "PRECONDITION_FAILED", message: outcome.reasons.join(" · ") });
      return outcome;
    }),

  /**
   * A device reports what it is holding.
   *
   * This is an observation, exactly like every other thing the field sends: it
   * tells the office a truck is locally stopped, and it creates no prohibition.
   * A latch that turns into an order does so because somebody confirmed the
   * document, not because a tablet said so.
   *
   * Idempotent per reporter and capture, because a device retrying on a bad
   * connection is the normal case, not a second truck being stopped.
   */
  latchReport: roleProcedure("enforcement.latchReport")
    .input(z.object({
      captureLocalId: z.string().min(1).max(120),
      deviceRef: z.string().max(64).optional(),
      subjectType: SCOPE,
      subjectRef: z.string().min(1).max(120),
      capturedAt: z.coerce.date(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      note: z.string().max(400).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const existing = (await d.select().from(deviceSafetyLatches)
        .where(and(eq(deviceSafetyLatches.reportedByUserId, ctx.user.id), eq(deviceSafetyLatches.captureLocalId, input.captureLocalId))).limit(1))[0];
      if (existing) {
        return { latchRef: existing.latchRef, recorded: false, state: existing.state, serverOrderRef: existing.serverOrderRef, note: "Already reported; nothing was recorded twice." };
      }
      const latchRef = ref("LATCH");
      await d.insert(deviceSafetyLatches).values({
        latchRef, deviceRef: input.deviceRef ?? null, reportedByUserId: ctx.user.id,
        captureLocalId: input.captureLocalId, subjectType: input.subjectType, subjectRef: input.subjectRef,
        capturedAt: input.capturedAt, latitude: input.latitude ?? null, longitude: input.longitude ?? null,
        note: input.note ?? null, state: "blocking",
      });
      return {
        latchRef, recorded: true, state: "blocking" as const, serverOrderRef: null,
        note: "Recorded. This tells the office the subject is stopped on this device; it does not by itself create an out-of-service order.",
      };
    }),

  /**
   * What the server can authoritatively say about the latches a device holds.
   *
   * The only thing that lifts a latch. An order the server cannot find, or one
   * still active, comes back as `hold` — never as a lift. A device that cannot
   * be told to lift keeps blocking, which is the safe direction.
   */
  latchStates: roleProcedure("enforcement.latchStates")
    .input(z.object({ orderRefs: z.array(z.string().min(1).max(64)).max(200).default([]) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const held = await d.select().from(deviceSafetyLatches).where(eq(deviceSafetyLatches.reportedByUserId, ctx.user.id));
      const refs = Array.from(new Set([...input.orderRefs, ...held.map((h: { serverOrderRef: string | null }) => h.serverOrderRef).filter((r: string | null): r is string => !!r)]));
      const orders = refs.length ? await d.select().from(outOfServiceOrders).where(inArray(outOfServiceOrders.orderRef, refs)) : [];
      const byRef = new Map(orders.map((o: { orderRef: string; status: string }) => [o.orderRef, o.status]));

      const states = refs.map(orderRef => {
        const status = byRef.get(orderRef);
        if (status === "released" || status === "rescinded") return { orderRef, decision: "lift" as const, authority: status, reason: `This order is ${status}` };
        if (status === "active") return { orderRef, decision: "hold" as const, authority: null, reason: "This order is still active" };
        // Unknown is not a lift. A device that cannot be told to lift keeps blocking.
        return { orderRef, decision: "hold" as const, authority: null, reason: "The server holds no authoritative state for this order — keep blocking" };
      });
      return {
        states,
        heldLatches: held.map((h: Record<string, unknown>) => ({ latchRef: h.latchRef, subjectType: h.subjectType, subjectRef: h.subjectRef, state: h.state, serverOrderRef: h.serverOrderRef })),
        note: "Only a released or rescinded order lifts a latch. Anything else is hold.",
      };
    }),

  /**
   * Issue a grant an inspector can be handed.
   *
   * Time-limited on purpose and short by default: a panel is for the stop that
   * is happening, not a standing window into the fleet. The issuer records who
   * it is for in their own words — the server does not verify that, and does not
   * pretend to.
   */
  panelGrantIssue: roleProcedure("enforcement.panelGrantIssue")
    .input(z.object({
      unitRef: z.string().min(1).max(120),
      unitId: z.number().int().positive().optional(),
      issuedFor: z.string().min(3).max(220),
      minutesValid: z.number().int().min(5).max(720).default(120),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5
      const d = await db();
      const grantRef = ref("PGRANT");
      const expiresAt = new Date(input.at.getTime() + input.minutesValid * 60_000);
      await d.insert(roadsidePanelGrants).values({
        grantRef, unitRef: input.unitRef, unitId: input.unitId ?? null,
        issuedByUserId: ctx.user.id, issuedFor: input.issuedFor,
        issuedAt: input.at, expiresAt,
      });
      return { grantRef, unitRef: input.unitRef, expiresAt, note: "The code carries this reference. It is not a key: the grant is resolved here, and it has to be live and for this unit." };
    }),

  /** Withdraw a grant before it expires. */
  panelGrantRevoke: roleProcedure("enforcement.panelGrantRevoke")
    .input(z.object({ grantRef: z.string().min(1).max(64), reason: z.string().min(3).max(400), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const r = await d.update(roadsidePanelGrants)
        .set({ revokedAt: input.at, revokedByUserId: ctx.user.id, revocationReason: input.reason })
        .where(and(eq(roadsidePanelGrants.grantRef, input.grantRef), isNull(roadsidePanelGrants.revokedAt)));
      if (affectedRows(r) !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "That grant does not exist or was already revoked" });
      return { grantRef: input.grantRef, revoked: true };
    }),

  /**
   * Open a panel against a grant.
   *
   * Read-only, scoped, recorded. The unit is presented by the caller and checked
   * against the grant, so a live grant for one truck cannot be pointed at
   * another. Every view increments the grant and writes a scan audit, because
   * "who saw our compliance records" is not a question to answer from memory.
   */
  panelView: roleProcedure("enforcement.panelView")
    .input(z.object({ grantRef: z.string().min(1).max(64), unitRef: z.string().min(1).max(120), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const row = (await d.select().from(roadsidePanelGrants).where(eq(roadsidePanelGrants.grantRef, input.grantRef)).limit(1))[0];
      const access = checkPanelAccess(row ? {
        grantRef: row.grantRef, unitRef: row.unitRef, issuedAt: row.issuedAt,
        expiresAt: row.expiresAt, issuedFor: row.issuedFor, revokedAt: row.revokedAt,
      } : null, input.unitRef, input.at);
      if (!access.allowed) throw new TRPCError({ code: "FORBIDDEN", message: access.reason });

      /* Active prohibitions become panel items. Nothing else is invented. */
      const actingForPanel = await resolveActingScope(d, ctx.user.id);
      const orders = await d.select().from(outOfServiceOrders)
        .where(and(
          eq(outOfServiceOrders.subjectRef, input.unitRef),
          eq(outOfServiceOrders.status, "active"),
          eq(outOfServiceOrders.tenantId, actingForPanel.tenantId),
        ));
      const items: PanelItem[] = orders.map((o: Record<string, unknown>) => ({
        ruleCode: `OOS.${String(o.scope).toUpperCase()}`,
        label: `Out of service — ${o.scope}`,
        axis: "roadworthiness" as const,
        state: "blocked" as const,
        reason: `Issued ${(o.issuedAt as Date).toISOString().slice(0, 16).replace("T", " ")}${o.issuingAgency ? ` by ${o.issuingAgency}` : ""}. Release condition: ${o.releaseCondition}`,
        expiresAt: null, documentRef: null, authority: (o.issuingAgency as string | null) ?? null,
      }));

      // Named because they apply to a commercial vehicle and this panel cannot
      // evaluate them — never omitted, which would read as "in order".
      const unevaluatedAxes = ["periodic_inspection", "daily_inspection", "documentation"] as const;

      const withheld: WithheldItem[] = [
        { label: "Driver medical and qualification records", because: "medical" },
        { label: "Operator personal details", because: "personal" },
        { label: "Insurance premiums and purchase cost", because: "financial" },
      ];

      const panel = buildRoadsidePanel({ unitRef: input.unitRef, items, unevaluatedAxes: [...unevaluatedAxes], withheld, generatedAt: input.at });

      await d.update(roadsidePanelGrants)
        .set({ viewCount: (row.viewCount ?? 0) + 1, lastViewedAt: input.at })
        .where(eq(roadsidePanelGrants.id, row.id));
      // The scan and access vocabulary this system already has: a QR scan of a unit,
      // accessed for inspection. Inventing
      // an "external_inspector" role would have meant a second audit taxonomy.
      await d.insert(scanAudits).values({ scanType: "qr", subjectType: "unit", subjectId: row.unitId ?? 0, accessRole: "inspection", scannedAt: input.at });

      return { access: access.reason, panel, lines: panelLines(panel) };
    }),

  /** What is prohibited right now, and why. */
  activeOrders: roleProcedure("enforcement.activeOrders")
    .input(z.object({ subjectRef: z.string().max(120).optional(), scope: SCOPE.optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const d = await db();
      // Scoped to the caller's own organization. This returned every active
      // prohibition in the database regardless of who was asking, which is
      // harmless with one organization and a leak with two.
      const acting = await resolveActingScope(d, ctx.user.id);
      let rows = await d.select().from(outOfServiceOrders)
        .where(and(eq(outOfServiceOrders.status, "active"), eq(outOfServiceOrders.tenantId, acting.tenantId)))
        .orderBy(desc(outOfServiceOrders.issuedAt)).limit(500);
      if (input.subjectRef) rows = rows.filter((r: { subjectRef: string }) => r.subjectRef === input.subjectRef);
      if (input.scope) rows = rows.filter((r: { scope: string }) => r.scope === input.scope);
      return {
        orders: rows.map((r: Record<string, unknown>) => ({
          orderRef: r.orderRef, scope: r.scope, subjectRef: r.subjectRef, issuedAt: r.issuedAt,
          issuingAgency: r.issuingAgency, releaseCondition: r.releaseCondition, requiredFindingType: r.requiredFindingType,
          branchId: r.branchId, terminalId: r.terminalId,
        })),
        note: "Active prohibitions. An order absent from this list has been released or rescinded, never deleted.",
      };
    }),

  /** One stop, with everything that followed from it. */
  eventGet: roleProcedure("enforcement.eventGet")
    .input(z.object({ eventRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const event = (await d.select().from(enforcementEvents).where(eq(enforcementEvents.eventRef, input.eventRef)).limit(1))[0];
      // Not found rather than forbidden: whether another organization has a stop
      // by this reference is itself something this caller should not learn.
      if (!event || event.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such enforcement event" });
      const violations = await d.select().from(enforcementViolations).where(eq(enforcementViolations.eventRef, input.eventRef));
      const orders = await d.select().from(outOfServiceOrders).where(eq(outOfServiceOrders.eventRef, input.eventRef));
      const findings = orders.length
        ? await d.select().from(oosReleaseFindings).where(inArray(oosReleaseFindings.orderRef, orders.map((o: { orderRef: string }) => o.orderRef)))
        : [];
      return { event, violations, orders, findings };
    }),
});
