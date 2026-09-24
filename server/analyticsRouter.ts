/**
 * Analytics Checkpoint B — the API.
 *
 * Read-only. Five procedures over one registry:
 *
 *   analytics.catalog         every registered metric and whether the caller may see it
 *   analytics.metric          one metric's value, with its determination and what it could not place
 *   analytics.drilldown       the exact rows that value was computed from
 *   analytics.mine            the caller's own metrics, scoped to their own operator record
 *   analytics.mineDrilldown   the rows behind one of those
 *
 * Three gates, in order, all on the server:
 *
 *   1. the procedure's permission — `analytics.read`, or the universal `analytics.read_own`;
 *   2. the metric's own `requiredPermission`, the read permission of its source records, so no
 *      metric reveals more than the records behind it would;
 *   3. the organization — resolved from the caller's membership by `resolveActingScope`, never
 *      from input, and applied by the source table's existing scope rule. A filter naming a unit,
 *      operator or job outside the scope is "not found", never "forbidden" and never a quiet zero.
 *
 * The value and the drill-down run the same resolver with the same scope, range and filters, and
 * the value is aggregated from the rows (`metricContract.aggregate`), so they cannot disagree.
 * Every answer echoes the scope it was computed in, the exact instants and zone of its range, the
 * registry version and when it was computed, so a screen can say "as of" and repeat the question.
 */
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { operators } from "../drizzle/schema";
import { AmbiguousOrganization, resolveActingScope, type ActingScope } from "./_core/actingScope";
import { aggregate, type DrillRow, type FilterKey, type MetricDefinition } from "./_core/analytics/metricContract";
import { METRICS, METRIC_REGISTRY_VERSION, metricById } from "./_core/analytics/metricRegistry";
import { resolverFor, type Db } from "./_core/analytics/metricSources";
import { RANGE_LABELS, RangeRefused, resolveRange, type ResolvedRange } from "./_core/analytics/ranges";
import { authorize } from "./_core/recordsAuthorization";
import { roleProcedure, router } from "./_core/trpc";
import { getDb, jobInScope, operatorInScope, unitInScope } from "./db";

const rangeInput = z.object({
  label: z.enum(RANGE_LABELS),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  zone: z.string().min(1).max(64).optional(),
}).strict();
const filtersInput = z.object({
  unitId: z.number().int().positive().optional(),
  operatorId: z.number().int().positive().optional(),
  jobId: z.number().int().positive().optional(),
}).strict();
const metricInput = z.object({
  metricId: z.string().min(1).max(80),
  range: rangeInput.default({ label: "today" }),
  filters: filtersInput.default({}),
}).strict();
const mineInput = z.object({
  metricIds: z.array(z.string().min(1).max(80)).max(40).optional(),
  range: rangeInput.default({ label: "today" }),
}).strict();
const mineDrillInput = z.object({ metricId: z.string().min(1).max(80), range: rangeInput.default({ label: "today" }) }).strict();

type Filters = Partial<Record<FilterKey, number>>;

async function dbOrThrow(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

async function scopeOf(db: Db, userId: number): Promise<ActingScope> {
  try {
    return await resolveActingScope(db, userId);
  } catch (e) {
    if (e instanceof AmbiguousOrganization) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "You are an active member of more than one organization; analytics will not choose one for you" });
    }
    throw e;
  }
}

function metricOrThrow(metricId: string): MetricDefinition {
  const def = metricById(metricId);
  if (!def) throw new TRPCError({ code: "NOT_FOUND", message: `No metric "${metricId}" is registered` });
  return def;
}

function rangeOrThrow(req: z.infer<typeof rangeInput>, now: Date): ResolvedRange {
  try {
    return resolveRange(req, now);
  } catch (e) {
    if (e instanceof RangeRefused) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

/** Gate 2: the metric's source permission, checked against the roles the gate already loaded. */
function assertMayRead(def: MetricDefinition, userId: number, roles: readonly string[]) {
  if (!authorize({ userId, roles, permission: def.requiredPermission }).allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: `Metric ${def.id} requires ${def.requiredPermission}` });
  }
}

/** Gate 3 for filters: every named subject must be one the scope may see. */
async function assertFiltersInScope(def: MetricDefinition, filters: Filters, scope: ActingScope) {
  for (const key of Object.keys(filters) as FilterKey[]) {
    if (!def.filters.includes(key)) throw new TRPCError({ code: "BAD_REQUEST", message: `Metric ${def.id} does not accept a ${key} filter` });
  }
  const s = { tenantId: scope.tenantId };
  if (filters.unitId !== undefined && !(await unitInScope(filters.unitId, s))) throw new TRPCError({ code: "NOT_FOUND", message: `Unit ${filters.unitId} not found` });
  if (filters.operatorId !== undefined && !(await operatorInScope(filters.operatorId, s))) throw new TRPCError({ code: "NOT_FOUND", message: `Operator ${filters.operatorId} not found` });
  if (filters.jobId !== undefined && !(await jobInScope(filters.jobId, s))) throw new TRPCError({ code: "NOT_FOUND", message: `Job ${filters.jobId} not found` });
}

type Evaluation = {
  metricId: string;
  name: string;
  family: MetricDefinition["family"];
  unit: MetricDefinition["unit"];
  temporal: MetricDefinition["temporal"];
  registryVersion: string;
  scope: { tenantId: string; derivedFrom: ActingScope["derivedFrom"] };
  range: ResolvedRange | null;
  asOf: Date;
  filters: Filters;
  value: number | null;
  determination: ReturnType<typeof aggregate>["determination"];
  unknowns: ReturnType<typeof aggregate>["unknowns"];
  basis: number;
  breakdown: Record<string, number> | null;
  computedAt: Date;
  freshnessSeconds: number;
  drilldown: { procedure: "analytics.drilldown" | "analytics.mineDrilldown"; input: Record<string, unknown> };
};

/** Resolve once, aggregate once. The value and the rows come out of the same call. */
async function evaluate(db: Db, def: MetricDefinition, scope: ActingScope, range: ResolvedRange, filters: Filters, now: Date, self: boolean): Promise<{ evaluation: Evaluation; rows: DrillRow[]; truncated: boolean }> {
  const resolver = resolverFor(def.id);
  const answer = def.unavailable || !resolver
    ? { rows: [] as DrillRow[], unknowns: [], truncated: false }
    : await resolver(db, { scope: { tenantId: scope.tenantId }, from: range.from, to: range.to, now, filters });
  const agg = aggregate(def, answer);
  const rangeEcho = { label: range.label, from: range.from, to: range.to, zone: range.zone };
  return {
    evaluation: {
      metricId: def.id, name: def.name, family: def.family, unit: def.unit, temporal: def.temporal,
      registryVersion: METRIC_REGISTRY_VERSION,
      scope: { tenantId: scope.tenantId, derivedFrom: scope.derivedFrom },
      range: def.temporal === "range" ? range : null,
      asOf: now,
      filters,
      value: agg.value, determination: agg.determination, unknowns: agg.unknowns, basis: agg.basis, breakdown: agg.breakdown,
      computedAt: now,
      freshnessSeconds: def.freshnessSeconds,
      drilldown: self
        ? { procedure: "analytics.mineDrilldown", input: { metricId: def.id, range: { ...rangeEcho, label: "custom" as const } } }
        : { procedure: "analytics.drilldown", input: { metricId: def.id, range: { ...rangeEcho, label: "custom" as const }, filters } },
    },
    rows: answer.rows,
    truncated: answer.truncated,
  };
}

/**
 * The caller's own operator record. One, or an answer saying why there is not one — never a guess
 * between two, which would put somebody else's hours on this person's screen.
 */
async function ownOperator(db: Db, userId: number, scope: ActingScope): Promise<{ operatorId: number } | { reason: string }> {
  const mine = await db.select({ id: operators.id }).from(operators).where(eq(operators.userId, userId)).orderBy(asc(operators.id)).limit(2);
  if (mine.length === 0) return { reason: "No operator record is linked to your login" };
  if (mine.length > 1) return { reason: "More than one operator record is linked to your login; analytics will not pick one" };
  // Every source is read in the organization's scope, so an operator record the organization does
  // not own would read as a row of zeros. Say why instead (workforce.applicantDecide writes no
  // ownership row — the survey's §1.3).
  if (!(await operatorInScope(mine[0]!.id, { tenantId: scope.tenantId }))) {
    return { reason: "Your operator record is not recorded as belonging to your organization, so its records cannot be counted here" };
  }
  return { operatorId: mine[0]!.id };
}

const definitionView = (def: MetricDefinition) => ({
  id: def.id, name: def.name, family: def.family, description: def.description, formula: def.formula,
  sources: def.sources, unit: def.unit, aggregation: def.aggregation, temporal: def.temporal, filters: def.filters,
  requiredPermission: def.requiredPermission, selfScoped: def.selfScoped, breakdownBy: def.breakdownBy ?? null,
  freshnessSeconds: def.freshnessSeconds, incompleteness: def.incompleteness,
  availability: def.unavailable ? def.unavailable : { determination: "resolvable" as const, reason: null },
});

export const analyticsRouter = router({
  /** Every registered metric, its formula and sources, and whether this caller may read it. No values. */
  catalog: roleProcedure("analytics.catalog").query(({ ctx }) => ({
    registryVersion: METRIC_REGISTRY_VERSION,
    metrics: METRICS.map(def => ({ ...definitionView(def), permitted: authorize({ userId: ctx.user.id, roles: ctx.roles, permission: def.requiredPermission }).allowed })),
  })),

  /** One metric's value in the caller's organization. */
  metric: roleProcedure("analytics.metric").input(metricInput).query(async ({ ctx, input }) => {
    const def = metricOrThrow(input.metricId);
    assertMayRead(def, ctx.user.id, ctx.roles);
    const now = new Date();
    const range = rangeOrThrow(input.range, now);
    const db = await dbOrThrow();
    const scope = await scopeOf(db, ctx.user.id);
    await assertFiltersInScope(def, input.filters, scope);
    return (await evaluate(db, def, scope, range, input.filters, now, false)).evaluation;
  }),

  /** The rows behind a metric. Same resolver, same scope, same range, same filters as `metric`. */
  drilldown: roleProcedure("analytics.drilldown").input(metricInput).query(async ({ ctx, input }) => {
    const def = metricOrThrow(input.metricId);
    assertMayRead(def, ctx.user.id, ctx.roles);
    const now = new Date();
    const range = rangeOrThrow(input.range, now);
    const db = await dbOrThrow();
    const scope = await scopeOf(db, ctx.user.id);
    await assertFiltersInScope(def, input.filters, scope);
    const { evaluation, rows, truncated } = await evaluate(db, def, scope, range, input.filters, now, false);
    return { ...evaluation, rows, truncated };
  }),

  /**
   * The caller's own numbers. Self-scoped in code: the operator is resolved from `ctx.user.id`,
   * nothing in the input can name another one, and only metrics marked `selfScoped` are offered.
   * Organization scope still applies on top, so an own record owned by another organization is
   * not read through this door either.
   */
  mine: roleProcedure("analytics.mine").input(mineInput).query(async ({ ctx, input }) => {
    const now = new Date();
    const range = rangeOrThrow(input.range, now);
    const wanted = input.metricIds ?? METRICS.filter(m => m.selfScoped).map(m => m.id);
    const defs = wanted.map(metricOrThrow);
    const notSelf = defs.find(d => !d.selfScoped);
    if (notSelf) throw new TRPCError({ code: "BAD_REQUEST", message: `Metric ${notSelf.id} is not available as your own` });
    const db = await dbOrThrow();
    const scope = await scopeOf(db, ctx.user.id);
    const own = await ownOperator(db, ctx.user.id, scope);
    if ("reason" in own) {
      return { operatorId: null, reason: own.reason, metrics: [] };
    }
    const metrics = [];
    for (const def of defs) metrics.push((await evaluate(db, def, scope, range, { operatorId: own.operatorId }, now, true)).evaluation);
    return { operatorId: own.operatorId, reason: null, metrics };
  }),

  /** The rows behind one of the caller's own metrics. */
  mineDrilldown: roleProcedure("analytics.mineDrilldown").input(mineDrillInput).query(async ({ ctx, input }) => {
    const def = metricOrThrow(input.metricId);
    if (!def.selfScoped) throw new TRPCError({ code: "BAD_REQUEST", message: `Metric ${def.id} is not available as your own` });
    const now = new Date();
    const range = rangeOrThrow(input.range, now);
    const db = await dbOrThrow();
    const scope = await scopeOf(db, ctx.user.id);
    const own = await ownOperator(db, ctx.user.id, scope);
    if ("reason" in own) throw new TRPCError({ code: "NOT_FOUND", message: own.reason });
    const { evaluation, rows, truncated } = await evaluate(db, def, scope, range, { operatorId: own.operatorId }, now, true);
    return { ...evaluation, rows, truncated };
  }),
});
