/**
 * v22.20 (0090) — time off, reachable at last.
 *
 * The engine in `_core/timeOff.ts` decides; this exposes it. Nothing here
 * re-decides disclosure, availability or coverage.
 *
 * Two things this layer is responsible for and the engine cannot be.
 *
 * **The private note is never selected.** `schedulingWindow` lists the columns
 * it reads and `privateNote` is not among them, so the value does not reach
 * this process at all. A filter in application code is one somebody eventually
 * forgets; a column absent from a SELECT cannot be forgotten into a response.
 *
 * **The requester is not the approver.** Nobody approves their own leave, and
 * that is checked here because only the request context knows who is asking.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, gte, lte } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { leaveRequests } from "../drizzle/schema";
import { recordCallOff, schedulingView, type LeaveCategory, type LeaveRequest } from "./_core/timeOff";
import { resolveActingScope } from "./_core/actingScope";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const CATEGORY = z.enum([
  "vacation", "sick", "medical_appointment", "personal", "family_responsibility",
  "bereavement", "unpaid", "statutory_holiday", "training", "certification_renewal",
  "court_obligation", "company_authorized", "other",
]);
const TIME = z.string().regex(/^\d{2}:\d{2}$/, "hh:mm");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toEngine = (row: any): LeaveRequest => ({
  requestRef: row.requestRef, userId: row.userId, category: row.category as LeaveCategory,
  urgency: row.urgency, from: row.fromDate, to: row.toDate,
  partialDay: row.partialFromTime && row.partialToTime ? { fromTime: row.partialFromTime, toTime: row.partialToTime } : null,
  privateNote: row.privateNote ?? null, requestedAt: row.requestedAt, status: row.status,
  decidedByUserId: row.decidedByUserId ?? null, decidedAt: row.decidedAt ?? null,
  decisionNote: row.decisionNote ?? null,
});

export const timeOffRouter = router({
  /** Ask for time off. The requester is the caller, never the body. */
  request: roleProcedure("timeOff.request")
    .input(z.object({
      category: CATEGORY,
      from: z.coerce.date(),
      to: z.coerce.date(),
      partialDay: z.object({ fromTime: TIME, toTime: TIME }).optional(),
      privateNote: z.string().max(2000).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      if (input.to.getTime() < input.from.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The window ends before it begins" });
      const acting = await resolveActingScope(d, ctx.user.id);
      const requestRef = ref("LR");
      await d.insert(leaveRequests).values({
        requestRef, tenantId: acting.tenantId, userId: ctx.user.id,
        category: input.category, urgency: "planned",
        fromDate: input.from, toDate: input.to,
        partialFromTime: input.partialDay?.fromTime ?? null,
        partialToTime: input.partialDay?.toTime ?? null,
        privateNote: input.privateNote ?? null,
        requestedAt: input.at, status: "requested",
      });
      return { requestRef, status: "requested" as const, note: "Requested. Nothing is reserved and nobody is removed from a crew until it is approved." };
    }),

  /**
   * Report that you are not coming in.
   *
   * Recorded, not requested. Somebody phoning at 05:00 to say they cannot drive
   * is reporting a fact; routing that through an approval form means either a
   * sick person arguing with a workflow or a crew that finds out when the truck
   * does not arrive.
   */
  callOff: roleProcedure("timeOff.callOff")
    .input(z.object({
      category: z.enum(["sick", "family_responsibility", "bereavement", "other"]),
      from: z.coerce.date(),
      to: z.coerce.date(),
      privateNote: z.string().max(2000).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const requestRef = ref("LR");
      const callOff = recordCallOff({ requestRef, userId: ctx.user.id, category: input.category, from: input.from, to: input.to, privateNote: input.privateNote ?? null, at: input.at });
      await d.insert(leaveRequests).values({
        requestRef, tenantId: acting.tenantId, userId: ctx.user.id,
        category: input.category, urgency: "same_day",
        fromDate: input.from, toDate: input.to,
        privateNote: input.privateNote ?? null,
        requestedAt: input.at, status: "recorded",
      });
      return { requestRef, status: "recorded" as const, routedTo: callOff.routedTo, note: callOff.note };
    }),

  /** Somebody else's decision on somebody else's request. */
  decide: roleProcedure("timeOff.decide")
    .input(z.object({
      requestRef: z.string().min(1).max(64),
      decision: z.enum(["approve", "decline"]),
      decisionNote: z.string().max(600).optional(),
      at: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const row = (await d.select().from(leaveRequests).where(eq(leaveRequests.requestRef, input.requestRef)).limit(1))[0];
      if (!row || row.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such leave request" });
      if (row.status !== "requested") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That request is ${row.status}` });
      if (row.userId === ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Nobody approves their own leave" });
      }
      await d.update(leaveRequests)
        .set({ status: input.decision === "approve" ? "approved" : "declined", decidedByUserId: ctx.user.id, decidedAt: input.at, decisionNote: input.decisionNote ?? null })
        .where(and(eq(leaveRequests.requestRef, input.requestRef), eq(leaveRequests.status, "requested")));
      return {
        requestRef: input.requestRef,
        status: input.decision === "approve" ? ("approved" as const) : ("declined" as const),
        note: input.decision === "approve" ? "Approved. This person is now out of the available pool for that window." : "Declined and recorded.",
      };
    }),

  /** The caller's own requests, in full. */
  mine: roleProcedure("timeOff.mine")
    .input(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).default({}))
    .query(async ({ ctx }) => {
      const d = await db();
      const rows = await d.select().from(leaveRequests).where(eq(leaveRequests.userId, ctx.user.id)).limit(200);
      return { requests: rows.map(toEngine) };
    }),

  /**
   * What a scheduler sees.
   *
   * The column list is the privacy boundary. `privateNote` is not read, so it
   * cannot appear in a response however this is later refactored.
   */
  schedulingWindow: roleProcedure("timeOff.schedulingRead")
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const rows = await d.select({
        requestRef: leaveRequests.requestRef, userId: leaveRequests.userId,
        category: leaveRequests.category, status: leaveRequests.status,
        fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate,
        partialFromTime: leaveRequests.partialFromTime, partialToTime: leaveRequests.partialToTime,
        urgency: leaveRequests.urgency,
      }).from(leaveRequests).where(and(
        eq(leaveRequests.tenantId, acting.tenantId),
        lte(leaveRequests.fromDate, input.to),
        gte(leaveRequests.toDate, input.from),
      )).limit(500);

      return {
        absences: rows
          .filter(r => r.status === "approved" || r.status === "recorded" || r.status === "requested")
          .map(r => schedulingView({ ...toEngine(r), privateNote: null })),
        note: "Categories the company treats as sensitive appear as unavailable. The reason is not read by this query.",
      };
    }),
});
