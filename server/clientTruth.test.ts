/**
 * v22.5.1 — Client truth.
 *
 * Demonstration identifiers and trust labels may exist only in the showcase
 * tree, whose surfaces cannot write production data: the tRPC link refuses
 * every mutation while a showcase page is mounted. Production client code
 * outside that tree must carry none of them, and the four production paths
 * that once landed on a demo page must not.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { isShowcaseMode, refusesShowcaseWrite, setShowcaseMode } from "../client/src/lib/showcaseGuard";

const DEMO = /JOB-08421|TR-2026-000812|unitId: 247|jobId: 1\b|operatorId: 1\b|53\.557|-113\.286|Imported \+ driver verified|Industrial road graph|Evidence marked as verified/;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

describe("the showcase link", () => {
  it("refuses a mutation while a showcase page is mounted, passes queries, and refuses nothing otherwise", () => {
    setShowcaseMode(true);
    expect(isShowcaseMode()).toBe(true);
    expect(refusesShowcaseWrite({ type: "mutation" })).toContain("does not write to production");
    expect(refusesShowcaseWrite({ type: "query" })).toBeNull();
    setShowcaseMode(false);
    expect(refusesShowcaseWrite({ type: "mutation" })).toBeNull();
  });
  it("is the first link in the client's chain", () => {
    const main = readFileSync("client/src/main.tsx", "utf8");
    expect(main.indexOf("showcaseGuardLink()")).toBeGreaterThan(0);
    expect(main.indexOf("showcaseGuardLink()")).toBeLessThan(main.indexOf("httpBatchLink({"));
  });
});

describe("demonstration data is quarantined", () => {
  it("appears in no production client file outside the showcase tree", () => {
    const offenders = walk("client/src").filter(f => !f.startsWith("client/src/showcase/")).filter(f => DEMO.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("mounts every showcase page inside ShowcaseFrame, and only under /showcase", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    for (const page of ["Home", "RouteSafetyWorkspace", "LocationWorkspace", "TripOperationsWorkspace", "FleetWorkspace", "BillingSafetyWorkspace", "ComplianceEngine", "OfflineVault"]) {
      const uses = app.match(new RegExp(`<${page} />`, "g")) ?? [];
      const framed = app.match(new RegExp(`<ShowcaseFrame[^>]*><${page} /></ShowcaseFrame>`, "g")) ?? [];
      expect(framed.length, `${page} must render only inside ShowcaseFrame`).toBe(uses.length);
      expect(app).toMatch(new RegExp(`path="/showcase[^"]*" component=\\{\\(\\) => <ShowcaseFrame[^>]*><${page} />`));
    }
    for (const page of ["Home", "RouteSafetyWorkspace", "LocationWorkspace", "TripOperationsWorkspace", "FleetWorkspace", "BillingSafetyWorkspace", "ComplianceEngine", "OfflineVault"]) expect(app).not.toMatch(new RegExp(`<DashboardRoute>\\s*<${page} />`));
  });
  it("routes /map, /jobs, /evidence and /safety to authoritative surfaces, and / to the portal", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    expect(app).toMatch(/path="\/map" component=\{\(\) => <MapSurface \/>\}/);
    expect(app).toMatch(/path="\/jobs" component=\{\(\) => <JobsSurface \/>\}/);
    expect(app).toMatch(/path="\/evidence" component=\{\(\) => <EvidenceSurface \/>\}/);
    expect(app).toMatch(/path="\/safety" component=\{\(\) => <SafetySurface \/>\}/);
    expect(app).toMatch(/path="\/" component=\{\(\) => <PortalShell \/>\}/);
    const surfaces = readFileSync("client/src/pages/authoritative/Surfaces.tsx", "utf8");
    expect(surfaces).toContain("spatial.routingSourceStatus");
    expect(DEMO.test(surfaces)).toBe(false);
  });
  it("sends no trust-bearing value from any showcase page to a refused field", () => {
    const refusedFields = ["verificationStatus:", "classificationStatus:", "inspectionStatus:", "maintenanceStatus:", "documentHash:", "authMethod:", "accessRole:", 'status: "verified"', 'status: "authenticated"', 'status: "resolved"'];
    for (const f of walk("client/src/showcase")) {
      const src = readFileSync(f, "utf8");
      // A review, verify or decide mutation is the transition service itself; a create or capture is what may not carry the state.
      const mutationCalls = (src.match(/[a-zA-Z]+\.mutate(?:Async)?\(\{[\s\S]*?\}\)/g) ?? []).filter(c => !/^(review|verify|decide|approve|acknowledge)[a-zA-Z]*\.mutate/.test(c));
      for (const call of mutationCalls) for (const field of refusedFields) expect(call, `${f} sends ${field}`).not.toContain(field);
    }
  });
});

describe("the first-run setup wizard", () => {
  it("is a real surface in the authoritative shell, for office portals, calling only real procedures", async () => {
    const shell = readFileSync("client/src/portal/PortalShell.tsx", "utf8");
    expect(shell).toContain('{panel === "setup" && OFFICE_PORTALS.has(portal) && <SetupPanel />}');
    const panel = readFileSync("client/src/portal/panels/SetupPanel.tsx", "utf8");
    const calls = [...panel.matchAll(/trpc\.([a-zA-Z]+)\.([a-zA-Z]+)\.use(?:Query|Mutation)/g)].map(m => `${m[1]}.${m[2]}`);
    expect(calls.sort()).toEqual(["commercialSetup.definitionApprove", "commercialSetup.definitionList", "commercialSetup.definitionPropose", "commercialSetup.goLiveReadiness", "commercialSetup.profileGet", "commercialSetup.profileSet", "finance.entitiesList", "finance.entityCreate"]);
    expect(DEMO.test(panel)).toBe(false);
    const { stepStates, nextStep, dollarsToMillis, percentToBps } = await import("../client/src/portal/setupModel");
    const projection = { percent: 63, ready: false, missing: ["2 sell proposal(s) awaiting approval", "1 vendor(s) without a payable rate", "3 unit(s) without an internal cost"], checks: [
      { key: "services", ok: true, detail: "2 service(s) declared" }, { key: "sell_rates", ok: true, detail: "4 approved sell definition(s)" }, { key: "proposals_pending", ok: false, detail: "2 sell proposal(s) awaiting approval" },
      { key: "customer_rates", ok: true, detail: "Every customer has a rate" }, { key: "vendor_rates", ok: false, detail: "1 vendor(s) without a payable rate" }, { key: "unit_cost", ok: false, detail: "3 unit(s) without an internal cost" },
      { key: "guardrails", ok: true, detail: "Margin guardrails set" }, { key: "terms", ok: true, detail: "1 approved contract terms" } ] };
    const steps = stepStates(projection, true);
    expect(steps.map(s => `${s.key}:${s.status}`)).toEqual(["company:done", "services:done", "rates:pending", "customers:done", "vendors:missing", "units:missing", "guardrails:done", "terms:done", "readiness:missing"]);
    expect(nextStep(steps)).toBe("rates");                                                       // a proposal awaiting approval is where the wizard opens
    expect(stepStates(null, false).map(s => s.status)).toEqual(["missing", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);   // nothing claimed without a projection
    expect(dollarsToMillis("325.00")).toBe(325_000);
    expect(dollarsToMillis("1.459")).toBe(1_459);
    expect(dollarsToMillis("abc")).toBeNull();
    expect(percentToBps("30")).toBe(3_000);
    expect(percentToBps("120")).toBeNull();
  });
});

/**
 * P5.1 — a showcase panel says where its content came from. Every showcase page carries the
 * per-panel statement, and the count of panels that carry it is pinned, so a new panel cannot
 * quietly show invented rows with no badge. The reason strings themselves are checked by
 * `client/src/showcase/panelSource.dom.test.tsx`; this only holds the coverage.
 */
describe("showcase panels declare their source", () => {
  const PINNED: Record<string, number> = {
    "RouteSafetyWorkspace.tsx": 4,
    "LocationWorkspace.tsx": 3,
    "OfflineVault.tsx": 3,
    "ComplianceEngine.tsx": 3,
    "BillingSafetyWorkspace.tsx": 3,
    "TripOperationsWorkspace.tsx": 3,
  };
  const pages = readdirSync("client/src/showcase").filter(f => f.endsWith(".tsx") && !/^(ShowcaseFrame|SourcedPanel)\.tsx$/.test(f) && !f.endsWith(".test.tsx"));

  it("carries the statement on every page that has been converted, at the pinned count", () => {
    for (const [file, count] of Object.entries(PINNED)) {
      const src = readFileSync(`client/src/showcase/${file}`, "utf8");
      expect(src.split("PanelSourceBadge source=").length - 1, file).toBe(count);
      expect(src, file).toContain('from "./panelSource"');
    }
  });

  it("names the pages not yet converted, so the gap is a number rather than a surprise", () => {
    const unconverted = pages.filter(f => !(f in PINNED) && !readFileSync(`client/src/showcase/${f}`, "utf8").includes("PanelSourceBadge"));
    // Home and FleetWorkspace are the two largest screens (2,150 and 1,578 lines); they are next.
    expect(unconverted.sort()).toEqual(["FleetWorkspace.tsx", "Home.tsx"]);
  });

  it("refuses a badge whose reason was left empty", () => {
    for (const f of pages) {
      const src = readFileSync(`client/src/showcase/${f}`, "utf8");
      expect(src.includes('demonstration("")') || src.includes("demonstration('')"), f).toBe(false);
    }
  });
});
