/**
 * v23.31 — conditioned rate lines: the conditions engine, and the resolver reading it.
 */
import { describe, expect, it } from "vitest";
import { conditionHolds, evaluateApplicability, parseConditions } from "./_core/rateApplicability";
import { resolveRate, scopeApplies, specificity, type ChargeDefinition } from "./_core/rateResolution";

const def = (o: Partial<ChargeDefinition> & { id: number }): ChargeDefinition => ({
  definitionRef: `CHG-${o.id}`, rateKind: "sell", serviceCode: "hydrovac_hour", resourceClass: null, unitId: null, pricingMethod: "per_unit", unit: "hour", rateMillis: 185_000, flatCents: null, basisPoints: null, multiplierMillis: null,
  minimumQuantityMillis: null, minimumChargeCents: null, billingIncrementMillis: null, roundingMode: "nearest", measurementBasis: "any", conditionKey: null,
  scopeLevel: "customer_rate_card", customerAccountId: 7, vendorId: null, projectRef: null, siteRef: null, contractRef: null, jobId: null, branchCode: null,
  effectiveFrom: new Date("2026-01-01"), effectiveTo: null, approvalStatus: "approved", version: 1, sourceClause: null, sourceKind: "human", applicabilityJson: null, rateSheetVersionId: null, lineKind: "hourly_equipment", ...o,
});
const at = new Date("2026-06-15");

describe("parsing conditions", () => {
  it("accepts a well-formed list and rejects everything else by name", () => {
    expect(parseConditions(null)).toEqual({ ok: true, conditions: [] });
    expect(parseConditions(JSON.stringify([{ kind: "shift", op: "eq", value: "night" }, { kind: "quantity", op: "between", value: [4, 8] }, { kind: "province", op: "in", value: ["AB", "BC"] }]))).toMatchObject({ ok: true });
    expect(parseConditions("nope")).toMatchObject({ ok: false, error: expect.stringMatching(/valid JSON/) });
    expect(parseConditions(JSON.stringify({ kind: "shift" }))).toMatchObject({ ok: false, error: expect.stringMatching(/list/) });
    expect(parseConditions(JSON.stringify([{ kind: "colour", op: "eq", value: "x" }]))).toMatchObject({ ok: false, error: expect.stringMatching(/unknown kind colour/) });
    expect(parseConditions(JSON.stringify([{ kind: "shift", op: "like", value: "x" }]))).toMatchObject({ ok: false, error: expect.stringMatching(/unknown operator/) });
    expect(parseConditions(JSON.stringify([{ kind: "quantity", op: "between", value: [8, 4] }]))).toMatchObject({ ok: false, error: expect.stringMatching(/low exceeds high/) });
    expect(parseConditions(JSON.stringify([{ kind: "quantity", op: "gte", value: "4" }]))).toMatchObject({ ok: false, error: expect.stringMatching(/needs a number/) });
    expect(parseConditions(JSON.stringify([{ kind: "province", op: "in", value: [] }]))).toMatchObject({ ok: false });
  });
  it("an attribute the context does not carry never holds — 'not known' is not 'day shift'", () => {
    expect(conditionHolds({ kind: "shift", op: "eq", value: "day" }, {})).toMatchObject({ holds: false, why: "shift not known for this job" });
    expect(conditionHolds({ kind: "shift", op: "eq", value: "Day" }, { shift: "day" }).holds).toBe(true);
    expect(conditionHolds({ kind: "province", op: "in", value: ["AB", "BC"] }, { province: "SK" }).holds).toBe(false);
    expect(conditionHolds({ kind: "distance_km", op: "gte", value: 100 }, { distance_km: 120 }).holds).toBe(true);
    expect(conditionHolds({ kind: "quantity", op: "between", value: [4, 8] }, { quantity: 9 }).holds).toBe(false);
    expect(conditionHolds({ kind: "quantity", op: "lte", value: 8 }, { quantity: 8 }).holds).toBe(true);
  });
  it("every condition must hold; specificity is the count; a malformed list applies to nothing", () => {
    const json = JSON.stringify([{ kind: "shift", op: "eq", value: "night" }, { kind: "province", op: "eq", value: "AB" }]);
    expect(evaluateApplicability(json, { shift: "night", province: "AB" })).toMatchObject({ applies: true, specificity: 2 });
    expect(evaluateApplicability(json, { shift: "night", province: "BC" })).toMatchObject({ applies: false, specificity: 2 });
    expect(evaluateApplicability("[{", {})).toMatchObject({ applies: false, specificity: 0, reasons: [expect.stringMatching(/set aside/)] });
  });
});

describe("the resolver with conditioned lines", () => {
  const dayLine = def({ id: 1 });
  const nightLine = def({ id: 2, rateMillis: 215_000, applicabilityJson: JSON.stringify([{ kind: "shift", op: "eq", value: "night" }]) });
  it("the conditioned line wins on a night job, the plain line on a day job, and the plain line when the shift is not known", () => {
    const night = resolveRate([dayLine, nightLine], { rateKind: "sell", serviceCode: "hydrovac_hour", at, customerAccountId: 7, attributes: { shift: "night" } });
    expect(night.outcome).toBe("resolved"); if (night.outcome === "resolved") expect(night.definition.id).toBe(2);
    const day = resolveRate([dayLine, nightLine], { rateKind: "sell", serviceCode: "hydrovac_hour", at, customerAccountId: 7, attributes: { shift: "day" } });
    expect(day.outcome).toBe("resolved"); if (day.outcome === "resolved") expect(day.definition.id).toBe(1);
    const unknown = resolveRate([dayLine, nightLine], { rateKind: "sell", serviceCode: "hydrovac_hour", at, customerAccountId: 7 });
    expect(unknown.outcome).toBe("resolved"); if (unknown.outcome === "resolved") expect(unknown.definition.id).toBe(1);
    expect(unknown.reasons.join(" ")).toMatch(/CHG-2 set aside: shift not known for this job/);
  });
  it("two lines of equal specificity at one level are a CONFLICT, and specificity counts conditions", () => {
    const other = def({ id: 3, rateMillis: 199_000, applicabilityJson: JSON.stringify([{ kind: "province", op: "eq", value: "AB" }]) });
    expect(specificity(nightLine)).toBe(2); expect(specificity(dayLine)).toBe(1);
    const r = resolveRate([dayLine, nightLine, other], { rateKind: "sell", serviceCode: "hydrovac_hour", at, customerAccountId: 7, attributes: { shift: "night", province: "AB" } });
    expect(r.outcome).toBe("conflict"); if (r.outcome === "conflict") expect(r.candidates.map(c => c.id).sort()).toEqual([2, 3]);
  });
  it("a job pinned to a sheet version never sees a line from another version — the June rate after July's sheet", () => {
    const june = def({ id: 10, rateMillis: 185_000, rateSheetVersionId: 100, approvalStatus: "superseded", effectiveTo: new Date("2026-07-01") });
    const july = def({ id: 11, rateMillis: 215_000, rateSheetVersionId: 101, effectiveFrom: new Date("2026-07-01") });
    const company = def({ id: 12, rateMillis: 150_000, scopeLevel: "company", customerAccountId: null });
    const r = resolveRate([june, july, company], { rateKind: "sell", serviceCode: "hydrovac_hour", at: new Date("2026-06-20"), customerAccountId: 7, rateSheetVersionId: 100 });
    expect(r.outcome).toBe("resolved"); if (r.outcome === "resolved") expect(r.definition.rateMillis).toBe(185_000);
    expect(scopeApplies(july, { rateKind: "sell", serviceCode: "hydrovac_hour", at: new Date("2026-08-01"), customerAccountId: 7, rateSheetVersionId: 100 })).toBe(false);
    // The company default stays in play under a pin: precedence, not the pin, decides between them.
    const later = resolveRate([june, july, company], { rateKind: "sell", serviceCode: "hydrovac_hour", at: new Date("2026-08-01"), customerAccountId: 7, rateSheetVersionId: 100 });
    expect(later.outcome).toBe("resolved"); if (later.outcome === "resolved") expect(later.definition.id).toBe(12);
  });
  it("a contract-level line beats a customer-card line, and an expired one is named, not used", () => {
    const card = def({ id: 20, rateMillis: 200_000 });
    const contract = def({ id: 21, rateMillis: 185_000, scopeLevel: "customer_contract", contractRef: "CTR-1" });
    const r = resolveRate([card, contract], { rateKind: "sell", serviceCode: "hydrovac_hour", at, customerAccountId: 7, contractRef: "CTR-1" });
    expect(r.outcome).toBe("resolved"); if (r.outcome === "resolved") expect(r.definition.id).toBe(21);
    const expired = resolveRate([def({ id: 22, effectiveTo: new Date("2026-03-01") })], { rateKind: "sell", serviceCode: "hydrovac_hour", at, customerAccountId: 7 });
    expect(expired.outcome).toBe("unknown"); expect(expired.reasons.join(" ")).toMatch(/outside their effective window/);
  });
});
