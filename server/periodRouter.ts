import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { moneyScoped, roleProcedure, router } from "./_core/trpc";
import { requireOwnedEntity } from "./_core/entityScope";
import { getDb } from "./db";
import { periodCloses } from "../drizzle/schema";
import { decideClose } from "./_core/periodClose";
import { loadCloseReadiness } from "./periodCloseService";

const PERIOD = z.string().regex(/^\d{4}-\d{2}$/);

export const periodRouter = router({
  readiness: moneyScoped(roleProcedure("period.readiness"))
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD }))
    .query(async ({ ctx, input }) => {
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      return loadCloseReadiness(input.financialEntityId, input.period);
    }),

  /** soft_close with review items remaining; close only with nothing blocking and nothing to review. */
  close: moneyScoped(roleProcedure("period.close"))
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, action: z.enum(["soft_close", "close"]), reason: z.string().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const r = await loadCloseReadiness(input.financialEntityId, input.period);
      const d = decideClose(r.state, input.action, r);
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.insert(periodCloses).values({ financialEntityId: input.financialEntityId, period: input.period, action: input.action, reason: input.reason, readinessJson: JSON.stringify({ verdict: r.verdict, findings: r.findings }), byUserId: ctx.user.id, at: new Date() });
      return { period: input.period, from: r.state, to: input.action === "close" ? "closed" : "soft_closed", reviewItems: r.findings.filter(f => f.severity === "review").length };
    }),

  reopen: moneyScoped(roleProcedure("period.reopen"))
    .input(z.object({ financialEntityId: z.number().int().positive(), period: PERIOD, reason: z.string().min(10).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      requireOwnedEntity(ctx.money, input.financialEntityId, `Financial entity ${input.financialEntityId}`);
      const r = await loadCloseReadiness(input.financialEntityId, input.period);
      const d = decideClose(r.state, "reopen", r);
      if (!d.permitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: d.refusals.join("; ") });
      await db.insert(periodCloses).values({ financialEntityId: input.financialEntityId, period: input.period, action: "reopen", reason: input.reason, readinessJson: null, byUserId: ctx.user.id, at: new Date() });
      return { period: input.period, from: r.state, to: "open" as const };
    }),
});
