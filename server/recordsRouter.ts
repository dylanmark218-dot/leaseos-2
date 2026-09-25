/**
 * Records API.
 *
 * Every procedure here goes through `roleProcedure`, which resolves the
 * caller's active domain roles from the database, decides against the
 * permission engine, and writes an authorization decision row — allowed or
 * denied. There is no `protectedProcedure` fallback in this file, and a
 * procedure with no entry in `RECORDS_PROCEDURE_PERMISSIONS` throws at wiring
 * time rather than degrading to authenticated-only.
 *
 * Two things the request is never trusted with:
 *
 *   Ownership. `ownerOperatorId` is never an input. The server loads the
 *   record, reads its operator relationship, and authorizes against that. A
 *   client that can name the owner of a record can name itself as the owner.
 *
 *   Severity and hashes. Defect severity comes from the defect, incident
 *   severity is derived from the reported facts, and a manifest hash is
 *   recomputed rather than accepted.
 */

import { TRPCError } from "@trpc/server";
import { actingScopeFor, evidenceInScope, incidentInScope, jobInScope, unitInScope, userInScope, workOrderInScope, type TenantScope } from "./db";
import { requireCallerUnits } from "./unitScope";
import { orgRefOf } from "./fleetPortfolioService";
import { actingRoleFor, mayReleaseHold } from "./_core/fleetPortfolio";
import { z } from "zod";
import { storageKeyInput } from "./_core/storageKey";
import { adminProcedure, roleProcedure, router } from "./_core/trpc";
import {
  authorizeMechanicRelease,
  authorizeRecordScope,
} from "./_core/recordsAuthorization";
import {
  amendSealedEvidence,
  sealEvidence,
  type EvidenceRelationshipInput,
} from "./_core/evidenceSeal";
import {
  COMPANY_DEFAULT_DEVICE_RETENTION_DAYS,
  COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS,
  computeEffectiveRetention,
  evaluateDeviceDeletion,
  evaluateOfficeDisposition,
  type RetentionPolicy,
} from "./_core/retentionPolicy";
import { planSendPackage } from "./_core/evidenceSync";
import {
  buildInspectionView,
  deriveSeverity,
  evaluateNearMiss,
  hosProductionWindow,
  planEscalation,
  ROADSIDE_INSPECTION_SCOPE,
} from "./_core/incidentReport";
import { currentReleaseEvidenceFor, evaluateMechanicRelease } from "./_core/mechanicRelease";
import * as svc from "./recordsService";
import {
  bootstrapManagementRole,
  countActiveManagementGrants,
  grantUserRole,
  listActiveUserRoles,
} from "./db";

/** Company default policy until a verified statutory source is loaded. */
const DEFAULT_POLICY: RetentionPolicy = {
  policyKey: "default",
  recordType: "other",
  statutoryMinimumMonths: null,
  statutorySourceStatus: "unverified",
  companyRetentionMonths: COMPANY_DEFAULT_OFFICE_RETENTION_MONTHS,
  deviceRetentionDays: COMPANY_DEFAULT_DEVICE_RETENTION_DAYS,
  deletionRequiresOfficeReceipt: true,
  legalHoldOverridesDeletion: true,
};

const forbidden = (message: string) =>
  new TRPCError({ code: "FORBIDDEN", message });

const relationshipInput = z.object({
  entityType: z.enum([
    "unit", "trailer", "equipment", "job", "trip", "load", "manifest",
    "disposalTicket", "fieldTicket", "workOrder", "incident", "nearMiss",
    "safetyMeeting", "facility", "dailyLog", "inspection",
  ]),
  entityId: z.number().int().optional(),
  entityRef: z.string().max(64).optional(),
  role: z.string().max(60).optional(),
});

/** CP1.5 — a job the caller's organization may not see is not found, in the same words as a job that does not exist. */
async function requireJobInScope(jobId: number | null | undefined, scope: TenantScope): Promise<void> {
  if (jobId != null && !(await jobInScope(jobId, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${jobId} not found` });
}

export const recordsRouter = router({
  evidence: router({
    /**
     * Seal a draft. The operator relationship is added by the server from the
     * caller's own identity — a driver cannot seal a record into someone
     * else's name, and cannot inject an `operator` relationship to do it.
     */
    seal: roleProcedure("records.evidence.seal")
      .input(
        z.object({
          evidenceId: z.number().int(),
          contentHash: z.string().length(64),
          recordType: z.string().max(60),
          relationships: z.array(relationshipInput).max(40),
          deviceId: z.string().max(120).optional(),
          devicePlatform: z.string().max(40).optional(),
          storageKey: storageKeyInput.optional(),
          mimeType: z.string().max(120).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: the evidence must be in the caller's scope (through its job, else its capturer); otherwise it does not exist here.
      if (!(await evidenceInScope(input.evidenceId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${input.evidenceId} not found` });
        const me = await svc.resolveOperatorForUser(ctx.user.id);
        const subject = await svc.loadEvidenceSubject(input.evidenceId);
        if (!subject) throw new TRPCError({ code: "NOT_FOUND", message: "No such record" });

        const scope = authorizeRecordScope({
          userId: ctx.user.id,
          operatorId: me.operatorId,
          grants: await listActiveUserRoles(ctx.user.id),
          permission: "evidence.seal",
          // v21.6 — a record is the capturer's until an operator relation says
          // otherwise: the user who uploaded it may seal it from a device that
          // has no operator record yet.
          subject: { ownerOperatorId: subject.ownerOperatorId ?? me.operatorId, ownerUserId: subject.capturedBy ?? null },
        });
        if (!scope.allowed) throw forbidden(scope.detail ?? "Not your record");

        if (subject.sealState !== "draft") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Record is already ${subject.sealState} — amend it instead of resealing`,
          });
        }

        // Server-owned relationship. Never taken from the request.
        const relationships: EvidenceRelationshipInput[] = [
          ...(me.operatorId
            ? [{ entityType: "operator" as const, entityId: me.operatorId }]
            : []),
          ...input.relationships.map(r => ({
            entityType: r.entityType,
            entityId: r.entityId ?? null,
            entityRef: r.entityRef ?? null,
            role: r.role ?? null,
          })),
        ];
        if (relationships.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A sealed record must relate to at least one entity",
          });
        }

        const sealedAt = new Date();
        // Hashes are computed here from what the server holds, not accepted.
        const seal = sealEvidence({
          trackingNumber: subject.trackingNumber ?? `DOC-${subject.id}`,
          recordType: input.recordType as never,
          version: 1,
          contentHash: input.contentHash,
          capturedAt: sealedAt,
          sealedAt,
          sealedByUserId: ctx.user.id,
          deviceId: input.deviceId ?? null,
          devicePlatform: input.devicePlatform ?? null,
          relationships,
        });

        const retention = computeEffectiveRetention({
          policy: DEFAULT_POLICY,
          sealedAt,
          underLegalHold: subject.legalHold,
        });

        await svc.addEvidenceRelationships(subject.id, relationships);
        await svc.persistSeal({
          evidenceId: subject.id,
          version: 1,
          contentHash: seal.contentHash,
          manifestHash: seal.manifestHash,
          canonicalManifest: seal.canonicalManifest,
          sealedAt,
          sealedByUserId: ctx.user.id,
          deviceId: input.deviceId ?? null,
          devicePlatform: input.devicePlatform ?? null,
          storageKey: input.storageKey ?? null,
          mimeType: input.mimeType ?? null,
          deviceRetainUntil: retention.deviceRetainUntil,
          officeRetainUntil: retention.officeRetainUntil,
          effectiveRetentionMonths: Number.isFinite(retention.months)
            ? retention.months
            : null,
          retentionBasis: retention.basis,
        });

        return {
          sealed: true,
          version: 1,
          manifestHash: seal.manifestHash,
          deviceRetainUntil: retention.deviceRetainUntil,
          officeRetainUntil: retention.officeRetainUntil,
          retentionBasis: retention.basis,
          retentionCaveat: retention.caveat,
        };
      }),

    /** Idempotent: an offline client may retry without duplicating packages. */
    queueSend: roleProcedure("records.evidence.queueSend")
      .input(
        z.object({
          packageRef: z.string().min(4).max(64),
          deviceId: z.string().max(120),
          evidenceIds: z.array(z.number().int()).min(1).max(200),
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: every evidence record named must be in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        for (const id of input.evidenceIds ?? []) if (!(await evidenceInScope(id, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${id} not found` });
      }
        const me = await svc.resolveOperatorForUser(ctx.user.id);
        const grants = await listActiveUserRoles(ctx.user.id);

        const candidates = [];
        const rejected: Array<{ evidenceId: number; reason: string }> = [];

        for (const id of input.evidenceIds) {
          const s = await svc.loadEvidenceSubject(id);
          if (!s) {
            rejected.push({ evidenceId: id, reason: "No such record" });
            continue;
          }
          const scope = authorizeRecordScope({
            userId: ctx.user.id,
            operatorId: me.operatorId,
            grants,
            permission: "evidence.send",
            subject: { ownerOperatorId: s.ownerOperatorId },
          });
          if (!scope.allowed) {
            // Another driver's record is refused, not silently skipped.
            rejected.push({ evidenceId: id, reason: "Belongs to another operator" });
            continue;
          }
          candidates.push(s);
        }

        // Declared hashes come from the stored seal, not from a constant and
        // not from the client. The office recomputes and compares against
        // these, so a placeholder here would make verification meaningless.
        const withHashes = await Promise.all(
          candidates.map(async c => ({
            subject: c,
            hashes:
              c.sealState === "draft"
                ? null
                : await svc.loadCurrentSealHashes(c.id, c.currentVersion),
          }))
        );

        const plan = planSendPackage({
          packageRef: input.packageRef,
          records: withHashes.map(({ subject, hashes }) => ({
            trackingNumber: subject.trackingNumber ?? `DOC-${subject.id}`,
            sealState: subject.sealState,
            contentHash: hashes?.contentHash ?? null,
            manifestHash: hashes?.manifestHash ?? null,
          })),
        });

        const sendable = withHashes.filter(
          w =>
            (w.subject.sealState === "sealed" || w.subject.sealState === "amended") &&
            w.hashes !== null
        );

        const result = await svc.createSyncPackage({
          packageRef: input.packageRef,
          deviceId: input.deviceId,
          operatorId: me.operatorId,
          queuedAt: new Date(),
          items: sendable.map(w => ({
            evidenceRecordId: w.subject.id,
            declaredContentHash: w.hashes!.contentHash,
            declaredManifestHash: w.hashes!.manifestHash,
          })),
        });

        return {
          packageRef: result.packageRef,
          created: result.created,
          queued: result.itemCount,
          rejected: [
            ...rejected,
            ...plan.rejected.map(r => ({
              evidenceId: -1,
              reason: `${r.trackingNumber}: ${r.reason}`,
            })),
          ],
        };
      }),

    /**
     * Returns a decision, and does not touch the office copy. Removing the file
     * from the device stays a device action taken after the server approves.
     */
    requestDeviceDeletion: roleProcedure("records.evidence.requestDeviceDeletion")
      .input(z.object({ evidenceId: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
      // P4.1: the evidence must be in the caller's scope (through its job, else its capturer); otherwise it does not exist here.
      if (!(await evidenceInScope(input.evidenceId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${input.evidenceId} not found` });
        const me = await svc.resolveOperatorForUser(ctx.user.id);
        const subject = await svc.loadEvidenceSubject(input.evidenceId);
        if (!subject) throw new TRPCError({ code: "NOT_FOUND", message: "No such record" });

        const scope = authorizeRecordScope({
          userId: ctx.user.id,
          operatorId: me.operatorId,
          grants: await listActiveUserRoles(ctx.user.id),
          permission: "evidence.delete_device_copy",
          subject: { ownerOperatorId: subject.ownerOperatorId },
        });
        if (!scope.allowed) throw forbidden(scope.detail ?? "Not your record");

        const state = await svc.loadRetentionState(subject.id);
        const underHold =
          subject.legalHold || (await svc.hasActiveLegalHold(subject.id));

        const decision = evaluateDeviceDeletion({
          sealed: subject.sealState !== "draft",
          now: new Date(),
          deviceRetainUntil: state?.deviceRetainUntil ?? null,
          officeReceivedAt: state?.officeReceivedAt ?? null,
          officeIntegrityVerifiedAt: state?.officeIntegrityVerifiedAt ?? null,
          underLegalHold: underHold,
          policy: DEFAULT_POLICY,
        });

        if (decision.allowed) {
          await svc.markDeviceCopyDeleted({
            evidenceId: subject.id,
            userId: ctx.user.id,
          });
        }

        return {
          allowed: decision.allowed,
          blockers: decision.blockers,
          retainUntil: state?.deviceRetainUntil ?? null,
          officeVerified: Boolean(state?.officeIntegrityVerifiedAt),
          legalHold: underHold,
        };
      }),

    amend: roleProcedure("records.evidence.amend")
      .input(
        z.object({
          evidenceId: z.number().int(),
          newContentHash: z.string().length(64),
          reason: z.string().min(3).max(2000),
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: the evidence must be in the caller's scope (through its job, else its capturer); otherwise it does not exist here.
      if (!(await evidenceInScope(input.evidenceId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${input.evidenceId} not found` });
        const subject = await svc.loadEvidenceSubject(input.evidenceId);
        if (!subject) throw new TRPCError({ code: "NOT_FOUND", message: "No such record" });
        if (subject.sealState === "draft") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Draft records are sealed, not amended",
          });
        }

        const sealedAt = new Date();
        const amended = amendSealedEvidence({
          previous: {
            trackingNumber: subject.trackingNumber ?? `DOC-${subject.id}`,
            recordType: subject.recordType as never,
            version: subject.currentVersion,
            contentHash: input.newContentHash,
            capturedAt: sealedAt,
            sealedAt,
            sealedByUserId: ctx.user.id,
            relationships: [
              { entityType: "operator", entityId: subject.ownerOperatorId ?? 0 },
            ],
          },
          newContentHash: input.newContentHash,
          amendedAt: sealedAt,
          amendedByUserId: ctx.user.id,
          amendmentReason: input.reason,
        });

        const retention = computeEffectiveRetention({
          policy: DEFAULT_POLICY,
          sealedAt,
          underLegalHold: subject.legalHold,
        });

        // Version 1 is untouched. The amendment is a new sealed version.
        await svc.persistSeal({
          evidenceId: subject.id,
          version: amended.version,
          supersedesVersion: amended.supersedesVersion,
          contentHash: amended.seal.contentHash,
          manifestHash: amended.seal.manifestHash,
          canonicalManifest: amended.seal.canonicalManifest,
          sealedAt,
          sealedByUserId: ctx.user.id,
          amendmentReason: input.reason,
          deviceRetainUntil: retention.deviceRetainUntil,
          officeRetainUntil: retention.officeRetainUntil,
          effectiveRetentionMonths: Number.isFinite(retention.months)
            ? retention.months
            : null,
          retentionBasis: retention.basis,
        });

        await svc.recordEvidenceAccess({
          evidenceRecordId: subject.id,
          actorUserId: ctx.user.id,
          actorRole: ctx.roles.join(","),
          action: "viewed",
          context: "amendment",
        });

        return {
          version: amended.version,
          supersedesVersion: amended.supersedesVersion,
        };
      }),

    listForOperator: roleProcedure("records.evidence.listForOperator").query(
      async ({ ctx }) => {
        const me = await svc.resolveOperatorForUser(ctx.user.id);
        if (!me.operatorId) return [];
        // Scoped by construction: the operator id is the caller's own.
        return svc.listEvidenceForOperator(me.operatorId);
      }
    ),

    export: roleProcedure("records.evidence.export")
      .input(z.object({ evidenceIds: z.array(z.number().int()).min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
      // P4.1: every evidence record named must be in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        for (const id of input.evidenceIds ?? []) if (!(await evidenceInScope(id, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${id} not found` });
      }
        for (const id of input.evidenceIds) {
          await svc.recordEvidenceAccess({
            evidenceRecordId: id,
            actorUserId: ctx.user.id,
            actorRole: ctx.roles.join(","),
            action: "exported",
            context: "records.evidence.export",
          });
        }
        return { exported: input.evidenceIds.length };
      }),
  }),

  incident: router({
    capture: roleProcedure("records.incident.capture")
      .input(
        z.object({
          incidentNumber: z.string().min(3).max(64),
          incidentType: z.enum([
            "hazard_observation", "near_miss", "incident", "collision",
            "injury", "environmental_release", "property_damage",
            "equipment_event",
          ]),
          originalStatement: z.string().min(1).max(8000),
          originalStatementSource: z
            .enum(["typed", "voice", "dictated_transcript"])
            .default("typed"),
          occurredAt: z.date(),
          unitId: z.number().int().optional(),
          jobId: z.number().int().optional(),
          injuryReported: z.boolean().default(false),
          emergencyServicesAttended: z.boolean().default(false),
          policeAttended: z.boolean().default(false),
          environmentalRelease: z.boolean().default(false),
          dangerousGoodsInvolved: z.boolean().default(false),
          workStopped: z.boolean().default(false),
          vehicleDamage: z.boolean().default(false),
          equipmentDamage: z.boolean().default(false),
          unNumber: z.string().max(20).optional(),
          // Deliberately absent from the input: `severity`, `unitHeld`,
          // `dangerousGoodsVerified`, `structuredSummary` as authoritative.
        })
      )
      .mutation(async ({ ctx, input }) => {
        // CP1.5 (sweep #19) — an incident's organization is its job's, else its unit's. Both must be the
        // caller's organization's, proved before anything is written: otherwise one organization could
        // file an incident that moves to another, or that holds another organization's truck.
        const scope = await requireCallerUnits(ctx.user.id, { unitId: input.unitId });
        await requireJobInScope(input.jobId, scope);
        const me = await svc.resolveOperatorForUser(ctx.user.id);
        const facts = {
          incidentType: input.incidentType,
          injuryReported: input.injuryReported,
          emergencyServicesAttended: input.emergencyServicesAttended,
          policeAttended: input.policeAttended,
          environmentalRelease: input.environmentalRelease,
          dangerousGoodsInvolved: input.dangerousGoodsInvolved,
          workStopped: input.workStopped,
          vehicleDamage: input.vehicleDamage,
          equipmentDamage: input.equipmentDamage,
        };

        // Severity and hold are derived here. The client does not get to
        // declare an incident minor.
        const severity = deriveSeverity(facts);
        const plan = planEscalation(facts);

        const written = await svc.insertIncidentHoldingUnit({
          incidentNumber: input.incidentNumber,
          incidentType: input.incidentType,
          severity,
          operatorId: me.operatorId,
          jobId: input.jobId ?? null,
          unitId: input.unitId ?? null,
          occurredAt: input.occurredAt,
          reportedAt: new Date(),
          originalStatement: input.originalStatement,
          originalStatementSource: input.originalStatementSource,
          injuryReported: input.injuryReported,
          emergencyServicesAttended: input.emergencyServicesAttended,
          policeAttended: input.policeAttended,
          environmentalRelease: input.environmentalRelease,
          dangerousGoodsInvolved: input.dangerousGoodsInvolved,
          unNumber: input.unNumber ?? null,
          // AI never sets this. It stays false until a human verifies.
          dangerousGoodsVerified: false,
          workStopped: input.workStopped,
          unitHeld: plan.holdUnit,
          escalationState: "captured",
        }, { orgRef: orgRefOf(scope.tenantId), byUserId: ctx.user.id });

        return {
          incidentId: written?.id || null,
          incidentNumber: input.incidentNumber,
          severity,
          holdUnit: plan.holdUnit,
          // The portfolio hold the plan placed on the unit — lifted by this incident's safety review.
          holdRef: written?.holdRef ?? null,
          notifying: plan.targets,
          legalHoldRecommended: plan.legalHoldRecommended,
        };
      }),

    /**
     * The investigation DTO. Field-level separation happens here, on the
     * server — a dispatcher never receives this payload and then has fields
     * hidden in React.
     */
    readInvestigation: roleProcedure("records.incident.readInvestigation")
      .input(z.object({ incidentNumber: z.string().max(64) }))
      .query(async ({ ctx, input }) => {
      // P4.1: the incident must be in the caller's scope (through its job, unit or operator); otherwise it does not exist here.
      if (!(await incidentInScope(input.incidentNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "No such incident" });
        const inc = await svc.loadIncident(input.incidentNumber);
        if (!inc) throw new TRPCError({ code: "NOT_FOUND", message: "No such incident" });

        return {
          incidentNumber: inc.incidentNumber,
          incidentType: inc.incidentType,
          severity: inc.severity,
          occurredAt: inc.occurredAt,
          operatorId: inc.operatorId,
          employeeNumber: inc.employeeNumber,
          originalStatement: inc.originalStatement,
          originalStatementSource: inc.originalStatementSource,
          structuredSummary: inc.structuredSummary,
          summarySource: inc.summarySource,
          injuryReported: inc.injuryReported,
          emergencyServicesAttended: inc.emergencyServicesAttended,
          policeAttended: inc.policeAttended,
          environmentalRelease: inc.environmentalRelease,
          dangerousGoodsInvolved: inc.dangerousGoodsInvolved,
          unNumber: inc.unNumber,
          dangerousGoodsVerified: inc.dangerousGoodsVerified,
          reviewedBy: inc.safetyReviewedByUserId,
          _actor: ctx.user.id,
        };
      }),

    review: roleProcedure("records.incident.review")
      .input(z.object({ incidentNumber: z.string().max(64) }))
      .mutation(async ({ ctx, input }) => {
      // P4.1: the incident must be in the caller's scope (through its job, unit or operator); otherwise it does not exist here.
      if (!(await incidentInScope(input.incidentNumber, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: "No such incident" });
        // CP1.5 — the safety review lifts the hold the incident placed. It is a hold release, so the
        // hold's rules apply: a second person (never whoever captured the incident and so placed it),
        // in a role that releases a hold of its type. Refused before anything is recorded.
        const holds = await svc.activeIncidentHolds(input.incidentNumber);
        for (const h of holds) {
          const may = mayReleaseHold({ roles: ctx.roles, holdType: h.holdType, placedByUserId: h.placedByUserId, userId: ctx.user.id, status: h.status });
          if (!may.allowed) throw new TRPCError({ code: "FORBIDDEN", message: `${may.reason}. Incident ${input.incidentNumber} is reviewed by someone else.` });
        }
        const { releasedHoldRefs } = await svc.markIncidentReviewed({
          incidentNumber: input.incidentNumber,
          userId: ctx.user.id,
          releasing: holds.length ? { holds, byRole: actingRoleFor(ctx.roles, holds[0]!.holdType, "release")! } : undefined,
        });
        return { reviewed: true, releasedHoldRefs };
      }),
  }),

  nearMiss: router({
    /** Three questions. Escalation carries the statement; nothing is retyped. */
    report: roleProcedure("records.nearMiss.report")
      .input(
        z.object({
          nearMissNumber: z.string().min(3).max(64),
          statement: z.string().min(1).max(4000),
          statementSource: z
            .enum(["typed", "voice", "dictated_transcript"])
            .default("typed"),
          anyoneInjured: z.boolean(),
          workStopped: z.boolean(),
          occurredAt: z.date(),
          unitId: z.number().int().optional(),
          jobId: z.number().int().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: a near miss on a unit names a unit the caller may see.
      // CP1.5 — and its job: an escalated near miss becomes an incident, whose organization is its job's.
      const scope = await requireCallerUnits(ctx.user.id, { unitId: input.unitId });
      await requireJobInScope(input.jobId, scope);
        const me = await svc.resolveOperatorForUser(ctx.user.id);
        const outcome = evaluateNearMiss({
          originalStatement: input.statement,
          anyoneInjured: input.anyoneInjured,
          workStopped: input.workStopped,
        });
        if (!outcome.accepted) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: outcome.rejectionReason ?? "Rejected",
          });
        }

        await svc.insertNearMiss({
          nearMissNumber: input.nearMissNumber,
          operatorId: me.operatorId,
          jobId: input.jobId ?? null,
          unitId: input.unitId ?? null,
          occurredAt: input.occurredAt,
          reportedAt: new Date(),
          originalStatement: input.statement,
          originalStatementSource: input.statementSource,
          anyoneInjured: input.anyoneInjured,
          workStopped: input.workStopped,
        });

        if (!outcome.mustEscalateToIncident) {
          return { escalated: false, incidentNumber: null };
        }

        const incidentNumber = `INC-${input.nearMissNumber}`;
        const facts = {
          incidentType: "injury" as const,
          injuryReported: true,
          emergencyServicesAttended: false,
          policeAttended: false,
          environmentalRelease: false,
          dangerousGoodsInvolved: false,
          workStopped: input.workStopped,
        };
        const written = await svc.insertIncidentHoldingUnit({
          incidentNumber,
          incidentType: "injury",
          severity: deriveSeverity(facts),
          operatorId: me.operatorId,
          jobId: input.jobId ?? null,
          unitId: input.unitId ?? null,
          occurredAt: input.occurredAt,
          reportedAt: new Date(),
          // The operator's original words travel across. Nothing retyped.
          originalStatement: input.statement,
          originalStatementSource: input.statementSource,
          injuryReported: true,
          workStopped: input.workStopped,
          unitHeld: planEscalation(facts).holdUnit,
          escalationState: "captured",
        }, { orgRef: orgRefOf(scope.tenantId), byUserId: ctx.user.id });

        if (written?.id) {
          await svc.linkNearMissToIncident({
            nearMissNumber: input.nearMissNumber,
            incidentId: written.id,
          });
        }

        return { escalated: true, incidentNumber };
      }),
  }),

  maintenance: router({
    recordRelease: roleProcedure("records.maintenance.recordRelease")
      .input(
        z.object({
          workOrderId: z.number().int(),
          releaseType: z.enum(["full", "restricted"]),
          restrictionDetail: z.string().max(2000).optional(),
          repairSummary: z.string().min(1).max(4000),
          testProcedure: z.string().max(4000).optional(),
          testResult: z.enum(["pass", "fail", "not_required"]).optional(),
          roadTestPerformed: z.boolean().default(false),
          roadTestNotes: z.string().max(4000).optional(),
          technicianIdentifier: z.string().min(1).max(80),
          // `defectSeverity` is deliberately not an input.
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: the work order's unit must be in the caller's scope.
      if (!(await workOrderInScope(input.workOrderId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderId} not found` });
        const grants = await listActiveUserRoles(ctx.user.id);

        // The signature must be the caller's own.
        const auth = authorizeMechanicRelease({
          userId: ctx.user.id,
          grants,
          technicianUserId: ctx.user.id,
        });
        if (!auth.allowed) throw forbidden(auth.detail ?? "Cannot record a release");

        const wo = await svc.loadWorkOrderSubject(input.workOrderId);
        if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "No such work order" });

        const decision = evaluateMechanicRelease({
          workOrderStatus: wo.status,
          // Read from the defect, never from the request.
          defectSeverity: wo.defectSeverity,
          releaseType: input.releaseType,
          restrictionDetail: input.restrictionDetail,
          repairSummary: input.repairSummary,
          testProcedure: input.testProcedure,
          testResult: input.testResult,
          roadTestPerformed: input.roadTestPerformed,
          technicianUserId: ctx.user.id,
          technicianIdentifier: input.technicianIdentifier,
        });

        if (!decision.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: decision.blockers.map(b => b.label).join("; "),
          });
        }

        await svc.appendWorkOrderRelease({
          workOrderId: wo.id,
          unitId: wo.unitId,
          releaseType: input.releaseType,
          restrictionDetail: input.restrictionDetail ?? null,
          repairSummary: input.repairSummary,
          testProcedure: input.testProcedure ?? null,
          testResult: input.testResult ?? null,
          roadTestPerformed: input.roadTestPerformed,
          roadTestNotes: input.roadTestNotes ?? null,
          technicianUserId: ctx.user.id,
          technicianIdentifier: input.technicianIdentifier,
          releasedAt: new Date(),
        });

        return {
          released: true,
          restricted: decision.restricted,
          unitId: wo.unitId,
          dispatchRecalculationRequired: true,
        };
      }),

    /**
     * Resolve one named maintenance defect.
     *
     * This did not exist, and its absence was load-bearing: `maintenanceDefects.status` has carried
     * `resolved` since the table was created and nothing could ever write it, so readiness inferred
     * resolution from release chronology instead — any release newer than a defect cleared it, a
     * revocation included. The owner decision is that a release is evidence about a repair and is
     * not, by itself, the resolution of a defect. So the transition is explicit, names one defect,
     * and leaves an observable change on the row.
     *
     * Authority is `maintenance.record_release` — the permission that already governs mechanic and
     * work-order release (mechanic, shop_lead). Deliberately NOT `maintenance.write_defect`, which
     * drivers and office staff hold so that they can *report* a defect: whoever may raise one must
     * not thereby be able to close it.
     *
     * The authorization trail is `roleProcedure`'s, as everywhere else, and
     * `maintenance.record_release` is a sensitive permission, so an unrecordable decision refuses
     * rather than acting unrecorded.
     */
    resolveDefect: roleProcedure("records.maintenance.resolveDefect")
      .input(
        z.object({
          defectId: z.number().int().positive(),
          /** The release that evidences the repair. Required for a critical defect. */
          releaseId: z.number().int().positive().nullable().default(null),
          note: z.string().min(3).max(400),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const defect = await svc.loadDefect(input.defectId);
        // P4.1: out of scope is "not found", never "forbidden" — and the unit is what carries scope.
        const scope = await actingScopeFor(ctx.user.id);
        if (!defect || !(await unitInScope(defect.unitId, scope))) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Defect ${input.defectId} not found` });
        }
        if (defect.status === "resolved") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Defect ${defect.id} is already resolved` });
        }

        /*
         * A critical defect needs release evidence that names it. "Names it" is the whole point:
         * accepting any release on the unit would rebuild the failure this replaces, one layer up.
         */
        let evidenceId: number | null = null;
        if (defect.severity === "critical") {
          if (input.releaseId == null) {
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A critical defect is resolved on the evidence of a mechanic release — supply the release that repaired it" });
          }
          const release = await svc.loadRelease(input.releaseId);
          if (!release || release.unitId !== defect.unitId) {
            throw new TRPCError({ code: "NOT_FOUND", message: `Release ${input.releaseId} not found for this unit` });
          }
          const stands = currentReleaseEvidenceFor(defect.id, [{
            id: release.id, workOrderId: release.workOrderId, releaseType: release.releaseType,
            testResult: release.testResult, resolvedDefectIds: release.resolvedDefectIds, releasedAt: release.releasedAt,
          }]);
          if (!stands) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `Release ${release.id} does not name defect ${defect.id}, or is revoked or failed — it cannot resolve it`,
            });
          }
          evidenceId = release.id;
        } else if (input.releaseId != null) {
          const release = await svc.loadRelease(input.releaseId);
          if (release && release.unitId === defect.unitId) evidenceId = release.id;
        }

        const changed = await svc.resolveMaintenanceDefect({
          defectId: defect.id, resolvedByUserId: ctx.user.id,
          resolvedByReleaseId: evidenceId, note: input.note, at: new Date(),
        });
        if (!changed) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Defect ${defect.id} is already resolved` });
        }
        return {
          defectId: defect.id, unitId: defect.unitId, severity: defect.severity,
          status: "resolved" as const, resolvedByReleaseId: evidenceId, resolvedByUserId: ctx.user.id,
          note: "A resolved defect no longer holds the unit. It does not lift a government out-of-service order, and it does not release any other defect.",
        };
      }),

    revokeRelease: roleProcedure("records.maintenance.revokeRelease")
      .input(
        z.object({
          workOrderId: z.number().int(),
          reason: z.string().min(3).max(2000),
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: the work order's unit must be in the caller's scope.
      if (!(await workOrderInScope(input.workOrderId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Work order ${input.workOrderId} not found` });
        const wo = await svc.loadWorkOrderSubject(input.workOrderId);
        if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "No such work order" });

        // Appended, not mutated. The earlier release stays on record.
        await svc.appendWorkOrderRelease({
          workOrderId: wo.id,
          unitId: wo.unitId,
          releaseType: "revoked",
          repairSummary: input.reason,
          technicianUserId: ctx.user.id,
          technicianIdentifier: `revoked-by-${ctx.user.id}`,
          releasedAt: new Date(),
        });

        return { revoked: true, unitId: wo.unitId, unitHeld: true };
      }),
  }),

  legalHold: router({
    place: roleProcedure("records.legalHold.place")
      .input(
        z.object({
          holdNumber: z.string().min(3).max(64),
          reason: z.string().min(3).max(2000),
          matterRef: z.string().max(120).optional(),
          incidentNumber: z.string().max(64).optional(),
          evidenceIds: z.array(z.number().int()).max(1000).default([]),
        })
      )
      .mutation(async ({ ctx, input }) => {
      // P4.1: every evidence record named must be in the caller's scope.
      {
        const scope = await actingScopeFor(ctx.user.id);
        for (const id of input.evidenceIds ?? []) if (!(await evidenceInScope(id, scope))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${id} not found` });
      }
        const id = await svc.placeLegalHold({
          holdNumber: input.holdNumber,
          reason: input.reason,
          matterRef: input.matterRef ?? null,
          incidentNumber: input.incidentNumber ?? null,
          placedByUserId: ctx.user.id,
          placedByRole: ctx.roles.join(","),
          evidenceRecordIds: input.evidenceIds,
        });
        return { holdId: id ?? null, recordsHeld: input.evidenceIds.length };
      }),

    /** Legal only. Reason and authority are both mandatory. */
    release: roleProcedure("records.legalHold.release")
      .input(
        z.object({
          holdNumber: z.string().min(3).max(64),
          reason: z.string().min(3).max(2000),
          authority: z.string().min(3).max(180),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const result = await svc.releaseLegalHold({
          holdNumber: input.holdNumber,
          releasedByUserId: ctx.user.id,
          releasedByRole: ctx.roles.join(","),
          reason: input.reason,
          authority: input.authority,
        });
        if (!result.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: result.reason });
        }
        // Records are not deleted; retention eligibility simply resumes.
        return { released: true, recordsReleased: result.releasedRecords };
      }),
  }),

  retention: router({
    disposition: roleProcedure("records.retention.disposition")
      .input(z.object({ evidenceId: z.number().int() }))
      .query(async ({ ctx, input }) => {
      // P4.1: the evidence must be in the caller's scope (through its job, else its capturer); otherwise it does not exist here.
      if (!(await evidenceInScope(input.evidenceId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `Evidence ${input.evidenceId} not found` });
        const state = await svc.loadRetentionState(input.evidenceId);
        const underHold = await svc.hasActiveLegalHold(input.evidenceId);
        const r = evaluateOfficeDisposition({
          now: new Date(),
          officeRetainUntil: state?.officeRetainUntil ?? null,
          underLegalHold: underHold,
        });
        // Eligibility, not an instruction to destroy anything.
        return { ...r, officeRetainUntil: state?.officeRetainUntil ?? null };
      }),
  }),

  roadside: router({
    /**
     * A purpose-built DTO, not a filtered records query. Categories outside the
     * allowlist are absent by construction rather than hidden — an officer
     * holding the tablet cannot navigate to what was never assembled.
     */
    open: roleProcedure("records.roadside.open").query(async ({ ctx }) => {
      const me = await svc.resolveOperatorForUser(ctx.user.id);
      const candidates = me.operatorId
        ? await svc.loadRoadsideCandidates(me.operatorId)
        : [];

      const view = buildInspectionView(
        candidates.map(c => ({
          category: c.recordType,
          trackingNumber: c.trackingNumber,
          capturedAt: c.capturedAt,
        }))
      );

      return {
        scope: ROADSIDE_INSPECTION_SCOPE,
        hoursOfService: hosProductionWindow(new Date()),
        records: view.visible,
        withheldCount: view.withheldCount,
      };
    }),
  }),

  roles: router({
    /**
     * The one crossing from an empty role table to a usable system.
     *
     * Fail-closed authorization means nobody can grant a role until somebody
     * holds `roles.grant`, and nobody holds it while the table is empty. This
     * is deliberately NOT a roleProcedure — it could never satisfy one. It is
     * gated on platform admin instead, and it closes behind itself: it refuses
     * once any active management grant exists, and it grants `management` and
     * nothing else. Platform admin is not a domain role; an admin is not
     * thereby a mechanic, HR or legal.
     */
    bootstrapManagement: adminProcedure
      .input(
        z.object({
          targetUserId: z.number().int(),
          reason: z.string().min(3).max(1000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const result = await bootstrapManagementRole({
          targetUserId: input.targetUserId,
          performedByUserId: ctx.user.id,
          reason: input.reason,
        });
        if (!result.ok) {
          throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
        }
        return { bootstrapped: true, targetUserId: input.targetUserId };
      }),

    /** Whether the bootstrap path is still open. Safe for an admin to read. */
    bootstrapStatus: adminProcedure.query(async () => {
      const active = await countActiveManagementGrants();
      return { open: active === 0, activeManagementGrants: active };
    }),

    grant: roleProcedure("records.roles.grant")
      .input(
        z.object({
          targetUserId: z.number().int(),
          role: z.enum([
            "driver", "dispatcher", "mechanic", "shop_lead", "safety",
            "office", "management", "hr", "legal", "auditor",
          ]),
          scopeRef: z.string().max(64).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // P4.1: a role is granted only to a person in the caller's scope.
        if (!(await userInScope(input.targetUserId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.targetUserId} not found` });
      // P4.1: a role is granted only to a person in the caller's scope.
      if (!(await userInScope(input.targetUserId, await actingScopeFor(ctx.user.id)))) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.targetUserId} not found` });
        const id = await grantUserRole({
          userId: input.targetUserId,
          role: input.role,
          scopeType: input.scopeRef ? "branch" : "global",
          scopeRef: input.scopeRef ?? null,
          grantedByUserId: ctx.user.id,
          grantedAt: new Date(),
        });
        return { granted: true, assignmentId: id ?? null };
      }),
  }),
});
