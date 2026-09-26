/**
 * v22.20 (0093) — the coverage forecast, from records.
 *
 * `_core/crewCoverage.ts` does the arithmetic; this supplies it with facts
 * instead of arguments. Three of them now exist where they did not:
 *
 *   ROTATION        from the member's own pattern
 *   APPROVED LEAVE  from `leaveRequests`
 *   QUALIFICATIONS  from the qualification read adapter (C1b-3), and only the verified,
 *                   unexpired ones count
 *
 * That last is the point of doing this at all. A forecast built from a list of
 * names somebody typed answers "are there enough people". A forecast built from
 * verified holdings answers "can this crew do the work", and those come apart
 * exactly when it matters.
 */
import { effectiveQualifications } from "./qualificationReads";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { crewMembers, crews, leaveRequests, operators } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import { coverageWarnings, qualifiedForecast, type CrewMember } from "./_core/crewCoverage";
import { isAbsent, type LeaveRequest } from "./_core/timeOff";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
async function db() { const d = await getDb(); if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); return d; }

const ROLE = z.enum(["supervisor", "driver", "operator", "labourer", "mechanic", "safety", "dispatch", "other"]);

export const crewRouter = router({
  create: roleProcedure("crews.create")
    .input(z.object({
      name: z.string().min(2).max(220),
      type: z.enum(["permanent", "job", "shift", "site", "unit", "project", "emergency"]).default("permanent"),
      supervisorUserId: z.number().int().positive().optional(),
      jobRef: z.string().max(64).optional(),
      branchId: z.string().max(40).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const crewRef = ref("CREW");
      await d.insert(crews).values({
        crewRef, tenantId: acting.tenantId, name: input.name, type: input.type,
        supervisorUserId: input.supervisorUserId ?? null, jobRef: input.jobRef ?? null,
        branchId: input.branchId ?? null, state: "active", createdByUserId: ctx.user.id,
      });
      return { crewRef, note: "Created. Members are added with their own rotation, because people move between patterns and crews outlive them." };
    }),

  addMember: roleProcedure("crews.addMember")
    .input(z.object({
      crewRef: z.string().min(1).max(64),
      userId: z.number().int().positive(),
      crewRole: ROLE.default("driver"),
      rotation: z.object({ onDays: z.number().int().min(1).max(60), offDays: z.number().int().min(0).max(60), anchor: z.coerce.date() }).optional(),
      joinedAt: z.coerce.date().default(() => new Date()),
    }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const crew = (await d.select().from(crews).where(eq(crews.crewRef, input.crewRef)).limit(1))[0];
      if (!crew || crew.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such crew" });
      if (crew.state !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `That crew is ${crew.state}` });

      const already = (await d.select().from(crewMembers).where(and(
        eq(crewMembers.crewRef, input.crewRef), eq(crewMembers.userId, input.userId), isNull(crewMembers.leftAt),
      )).limit(1))[0];
      if (already) return { crewRef: crew.crewRef, added: false, note: "Already a current member." };

      await d.insert(crewMembers).values({
        crewRef: input.crewRef, userId: input.userId, crewRole: input.crewRole, source: "manual",
        rotationOnDays: input.rotation?.onDays ?? null,
        rotationOffDays: input.rotation?.offDays ?? null,
        rotationAnchor: input.rotation?.anchor ?? null,
        joinedAt: input.joinedAt,
      });
      return { crewRef: crew.crewRef, added: true, note: "Added." };
    }),

  /** End a membership. The row stays; only what they receive next changes. */
  removeMember: roleProcedure("crews.removeMember")
    .input(z.object({ crewRef: z.string().min(1).max(64), userId: z.number().int().positive(), at: z.coerce.date().default(() => new Date()) }))
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const crew = (await d.select().from(crews).where(eq(crews.crewRef, input.crewRef)).limit(1))[0];
      if (!crew || crew.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such crew" });
      await d.update(crewMembers).set({ leftAt: input.at }).where(and(
        eq(crewMembers.crewRef, input.crewRef), eq(crewMembers.userId, input.userId), isNull(crewMembers.leftAt),
      ));
      return { crewRef: crew.crewRef, note: "Membership ended. The record stays — deleting it would make their history authored by somebody who was never here." };
    }),

  /**
   * The forecast.
   *
   * Reads the crew, everybody's rotation, approved leave and verified
   * qualifications, then asks the engine. Nothing is passed in that the
   * database could answer.
   */
  forecast: roleProcedure("crews.forecast")
    .input(z.object({
      crewRef: z.string().min(1).max(64),
      from: z.coerce.date(),
      days: z.number().int().min(1).max(60).default(14),
      neededPerDay: z.number().int().min(1).max(200),
      requirements: z.array(z.object({ qualification: z.string().max(60), neededHolders: z.number().int().min(1).max(200) })).max(20).default([]),
    }))
    .query(async ({ ctx, input }) => {
      const d = await db();
      const acting = await resolveActingScope(d, ctx.user.id);
      const crew = (await d.select().from(crews).where(eq(crews.crewRef, input.crewRef)).limit(1))[0];
      if (!crew || crew.tenantId !== acting.tenantId) throw new TRPCError({ code: "NOT_FOUND", message: "No such crew" });

      const to = new Date(input.from.getTime() + input.days * 86_400_000);
      const members = await d.select().from(crewMembers).where(and(eq(crewMembers.crewRef, input.crewRef), isNull(crewMembers.leftAt))).limit(200);

      const crewOut: CrewMember[] = [];
      for (const m of members) {
        const person = (await d.select().from(operators).where(eq(operators.id, m.userId)).limit(1))[0];

        /* Approved leave in the window becomes away-days, which the engine
           already treats as absent whatever the rotation says. */
        const leave = await d.select().from(leaveRequests).where(eq(leaveRequests.userId, m.userId)).limit(100);
        const awayOn: Date[] = [];
        for (const l of leave) {
          const absent = isAbsent({ status: l.status } as LeaveRequest) && !l.partialFromTime;
          if (!absent) continue;
          for (let t = l.fromDate.getTime(); t <= l.toDate.getTime(); t += 86_400_000) {
            const day = new Date(t);
            if (day >= input.from && day <= to) awayOn.push(day);
          }
        }

        /* Only verified, unexpired holdings count as held. An uploaded
           certificate is a photo, and the engine must not see it as a ticket. */
        // C1b-3: held qualifications from the read adapter (Academy first; legacy only as a marked
        // fallback; this organization) — held means verified, in date and with an establishable end.
        const currentQualifications = (await effectiveQualifications(d, { tenantId: acting.tenantId, userId: m.userId, at: input.from }))
          .filter(e => e.held).map(e => e.code);

        crewOut.push({
          userId: m.userId, name: person?.name ?? `user ${m.userId}`,
          roles: [m.crewRole], currentQualifications, existingAssignments: [],
          rotation: m.rotationOnDays && m.rotationAnchor
            ? { onDays: m.rotationOnDays, offDays: m.rotationOffDays ?? 0, anchor: m.rotationAnchor, label: `${m.rotationOnDays}/${m.rotationOffDays ?? 0}` }
            : null,
          awayOn,
        });
      }

      const forecast = qualifiedForecast({
        crew: crewOut, from: input.from, days: input.days,
        neededPerDay: input.neededPerDay, requirements: input.requirements,
      });
      return {
        crewRef: crew.crewRef,
        days: forecast.map(f => ({ day: f.day, state: f.state, line: f.line, available: f.headcount.available, needed: f.headcount.needed })),
        warnings: coverageWarnings(forecast),
        note: "Availability is the member's rotation minus approved leave. A qualification counts only where a verified, unexpired holding exists — an uploaded certificate is not a ticket.",
      };
    }),
});
