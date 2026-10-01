/**
 * P0-A2.1 — the unsafe form is unavailable, not merely unused.
 *
 * The regression this guards against: the geofence engine going back to "every active zone for
 * every trip", or the zone list and create going back to "every organization's". The check is
 * structural, from the syntax tree, and narrow on purpose:
 *
 *   1. server/db.ts exports none of `listOperatingZones`, `createOperatingZone`,
 *      `listActiveOperatingZones`. The engine cannot ask for all active zones because no function
 *      answers that.
 *   2. server/_core/tripGps.ts holds no binding for the `operatingZones` table and imports
 *      `activeOperatingZonesForTrip` from the boundary — the only way it can obtain zones.
 *   3. `activeOperatingZonesForTrip` takes exactly one parameter, the trip id: there is no
 *      parameter through which a caller, a request or a session could name the organization. The
 *      organization is the trip's (trips.orgRef), read inside the boundary.
 *   4. The `operatingZones` block of server/routers.ts names the boundary and none of the retired
 *      helpers, and its create schema refuses an `orgRef` field (a bounded text check on a
 *      delimited region).
 *
 * server/tenantScopeOperatingZones.db.test.ts proves the behaviour through the real router and
 * the real engine against a database. This pins the shape that makes that behaviour hard to lose.
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

/** Parameter names of a top-level exported function, from the syntax tree. */
function parameterNames(source: string, file: string, fn: string): string[] | null {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === fn) return st.parameters.map(p => p.name.getText(sf));
  }
  return null;
}

describe("the unscoped operating-zone helpers are gone", () => {
  it("db.ts exports none of listOperatingZones, createOperatingZone, listActiveOperatingZones", () => {
    for (const retired of ["listOperatingZones", "createOperatingZone", "listActiveOperatingZones"]) {
      expect(retired in db, `db.ts must not export ${retired}`).toBe(false);
    }
  });
});

describe("the geofence engine obtains zones only through the boundary, and only by trip", () => {
  const imports = namedImports(read("server/_core/tripGps.ts"), "tripGps.ts");

  it("holds no binding for the operatingZones table and none of the retired helpers, from any module", () => {
    const offending: string[] = [];
    for (const [mod, names] of imports) {
      for (const n of ["operatingZones", "listOperatingZones", "listActiveOperatingZones", "createOperatingZone"]) if (names.has(n)) offending.push(`${n} from ${mod}`);
      if (names.has("*") && /drizzle\/schema$/.test(mod)) offending.push(`namespace import of ${mod}`);
    }
    expect(offending).toEqual([]);
  });

  it("imports activeOperatingZonesForTrip from the boundary", () => {
    const boundary = imports.get("../operatingZoneScope");
    expect(boundary, "tripGps.ts must import from ../operatingZoneScope").toBeDefined();
    expect([...boundary!]).toContain("activeOperatingZonesForTrip");
  });

  it("activeOperatingZonesForTrip takes the trip id and nothing else — no organization, scope, user or request parameter", () => {
    expect(parameterNames(read("server/operatingZoneScope.ts"), "operatingZoneScope.ts", "activeOperatingZonesForTrip")).toEqual(["tripId"]);
  });
});

describe("the operatingZones router block calls the boundary and none of the retired helpers", () => {
  it("lists and creates through the boundary and refuses an orgRef in the input", () => {
    const src = read("server/routers.ts");
    const marker = "operatingZones: router({";
    const start = src.indexOf(marker);
    expect(start, "routers.ts must still mount operatingZones").toBeGreaterThan(0);
    const end = src.indexOf(": router({", start + marker.length);
    const block = src.slice(start, end > 0 ? end : undefined);
    for (const required of ["operatingZoneScopeFor(", "listOperatingZonesInScope(", "createOperatingZoneInScope(", "orgRef: REFUSED"]) {
      expect(block, `operatingZones block must contain ${required}`).toContain(required);
    }
    for (const retired of ["listOperatingZones(", "createOperatingZone(", "listActiveOperatingZones("]) {
      expect(block, `operatingZones block must not call ${retired}`).not.toContain(retired);
    }
    // The non-strict legacy resolver (`scopeFor(`, not `operatingZoneScopeFor(`) is not used here.
    expect(block).not.toMatch(/(^|[^A-Za-z])scopeFor\(/);
  });
});
