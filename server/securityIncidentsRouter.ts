/**
 * P4.6 — security incidents and privacy breach assessments (0131).
 *
 * Anyone who can create an incident may report one. Only incident.review
 * (safety, management) assesses privacy impact and decides notification —
 * and the decision is theirs: `pending` until a person moves it, `uncertain`
 * is a legitimate answer, and nothing here infers it from the data.
 * Closure is refused while a required notification is unsent or a privacy
 * assessment is still pending on an incident where personal information is
 * suspected. The timeline is append-only.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { router, roleProcedure } from "./_core/trpc";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { incidentNotificationObligations, privacyBreachAssessments, securityIncidentEvents, securityIncidentOrganizations, securityIncidents } from "../drizzle/schema";

async function dbOrThrow() { const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return db; }
type Db = Awaited<ReturnType<typeof dbOrThrow>>;
const ref = (p: string) => `${p}-${randomUUID().toUpperCase().slice(0, 12)}`;

async function ownedIncident(db: Db, userId: number, incidentRef: string) {
  const orgRef = (await resolveActingScope(db, userId)).tenantId;
  const i = (await db.select().from(securityIncidents).where(eq(securityIncidents.incidentRef, incidentRef)).limit(1))[0];
  if (!i || i.orgRef !== orgRef) throw new TRPCError({ code: "NOT_FOUND", message: "Incident not found" });
  return { i, orgRef };
}
async function appendEvent(db: Db, incidentId: number, e: { eventType: typeof securityIncidentEvents.$inferInsert["eventType"]; actorUserId: number; detail?: string | null; evidenceRecordId?: number | null; occurredAt: Date }) {
  const last = (await db.select({ sequence: securityIncidentEvents.sequence }).from(securityIncidentEvents).where(eq(securityIncidentEvents.securityIncidentId, incidentId)).orderBy(asc(securityIncidentEvents.sequence)));
  const sequence = (last[last.length - 1]?.sequence ?? 0) + 1;
  await db.insert(securityIncidentEvents).values({ securityIncidentId: incidentId, sequence, eventType: e.eventType, actorUserId: e.actorUserId, detail: e.detail ?? null, evidenceRecordId: e.evidenceRecordId ?? null, occurredAt: e.occurredAt });
  return sequence;
}

export const securityIncidentsRouter = router({
  /** Report. The discovery is the first timeline event. */
  open: roleProcedure("securityIncidents.open")
    .input(z.object({
      incidentType: z.enum(["account_compromise", "unauthorized_access", "data_exposure", "malware", "ransomware", "credential_exposure", "cross_tenant_access", "lost_device", "vendor_incident", "availability", "integrity", "privacy", "other"]),
      severity: z.enum(["low", "moderate", "high", "critical"]).default("moderate"),
      title: z.string().min(3).max(220), summary: z.string().max(4000).nullable().optional(),
      discoveredAt: z.coerce.date(), occurredFrom: z.coerce.date().nullable().optional(), occurredTo: z.coerce.date().nullable().optional(),
      personalInformationSuspected: z.boolean().default(false), customerDataSuspected: z.boolean().default(false),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const incidentRef = ref("SEC");
      const [ins] = await db.insert(securityIncidents).values({ orgRef, incidentRef, incidentType: input.incidentType, severity: input.severity, title: input.title, summary: input.summary ?? null, discoveredAt: input.discoveredAt, occurredFrom: input.occurredFrom ?? null, occurredTo: input.occurredTo ?? null, discoveredByUserId: ctx.user.id, personalInformationSuspected: input.personalInformationSuspected, customerDataSuspected: input.customerDataSuspected });
      await appendEvent(db, ins.insertId, { eventType: "discovered", actorUserId: ctx.user.id, detail: input.title, occurredAt: input.discoveredAt });
      return { incidentRef, status: "open" as const };
    }),

  /** Append to the timeline; some events also move the incident's status. */
  timelineAppend: roleProcedure("securityIncidents.timelineAppend")
    .input(z.object({
      incidentRef: z.string().min(1).max(64),
      eventType: z.enum(["triage", "evidence_added", "contained", "scope_changed", "customer_identified", "recovery", "reopened"]),
      detail: z.string().max(4000).nullable().optional(), evidenceRecordId: z.number().int().positive().nullable().optional(), occurredAt: z.coerce.date(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      if (i.status === "closed" && input.eventType !== "reopened") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The incident is closed; reopen it to add to its timeline" });
      const sequence = await appendEvent(db, i.id, { eventType: input.eventType, actorUserId: ctx.user.id, detail: input.detail, evidenceRecordId: input.evidenceRecordId, occurredAt: input.occurredAt });
      const status = { triage: "triaging", contained: "contained", recovery: "recovering", reopened: "investigating" } as const;
      const next = (status as Record<string, typeof securityIncidents.$inferInsert["status"]>)[input.eventType];
      if (next) await db.update(securityIncidents).set({ status: next, ...(input.eventType === "contained" ? { containedAt: input.occurredAt } : {}), ...(input.eventType === "reopened" ? { closedAt: null } : {}) }).where(eq(securityIncidents.id, i.id));
      return { incidentRef: i.incidentRef, sequence, status: next ?? i.status };
    }),

  /** Name an organization the incident touched. Suspected until someone confirms or rules it out. */
  organizationAffect: roleProcedure("securityIncidents.organizationAffect")
    .input(z.object({ incidentRef: z.string().min(1).max(64), orgRef: z.string().min(1).max(64), affectedStatus: z.enum(["suspected", "confirmed", "ruled_out"]).default("suspected"), dataCategories: z.array(z.string().max(60)).max(20).default([]) }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      await db.insert(securityIncidentOrganizations).values({ securityIncidentId: i.id, orgRef: input.orgRef, affectedStatus: input.affectedStatus, dataCategoriesJson: JSON.stringify(input.dataCategories) })
        .onDuplicateKeyUpdate({ set: { affectedStatus: input.affectedStatus, dataCategoriesJson: JSON.stringify(input.dataCategories) } });
      await appendEvent(db, i.id, { eventType: "customer_identified", actorUserId: ctx.user.id, detail: `${input.orgRef}: ${input.affectedStatus}`, occurredAt: new Date() });
      return { incidentRef: i.incidentRef, orgRef: input.orgRef, affectedStatus: input.affectedStatus };
    }),

  /** The privacy conclusion — a reviewer's. `uncertain` is a valid decision; `pending` is not a decision. */
  breachAssess: roleProcedure("securityIncidents.breachAssess")
    .input(z.object({
      incidentRef: z.string().min(1).max(64), jurisdiction: z.string().min(2).max(80), applicableLaw: z.string().max(180).nullable().optional(),
      sensitivity: z.enum(["low", "moderate", "high", "very_high", "unknown"]), misuseLikelihood: z.enum(["low", "moderate", "high", "unknown"]),
      harmAssessment: z.record(z.string(), z.unknown()).nullable().optional(),
      notificationDecision: z.enum(["not_required", "required", "uncertain"]), decisionReason: z.string().min(10).max(4000),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      const prior = await db.select({ id: privacyBreachAssessments.id, assessmentNo: privacyBreachAssessments.assessmentNo }).from(privacyBreachAssessments).where(eq(privacyBreachAssessments.securityIncidentId, i.id));
      const assessmentNo = (prior.length ? Math.max(...prior.map(p => p.assessmentNo)) : 0) + 1;
      await db.transaction(async (tx) => {
        if (prior.length) await tx.update(privacyBreachAssessments).set({ status: "superseded" }).where(inArray(privacyBreachAssessments.id, prior.map(p => p.id)));
        await tx.insert(privacyBreachAssessments).values({ securityIncidentId: i.id, assessmentNo, jurisdiction: input.jurisdiction, applicableLaw: input.applicableLaw ?? null, status: "complete", sensitivity: input.sensitivity, misuseLikelihood: input.misuseLikelihood, harmAssessmentJson: input.harmAssessment ? JSON.stringify(input.harmAssessment) : null, notificationDecision: input.notificationDecision, decisionReason: input.decisionReason, assessedByUserId: ctx.user.id, assessedAt: new Date(), createdByUserId: ctx.user.id });
      });
      await appendEvent(db, i.id, { eventType: "privacy_assessment", actorUserId: ctx.user.id, detail: `${input.jurisdiction}: sensitivity ${input.sensitivity}, misuse ${input.misuseLikelihood}`, occurredAt: new Date() });
      await appendEvent(db, i.id, { eventType: "notification_decision", actorUserId: ctx.user.id, detail: `${input.notificationDecision}: ${input.decisionReason}`, occurredAt: new Date() });
      return { incidentRef: i.incidentRef, assessmentNo, notificationDecision: input.notificationDecision };
    }),

  /** A notification the reviewer says is owed: to whom, on what basis, by when (the person sets the date; no statute is encoded here). */
  obligationCreate: roleProcedure("securityIncidents.obligationCreate")
    .input(z.object({ incidentRef: z.string().min(1).max(64), recipientType: z.enum(["commissioner", "individuals", "customer_organization", "law_enforcement", "insurer", "vendor", "other"]), recipientRef: z.string().max(220).nullable().optional(), basis: z.string().min(5).max(300), dueAt: z.coerce.date().nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      const latest = (await db.select({ id: privacyBreachAssessments.id }).from(privacyBreachAssessments).where(and(eq(privacyBreachAssessments.securityIncidentId, i.id), eq(privacyBreachAssessments.status, "complete"))).limit(1))[0];
      const [ins] = await db.insert(incidentNotificationObligations).values({ securityIncidentId: i.id, assessmentId: latest?.id ?? null, recipientType: input.recipientType, recipientRef: input.recipientRef ?? null, basis: input.basis, dueAt: input.dueAt ?? null, createdByUserId: ctx.user.id });
      return { incidentRef: i.incidentRef, obligationId: ins.insertId, state: "required" as const };
    }),

  /** Record that a notification went out, with its evidence. */
  obligationSent: roleProcedure("securityIncidents.obligationSent")
    .input(z.object({ incidentRef: z.string().min(1).max(64), obligationId: z.number().int().positive(), sentAt: z.coerce.date(), evidenceRecordId: z.number().int().positive().nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      const o = (await db.select().from(incidentNotificationObligations).where(and(eq(incidentNotificationObligations.id, input.obligationId), eq(incidentNotificationObligations.securityIncidentId, i.id))).limit(1))[0];
      if (!o) throw new TRPCError({ code: "NOT_FOUND", message: "Obligation not found on this incident" });
      if (o.state !== "required") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Obligation is ${o.state}, not required` });
      await db.update(incidentNotificationObligations).set({ state: "sent", sentAt: input.sentAt, sentByUserId: ctx.user.id, evidenceRecordId: input.evidenceRecordId ?? null }).where(eq(incidentNotificationObligations.id, o.id));
      await appendEvent(db, i.id, { eventType: "notification_sent", actorUserId: ctx.user.id, detail: `${o.recipientType}${o.recipientRef ? ` (${o.recipientRef})` : ""}`, evidenceRecordId: input.evidenceRecordId, occurredAt: input.sentAt });
      return { incidentRef: i.incidentRef, obligationId: o.id, state: "sent" as const };
    }),

  /** Close — refused while a required notification is unsent, or personal information is suspected and no privacy decision exists. */
  close: roleProcedure("securityIncidents.close")
    .input(z.object({ incidentRef: z.string().min(1).max(64), closedAt: z.coerce.date(), detail: z.string().max(4000).nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      const blockers: string[] = [];
      const unsent = await db.select({ id: incidentNotificationObligations.id, recipientType: incidentNotificationObligations.recipientType }).from(incidentNotificationObligations).where(and(eq(incidentNotificationObligations.securityIncidentId, i.id), eq(incidentNotificationObligations.state, "required")));
      for (const u of unsent) blockers.push(`notification to ${u.recipientType} (obligation ${u.id}) is required and unsent`);
      if (i.personalInformationSuspected) {
        const decided = (await db.select({ notificationDecision: privacyBreachAssessments.notificationDecision }).from(privacyBreachAssessments).where(and(eq(privacyBreachAssessments.securityIncidentId, i.id), eq(privacyBreachAssessments.status, "complete"))).limit(1))[0];
        if (!decided) blockers.push("personal information is suspected and no privacy breach assessment has been completed");
        else if (decided.notificationDecision === "uncertain") blockers.push("the privacy assessment's notification decision is uncertain; resolve it before closing");
      }
      if (blockers.length) return { closed: false as const, blockers };
      await db.transaction(async (tx) => {
        await tx.update(securityIncidents).set({ status: "closed", closedAt: input.closedAt }).where(eq(securityIncidents.id, i.id));
      });
      await appendEvent(db, i.id, { eventType: "closed", actorUserId: ctx.user.id, detail: input.detail, occurredAt: input.closedAt });
      return { closed: true as const, blockers: [] };
    }),

  /** The whole incident: timeline, organizations, assessments, obligations. */
  view: roleProcedure("securityIncidents.view")
    .input(z.object({ incidentRef: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const { i } = await ownedIncident(db, ctx.user.id, input.incidentRef);
      const [events, organizations, assessments, obligations] = await Promise.all([
        db.select().from(securityIncidentEvents).where(eq(securityIncidentEvents.securityIncidentId, i.id)).orderBy(asc(securityIncidentEvents.sequence)),
        db.select().from(securityIncidentOrganizations).where(eq(securityIncidentOrganizations.securityIncidentId, i.id)),
        db.select().from(privacyBreachAssessments).where(eq(privacyBreachAssessments.securityIncidentId, i.id)).orderBy(asc(privacyBreachAssessments.assessmentNo)),
        db.select().from(incidentNotificationObligations).where(eq(incidentNotificationObligations.securityIncidentId, i.id)),
      ]);
      return { incident: i, events, organizations, assessments, obligations };
    }),

  /** Open incidents for the exception centre and the office. */
  list: roleProcedure("securityIncidents.list")
    .query(async ({ ctx }) => {
      const db = await dbOrThrow();
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      return db.select().from(securityIncidents).where(eq(securityIncidents.orgRef, orgRef)).orderBy(asc(securityIncidents.discoveredAt));
    }),
});
