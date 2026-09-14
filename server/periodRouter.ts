import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { periodCloses } from "../drizzle/schema";
import { decideClose } from "./_core/periodClose";
import { loadCloseReadiness } from "./periodCloseService";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/);

export const periodRouter = router({
  readiness: roleProcedure("period.readiness")
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD }))
    .query(async ({ input }) => loadCloseReadiness(input.financialEntityId, input.period)),

  /** soft_close with review items remaining; close only with nothing blocking and nothing to review. */
  close: roleProcedure("period.close")
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, action: z.enum(["soft_close", "close"]), reason: z.string().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const r = await loadCloseReadiness(input.financialEntityId, input.period);
      const d = decideClose(r.state, input.action, r);
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.insert(periodCloses).values({ financialEntityId: input.financialEntityId, period: input.period, action: input.action, reason: input.reason, readinessJson: JSON.stringify({ verdict: r.verdict, findings: r.findings }), byUserId: ctx.user.id, at: new Date() });
      return { period: input.period, from: r.state, to: input.action === "close" ? "closed" : "soft_closed", reviewItems: r.findings.filter(f => f.severity === "review").length };
    }),

  reopen: roleProcedure("period.reopen")
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, reason: z.string().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const r = await loadCloseReadiness(input.financialEntityId, input.period);
      const d = decideClose(r.state, "reopen", r);
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.insert(periodCloses).values({ financialEntityId: input.financialEntityId, period: input.period, action: "reopen", reason: input.reason, readinessJson: null, byUserId: ctx.user.id, at: new Date() });
      return { period: input.period, from: r.state, to: "open" as const };
    }),
});
