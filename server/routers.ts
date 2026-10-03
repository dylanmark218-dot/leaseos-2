import { randomUUID } from "node:crypto";
import { REFRESH_COOKIE_NAME } from "@shared/const";
import { redeemRefresh, revokeAllForOpenId, revokeFamily } from "./sessionFamilyService";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import { isTrustedOrigin } from "./_core/csrf";
import { clearAccessCookie, clearRefreshCookie, issueAccessCookie, issueRefreshCookie } from "./_core/cookies";

/**
 * P0-B — the surface a refresh family must belong to.
 *
 * The same rule `verifySession` applies to the access token: enforced when this server knows its
 * own identity, and not in a checkout that has none (development, the test suite), where refusing
 * every family would turn a missing variable into an outage. Production always has one
 * (`assertProductionSecrets`), so there a family minted for another surface — or for none — is
 * refused the way a retired verifier is, and nothing about which families exist is disclosed.
 */
const expectedFamilyApp = (): { appId: string } | undefined => (ENV.appId ? { appId: ENV.appId } : undefined);

/**
 * The refresh cookie carries `familyRef.verifier`. Split on the FIRST dot only: the reference is
 * base64url of random bytes and contains no dot, while splitting greedily would mangle a verifier
 * that happens to contain one.
 */
function readRefreshCookie(req: { headers?: { cookie?: string } }): { familyRef: string; verifier: string } | null {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  const pair = raw.split(";").map(s => s.trim()).find(s => s.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!pair) return null;
  const value = decodeURIComponent(pair.slice(REFRESH_COOKIE_NAME.length + 1));
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  return { familyRef: value.slice(0, dot), verifier: value.slice(dot + 1) };
}
import { TRPCError } from "@trpc/server";
import { requireCallerUnits, requireUnitInScope } from "./unitScope";
import { z } from "zod";
import { storageKeyInput } from "./_core/storageKey";
/**
 * v22.5.1 — the operational truth boundary. Authorization answers "may this
 * person perform this kind of action"; these refusals answer "what may the
 * action establish as fact". A create or capture may carry an observation or
 * a claim; it may not carry a verified, authenticated, resolved, approved or
 * authoritative state, a verification time or verifier, or server provenance.
 * A present value is refused, not silently dropped, so an old client learns.
 */
const REFUSED = z.undefined({ message: "Trust-bearing value refused: this state is established by its own review, verification or transition procedure, never by a create or capture." }).optional();
import { systemRouter } from "./_core/systemRouter";
import { peopleRouter } from "./peopleRouter";
import { recordsRouter } from "./recordsRouter";
import {
  contractorRouter,
  financeRouter,
  payrollRouter,
} from "./payrollRouter";
import { payrollCompensationRouter } from "./payrollCompensationRouter";   // payroll P1 (0226)
import { payrollScheduleRouter } from "./payrollScheduleRouter";   // payroll P2 (0227)
import { fundingRouter, portalsRouter } from "./portalFundingRouter";
import { purchasingRouter, recoveryRouter, roadsideRouter, vendorRouter } from "./purchasingRouter";
import { deviceRouter, syncRouter } from "./deviceRouter";
import { complianceRouter } from "./complianceRouter";
import { calibrationRouter, requirementRouter } from "./requirementRouter";
import { surfacesRouter } from "./surfacesRouter";
import { widgetsRouter, type WidgetDeps } from "./widgetsRouter";
import { manifestCustodyRouter } from "./manifestCustodyRouter";
import { resolveActingScope } from "./_core/actingScope";
import { hosScopeFor, listDutyRecordsInScope, requireHosOperatorInScope, selfOperatorInScope } from "./hosScope";

/** 0132 — the acting tenant for the legacy readers; a user with no membership acts as the historical single tenant. */
async function scopeFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return { tenantId: (await resolveActingScope(db, userId)).tenantId };
}

import { securityIncidentsRouter } from "./securityIncidentsRouter";
import { sessionRouter } from "./sessionRouter";
import { clearOrganizationSelectionCookie } from "./_core/organizationSelectionCookie";
import { commercialOfficeRouter } from "./commercialOfficeRouter";
import { documentControlRouter } from "./documentControlRouter";
import { facilityDirectoryRouter } from "./facilityDirectoryRouter";
import type { WidgetLayoutStore } from "./_core/widgetService";
import { drizzleWidgetLayoutStore } from "./widgetLayouts";
import { widgetReaderFor } from "./widgetSources";
import { automationPolicyRouter } from "./automationPolicyRouter";
import { restrictedVaultRouter } from "./restrictedVaultRouter";
import { safetyProgramRouter } from "./safetyProgramRouter";
import { composeReadiness } from "./readinessComposer";
import { branchRolesFor } from "./_core/widgetRoleKeys";
import { isDomainRole, permissionsForDomainRole } from "./_core/recordsAuthorization";
import {
  listActiveUserRoles,
  recordAuthorizationDecision,
  actingScopeFor,
  evidenceInScope,
  jobInScope,
  operatorInScope,
  operatorForUserInScope,
  tripInScope,
  unitInScope,
  workOrderInScope,
  proposalInScope,
  rateCardInScope,
  trackingSubjectInScope,
  transferTrackingNumber,
  tripStopTripId,
  unitSafetyPlanUnitId,
  tripRefInScope,
  getUserByOpenId,
} from "./db";
import { dispatchGateRouter } from "./dispatchRouter";
import { createJobUnitGated } from "./dispatchEnforcementService";
import { iftaRouter } from "./iftaRouter";
import { fuelOpsRouter } from "./fuelOpsRouter";
import { periodRouter } from "./periodRouter";
import { paperworkRouter } from "./paperworkRouter";
import { gstRouter } from "./gstRouter";
import { arRouter, bankRouter } from "./cashRouter";
import { commercialRouter, portalAdminRouter } from "./commercialRouter";
import { commercialSetupRouter } from "./commercialSetupRouter";
import { customerCommercialRouter } from "./customerCommercialRouter";
import { invoicingRouter } from "./invoicingRouter";
import { billingRouter } from "./billingRouter";
import { geoRouter } from "./geoRouter";
import { commsRouter } from "./commsRouter";
import { enforcementRouter } from "./enforcementRouter";
import { timeOffRouter } from "./timeOffRouter";
import { openShiftsRouter } from "./openShiftsRouter";
import { crewRouter } from "./crewRouter";
import { calendarRouter } from "./calendarRouter";
import { readinessRouter } from "./readinessRouter";
import { messageBoardRouter } from "./messageBoardRouter";
import { assistantAskRouter } from "./assistantAskRouter";
import { agentRouter } from "./agentRouter";
import { liveAssistRouter } from "./liveAssistRouter";
import { attestRouter } from "./attestRouter";
import { hosRouter } from "./hosRouter";
import { portalRouter } from "./portalRouter";
import { shopRouter } from "./shopRouter";
import { maintenanceRouter } from "./maintenanceRouter";
import { fleetPortfolioRouter } from "./fleetPortfolioRouter";
import { assetRouter } from "./assetRouter";
import { projectRouter } from "./projectRouter";
import { inboundRouter, integrationRouter } from "./integrationRouter";
import { telematicsRouter } from "./telematicsRouter";
import { workforceRouter } from "./workforceRouter";
import { trainingAcademyRouter } from "./trainingAcademyRouter";
import { driverPortfolioRouter } from "./driverPortfolioRouter";
import { contractorOperationsRouter } from "./contractorOperationsRouter";
import { auditRouter } from "./auditRouter";
import { spatialRouter } from "./spatialRouter";
import { closeoutRouter } from "./closeoutRouter";
import { insuranceRouter } from "./insuranceRouter";
import { publicProcedure, roleProcedure, router } from "./_core/trpc";
import { storagePut } from "./storage";
import {
  createEvidenceRecord,
  findEvidenceByClientCaptureRef,
  createJob,
  createSafetyEvent,
  getJobByCode,
  listEvidenceRecords,
  listJobs,
  listRouteContexts,
  listSafetyEvents,
  verifyEvidenceRecord,
  createRouteContext,
  createComplianceDocument,
  createOperator,
  createUnit,
  createLoadProfile,
  createFacility,
  createMaintenanceDefect,
  createDelivery,
  createSignatureAudit,
  listComplianceDocuments,
  listOperators,
  listUnits,
  listLoadProfiles,
  listFacilities,
  listMaintenanceDefects,
  listDeliveries,
  listJobUnits,
  createInspection,
  listInspections,
  reviewComplianceDocument,
  listLocationIdentities,
  createLocationIdentity,
  listManifests,
  createManifest,
  listScanAudits,
  createScanAudit,
  listComplianceArtifacts,
  createComplianceArtifact,
  listTailgateMeetings,
  createTailgateMeeting,
  listTransferAcknowledgements,
  createTransferAcknowledgement,
  acknowledgeTransfer,
  listBillingRateCards,
  createBillingRateCard,
  listJobChargeLines,
  createJobChargeLine,
  listVendors,
  createVendor,
  listUnitSafetyPlans,
  createUnitSafetyPlan,
  updateBillingRateCard,
  updateVendor,
  updateUnitSafetyPlan,
  listRouteDecisions,
  createRouteDecision,
  listTrips,
  createTrip,
  updateTrip,
  listTripStops,
  createTripStop,
  updateTripStop,
  createDutyRecord,
  listWorkOrders,
  createWorkOrder,
  updateWorkOrder,
  updateZoneEvent,
 getDb } from "./db";
import { ingestBreadcrumb } from "./_core/tripGps";
import { routingSourceStatus } from "./_core/routingSource";
// P0-A2 — the GPS trace and the geofence proposals reach the database only through the telematics
// boundary. The unscoped `operatorForUser` / `activeTripForOperator` helpers that lived here, and
// `listZoneEvents` / `zoneEventTripId` in db.ts, are gone: an operator record and an active trip are
// the acting organization's or they are nobody's here.
import { activeTripForOperatorInScope, listZoneEventsInScope, requireZoneEventInScope, selfOperatorInTelematicsScope, telematicsScopeFor, tripBreadcrumbsInScope } from "./telematicsScope";
import { createOperatingZoneInScope, listOperatingZonesInScope, operatingZoneScopeFor } from "./operatingZoneScope";
/** A scan's access role is the strongest role the caller holds, in the scan audit's vocabulary. */
function scanRoleOf(roles: readonly string[]): "inspection" | "driver" | "mechanic" | "dispatcher" | "admin" {
  if (roles.includes("management") || roles.includes("controller")) return "admin";
  if (roles.includes("dispatcher")) return "dispatcher";
  if (roles.includes("mechanic") || roles.includes("shop_lead")) return "mechanic";
  if (roles.includes("safety") || roles.includes("auditor")) return "inspection";
  return "driver";
}
import {
  createAssistantProposal,
  updateAssistantProposal,
  getAssistantProposal,
  listPendingProposals,
  replaceProposalFields,
  listProposalFields,
} from "./db";
import {
  FORMS,
  buildProposal,
  answerField,
  setFieldStatus,
  generateReadBack,
  acknowledgeReadBack,
  rejectProposal,
  type Proposal,
  type ProposedField,
} from "./_core/aiProposal";
import {
  buildOutputSchema,
  buildSystemPrompt,
  parseExtraction,
  parseModelJson,
} from "./_core/assistantExtraction";
import { rehydrateProposal } from "./_core/assistantPersistence";
import { executeAssistantCommit } from "./_core/assistantCommitService";
import { invokeLLM } from "./_core/llm";

/** Rebuild the in-memory proposal from its stored rows. */
async function loadProposal(proposalId: string): Promise<Proposal | null> {
  const row = await getAssistantProposal(proposalId);
  if (!row) return null;
  const fieldRows = await listProposalFields(proposalId);
  return rehydrateProposal(row, fieldRows);
}

async function persist(p: Proposal) {
  await updateAssistantProposal(p.proposalId, {
    readBack: p.readBack,
    readBackAcknowledged: p.readBackAcknowledged,
    commitState: p.commitState,
  });
  await replaceProposalFields(
    p.proposalId,
    p.fields.map(f => ({
      proposalId: p.proposalId,
      fieldKey: f.key,
      label: f.label,
      fieldValue: JSON.stringify(f.value),
      precision: f.precision,
      source: f.source,
      confidence: f.confidence,
      status: f.status,
      sourceUtterance: f.sourceUtterance ?? null,
      correctedFrom:
        f.correctedFrom === undefined ? null : JSON.stringify(f.correctedFrom),
    }))
  );
}

const jobInput = z.object({
  jobCode: z.string().min(1).max(32),
  type: z.string().min(1).max(120),
  mode: z
    .enum(["general", "hydrovac", "recovery", "transport"])
    .default("general"),
  customer: z.string().min(1).max(160),
  location: z.string().min(1).max(220),
  vehicle: z.string().max(120).optional(),
  driver: z.string().max(120).optional(),
  status: z
    .enum([
      "dispatched",
      "in_transit",
      "loading",
      "on_site",
      "awaiting_docs",
      "complete",
    ])
    .default("dispatched"),
  progress: z.number().int().min(0).max(100).default(0),
  eta: z.string().max(32).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

/* ---- B28 widget board: real dependencies for the engine's router ---- */
/** The store's methods are all async, so the database handle can be resolved on first use rather than at module load. */
function lazyWidgetStore(tenantId: string): WidgetLayoutStore {
  const real = getDb().then(d => {
    if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return drizzleWidgetLayoutStore(d, tenantId);
  });
  return {
    findLayout: async (q) => (await real).findLayout(q),
    createLayout: async (layout, items, unset) => (await real).createLayout(layout, items, unset),
    updateOwnedLayout: async (layout, items, unset, tid, rev) => (await real).updateOwnedLayout(layout, items, unset, tid, rev),
  };
}
const widgetDeps: WidgetDeps = {
  storeFor: lazyWidgetStore,
  grants: {
    // Permissions of one role the user actually holds — or null, which actorForRole refuses.
    async permissionsForRole(userId, roleKey) {
      const held = new Set((await listActiveUserRoles(userId)).map(g => g.role));
      const branchRole = branchRolesFor(roleKey).find(b => held.has(b));
      return branchRole && isDomainRole(branchRole) ? permissionsForDomainRole(branchRole) : null;
    },
  },
  readerFor: (actor) => widgetReaderFor(actor, (userId) =>
    appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId } as never }) as never,
    // The caller's own operator record, in the scope the actor was resolved in — not their user id.
    () => operatorForUserInScope(actor.userId, { tenantId: actor.tenantId }),
    (subject) => composeReadiness(subject)),
};

export const appRouter = router({
  widgets: widgetsRouter(widgetDeps),
  automationPolicy: automationPolicyRouter,
  restrictedVault: restrictedVaultRouter,
  safetyProgram: safetyProgramRouter,
  manifestCustody: manifestCustodyRouter,
  securityIncidents: securityIncidentsRouter,
  commercialOffice: commercialOfficeRouter,
  documentControl: documentControlRouter,
  facilityDirectory: facilityDirectoryRouter,
  system: systemRouter,
  comms: commsRouter,
  paperwork: paperworkRouter,
  enforcement: enforcementRouter,
  timeOff: timeOffRouter,
  shifts: openShiftsRouter,
  crews: crewRouter,
  calendar: calendarRouter,
  readiness: readinessRouter,
  board: messageBoardRouter,
  assistantAsk: assistantAskRouter,
  agent: agentRouter,
  liveAssist: liveAssistRouter,
  hos: hosRouter,
  // B23.2 — who belongs to this organization and what they may do here.
  people: peopleRouter,
  records: recordsRouter,
  payroll: payrollRouter,
  payrollCompensation: payrollCompensationRouter,
  payrollSchedule: payrollScheduleRouter,
  contractors: contractorRouter,
  contractorOperations: contractorOperationsRouter,
  finance: financeRouter,
  portals: portalsRouter,
  funding: fundingRouter,
  roadside: roadsideRouter,
  purchasing: purchasingRouter,
  vendor: vendorRouter,
  recovery: recoveryRouter,
  device: deviceRouter,
  sync: syncRouter,
  compliance: complianceRouter,
  requirement: requirementRouter,
  calibration: calibrationRouter,
  surfaces: surfacesRouter,
  dispatch: dispatchGateRouter,
  ifta: iftaRouter,
  fuel: fuelOpsRouter,
  period: periodRouter,
  gst: gstRouter,
  bank: bankRouter,
  ar: arRouter,
  commercial: commercialRouter,
  commercialSetup: commercialSetupRouter,
  customerCommercial: customerCommercialRouter,
  invoicing: invoicingRouter,
  // v23.32 — Billing, Invoicing & AR: the billing workspace, billing invoices and receivables (0233).
  billing: billingRouter,
  geo: geoRouter,
  closeout: closeoutRouter,
  // SA1 — Sign & Attest: the signing foundation (docs/sign-attest/SA1_OWNER_RULING.md).
  attest: attestRouter,
  portalAdmin: portalAdminRouter,
  // v21.10 — external identities only; gated by externalProcedure, never by roles.
  portal: portalRouter,
  shop: shopRouter,
  // 0199 — fleet maintenance, checkpoint 1: who owns a work order, and cancelling one.
  maintenance: maintenanceRouter,
  // 0200 — the Fleet & Equipment Portfolio: holds, the meter record, the unit's operational state.
  fleet: fleetPortfolioRouter,
  asset: assetRouter,
  project: projectRouter,
  integration: integrationRouter,
  telematics: telematicsRouter,
  workforce: workforceRouter,
  academy: trainingAcademyRouter,
  driverPortfolio: driverPortfolioRouter,
  audit: auditRouter,
  spatial: spatialRouter,
  // v21.18 — machines only; gated by integrationProcedure, never by roles.
  inbound: inboundRouter,
  insurance: insuranceRouter,
  /**
   * v23.26 — identity, organization and workspace, resolved server-side.
   * The shell reads `session.context`; nothing it returns is an authority.
   */
  session: sessionRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),

    /**
     * S1-D — logout ends the session, rather than forgetting where it was kept.
     *
     * This used to clear the cookie and return success. A token already copied out of the browser
     * kept working for the rest of its year, because nothing recorded the session and nothing could
     * revoke it. Now the family named by the refresh cookie is revoked, so the next refresh fails
     * and the access token expires within its fifteen minutes.
     */
    logout: publicProcedure.mutation(async ({ ctx }) => {
      const presented = readRefreshCookie(ctx.req);
      if (presented) await revokeFamily(presented.familyRef, "logout");

      // Cleared with the attributes they were issued with (P0-B): a deletion that names another
      // path leaves the browser holding a live credential.
      clearAccessCookie(ctx.req, ctx.res);
      clearRefreshCookie(ctx.req, ctx.res);
      // v23.26 — the organization selection is part of the session, so it ends
      // with it. Leaving it behind would hand the next person to use this
      // browser a pre-selected tenant, which is a confusing way to start and a
      // bad way to end.
      clearOrganizationSelectionCookie(ctx.req, ctx.res);
      // Through the same table every other security decision is written to.
      // A sign-out is the event an access review most often needs and the one
      // a system that only logs refusals never has.
      await recordAuthorizationDecision({
        actorUserId: ctx.user?.id ?? null,
        procedureName: "auth.logout",
        permission: "portal.compose_own",
        rolesHeld: null,
        outcome: ctx.user ? "allowed" : "denied_unauthenticated",
        detail: "session ended",
        occurredAt: new Date(),
      });
      return { success: true } as const;
    }),

    /**
     * S1-C — spend the refresh credential, get the next one.
     *
     * Every outcome other than `ok` is one refusal, deliberately: a caller cannot tell a revoked
     * family from an expired one from a verifier that never matched, so the endpoint gives nothing
     * away about which families exist or why one died.
     */
    refresh: publicProcedure.mutation(async ({ ctx }) => {
      /*
       * The cookie is sameSite "none" so embedded surfaces keep working, which means a page on any
       * origin can cause this call. It could read nothing — the cookies are httpOnly — but it
       * could rotate the family and strand the real browser, or trip reuse detection and kill it.
       */
      if (!isTrustedOrigin(ctx.req)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cross-site refresh refused" });
      }
      const presented = readRefreshCookie(ctx.req);
      if (!presented) throw new TRPCError({ code: "UNAUTHORIZED", message: "No refresh credential" });

      const out = await redeemRefresh(presented.familyRef, presented.verifier, new Date(), expectedFamilyApp());
      if (out.kind !== "ok") {
        clearRefreshCookie(ctx.req, ctx.res);
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Session expired. Sign in again." });
      }

      /*
       * P0-B — the replacement access token carries the account's name, as the login's did.
       * `verifySession` refuses a token whose `name` is empty, so a refresh that minted one with
       * `name: ""` handed the browser a credential the next request would reject — the session
       * still ended fifteen minutes after login even once the cookie reached this procedure.
       */
      const who = await getUserByOpenId(out.openId);
      const accessToken = await sdk.createSessionToken(out.openId, { name: who?.name || "" });
      issueAccessCookie(ctx.req, ctx.res, accessToken);
      issueRefreshCookie(ctx.req, ctx.res, { familyRef: presented.familyRef, verifier: out.verifier });
      return { ok: true as const };
    }),

    /** Sign out everywhere — the control a stolen-laptop report needs. */
    revokeAll: publicProcedure.mutation(async ({ ctx }) => {
      if (!isTrustedOrigin(ctx.req)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cross-site revocation refused" });
      }
      const presented = readRefreshCookie(ctx.req);
      if (!presented) throw new TRPCError({ code: "UNAUTHORIZED", message: "No refresh credential" });
      const out = await redeemRefresh(presented.familyRef, presented.verifier, new Date(), expectedFamilyApp());
      if (out.kind !== "ok") throw new TRPCError({ code: "UNAUTHORIZED", message: "Session expired." });
      await revokeAllForOpenId(out.openId, "revoked_all");
      // Every family is dead; the credentials this browser holds are cleared with them (P0-B).
      clearAccessCookie(ctx.req, ctx.res);
      clearRefreshCookie(ctx.req, ctx.res);
      return { ok: true as const };
    }),
  }),
  fieldRoute: router({
    jobs: router({
      list: roleProcedure("jobs.list").query(async ({ ctx }) => listJobs(await scopeFor(ctx.user.id))),
      byCode: roleProcedure("jobs.byCode")
        .input(z.object({ jobCode: z.string().min(1) }))
        .query(async ({ ctx, input }) => getJobByCode(input.jobCode, await scopeFor(ctx.user.id))),
      create: roleProcedure("jobs.create")
        .input(jobInput)
        .mutation(async ({ ctx, input }) => createJob(input, await scopeFor(ctx.user.id))),
    }),
    evidence: router({
      list: roleProcedure("evidence.list").query(async ({ ctx }) => listEvidenceRecords(await scopeFor(ctx.user.id))),
      upload: roleProcedure("evidence.upload")
        .input(
          z.object({
            title: z.string().min(1).max(220),
            category: z.string().min(1).max(80),
            fileName: z.string().min(1).max(220),
            mimeType: z.string().min(1).max(120),
            dataBase64: z.string().min(1),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            notes: z.string().optional(),
            // v21.6 — offline-first: the device's reference (idempotent) and when it captured.
            clientCaptureRef: z.string().min(8).max(80).optional(),
            capturedAt: z.coerce.date().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          const fileBuffer = Buffer.from(input.dataBase64, "base64");
          if (fileBuffer.byteLength > 15 * 1024 * 1024) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Evidence files must be 15 MB or smaller.",
            });
          }
          if (input.clientCaptureRef) {
            const existing = await findEvidenceByClientCaptureRef(input.clientCaptureRef);
            if (existing) return { id: existing.id, key: existing.storageKey ?? "", alreadyUploaded: true as const };
          }
          const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
          const stored = await storagePut(
            `${ctx.user.id}/evidence/${Date.now()}-${safeName}`,
            fileBuffer,
            input.mimeType
          );
          const id = await createEvidenceRecord({
            title: input.title,
            category: input.category,
            storageKey: stored.key,
            // No storageUrl: a durable read URL is a bearer capability. Reads mint a
            // short-lived signed URL after an authorization check.
            storageUrl: null,
            mimeType: input.mimeType,
            // The device says when it captured; createdAt is when the server received it.
            capturedAt: input.capturedAt ?? new Date(),
            capturedBy: ctx.user.id,
            clientCaptureRef: input.clientCaptureRef ?? null,
            latitude: input.latitude,
            longitude: input.longitude,
            status: "needs_review",
            notes: input.notes,
          });
          return { id, ...stored };
        }),
      add: roleProcedure("evidence.add")
        .input(
          z.object({
            jobId: z.number().int().optional(),
            title: z.string().min(1).max(220),
            category: z.string().min(1).max(80),
            storageKey: storageKeyInput.optional(),
            // A caller may record where a document lives, but not a `/manus-storage/`
            // path: that route is deleted, so such a value is a dead capability stored
            // as if it were live. Refused at the input rather than cleaned up later.
            storageUrl: z.string().max(1024).refine(u => !u.startsWith("/manus-storage/"), {
              message: "The generic storage proxy is retired; store the storage key instead",
            }).optional(),
            mimeType: z.string().max(120).optional(),
            capturedAt: z.coerce.date(),
            capturedBy: z.number().int().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            status: REFUSED,
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createEvidenceRecord({ ...input, status: "needs_review" });
      }),   // verification is evidence.verify
      verify: roleProcedure("evidence.verify")
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await evidenceInScope(input.id, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${input.id} not found` });
        return verifyEvidenceRecord(input.id);
      }),
    }),
    trips: router({
      list: roleProcedure("trips.list").query(async ({ ctx }) => listTrips(await scopeFor(ctx.user.id))),
      create: roleProcedure("trips.create")
        .input(
          z.object({
            tripNumber: z.string().min(1).max(50),
            jobId: z.number().int().optional(),
            unitId: z.number().int().optional(),
            operatorId: z.number().int().optional(),
            manifestId: z.number().int().optional(),
            originLocationId: z.number().int().optional(),
            destinationFacilityId: z.number().int().optional(),
            tripType: z
              .enum(["round_trip", "one_way", "shuttle"])
              .default("round_trip"),
            status: z
              .enum([
                "planned",
                "loading",
                "in_transit",
                "unloading",
                "complete",
                "cancelled",
              ])
              .default("planned"),
            startedAt: z.coerce.date().optional(),
            completedAt: z.coerce.date().optional(),
            odometerStartKm: z.number().nonnegative().optional(),
            odometerEndKm: z.number().nonnegative().optional(),
            distanceKm: z.number().nonnegative().optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          const scope = await scopeFor(ctx.user.id);
          /*
           * A trip may not name a unit the caller's organization cannot see. This wrote any unitId it
           * was given, so one organization could put a trip — its distance, its odometer, its IFTA
           * miles — on another organization's truck. Scoped as every unit-keyed write is, and out of
           * scope is "not found", worded exactly as for a unit that does not exist.
           */
          if (input.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
          return createTrip({
            ...input,
            distanceKm:
              input.distanceKm ??
              (input.odometerStartKm !== undefined &&
              input.odometerEndKm !== undefined
                ? Math.max(0, input.odometerEndKm - input.odometerStartKm)
                : undefined),
          }, scope);
        }),
      update: roleProcedure("trips.update")
        .input(
          z.object({
            id: z.number().int().positive(),
            status: z
              .enum([
                "planned",
                "loading",
                "in_transit",
                "unloading",
                "complete",
                "cancelled",
              ])
              .optional(),
            startedAt: z.coerce.date().optional(),
            completedAt: z.coerce.date().optional(),
            odometerEndKm: z.number().nonnegative().optional(),
            distanceKm: z.number().nonnegative().optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.id != null && !(await tripInScope(input.id, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Trip ${input.id} not found` });
        
          const { id, ...values } = input;
          return updateTrip(id, values);
        }),
    }),
    tripStops: router({
      list: roleProcedure("tripStops.list")
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(async ({ ctx, input }) => listTripStops(input?.tripId, await scopeFor(ctx.user.id))),
      create: roleProcedure("tripStops.create")
        .input(
          z.object({
            tripId: z.number().int(),
            stopType: z.enum(["load", "unload", "fuel", "checkpoint"]),
            locationId: z.number().int().optional(),
            facilityId: z.number().int().optional(),
            sequence: z.number().int().positive().default(1),
            arrivedAt: z.coerce.date().optional(),
            setupStartedAt: z.coerce.date().optional(),
            operationStartedAt: z.coerce.date().optional(),
            operationCompletedAt: z.coerce.date().optional(),
            departedAt: z.coerce.date().optional(),
            durationMinutes: z.number().nonnegative().optional(),
            setupMinutes: z.number().nonnegative().optional(),
            waitMinutes: z.number().nonnegative().optional(),
            quantity: z.number().nonnegative().optional(),
            quantityUnit: z.string().max(30).optional(),
            ticketNumber: z.string().max(100).optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.tripId != null && !(await tripInScope(input.tripId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Trip ${input.tripId} not found` });
        
          const minutes = (a?: Date, b?: Date) =>
            a && b
              ? Math.max(0, (b.getTime() - a.getTime()) / 60000)
              : undefined;
          return createTripStop({
            ...input,
            // 0179: the actor was in hand here and discarded. A stop is evidence
            // on the spine; `driver_typed` because this procedure is a person
            // entering it directly — the assistant path stamps neither, because
            // its provenance is per-field in proposalFields.
            recordedByUserId: ctx.user.id,
            recordedSource: "driver_typed" as const,
            waitMinutes:
              input.waitMinutes ??
              minutes(input.arrivedAt, input.setupStartedAt),
            setupMinutes:
              input.setupMinutes ??
              minutes(input.setupStartedAt, input.operationStartedAt),
            durationMinutes:
              input.durationMinutes ??
              minutes(input.arrivedAt, input.departedAt),
          });
        }),
      update: roleProcedure("tripStops.update")
        .input(
          z.object({
            id: z.number().int().positive(),
            arrivedAt: z.coerce.date().optional(),
            setupStartedAt: z.coerce.date().optional(),
            operationStartedAt: z.coerce.date().optional(),
            operationCompletedAt: z.coerce.date().optional(),
            departedAt: z.coerce.date().optional(),
            durationMinutes: z.number().nonnegative().optional(),
            setupMinutes: z.number().nonnegative().optional(),
            waitMinutes: z.number().nonnegative().optional(),
            quantity: z.number().nonnegative().optional(),
            ticketNumber: z.string().max(100).optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        { const tid = await tripStopTripId(input.id); if (tid != null && !(await tripInScope(tid, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Trip stop ${input.id} not found` }); }
        
          const { id, ...values } = input;
          return updateTripStop(id, {
            ...values,
            // 0179: an edit left no trace at all before this — no actor, and the
            // table carried no updatedAt. The receipt reader compares this stamp
            // with the newest assistant commit, so a hand edit is never mistaken
            // for committed evidence.
            updatedByUserId: ctx.user.id,
            updatedSource: "driver_typed" as const,
            updatedAt: new Date(),
          });
        }),
    }),
    operatingZones: router({
      // P0-A2.1 — an operating zone is the acting organization's geofence. The list is filtered in
      // the query to the caller's organization; a new zone is stamped with it, never with an
      // organization named in the input; and the GPS engine (server/_core/tripGps.ts) evaluates a
      // trip against its own organization's zones only, read from trips.orgRef.
      list: roleProcedure("operatingZones.list").query(async ({ ctx }) => listOperatingZonesInScope(await operatingZoneScopeFor(ctx.user.id))),
      create: roleProcedure("operatingZones.create")
        .input(
          z.object({
            orgRef: REFUSED,
            name: z.string().min(1).max(180),
            zoneType: z.enum(["loading", "unloading", "both"]),
            locationId: z.number().int().optional(),
            facilityId: z.number().int().optional(),
            latitude: z.number(),
            longitude: z.number(),
            radiusMetres: z.number().positive().default(75),
            active: z.number().int().default(1),
            verifiedAt: z.coerce.date().optional(),
            source: z.string().max(220).optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          const { orgRef: _refused, ...zone } = input;
          return createOperatingZoneInScope(await operatingZoneScopeFor(ctx.user.id), zone);
        }),
    }),
    assistant: router({
      forms: roleProcedure("assistant.forms").query(() =>
        Object.values(FORMS).map(f => ({
          key: f.key,
          version: f.version,
          title: f.title,
        }))
      ),

      /**
       * Speech or text in, typed proposal out. The model is constrained by
       * outputSchema to the declared slots — it cannot return a field this
       * form does not have.
       */
      draft: roleProcedure("assistant.draft")
        .input(
          z.object({
            formKey: z.string(),
            targetRef: z.string().max(180),
            transcript: z.string().min(1).max(8000),
            // Structured write context. targetRef remains display-only.
            targetRecordId: z.number().int().positive().optional(),
            eventDateLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
            tripId: z.number().int().optional(),
            jobId: z.number().int().optional(),
            unitId: z.number().int().optional(),
            capturedOffline: z.boolean().default(false),
            idempotencyKey: z.string().min(1).max(40).optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          await requireCallerUnits(ctx.user.id, { unitId: input.unitId });   // CP1.5 — before the model is asked anything; the proposal would be visible to the unit's owner
          if (input.idempotencyKey) {
            const existing = await getAssistantProposal(input.idempotencyKey);
            if (existing) {
              if (existing.createdByUserId !== ctx.user.id) {
                throw new TRPCError({
                  code: "FORBIDDEN",
                  message: "Idempotency key already belongs to another user",
                });
              }
              const proposal = await loadProposal(input.idempotencyKey);
              if (proposal) {
                return {
                  proposal,
                  notes: existing.notes,
                  overreachDetected: !!existing.overreachFlags,
                };
              }
            }
          }

          const form = FORMS[input.formKey];
          if (!form) throw new Error(`Unknown form: ${input.formKey}`);

          const result = await invokeLLM({
            messages: [
              {
                role: "system",
                content: buildSystemPrompt(form, input.targetRef),
              },
              { role: "user", content: input.transcript },
            ],
            outputSchema: buildOutputSchema(form),
          });

          // Response is OpenAI-shaped; content may be a string or content parts.
          const raw = result.choices?.[0]?.message?.content ?? "";
          const parsed = parseModelJson(
            typeof raw === "string" ? raw : JSON.stringify(raw)
          );
          const extraction = parseExtraction(form, parsed ?? {});
          const proposal = buildProposal(
            form,
            input.targetRef,
            extraction.values,
            input.idempotencyKey ?? `P-${randomUUID()}`
          );

          await createAssistantProposal({
            proposalId: proposal.proposalId,
            formKey: form.key,
            formVersion: form.version,
            title: form.title,
            targetRef: input.targetRef,
            targetRecordId: input.targetRecordId,
            eventDateLocal: input.eventDateLocal,
            utcOffsetMinutes: input.utcOffsetMinutes,
            jobId: input.jobId,
            tripId: input.tripId,
            unitId: input.unitId,
            createdByUserId: ctx.user.id,
            transcript: input.transcript,
            notes: extraction.notes,
            commitState: proposal.commitState,
            capturedOffline: input.capturedOffline,
            overreachFlags: extraction.overreach.length
              ? JSON.stringify(extraction.overreach)
              : null,
          });
          await persist(proposal);

          return {
            proposal,
            notes: extraction.notes,
            // Surfaced rather than hidden: a model that concluded something is
            // worth a person seeing.
            overreachDetected: extraction.overreach.length > 0,
          };
        }),

      get: roleProcedure("assistant.get")
        .input(z.object({ proposalId: z.string() }))
        .query(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        return loadProposal(input.proposalId);
      }),

      pending: roleProcedure("assistant.pending")
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.tripId != null && !(await tripInScope(input.tripId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Trip ${input.tripId} not found` });
        return listPendingProposals(input?.tripId);
      }),

      answer: roleProcedure("assistant.answer")
        .input(
          z.object({
            proposalId: z.string(),
            fieldKey: z.string(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            precision: z.enum(["exact", "approximate"]).default("exact"),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          const next = answerField(
            p,
            FORMS[p.formKey],
            input.fieldKey,
            input.value,
            input.precision
          );
          await persist(next);
          return next;
        }),

      setStatus: roleProcedure("assistant.setStatus")
        .input(
          z.object({
            proposalId: z.string(),
            fieldKey: z.string(),
            status: z.enum(["proposed", "confirmed", "rejected", "corrected"]),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          const next = setFieldStatus(
            p,
            FORMS[p.formKey],
            input.fieldKey,
            input.status
          );
          await persist(next);
          return next;
        }),

      readBack: roleProcedure("assistant.readBack")
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          const next = generateReadBack(p);
          await persist(next);
          return next;
        }),

      acknowledge: roleProcedure("assistant.acknowledge")
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          const next = acknowledgeReadBack(p);
          await persist(next);
          return next;
        }),

      /**
       * The only path from proposal to operational record. Refuses with the
       * specific outstanding items rather than a generic failure.
       */
      commit: roleProcedure("assistant.commit")
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        return executeAssistantCommit({
            proposalId: input.proposalId,
            actorUserId: ctx.user.id,
          });
      }),

      reject: roleProcedure("assistant.reject")
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await proposalInScope(input.proposalId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Proposal ${input.proposalId} not found` });
        
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          await persist(rejectProposal(p));
          return { success: true } as const;
        }),
    }),
    gps: router({
      // Called on an interval (e.g. every 15-30s) or on significant movement
      // while a trip is active. Runs the point against all active operating
      // zones and proposes any enter/exit it implies as a pending zoneEvent —
      // it never writes to tripStops directly.
      submitBreadcrumb: roleProcedure("gps.submitBreadcrumb")
        .input(
          z.object({
            tripId: z.number().int().optional(),
            unitId: REFUSED,
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            accuracyMetres: z.number().nonnegative().optional(),
            speedKmh: z.number().nonnegative().optional(),
            headingDegrees: z.number().min(0).max(360).optional(),
            source: z.enum(["gps", "dead_reckoning", "manual"]).default("gps"),
            recordedAt: z.coerce.date(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          // P0-A2 — the operator record and the active trip are both resolved inside the acting
          // organization. A driver who left company B does not keep sending positions to B's trip
          // through their old operator row, and an ex-member is refused at the scope step.
          const scope = await telematicsScopeFor(ctx.user.id);
          const own = await selfOperatorInTelematicsScope(scope, ctx.user.id);
          const active = own ? await activeTripForOperatorInScope(scope, own.id) : null;
          if (!active) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active trip is assigned to the signed-in operator; a position is not attached to a trip it was not assigned to" });
          if (input.tripId != null && input.tripId !== active.id) throw new TRPCError({ code: "FORBIDDEN", message: `The signed-in operator's active trip is ${active.id}; a breadcrumb is not attached to another trip` });
          return ingestBreadcrumb({ ...input, tripId: active.id, unitId: active.unitId ?? undefined });
        }),
      breadcrumbs: roleProcedure("gps.breadcrumbs")
        .input(z.object({ tripId: z.number().int() }))
        .query(async ({ ctx, input }) => tripBreadcrumbsInScope(await telematicsScopeFor(ctx.user.id), input.tripId)),
      // Pending proposals a driver/dispatcher hasn't ruled on yet. Omit tripId
      // to review pending events across the organization's active trips (dispatch view).
      pendingZoneEvents: roleProcedure("gps.pendingZoneEvents")
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(async ({ ctx, input }) => listZoneEventsInScope(await telematicsScopeFor(ctx.user.id), input?.tripId, "pending")),
      zoneEvents: roleProcedure("gps.zoneEvents")
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(async ({ ctx, input }) =>
          // P0-A2 — filtered in the query to the trips the caller's organization owns. The P4.1 guard
          // only ever checked a NAMED trip; the unfiltered list was every company's proposals.
          listZoneEventsInScope(await telematicsScopeFor(ctx.user.id), input?.tripId)),
      // The human-in-the-loop step: a confirmed event can optionally be linked
      // to the tripStop it resolves (e.g. sets arrivedAt). Rejecting it leaves
      // the tripStop entirely untouched — the GPS engine never overwrites a
      // record on its own say-so.
      confirmZoneEvent: roleProcedure("gps.confirmZoneEvent")
        .input(
          z.object({
            id: z.number().int().positive(),
            action: z.enum(["confirm", "reject"]),
            tripStopId: z.number().int().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          // P0-A2 — the proposal must belong to a trip the caller's organization owns; a foreign
          // one is refused exactly as a nonexistent one, before anything is written.
          const ze = await requireZoneEventInScope(await telematicsScopeFor(ctx.user.id), input.id);
          await updateZoneEvent(ze.id, {
            status: input.action === "confirm" ? "confirmed" : "rejected",
            confirmedAt: new Date(),
            confirmedBy: ctx.user.id,
            tripStopId:
              input.action === "confirm" ? input.tripStopId : undefined,
          });
          return { success: true } as const;
        }),
    }),
    dutyRecords: router({
      list: roleProcedure("dutyRecords.list")
        .input(z.object({ operatorId: z.number().int().optional() }).optional())
        .query(async ({ ctx, input }) => {
          // P0-A1 — filtered in the query to the operators the caller's organization owns. The P4.1
          // guard above this only ever checked a NAMED operator; the unfiltered list was every
          // company's duty records, newest 500. A foreign operator id is refused by the boundary
          // exactly as a nonexistent one is.
          return listDutyRecordsInScope(await hosScopeFor(ctx.user.id), input?.operatorId);
        }),
      create: roleProcedure("dutyRecords.create")
        .input(
          z.object({
            operatorId: z.number().int().optional(),
            tripId: z.number().int().optional(),
            dutyStatus: z.enum([
              "driving",
              "on_duty",
              "sleeper_berth",
              "off_duty",
            ]),
            startedAt: z.coerce.date(),
            endedAt: z.coerce.date().optional(),
            durationMinutes: z.number().nonnegative().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            locationLabel: z.string().max(220).optional(),
            jurisdiction: z.string().max(100).optional(),
            source: z.string().max(80).default("driver_entry"),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          // P0-A1 — whichever operator this names, the caller's organization must own it: a named
          // operator (an amendment) through the boundary, the signed-in driver's own through the
          // scoped self-resolution. An operator record another company owns is not the driver's
          // here, so a driver who left company B does not keep writing B's duty records.
          const scope = await hosScopeFor(ctx.user.id);
          if (input.operatorId != null) await requireHosOperatorInScope(scope, input.operatorId);
          const own = await selfOperatorInScope(scope, ctx.user.id);
          const roles = (ctx as unknown as { roles?: readonly string[] }).roles ?? [];
          const amending = input.operatorId != null && input.operatorId !== own?.id;
          if (amending && !roles.some(r => r === "dispatcher" || r === "hr" || r === "management")) throw new TRPCError({ code: "FORBIDDEN", message: "A duty record names the operator of the signed-in driver; recording for another operator is an amendment for dispatch, HR or management" });
          const operatorId = amending ? input.operatorId! : own?.id;
          if (operatorId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No operator record for the signed-in user, and no amendment authority to name one" });
          return createDutyRecord({
            ...input,
            operatorId,
            source: amending ? `amendment by user ${ctx.user.id}` : input.source,
            durationMinutes:
              input.durationMinutes ??
              (input.endedAt
                ? Math.max(
                    0,
                    (input.endedAt.getTime() - input.startedAt.getTime()) /
                      60000
                  )
                : undefined),
          });
        }),
    }),
    workOrders: router({
      list: roleProcedure("workOrders.list")
        .input(z.object({ unitId: z.number().int().optional() }).optional())
        .query(async ({ ctx, input }) => {
        // P4.1: scope guard
        const scope = await scopeFor(ctx.user.id);
        if (input?.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
        // 0199 — without a unit this listed every organization's work orders. It lists the caller's.
        return listWorkOrders(input?.unitId, scope);
      }),
      create: roleProcedure("workOrders.create")
        .input(
          z.object({
            workOrderNumber: z.string().min(1).max(80),
            unitId: z.number().int(),
            inspectionId: z.number().int().optional(),
            defectId: z.number().int().optional(),
            status: z
              .enum([
                "draft",
                "open",
                "in_progress",
                "waiting_parts",
                "ready_for_service",
                "closed",
              ])
              .default("open"),
            priority: z
              .enum(["routine", "urgent", "critical"])
              .default("routine"),
            openedAt: z.coerce.date(),
            startedAt: z.coerce.date().optional(),
            completedAt: z.coerce.date().optional(),
            odometerKm: z.number().nonnegative().optional(),
            engineHours: z.number().nonnegative().optional(),
            technician: z.string().max(180).optional(),
            laborMinutes: z.number().nonnegative().optional(),
            parts: z.string().optional(),
            findings: z.string().optional(),
            correctiveAction: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.unitId != null && !(await unitInScope(input.unitId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
        return createWorkOrder({ ...input, openedByUserId: ctx.user.id });
      }),
      update: roleProcedure("workOrders.update")
        .input(
          z.object({
            id: z.number().int().positive(),
            /*
             * 0199 — status is not editable here. This took any status, including backwards, and so
             * walked around `shop.workOrderAdvance`'s forward-only rule; a status sent now is refused
             * at the schema, not dropped quietly. Moving a work order is `shop.workOrderAdvance`;
             * cancelling one is `maintenance.workOrderCancel`.
             */
            status: REFUSED,
            priority: z.enum(["routine", "urgent", "critical"]).optional(),
            startedAt: z.coerce.date().optional(),
            completedAt: z.coerce.date().optional(),
            odometerKm: z.number().nonnegative().optional(),
            engineHours: z.number().nonnegative().optional(),
            technician: z.string().max(180).optional(),
            laborMinutes: z.number().nonnegative().optional(),
            parts: z.string().optional(),
            findings: z.string().optional(),
            correctiveAction: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await workOrderInScope(input.id, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.id} not found` });
        
          const { id, status: _refused, ...values } = input;
          return updateWorkOrder(id, values);
        }),
    }),
    routeContext: router({
      list: roleProcedure("routeContext.list").query(() => listRouteContexts()),
      create: roleProcedure("routeContext.create")
        .input(
          z.object({
            name: z.string().min(1).max(180),
            source: z.string().min(1).max(220),
            effectiveAt: z.coerce.date(),
            expiresAt: z.coerce.date().optional(),
            verifiedAt: REFUSED,
            confidence: REFUSED,
            restrictions: z.string().optional(),
            snapshotKey: z.string().max(512).optional(),
            snapshotUrl: z.string().max(1024).optional(),
          })
        )
        .mutation(({ input }) => createRouteContext({ ...input, verifiedAt: null, confidence: "low", source: `stated: ${input.source}` })),   // a stated source is a claim; verification names its dataset
    }),
    routeDecisions: router({
      list: roleProcedure("routeDecisions.list").query(async ({ ctx }) => listRouteDecisions(await scopeFor(ctx.user.id))),
      create: roleProcedure("routeDecisions.create")
        .input(
          z.object({
            tripId: z.string().min(1).max(40),
            selectedRoute: z.string().min(1).max(180),
            alternatives: z.string().optional(),
            vehicleType: z.string().min(1).max(100),
            gvwTonnes: z.number().int().positive(),
            axleCount: z.number().int().positive(),
            heightMetres: z.number().int().positive(),
            widthMetres: z.number().int().positive(),
            lengthMetres: z.number().int().positive(),
            hazmatClass: z.string().max(40).optional(),
            quantity: z.string().max(80).optional(),
            riskLevel: z
              .enum(["low", "moderate", "high", "blocked"])
              .default("moderate"),
            source: REFUSED,
            confidence: REFUSED,
            driverAcknowledged: z.number().int().default(0),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await tripRefInScope(input.tripId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Trip ${input.tripId} not found` });
        return createRouteDecision({ ...input, source: `manual choice (routing source ${routingSourceStatus().status})`, confidence: "manual — not authority data" });
      }),   // a person's choice, labelled as one; never authority
    }),
    billing: router({
      rateCards: router({
        list: roleProcedure("rateCards.list").query(async ({ ctx }) => listBillingRateCards(await scopeFor(ctx.user.id))),
        create: roleProcedure("rateCards.create")
          .input(
            z.object({
              name: z.string().min(1).max(160),
              unitType: z.string().min(1).max(100),
              hourlyRate: z.number().int().nonnegative().default(0),
              dailyRate: z.number().int().nonnegative().default(0),
              jumpHourRate: z.number().int().nonnegative().default(0),
              disposalRate: z.number().int().nonnegative().default(0),
              specialtyEquipmentRate: z.number().int().nonnegative().default(0),
              currency: z.string().length(3).default("CAD"),
              active: z.number().int().default(1),
            })
          )
          .mutation(async ({ ctx, input }) => createBillingRateCard(input, await scopeFor(ctx.user.id))),
        update: roleProcedure("rateCards.update")
          .input(
            z.object({
              id: z.number().int().positive(),
              hourlyRate: z.number().int().nonnegative().optional(),
              dailyRate: z.number().int().nonnegative().optional(),
              jumpHourRate: z.number().int().nonnegative().optional(),
              disposalRate: z.number().int().nonnegative().optional(),
              specialtyEquipmentRate: z.number().int().nonnegative().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await rateCardInScope(input.id, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Rate card ${input.id} not found` });
        
            const { id, ...values } = input;
            return updateBillingRateCard(id, values);
          }),
      }),
      lines: router({
        list: roleProcedure("lines.list")
          .input(z.object({ jobId: z.number().int().optional() }).optional())
          .query(async ({ ctx, input }) => listJobChargeLines(input?.jobId, await scopeFor(ctx.user.id))),
        create: roleProcedure("lines.create")
          .input(
            z.object({
              jobId: z.number().int().optional(),
              description: z.string().min(1).max(220),
              quantity: z.number().int().positive(),
              unitRate: z.number().int().nonnegative(),
              source: z.string().max(80).default("rate_card"),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createJobChargeLine({
              ...input,
              amount: input.quantity * input.unitRate,
            });
      }),
      }),
    }),
    vendors: router({
      list: roleProcedure("vendors.list").query(async ({ ctx }) => listVendors(await scopeFor(ctx.user.id))),
      update: roleProcedure("vendors.update")
        .input(
          z.object({
            id: z.number().int().positive(),
            phone: z.string().max(40).optional(),
            emergencyPhone: z.string().max(40).optional(),
            availability: z.string().max(100).optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          const { id, ...values } = input;
          // P4.1: only this book's vendor can be updated here; another book's is not found.
          const ok = await updateVendor(id, values, await scopeFor(ctx.user.id));
          if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: `Vendor ${id} not found` });
          return ok;
        }),
      create: roleProcedure("vendors.create")
        .input(
          z.object({
            name: z.string().min(1).max(180),
            category: z.string().min(1).max(100),
            contactName: z.string().max(160).optional(),
            phone: z.string().max(40).optional(),
            emergencyPhone: z.string().max(40).optional(),
            email: z.string().email().optional(),
            coverageArea: z.string().max(220).optional(),
            availability: z.string().max(100).optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => createVendor(input, await scopeFor(ctx.user.id))),
    }),
    unitSafety: router({
      list: roleProcedure("unitSafety.list").query(async ({ ctx }) => listUnitSafetyPlans(await scopeFor(ctx.user.id))),
      update: roleProcedure("unitSafety.update")
        .input(
          z.object({
            id: z.number().int().positive(),
            hazardSummary: z.string().optional(),
            shutdownProcedure: z.string().optional(),
            requiredPpe: z.string().optional(),
            sdsReferences: z.string().optional(),
            emergencyContacts: z.string().optional(),
            version: z.number().int().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        { const uid = await unitSafetyPlanUnitId(input.id); if (uid != null && !(await unitInScope(uid, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit safety plan ${input.id} not found` }); }
        
          const { id, ...values } = input;
          return updateUnitSafetyPlan(id, values);
        }),
      create: roleProcedure("unitSafety.create")
        .input(
          z.object({
            unitId: z.number().int().optional(),
            unitLabel: z.string().min(1).max(120),
            hazardSummary: z.string().optional(),
            shutdownProcedure: z.string().optional(),
            requiredPpe: z.string().optional(),
            sdsReferences: z.string().optional(),
            emergencyContacts: z.string().optional(),
            version: z.number().int().default(1),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.unitId != null && !(await unitInScope(input.unitId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
        return createUnitSafetyPlan(input);
      }),
    }),
    complianceEngine: router({
      artifacts: router({
        list: roleProcedure("artifacts.list").query(async ({ ctx }) => listComplianceArtifacts(await scopeFor(ctx.user.id))),
        create: roleProcedure("artifacts.create")
          .input(
            z.object({
              trackingNumber: z.string().min(1).max(40),
              artifactType: z.string().min(1).max(40),
              jobId: z.number().int().optional(),
              locationId: z.number().int().optional(),
              manifestId: z.number().int().optional(),
              status: z
                .enum(["active", "completed", "archived", "legal_hold"])
                .default("active"),
              jurisdiction: z.string().max(100).optional(),
              regulatoryProfile: z.string().max(180).optional(),
              regulatoryVersion: z.string().max(100).optional(),
              retentionUntil: z.coerce.date().optional(),
              metadata: z.string().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createComplianceArtifact(input);
      }),
      }),
      tailgates: router({
        list: roleProcedure("tailgates.list").query(async ({ ctx }) => listTailgateMeetings(await scopeFor(ctx.user.id))),
        create: roleProcedure("tailgates.create")
          .input(
            z.object({
              trackingNumber: z.string().min(1).max(40),
              jobId: z.number().int().optional(),
              locationId: z.number().int().optional(),
              supervisor: z.string().max(180).optional(),
              operators: z.string().optional(),
              units: z.string().optional(),
              hazards: z.string().optional(),
              ppe: z.string().optional(),
              controls: z.string().optional(),
              voiceTranscript: z.string().optional(),
              reviewStatus: z
                .enum(["needs_review", "approved"])
                .default("needs_review"),
              startedAt: z.coerce.date().optional(),
              endedAt: z.coerce.date().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createTailgateMeeting(input);
      }),
      }),
      transfers: router({
        list: roleProcedure("transfers.list").query(async ({ ctx }) => listTransferAcknowledgements(await scopeFor(ctx.user.id))),
        create: roleProcedure("transfers.create")
          .input(
            z.object({
              trackingNumber: z.string().min(1).max(40),
              channel: z.enum(["email", "portal", "api", "download"]),
              recipient: z.string().min(1).max(220),
              deliveryStatus: z
                .enum(["pending", "confirmed", "failed", "opened"])
                .default("pending"),
              messageId: z.string().max(180).optional(),
              attachmentCount: z.number().int().default(0),
              acknowledgedBy: z.string().max(180).optional(),
              acknowledgedAt: z.coerce.date().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (!(await trackingSubjectInScope(input.trackingNumber, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `${input.trackingNumber} not found` });
        return createTransferAcknowledgement(input);
      }),
        acknowledge: roleProcedure("transfers.acknowledge")
          .input(
            z.object({
              id: z.number().int().positive(),
              acknowledgedBy: z.string().min(1).max(180),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        { const tn = await transferTrackingNumber(input.id); if (tn && !(await trackingSubjectInScope(tn, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Transfer ${input.id} not found` }); }
        return acknowledgeTransfer(input.id, input.acknowledgedBy);
      }),
      }),
    }),
    locations: router({
      list: roleProcedure("locations.list").query(() => listLocationIdentities()),
      create: roleProcedure("locations.create")
        .input(
          z.object({
            name: z.string().min(1).max(180),
            surfaceLsd: z.string().min(1).max(80),
            downholeLsd: z.string().max(80).optional(),
            uwi: z.string().max(120).optional(),
            wellLicense: z.string().max(100).optional(),
            operator: z.string().max(180).optional(),
            lease: z.string().max(180).optional(),
            field: z.string().max(160).optional(),
            province: z.string().max(100).optional(),
            accessRoad: z.string().max(220).optional(),
            gate: z.string().max(180).optional(),
            hazards: z.string().optional(),
            emergencyInfo: z.string().optional(),
            surfaceLatitude: z.number().optional(),
            surfaceLongitude: z.number().optional(),
            downholeLatitude: z.number().optional(),
            downholeLongitude: z.number().optional(),
            source: z.string().max(220).optional(),
            lastVerifiedAt: z.coerce.date().optional(),
          })
        )
        .mutation(({ input }) => createLocationIdentity(input)),
    }),
    manifests: router({
      list: roleProcedure("manifests.list").query(async ({ ctx }) => listManifests(await scopeFor(ctx.user.id))),
      create: roleProcedure("manifests.create")
        .input(
          z.object({
            manifestNumber: z.string().min(1).max(80),
            locationId: z.number().int().optional(),
            jobId: z.number().int().optional(),
            material: z.string().max(220).optional(),
            unNumber: z.string().max(40).optional(),
            unitId: z.number().int().optional(),
            trailer: z.string().max(100).optional(),
            driver: z.string().max(180).optional(),
            route: z.string().max(220).optional(),
            facility: z.string().max(220).optional(),
            scaleTickets: z.string().optional(),
            evidenceRefs: z.string().optional(),
            signatureRefs: z.string().optional(),
            status: REFUSED,
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        { const scope = await scopeFor(ctx.user.id); if (input?.jobId != null && !(await jobInScope(input.jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` }); if (input?.unitId != null && !(await unitInScope(input.unitId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` }); }
        return createManifest({ ...input, status: "draft" }, await scopeFor(ctx.user.id));
      }),
    }),
    scans: router({
      list: roleProcedure("scans.list").query(async ({ ctx }) => listScanAudits(await scopeFor(ctx.user.id))),
      create: roleProcedure("scans.create")
        .input(
          z.object({
            scanType: z.enum(["qr", "nfc"]),
            subjectType: z.enum(["unit", "location", "manifest"]),
            subjectId: z.number().int(),
            accessRole: REFUSED,
            scannedAt: z.coerce.date(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        { const scope = await scopeFor(ctx.user.id); const st = input.subjectType as string; const sid = Number(input.subjectId); if (["unit", "trailer", "equipment"].includes(st) && !(await unitInScope(sid, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Subject ${st} ${sid} not found` }); if (st === "operator" && !(await operatorInScope(sid, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Subject operator ${sid} not found` }); if (st === "job" && !(await jobInScope(sid, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Subject job ${sid} not found` }); }
        return createScanAudit({ ...input, accessRole: scanRoleOf((ctx as unknown as { roles?: readonly string[] }).roles ?? []) });
      }),   // the caller's role, never the caller's claim
    }),
    identity: router({
      operators: router({
        list: roleProcedure("operators.list").query(async ({ ctx }) => listOperators(await scopeFor(ctx.user.id))),
        create: roleProcedure("operators.create")
          .input(
            z.object({
              userId: z.number().int().optional(),
              name: z.string().min(1).max(180),
              company: z.string().max(180).optional(),
              licenseNumber: z.string().max(100).optional(),
              licenseClass: z.string().max(40).optional(),
              licenseExpiresAt: z.coerce.date().optional(),
              restrictions: z.string().optional(),
              trainingStatus: z.string().max(120).optional(),
              certifications: z.string().optional(),
              insurance: z.string().optional(),
              emergencyContact: z.string().max(220).optional(),
            })
          )
          .mutation(async ({ ctx, input }) => createOperator(input, await scopeFor(ctx.user.id), ctx.user.id)),
      }),
      units: router({
        list: roleProcedure("units.list").query(async ({ ctx }) => listUnits(await scopeFor(ctx.user.id))),
        create: roleProcedure("units.create")
          .input(
            z.object({
              unitNumber: z.string().min(1).max(40),
              vin: z.string().max(80).optional(),
              plate: z.string().max(40).optional(),
              vehicleType: z.string().min(1).max(120),
              company: z.string().max(180).optional(),
              weightKg: z.number().int().optional(),
              axles: z.number().int().optional(),
              dimensions: z.string().max(160).optional(),
              equipment: z.string().optional(),
              inspectionStatus: REFUSED,
              maintenanceStatus: REFUSED,
              qrTag: z.string().max(120).optional(),
            })
          )
          .mutation(async ({ ctx, input }) => createUnit({ ...input, inspectionStatus: "due", maintenanceStatus: "review" }, await scopeFor(ctx.user.id), ctx.user.id)),   // a new row proves nothing: due and review until the facts exist
      }),
      jobUnits: router({
        list: roleProcedure("jobUnits.list").query(async ({ ctx }) => listJobUnits(await scopeFor(ctx.user.id))),
        create: roleProcedure("jobUnits.create")
          .input(
            z.object({
              jobId: z.number().int(),
              unitId: z.number().int(),
              operatorId: z.number().int().optional(),
              role: z.string().min(1).max(100),
              joinedAt: z.coerce.date(),
              departedAt: z.coerce.date().optional(),
              hours: z.number().int().optional(),
              mileage: z.number().int().optional(),
              workPerformed: z.string().optional(),
              // v21.2 — the readiness check this assignment relies on. Required
              // when enforcement is on; recorded whenever supplied.
              eligibilityCheckId: z.number().int().positive().nullable().optional(),
            })
          )
          // v21.2 — under the enforcement setting: off as always, advisory
          // records findings, enforced refuses without a valid check.
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        const actingScope = await scopeFor(ctx.user.id);
        if (input?.jobId != null && !(await jobInScope(input.jobId, actingScope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        // CP1.5 (sweep #22) — the job was scoped, the unit only through a check in enforced mode. A job
        // may not take another organization's truck, in any mode.
        await requireUnitInScope(input.unitId, actingScope);
         // C1a — the check relied on must belong to the caller's organization too.
         const r = await createJobUnitGated({ ...input, actingScope }); return r.id; }),
      }),
      inspections: router({
        list: roleProcedure("inspections.list").query(async ({ ctx }) => listInspections(await scopeFor(ctx.user.id))),
        create: roleProcedure("inspections.create")
          .input(
            z.object({
              unitId: z.number().int(),
              type: z.enum(["training", "pre_trip", "post_trip"]),
              status: z
                .enum(["pass", "fail", "needs_maintenance", "not_applicable"])
                .default("pass"),
              checklist: z.string().optional(),
              resultSummary: z.string().optional(),
              observedAt: z.coerce.date(),
              authenticatedOperatorId: z.number().int().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.unitId != null && !(await unitInScope(input.unitId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
        return createInspection(input);
      }),
      }),
      documents: router({
        list: roleProcedure("documents.list")
          // Optional: one owner's documents. Narrows the organization's list; it never widens it —
          // the scope predicate still applies. The documentExpiry tile reads this, because the
          // canonical verdict needs an owner's whole history, not whatever of it made the org's
          // newest hundred.
          .input(z.object({ ownerType: z.enum(["operator", "unit", "trailer", "equipment", "job"]), ownerId: z.number().int().positive() }).optional())
          .query(async ({ ctx, input }) => listComplianceDocuments(await scopeFor(ctx.user.id), input)),
        create: roleProcedure("documents.create")
          .input(
            z.object({
              ownerType: z.enum(["operator", "unit", "job"]),
              ownerId: z.number().int(),
              docType: z.string().min(1).max(100),
              title: z.string().min(1).max(220),
              storageKey: storageKeyInput.optional(),
              // A caller may record where a document lives, but not a `/manus-storage/`
            // path: that route is deleted, so such a value is a dead capability stored
            // as if it were live. Refused at the input rather than cleaned up later.
            storageUrl: z.string().max(1024).refine(u => !u.startsWith("/manus-storage/"), {
              message: "The generic storage proxy is retired; store the storage key instead",
            }).optional(),
              capturedAt: z.coerce.date(),
              expiresAt: z.coerce.date().optional(),
              verificationStatus: REFUSED,
              source: z.string().max(220).optional(),
              confidence: z.enum(["low", "medium", "high"]).default("medium"),
            })
          )
          .mutation(async ({ ctx, input }) => createComplianceDocument({ ...input, verificationStatus: "needs_review" }, await scopeFor(ctx.user.id))),   // review is documents.review
        review: roleProcedure("documents.review")
          .input(
            z.object({
              id: z.number().int().positive(),
              status: z.enum(["verified", "rejected"]),
            })
          )
          .mutation(async ({ ctx, input }) => { const ok = await reviewComplianceDocument(input.id, input.status, await scopeFor(ctx.user.id)); if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: `Document ${input.id} not found` }); return ok; }),
      }),
    }),
    compliance: router({
      loads: router({
        list: roleProcedure("loads.list").query(async ({ ctx }) => listLoadProfiles(await scopeFor(ctx.user.id))),
        create: roleProcedure("loads.create")
          .input(
            z.object({
              jobId: z.number().int(),
              material: z.string().min(1).max(220),
              isWaste: z.boolean().default(false),
              composition: z.string().optional(),
              sdsStorageKey: z.string().max(512).optional(),
              sdsStorageUrl: z.string().max(1024).optional(),
              unNumber: z.string().max(40).optional(),
              properShippingName: z.string().max(220).optional(),
              dgClass: z.string().max(40).optional(),
              packingGroup: z.string().max(40).optional(),
              quantity: z.string().max(80).optional(),
              transportMode: z.string().max(80).optional(),
              jurisdiction: z.string().max(120).optional(),
              classificationStatus: REFUSED,
              source: z.string().max(220).optional(),
              confidence: z.enum(["low", "medium", "high"]).default("low"),
              verifiedAt: REFUSED,
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createLoadProfile({ ...input, classificationStatus: "needs_verification", verifiedAt: null });
      }),   // TDG is never self-certified
      }),
      facilities: router({
        list: roleProcedure("facilities.list").query(() => listFacilities()),
        create: roleProcedure("facilities.create")
          .input(
            z.object({
              name: z.string().min(1).max(220),
              status: z.enum(["unknown", "open", "closed"]).default("unknown"),
              operatingHours: z.string().max(120).optional(),
              acceptedMaterials: z.string().optional(),
              restrictions: z.string().optional(),
              phone: z.string().max(60).optional(),
              emergencyPhone: z.string().max(60).optional(),
              gateInstructions: z.string().optional(),
              requiredDocuments: z.string().optional(),
              lastVerifiedAt: z.coerce.date().optional(),
              latitude: z.number().optional(),
              longitude: z.number().optional(),
            })
          )
          .mutation(({ input }) => createFacility(input)),
      }),
      maintenance: router({
        list: roleProcedure("maintenance.list").query(async ({ ctx }) => listMaintenanceDefects(await scopeFor(ctx.user.id))),
        create: roleProcedure("maintenance.create")
          .input(
            z.object({
              unitId: z.number().int(),
              title: z.string().min(1).max(220),
              severity: z
                .enum(["advisory", "inspection_required", "critical"])
                .default("advisory"),
              status: REFUSED,
              detail: z.string().optional(),
              storageKey: storageKeyInput.optional(),
              // A caller may record where a document lives, but not a `/manus-storage/`
            // path: that route is deleted, so such a value is a dead capability stored
            // as if it were live. Refused at the input rather than cleaned up later.
            storageUrl: z.string().max(1024).refine(u => !u.startsWith("/manus-storage/"), {
              message: "The generic storage proxy is retired; store the storage key instead",
            }).optional(),
              reportedAt: z.coerce.date(),
              reportedBy: z.number().int().optional(),
              workOrderNumber: z.string().max(80).optional(),
              completedAt: z.coerce.date().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.unitId != null && !(await unitInScope(input.unitId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${input.unitId} not found` });
        return createMaintenanceDefect({ ...input, status: "open" });
      }),   // resolution is a later act
      }),
      deliveries: router({
        list: roleProcedure("deliveries.list").query(async ({ ctx }) => listDeliveries(await scopeFor(ctx.user.id))),
        create: roleProcedure("deliveries.create")
          .input(
            z.object({
              jobId: z.number().int(),
              recipientRole: z.string().min(1).max(80),
              recipient: z.string().min(1).max(220),
              status: z
                .enum(["queued", "delivered", "failed"])
                .default("queued"),
              deliveredAt: z.coerce.date().optional(),
            })
          )
          .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createDelivery(input);
      }),
      }),
      sign: roleProcedure("compliance.sign")
        .input(
          z.object({
            jobId: z.number().int(),
            signerName: z.string().min(1).max(180),
            authMethod: REFUSED,
            signedAt: z.coerce.date(),
            documentHash: REFUSED,
            status: REFUSED,
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createSignatureAudit({ ...input, authMethod: "legacy observation — not the frozen signature chain (use closeout.siteSign)", documentHash: null, status: "pending" });
      }),
    }),
    safety: router({
      list: roleProcedure("safety.list").query(async ({ ctx }) => listSafetyEvents(await scopeFor(ctx.user.id))),
      create: roleProcedure("safety.create")
        .input(
          z.object({
            jobId: z.number().int().optional(),
            eventType: z.string().min(1).max(80),
            severity: z.enum(["info", "warning", "critical"]).default("info"),
            title: z.string().min(1).max(220),
            detail: z.string().optional(),
            occurredAt: z.coerce.date(),
            status: REFUSED,
          })
        )
        .mutation(async ({ ctx, input }) => {
        // P4.1: scope guard
        if (input?.jobId != null && !(await jobInScope(input.jobId, await scopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${input.jobId} not found` });
        return createSafetyEvent({ ...input, status: "open" });
      }),
    }),
  }),
});

export type AppRouter = typeof appRouter;
