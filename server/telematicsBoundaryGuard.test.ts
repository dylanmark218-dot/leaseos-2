/**
 * P0-A2 — the unsafe form is unavailable, not merely unused.
 *
 * The tenant-isolation repair for telematics is one boundary (server/telematicsScope.ts) that
 * turns a caller-supplied unit id, fault id, event reference, trip id or zone-event id into a record
 * the caller's organization owns, or refuses. The regression this guards against is the easy one: a
 * future procedure selecting from `telemetrySnapshots`, `faultCodes` or `drivingEvents` by an id
 * from the input, because the tables were right there.
 *
 * So the check is structural, from the syntax tree, and narrow on purpose:
 *
 *   1. server/telematicsRouter.ts imports NONE of the telemetry tables (`telemetrySnapshots`,
 *      `faultCodes`, `drivingEvents`), nor `units`, `trips` or `workOrders`, from any module. With
 *      no binding for those tables, the unscoped select cannot be written in that file at all.
 *   2. server/telematicsRouter.ts imports the boundary, and the functions its procedures need are
 *      among what it imports.
 *   3. server/db.ts no longer exports `listZoneEvents` (every organization's proposals when no trip
 *      was named) or `zoneEventTripId` (the unscoped parent lookup the old guard rested on).
 *   4. The `gps` block of server/routers.ts (from its `gps: router({` to the next sibling router)
 *      names the boundary and none of the retired helpers. A bounded text check on a delimited
 *      region, not a repository-wide pattern.
 *   5. server/routers.ts no longer declares the unscoped `operatorForUser` / `activeTripForOperator`.
 *
 * None of this is a substitute for server/tenantScopeTelematics.db.test.ts, which proves the
 * behaviour through the real router against a database. This pins the shape that makes that
 * behaviour hard to lose.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as db from "./db";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Named imports per module specifier, from the syntax tree — comments and strings do not count. */
function namedImports(source: string, file: string): Map<string, Set<string>> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Set<string>>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = st.moduleSpecifier.text;
    const names = out.get(mod) ?? new Set<string>();
    const clause = st.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.add((el.propertyName ?? el.name).text);
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add("*");
    out.set(mod, names);
  }
  return out;
}

/** Top-level function declarations, from the syntax tree. */
function declaredFunctions(source: string, file: string): Set<string> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name) out.add(st.name.text);
  return out;
}

const TELEMETRY_TABLES = ["telemetrySnapshots", "faultCodes", "drivingEvents", "units", "trips", "workOrders", "tripBreadcrumbs", "zoneEvents"];

describe("the telematics router reaches telemetry rows only through the boundary", () => {
  const imports = namedImports(read("server/telematicsRouter.ts"), "telematicsRouter.ts");

  it("has no binding for the telemetry, unit, trip or work-order tables, from any module", () => {
    const offending: string[] = [];
    for (const [mod, names] of imports) {
      for (const n of TELEMETRY_TABLES) if (names.has(n)) offending.push(`${n} from ${mod}`);
      if (names.has("*") && /drizzle\/schema$/.test(mod)) offending.push(`namespace import of ${mod}`);
    }
    expect(offending).toEqual([]);
  });

  it("imports the boundary, including the scope resolver, the unit view, the lists and the by-id resolvers", () => {
    const boundary = imports.get("./telematicsScope");
    expect(boundary, "telematicsRouter.ts must import from ./telematicsScope").toBeDefined();
    expect([...boundary!]).toEqual(expect.arrayContaining([
      "telematicsScopeFor", "unitTelemetryInScope", "listFaultsInScope", "requireFaultInScope",
      "unreviewedDrivingEventsInScope", "requireDrivingEventInScope", "updateFaultInScope", "updateDrivingEventInScope",
    ]));
  });
});

describe("the unscoped zone-event helpers are gone", () => {
  it("db.ts exports neither listZoneEvents nor zoneEventTripId", () => {
    expect("listZoneEvents" in db).toBe(false);
    expect("zoneEventTripId" in db).toBe(false);
  });

  it("routers.ts declares neither operatorForUser nor activeTripForOperator", () => {
    const fns = declaredFunctions(read("server/routers.ts"), "routers.ts");
    expect(fns.has("operatorForUser")).toBe(false);
    expect(fns.has("activeTripForOperator")).toBe(false);
  });

  it("the gps router block calls the boundary and none of the retired helpers", () => {
    const src = read("server/routers.ts");
    const marker = "gps: router({";
    const start = src.indexOf(marker);
    expect(start, "routers.ts must still mount gps").toBeGreaterThan(0);
    const end = src.indexOf(": router({", start + marker.length);
    const block = src.slice(start, end > 0 ? end : undefined);
    for (const required of ["telematicsScopeFor(", "selfOperatorInTelematicsScope(", "activeTripForOperatorInScope(", "tripBreadcrumbsInScope(", "listZoneEventsInScope(", "requireZoneEventInScope("]) {
      expect(block, `gps block must call ${required}`).toContain(required);
    }
    for (const retired of ["listZoneEvents(", "zoneEventTripId(", "operatorForUser(", "activeTripForOperator(", "listTripBreadcrumbs(", "tripInScope("]) {
      expect(block, `gps block must not call ${retired}`).not.toContain(retired);
    }
    // The non-strict legacy resolver (`scopeFor(`, not `telematicsScopeFor(`) is not used here.
    expect(block).not.toMatch(/(^|[^A-Za-z])scopeFor\(/);
  });
});
