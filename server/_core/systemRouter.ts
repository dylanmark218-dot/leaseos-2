import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";
import { getDb } from "../db";
import { hubWorkerHeartbeat } from "../integrationHubService";
import { integrationConnectors, integrationDeadLetters } from "../../drizzle/schema";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(async () => {
      // Integration Hub — counts only, never a payload, a secret or a connector name.
      const db = await getDb();
      let integrationHub: { openDeadLetters: number; failingConnectors: number; workerHeartbeatAgeSeconds: number | null } | null = null;
      if (db) {
        try {
          const [dl] = await db.select({ n: sql<number>`count(*)` }).from(integrationDeadLetters).where(eq(integrationDeadLetters.state, "open"));
          const [fc] = await db.select({ n: sql<number>`count(*)` }).from(integrationConnectors).where(and(eq(integrationConnectors.status, "active"), inArray(integrationConnectors.healthState, ["failing", "authentication_required"])));
          const hb = hubWorkerHeartbeat();
          integrationHub = { openDeadLetters: Number(dl?.n ?? 0), failingConnectors: Number(fc?.n ?? 0), workerHeartbeatAgeSeconds: hb ? Math.round((Date.now() - hb.getTime()) / 1000) : null };
        } catch { integrationHub = null; }
      }
      return { ok: true, integrationHub };
    }),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
