/**
 * v23.31 — rate line applicability: conditions beyond the scope columns.
 *
 * A charge definition names its scope (customer, contract, site, unit, job, branch) in columns
 * the resolver has always matched exactly. A rate line on a sheet may also be conditioned on
 * things that are not scope: the equipment class, the shift, the province, a quantity band, the
 * disposal facility, the material, a dangerous-goods class. Those are a JSON list of typed
 * conditions, and this module is the one place that evaluates them.
 *
 * Rules, all deterministic and all fail-closed:
 *   - Every condition on the line must hold. A line with no conditions holds trivially.
 *   - A condition whose attribute the context does not carry DOES NOT HOLD. "The context did
 *     not say what shift it was" is not "day shift"; the line simply does not apply, and the
 *     resolver's reasons say why.
 *   - A malformed condition list makes the line inapplicable and is reported, never ignored.
 *   - Specificity is the number of conditions, added to the scope specificity, so a line that
 *     names the shift beats one that does not — and two lines naming the same number of things
 *     at the same level are a CONFLICT, as the resolver has always ruled.
 */
import { CONDITION_KINDS, CONDITION_OPERATORS, type ConditionKind, type ConditionOperator } from "../../shared/commercialVocabulary";

export type RateCondition = { kind: ConditionKind; op: ConditionOperator; value: string | number | (string | number)[] };
/** What the job context knows about itself, keyed by condition kind. A missing key is "not known". */
export type ContextAttributes = Partial<Record<ConditionKind, string | number | null>>;

export type ParsedConditions = { ok: true; conditions: RateCondition[] } | { ok: false; error: string };

const isKind = (k: unknown): k is ConditionKind => typeof k === "string" && (CONDITION_KINDS as readonly string[]).includes(k);
const isOp = (o: unknown): o is ConditionOperator => typeof o === "string" && (CONDITION_OPERATORS as readonly string[]).includes(o);
const scalar = (v: unknown) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** Parse and validate a stored applicability list. Empty or null is "no conditions". */
export function parseConditions(json: string | null | undefined): ParsedConditions {
  if (json == null || json.trim() === "") return { ok: true, conditions: [] };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { ok: false, error: "applicability is not valid JSON" }; }
  if (!Array.isArray(raw)) return { ok: false, error: "applicability must be a list of conditions" };
  const out: RateCondition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c: unknown = raw[i];
    if (!c || typeof c !== "object") return { ok: false, error: `condition ${i} is not an object` };
    const { kind, op, value } = c as Record<string, unknown>;
    if (!isKind(kind)) return { ok: false, error: `condition ${i} names an unknown kind ${String(kind)}` };
    if (!isOp(op)) return { ok: false, error: `condition ${i} names an unknown operator ${String(op)}` };
    if (op === "in") { if (!Array.isArray(value) || value.length === 0 || !value.every(scalar)) return { ok: false, error: `condition ${i}: "in" needs a non-empty list` }; }
    else if (op === "between") { if (!Array.isArray(value) || value.length !== 2 || !value.every(v => typeof v === "number")) return { ok: false, error: `condition ${i}: "between" needs [low, high]` }; if ((value[0] as number) > (value[1] as number)) return { ok: false, error: `condition ${i}: "between" low exceeds high` }; }
    else if (op === "gte" || op === "lte") { if (typeof value !== "number") return { ok: false, error: `condition ${i}: "${op}" needs a number` }; }
    else if (!scalar(value)) return { ok: false, error: `condition ${i}: "eq" needs a string or number` };
    out.push({ kind, op, value: value as RateCondition["value"] });
  }
  return { ok: true, conditions: out };
}

const same = (a: string | number, b: string | number) => (typeof a === "number" || typeof b === "number") ? Number(a) === Number(b) : a.toLowerCase() === b.toLowerCase();

/** Does one condition hold for the context? An attribute the context lacks never holds. */
export function conditionHolds(c: RateCondition, attrs: ContextAttributes): { holds: boolean; why: string } {
  const v = attrs[c.kind];
  if (v == null) return { holds: false, why: `${c.kind} not known for this job` };
  switch (c.op) {
    case "eq": return same(v, c.value as string | number) ? { holds: true, why: `${c.kind} = ${String(v)}` } : { holds: false, why: `${c.kind} is ${String(v)}, line needs ${String(c.value)}` };
    case "in": { const ok = (c.value as (string | number)[]).some(x => same(v, x)); return ok ? { holds: true, why: `${c.kind} ∈ list` } : { holds: false, why: `${c.kind} is ${String(v)}, not in [${(c.value as unknown[]).join(", ")}]` }; }
    case "gte": return Number(v) >= (c.value as number) ? { holds: true, why: `${c.kind} ≥ ${c.value}` } : { holds: false, why: `${c.kind} ${String(v)} < ${c.value}` };
    case "lte": return Number(v) <= (c.value as number) ? { holds: true, why: `${c.kind} ≤ ${c.value}` } : { holds: false, why: `${c.kind} ${String(v)} > ${c.value}` };
    case "between": { const [lo, hi] = c.value as [number, number]; const n = Number(v); return n >= lo && n <= hi ? { holds: true, why: `${c.kind} in [${lo}, ${hi}]` } : { holds: false, why: `${c.kind} ${String(v)} outside [${lo}, ${hi}]` }; }
  }
}

export type Applicability = { applies: boolean; specificity: number; reasons: string[] };

/** All conditions must hold. Specificity is the count of conditions on a well-formed, applicable line. */
export function evaluateApplicability(json: string | null | undefined, attrs: ContextAttributes): Applicability {
  const parsed = parseConditions(json);
  if (!parsed.ok) return { applies: false, specificity: 0, reasons: [`line set aside: ${parsed.error}`] };
  const reasons: string[] = [];
  let applies = true;
  for (const c of parsed.conditions) { const r = conditionHolds(c, attrs); reasons.push(r.why); if (!r.holds) applies = false; }
  return { applies, specificity: parsed.conditions.length, reasons };
}
