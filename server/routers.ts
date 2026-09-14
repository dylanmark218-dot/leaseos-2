import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { storagePut } from "./storage";
import {
  createEvidenceRecord,
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
  createJobUnit,
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
  listOperatingZones,
  createOperatingZone,
  listDutyRecords,
  createDutyRecord,
  listWorkOrders,
  createWorkOrder,
  updateWorkOrder,
  listTripBreadcrumbs,
  listZoneEvents,
  updateZoneEvent,
} from "./db";
import { ingestBreadcrumb } from "./_core/tripGps";
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
  checkCommit,
  commitProposal,
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
import { invokeLLM } from "./_core/llm";

/** Rebuild the in-memory proposal from its stored rows. */
async function loadProposal(proposalId: string): Promise<Proposal | null> {
  const row = await getAssistantProposal(proposalId);
  if (!row) return null;
  const fieldRows = await listProposalFields(proposalId);
  const fields: ProposedField[] = fieldRows.map(f => ({
    key: f.fieldKey,
    label: f.label,
    value: f.fieldValue === null ? null : safeParse(f.fieldValue),
    precision: f.precision,
    source: f.source,
    confidence: f.confidence,
    status: f.status,
    sourceUtterance: f.sourceUtterance,
    correctedFrom: f.correctedFrom === null ? null : safeParse(f.correctedFrom),
  }));
  const form = FORMS[row.formKey];
  const base = buildProposal(form, row.targetRef, []);
  return {
    ...base,
    proposalId: row.proposalId,
    fields,
    gaps: base.gaps,
    questions: base.questions,
    readBack: row.readBack,
    readBackAcknowledged: row.readBackAcknowledged,
    commitState: row.commitState,
  };
}
const safeParse = (v: string): string | number | boolean | null => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

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

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  fieldRoute: router({
    jobs: router({
      list: protectedProcedure.query(() => listJobs()),
      byCode: protectedProcedure
        .input(z.object({ jobCode: z.string().min(1) }))
        .query(({ input }) => getJobByCode(input.jobCode)),
      create: protectedProcedure
        .input(jobInput)
        .mutation(({ input }) => createJob(input)),
    }),
    evidence: router({
      list: protectedProcedure.query(() => listEvidenceRecords()),
      upload: protectedProcedure
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
            storageUrl: stored.url,
            mimeType: input.mimeType,
            capturedAt: new Date(),
            capturedBy: ctx.user.id,
            latitude: input.latitude,
            longitude: input.longitude,
            status: "needs_review",
            notes: input.notes,
          });
          return { id, ...stored };
        }),
      add: protectedProcedure
        .input(
          z.object({
            jobId: z.number().int().optional(),
            title: z.string().min(1).max(220),
            category: z.string().min(1).max(80),
            storageKey: z.string().max(512).optional(),
            storageUrl: z.string().max(1024).optional(),
            mimeType: z.string().max(120).optional(),
            capturedAt: z.coerce.date(),
            capturedBy: z.number().int().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            status: z
              .enum(["needs_review", "verified", "unverified"])
              .default("needs_review"),
            notes: z.string().optional(),
          })
        )
        .mutation(({ input }) => createEvidenceRecord(input)),
      verify: protectedProcedure
        .input(z.object({ id: z.number().int().positive() }))
        .mutation(({ input }) => verifyEvidenceRecord(input.id)),
    }),
    trips: router({
      list: protectedProcedure.query(() => listTrips()),
      create: protectedProcedure
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
        .mutation(({ input }) =>
          createTrip({
            ...input,
            distanceKm:
              input.distanceKm ??
              (input.odometerStartKm !== undefined &&
              input.odometerEndKm !== undefined
                ? Math.max(0, input.odometerEndKm - input.odometerStartKm)
                : undefined),
          })
        ),
      update: protectedProcedure
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
        .mutation(({ input }) => {
          const { id, ...values } = input;
          return updateTrip(id, values);
        }),
    }),
    tripStops: router({
      list: protectedProcedure
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(({ input }) => listTripStops(input?.tripId)),
      create: protectedProcedure
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
        .mutation(({ input }) => {
          const minutes = (a?: Date, b?: Date) =>
            a && b
              ? Math.max(0, (b.getTime() - a.getTime()) / 60000)
              : undefined;
          return createTripStop({
            ...input,
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
      update: protectedProcedure
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
        .mutation(({ input }) => {
          const { id, ...values } = input;
          return updateTripStop(id, values);
        }),
    }),
    operatingZones: router({
      list: protectedProcedure.query(() => listOperatingZones()),
      create: protectedProcedure
        .input(
          z.object({
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
        .mutation(({ input }) => createOperatingZone(input)),
    }),
    assistant: router({
      forms: protectedProcedure.query(() =>
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
      draft: protectedProcedure
        .input(
          z.object({
            formKey: z.string(),
            targetRef: z.string().max(180),
            transcript: z.string().min(1).max(8000),
            tripId: z.number().int().optional(),
            jobId: z.number().int().optional(),
            unitId: z.number().int().optional(),
            capturedOffline: z.boolean().default(false),
          })
        )
        .mutation(async ({ ctx, input }) => {
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
            extraction.values
          );

          await createAssistantProposal({
            proposalId: proposal.proposalId,
            formKey: form.key,
            formVersion: form.version,
            title: form.title,
            targetRef: input.targetRef,
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

      get: protectedProcedure
        .input(z.object({ proposalId: z.string() }))
        .query(({ input }) => loadProposal(input.proposalId)),

      pending: protectedProcedure
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(({ input }) => listPendingProposals(input?.tripId)),

      answer: protectedProcedure
        .input(
          z.object({
            proposalId: z.string(),
            fieldKey: z.string(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            precision: z.enum(["exact", "approximate"]).default("exact"),
          })
        )
        .mutation(async ({ input }) => {
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

      setStatus: protectedProcedure
        .input(
          z.object({
            proposalId: z.string(),
            fieldKey: z.string(),
            status: z.enum(["proposed", "confirmed", "rejected", "corrected"]),
          })
        )
        .mutation(async ({ input }) => {
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

      readBack: protectedProcedure
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ input }) => {
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          const next = generateReadBack(p);
          await persist(next);
          return next;
        }),

      acknowledge: protectedProcedure
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ input }) => {
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
      commit: protectedProcedure
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ input }) => {
          const p = await loadProposal(input.proposalId);
          if (!p) throw new Error("Proposal not found");
          const form = FORMS[p.formKey];
          const check = checkCommit(p, form);
          if (!check.canCommit)
            return { committed: false as const, refusals: check.refusals };

          const result = commitProposal(p, form, new Date());
          if (!result.ok)
            return { committed: false as const, refusals: result.refusals };

          await updateAssistantProposal(p.proposalId, {
            commitState: "committed",
            committedAt: new Date(),
          });
          return { committed: true as const, fields: result.fields };
        }),

      reject: protectedProcedure
        .input(z.object({ proposalId: z.string() }))
        .mutation(async ({ input }) => {
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
      submitBreadcrumb: protectedProcedure
        .input(
          z.object({
            tripId: z.number().int(),
            unitId: z.number().int().optional(),
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            accuracyMetres: z.number().nonnegative().optional(),
            speedKmh: z.number().nonnegative().optional(),
            headingDegrees: z.number().min(0).max(360).optional(),
            source: z.enum(["gps", "dead_reckoning", "manual"]).default("gps"),
            recordedAt: z.coerce.date(),
          })
        )
        .mutation(({ input }) => ingestBreadcrumb(input)),
      breadcrumbs: protectedProcedure
        .input(z.object({ tripId: z.number().int() }))
        .query(({ input }) => listTripBreadcrumbs(input.tripId)),
      // Pending proposals a driver/dispatcher hasn't ruled on yet. Omit tripId
      // to review pending events across all active trips (dispatch view).
      pendingZoneEvents: protectedProcedure
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(({ input }) => listZoneEvents(input?.tripId, "pending")),
      zoneEvents: protectedProcedure
        .input(z.object({ tripId: z.number().int().optional() }).optional())
        .query(({ input }) => listZoneEvents(input?.tripId)),
      // The human-in-the-loop step: a confirmed event can optionally be linked
      // to the tripStop it resolves (e.g. sets arrivedAt). Rejecting it leaves
      // the tripStop entirely untouched — the GPS engine never overwrites a
      // record on its own say-so.
      confirmZoneEvent: protectedProcedure
        .input(
          z.object({
            id: z.number().int().positive(),
            action: z.enum(["confirm", "reject"]),
            tripStopId: z.number().int().optional(),
          })
        )
        .mutation(async ({ ctx, input }) => {
          await updateZoneEvent(input.id, {
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
      list: protectedProcedure
        .input(z.object({ operatorId: z.number().int().optional() }).optional())
        .query(({ input }) => listDutyRecords(input?.operatorId)),
      create: protectedProcedure
        .input(
          z.object({
            operatorId: z.number().int(),
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
        .mutation(({ input }) =>
          createDutyRecord({
            ...input,
            durationMinutes:
              input.durationMinutes ??
              (input.endedAt
                ? Math.max(
                    0,
                    (input.endedAt.getTime() - input.startedAt.getTime()) /
                      60000
                  )
                : undefined),
          })
        ),
    }),
    workOrders: router({
      list: protectedProcedure
        .input(z.object({ unitId: z.number().int().optional() }).optional())
        .query(({ input }) => listWorkOrders(input?.unitId)),
      create: protectedProcedure
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
        .mutation(({ input }) => createWorkOrder(input)),
      update: protectedProcedure
        .input(
          z.object({
            id: z.number().int().positive(),
            status: z
              .enum([
                "draft",
                "open",
                "in_progress",
                "waiting_parts",
                "ready_for_service",
                "closed",
              ])
              .optional(),
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
        .mutation(({ input }) => {
          const { id, ...values } = input;
          return updateWorkOrder(id, values);
        }),
    }),
    routeContext: router({
      list: protectedProcedure.query(() => listRouteContexts()),
      create: protectedProcedure
        .input(
          z.object({
            name: z.string().min(1).max(180),
            source: z.string().min(1).max(220),
            effectiveAt: z.coerce.date(),
            expiresAt: z.coerce.date().optional(),
            verifiedAt: z.coerce.date().optional(),
            confidence: z.enum(["low", "medium", "high"]).default("medium"),
            restrictions: z.string().optional(),
            snapshotKey: z.string().max(512).optional(),
            snapshotUrl: z.string().max(1024).optional(),
          })
        )
        .mutation(({ input }) => createRouteContext(input)),
    }),
    routeDecisions: router({
      list: protectedProcedure.query(() => listRouteDecisions()),
      create: protectedProcedure
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
            source: z.string().max(180).optional(),
            confidence: z.string().max(40).optional(),
            driverAcknowledged: z.number().int().default(0),
          })
        )
        .mutation(({ input }) => createRouteDecision(input)),
    }),
    billing: router({
      rateCards: router({
        list: protectedProcedure.query(() => listBillingRateCards()),
        create: protectedProcedure
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
          .mutation(({ input }) => createBillingRateCard(input)),
        update: protectedProcedure
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
          .mutation(({ input }) => {
            const { id, ...values } = input;
            return updateBillingRateCard(id, values);
          }),
      }),
      lines: router({
        list: protectedProcedure
          .input(z.object({ jobId: z.number().int().optional() }).optional())
          .query(({ input }) => listJobChargeLines(input?.jobId)),
        create: protectedProcedure
          .input(
            z.object({
              jobId: z.number().int().optional(),
              description: z.string().min(1).max(220),
              quantity: z.number().int().positive(),
              unitRate: z.number().int().nonnegative(),
              source: z.string().max(80).default("rate_card"),
            })
          )
          .mutation(({ input }) =>
            createJobChargeLine({
              ...input,
              amount: input.quantity * input.unitRate,
            })
          ),
      }),
    }),
    vendors: router({
      list: protectedProcedure.query(() => listVendors()),
      update: protectedProcedure
        .input(
          z.object({
            id: z.number().int().positive(),
            phone: z.string().max(40).optional(),
            emergencyPhone: z.string().max(40).optional(),
            availability: z.string().max(100).optional(),
            notes: z.string().optional(),
          })
        )
        .mutation(({ input }) => {
          const { id, ...values } = input;
          return updateVendor(id, values);
        }),
      create: protectedProcedure
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
        .mutation(({ input }) => createVendor(input)),
    }),
    unitSafety: router({
      list: protectedProcedure.query(() => listUnitSafetyPlans()),
      update: protectedProcedure
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
        .mutation(({ input }) => {
          const { id, ...values } = input;
          return updateUnitSafetyPlan(id, values);
        }),
      create: protectedProcedure
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
        .mutation(({ input }) => createUnitSafetyPlan(input)),
    }),
    complianceEngine: router({
      artifacts: router({
        list: protectedProcedure.query(() => listComplianceArtifacts()),
        create: protectedProcedure
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
          .mutation(({ input }) => createComplianceArtifact(input)),
      }),
      tailgates: router({
        list: protectedProcedure.query(() => listTailgateMeetings()),
        create: protectedProcedure
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
          .mutation(({ input }) => createTailgateMeeting(input)),
      }),
      transfers: router({
        list: protectedProcedure.query(() => listTransferAcknowledgements()),
        create: protectedProcedure
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
          .mutation(({ input }) => createTransferAcknowledgement(input)),
        acknowledge: protectedProcedure
          .input(
            z.object({
              id: z.number().int().positive(),
              acknowledgedBy: z.string().min(1).max(180),
            })
          )
          .mutation(({ input }) =>
            acknowledgeTransfer(input.id, input.acknowledgedBy)
          ),
      }),
    }),
    locations: router({
      list: protectedProcedure.query(() => listLocationIdentities()),
      create: protectedProcedure
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
      list: protectedProcedure.query(() => listManifests()),
      create: protectedProcedure
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
            status: z.enum(["draft", "verified", "complete"]).default("draft"),
          })
        )
        .mutation(({ input }) => createManifest(input)),
    }),
    scans: router({
      list: protectedProcedure.query(() => listScanAudits()),
      create: protectedProcedure
        .input(
          z.object({
            scanType: z.enum(["qr", "nfc"]),
            subjectType: z.enum(["unit", "location", "manifest"]),
            subjectId: z.number().int(),
            accessRole: z.enum([
              "inspection",
              "driver",
              "mechanic",
              "dispatcher",
              "admin",
            ]),
            scannedAt: z.coerce.date(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
          })
        )
        .mutation(({ input }) => createScanAudit(input)),
    }),
    identity: router({
      operators: router({
        list: protectedProcedure.query(() => listOperators()),
        create: protectedProcedure
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
          .mutation(({ input }) => createOperator(input)),
      }),
      units: router({
        list: protectedProcedure.query(() => listUnits()),
        create: protectedProcedure
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
              inspectionStatus: z
                .enum(["current", "due", "blocked"])
                .default("current"),
              maintenanceStatus: z
                .enum(["clear", "review", "blocked"])
                .default("clear"),
              qrTag: z.string().max(120).optional(),
            })
          )
          .mutation(({ input }) => createUnit(input)),
      }),
      jobUnits: router({
        list: protectedProcedure.query(() => listJobUnits()),
        create: protectedProcedure
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
            })
          )
          .mutation(({ input }) => createJobUnit(input)),
      }),
      inspections: router({
        list: protectedProcedure.query(() => listInspections()),
        create: protectedProcedure
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
          .mutation(({ input }) => createInspection(input)),
      }),
      documents: router({
        list: protectedProcedure.query(() => listComplianceDocuments()),
        create: protectedProcedure
          .input(
            z.object({
              ownerType: z.enum(["operator", "unit", "job"]),
              ownerId: z.number().int(),
              docType: z.string().min(1).max(100),
              title: z.string().min(1).max(220),
              storageKey: z.string().max(512).optional(),
              storageUrl: z.string().max(1024).optional(),
              capturedAt: z.coerce.date(),
              expiresAt: z.coerce.date().optional(),
              verificationStatus: z
                .enum(["needs_review", "verified", "rejected"])
                .default("needs_review"),
              source: z.string().max(220).optional(),
              confidence: z.enum(["low", "medium", "high"]).default("medium"),
            })
          )
          .mutation(({ input }) => createComplianceDocument(input)),
        review: protectedProcedure
          .input(
            z.object({
              id: z.number().int().positive(),
              status: z.enum(["verified", "rejected"]),
            })
          )
          .mutation(({ input }) =>
            reviewComplianceDocument(input.id, input.status)
          ),
      }),
    }),
    compliance: router({
      loads: router({
        list: protectedProcedure.query(() => listLoadProfiles()),
        create: protectedProcedure
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
              classificationStatus: z
                .enum(["needs_verification", "verified", "blocked"])
                .default("needs_verification"),
              source: z.string().max(220).optional(),
              confidence: z.enum(["low", "medium", "high"]).default("low"),
              verifiedAt: z.coerce.date().optional(),
            })
          )
          .mutation(({ input }) => createLoadProfile(input)),
      }),
      facilities: router({
        list: protectedProcedure.query(() => listFacilities()),
        create: protectedProcedure
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
        list: protectedProcedure.query(() => listMaintenanceDefects()),
        create: protectedProcedure
          .input(
            z.object({
              unitId: z.number().int(),
              title: z.string().min(1).max(220),
              severity: z
                .enum(["advisory", "inspection_required", "critical"])
                .default("advisory"),
              status: z
                .enum(["open", "in_progress", "resolved"])
                .default("open"),
              detail: z.string().optional(),
              storageKey: z.string().max(512).optional(),
              storageUrl: z.string().max(1024).optional(),
              reportedAt: z.coerce.date(),
              reportedBy: z.number().int().optional(),
              workOrderNumber: z.string().max(80).optional(),
              completedAt: z.coerce.date().optional(),
            })
          )
          .mutation(({ input }) => createMaintenanceDefect(input)),
      }),
      deliveries: router({
        list: protectedProcedure.query(() => listDeliveries()),
        create: protectedProcedure
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
          .mutation(({ input }) => createDelivery(input)),
      }),
      sign: protectedProcedure
        .input(
          z.object({
            jobId: z.number().int(),
            signerName: z.string().min(1).max(180),
            authMethod: z.string().min(1).max(120),
            signedAt: z.coerce.date(),
            documentHash: z.string().max(180).optional(),
            status: z
              .enum(["pending", "authenticated", "invalidated"])
              .default("pending"),
          })
        )
        .mutation(({ input }) => createSignatureAudit(input)),
    }),
    safety: router({
      list: protectedProcedure.query(() => listSafetyEvents()),
      create: protectedProcedure
        .input(
          z.object({
            jobId: z.number().int().optional(),
            eventType: z.string().min(1).max(80),
            severity: z.enum(["info", "warning", "critical"]).default("info"),
            title: z.string().min(1).max(220),
            detail: z.string().optional(),
            occurredAt: z.coerce.date(),
            status: z
              .enum(["open", "acknowledged", "resolved"])
              .default("open"),
          })
        )
        .mutation(({ input }) => createSafetyEvent(input)),
    }),
  }),
});

export type AppRouter = typeof appRouter;
