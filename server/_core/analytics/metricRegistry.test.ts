/**
 * The registry is the one place a metric is defined. These hold it to what it claims.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_LABELS } from "../hosClockPresentation";
import { authorize, type DomainRole } from "../recordsAuthorization";
import { METRICS, METRIC_REGISTRY_VERSION, metricById } from "./metricRegistry";
import { RESOLVERS, blockerCodes } from "./metricSources";

const ROLES: DomainRole[] = ["driver", "dispatcher", "mechanic", "shop_lead", "safety", "office", "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant"];
const holds = (role: DomainRole, permission: string) => authorize({ userId: 1, roles: [role], permission: permission as never }).allowed;

/**
 * Every table a resolver may read, with the scope rule `metricSources.ts` applies to it. A metric
 * naming a table outside this list has no rule to be scoped by, and is refused here before it can
 * be refused in production by accident.
 */
const SCOPED_SOURCES: Record<string, string> = {
  trips: "orgScopeWhere", jobs: "orgScopeWhere", dispatchEligibilityChecks: "orgScopeWhere",
  units: "ownershipScopeWhere(unit)", inspections: "ownershipScopeWhere(unit)", maintenanceDefects: "ownershipScopeWhere(unit)", workOrders: "ownershipScopeWhere(unit)",
  operators: "ownershipScopeWhere(operator)", dutyRecords: "ownershipScopeWhere(operator)",
  complianceDocuments: "complianceDocumentScopeWhere",
  incidentReports: "jobUnitOperatorScopeWhere", nearMissReports: "jobUnitOperatorScopeWhere",
};

describe("every metric is defined, once, completely", () => {
  it("has unique, namespaced ids", () => {
    const ids = METRICS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    expect(metricById("ops.trips.in_progress")?.name).toBe("Trips in progress");
    expect(metricById("nope")).toBeNull();
  });

  it("states a formula, a description and an incompleteness rule for each", () => {
    for (const m of METRICS) {
      for (const text of [m.name, m.description, m.formula, m.incompleteness]) expect(text.trim().length, m.id).toBeGreaterThan(0);
      expect(m.freshnessSeconds, m.id).toBeGreaterThan(0);
    }
  });

  it("gives every resolvable metric a resolver and sources, and every unavailable one a reason and neither", () => {
    for (const m of METRICS) {
      if (m.unavailable) {
        expect(RESOLVERS[m.id], m.id).toBeUndefined();
        expect(m.sources, m.id).toEqual([]);
        expect(m.unavailable.reason.length, m.id).toBeGreaterThan(20);
      } else {
        expect(RESOLVERS[m.id], m.id).toBeTypeOf("function");
        expect(m.sources.length, m.id).toBeGreaterThan(0);
      }
    }
    for (const id of Object.keys(RESOLVERS)) expect(metricById(id), `resolver ${id} has no registered metric`).not.toBeNull();
  });

  it("reads only tables that have a scope rule", () => {
    for (const m of METRICS) for (const s of m.sources) expect(SCOPED_SOURCES[s], `${m.id} reads ${s}, which has no scope rule here`).toBeDefined();
  });

  it("offers a metric as the caller's own only when it can be filtered to one operator", () => {
    for (const m of METRICS.filter(x => x.selfScoped)) expect(m.filters, m.id).toContain("operatorId");
  });
});

describe("who can see what", () => {
  it("lets some role that holds analytics.read also hold each metric's source permission", () => {
    for (const m of METRICS) {
      const readers = ROLES.filter(r => holds(r, "analytics.read") && holds(r, m.requiredPermission));
      expect(readers.length, `nobody can read ${m.id}`).toBeGreaterThan(0);
    }
  });
  it("keeps organization metrics from drivers, even where a driver holds the source read", () => {
    expect(holds("driver", "analytics.read")).toBe(false);
    expect(holds("driver", "trip.read")).toBe(true);
    for (const r of ROLES) expect(holds(r, "analytics.read_own"), r).toBe(true);
  });
});

describe("what a metric may say", () => {
  it("uses no hours-of-service label the HOS presentation forbids", () => {
    for (const m of METRICS.filter(x => x.family === "hours_of_service")) {
      for (const text of [m.name, m.description, m.unavailable?.reason ?? ""]) {
        for (const f of FORBIDDEN_LABELS) expect(text.toLowerCase(), `${m.id}: "${f}"`).not.toContain(f);
      }
    }
  });
  it("is never a score, a rank or a percentage", () => {
    for (const m of METRICS) expect(`${m.id} ${m.name}`.toLowerCase(), m.id).not.toMatch(/score|rank|percent|leaderboard/);
  });
  it("sums nothing per driver out of telematics driving events", () => {
    for (const m of METRICS) expect(m.sources, m.id).not.toContain("drivingEvents");
  });
});

describe("the version moves with the formulas", () => {
  it("pins the registry version to what the formulas say", () => {
    const meaning = METRICS.map(m => [m.id, m.formula, m.aggregation, m.temporal, m.sources, m.unit, m.unavailable ?? null]);
    const hash = createHash("sha256").update(JSON.stringify(meaning)).digest("hex").slice(0, 16);
    // Changing a formula changes this hash. Change METRIC_REGISTRY_VERSION with it, then this pin.
    expect({ version: METRIC_REGISTRY_VERSION, hash }).toEqual({ version: "b.1", hash: "d773fe3d2166930b" });
  });
});

describe("stored readiness blockers", () => {
  it("reads the codes a dispatch check stored, and nothing from text that is not the array it should be", () => {
    expect(blockerCodes(JSON.stringify([{ code: "critical_defect", severity: "blocking" }, { code: "hos_unknown" }, { nope: 1 }]))).toBe("critical_defect, hos_unknown");
    expect(blockerCodes(null)).toBeNull();
    expect(blockerCodes("{not json")).toBeNull();
    expect(blockerCodes(JSON.stringify({ code: "x" }))).toBeNull();
  });
});
