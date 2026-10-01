/**
 * LA-1a — Live Assist, the session spine only.
 *
 * Built under the owner's narrow LA-1a carve-out (docs/live-assist/LA1A_OWNER_RULING.md). That ruling
 * does NOT lift the SPINE moratorium or the Wave 0 freeze for Live Assist as a whole. It authorizes this
 * router's eight procedures and nothing else: no model call, image analysis, camera, screen or video
 * capture, document transmission, form extraction, AI commit or evidence creation. Those are LA-1b/c/d
 * and later, and remain blocked by their own prerequisites.
 *
 * **Every input is strict.** An unknown field is refused, not ignored, so a client cannot send an
 * organization, a state, a deadline or an image and have any of it quietly dropped or used.
 *
 * **The organization is the server's.** `resolveActingScope` on every call. A user with two live
 * memberships and no selection is refused rather than guessed.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { AmbiguousOrganization, resolveActingScope } from "./_core/actingScope";
import { SESSION_REF_PATTERN, START_KEY_PATTERN, type Caller, type Operation } from "./_core/liveAssist/session";
import {
  LiveAssistRefusal, applyOperation, getPolicy, listLifecycle, setPolicy, startSession, type RefusalCode,
} from "./liveAssistService";
import type { DbOrTx } from "./_core/dbTypes";

async function db(): Promise<DbOrTx> {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}

async function callerFor(d: DbOrTx, userId: number): Promise<Caller> {
  try {
    const acting = await resolveActingScope(d, userId);
    return { userId, orgRef: acting.tenantId };
  } catch (e) {
    if (e instanceof AmbiguousOrganization) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your acting organization is not established. Choose one before using Live Assist." });
    }
    throw e;
  }
}

const CODE: Record<RefusalCode, TRPCError["code"]> = {
  not_found: "NOT_FOUND",
  disabled: "PRECONDITION_FAILED",
  source_not_allowed: "PRECONDITION_FAILED",
  open_session_exists: "CONFLICT",
  daily_limit: "TOO_MANY_REQUESTS",
  terminal: "CONFLICT",
  previous_still_open: "CONFLICT",
  policy_invalid: "BAD_REQUEST",
  conflict: "CONFLICT",
};

/** Turn a refusal into a tRPC error. The message never echoes input. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof LiveAssistRefusal) {
      const own = e.detail.sessionRef ? ` (${e.detail.sessionRef}, ${e.detail.state})` : "";
      const why = e.detail.disabledBecause?.length ? ` Reason: ${e.detail.disabledBecause.join(", ")}.` : "";
      const fields = e.detail.violations?.length ? ` ${e.detail.violations.map(v => `${v.field} ${v.message}`).join("; ")}.` : "";
      throw new TRPCError({ code: CODE[e.code], message: `${e.message}${own}${why}${fields}` });
    }
    throw e;
  }
}

const sessionRef = z.string().regex(SESSION_REF_PATTERN, "not a Live Assist session reference");
const byRef = z.object({ sessionRef }).strict();

const operation = (op: Operation) => async ({ ctx, input }: { ctx: { user: { id: number } }; input: { sessionRef: string } }) => {
  const d = await db();
  const caller = await callerFor(d, ctx.user.id);
  return refusing(() => applyOperation(d, caller, input.sessionRef, op, new Date(), process.env));
};

export const liveAssistRouter = router({
  /** Open a session for one source. Idempotent on `startKey`. */
  start: roleProcedure("liveAssist.start")
    .input(z.object({
      source: z.enum(["photo", "camera", "screen", "video"]),
      startKey: z.string().regex(START_KEY_PATTERN, "16–64 letters, digits, '-' or '_'"),
      previousSessionRef: sessionRef.optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const caller = await callerFor(d, ctx.user.id);
      return refusing(() => startSession(d, caller, input, new Date(), process.env));
    }),

  /** Keep an open session alive, or learn that it has stopped. */
  heartbeat: roleProcedure("liveAssist.heartbeat").input(byRef).mutation(operation("heartbeat")),
  pause: roleProcedure("liveAssist.pause").input(byRef).mutation(operation("pause")),
  /** Paused → active. A stopped session is refused: it never comes back. */
  resume: roleProcedure("liveAssist.resume").input(byRef).mutation(operation("resume")),
  /** End the session. Repeating it returns the ended session unchanged. */
  end: roleProcedure("liveAssist.end").input(byRef).mutation(operation("end")),

  /** The policy that governs the caller's organization now, and why it is off if it is. */
  policyGet: roleProcedure("liveAssist.policyGet")
    .input(z.object({}).strict().optional())
    .query(async ({ ctx }) => {
      const d = await db();
      const caller = await callerFor(d, ctx.user.id);
      return getPolicy(d, caller, process.env);
    }),

  /** Replace the organization's policy. Refused, field by field, outside LeaseOS's hard limits. */
  policySet: roleProcedure("liveAssist.policySet")
    .input(z.object({
      enabled: z.boolean(),
      sourcesAllowed: z.array(z.enum(["photo", "camera", "screen", "video"])).max(4),
      idleSeconds: z.number().int(),
      maxSessionMinutes: z.number().int(),
      retentionHours: z.number().int(),
      maxSessionsPerUserPerDay: z.number().int(),
      dailySpendCeilingCents: z.number().int().nullable(),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const caller = await callerFor(d, ctx.user.id);
      return refusing(() => setPolicy(d, caller, input, new Date()));
    }),

  /** Lifecycle rows and events for the caller's organization. Never turns, frames or observations. */
  lifecycleList: roleProcedure("liveAssist.lifecycleList")
    .input(z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      userId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).strict())
    .query(async ({ ctx, input }) => {
      if (input.to.getTime() < input.from.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "`to` is before `from`." });
      const d = await db();
      const caller = await callerFor(d, ctx.user.id);
      return listLifecycle(d, caller.orgRef, input);
    }),
});
