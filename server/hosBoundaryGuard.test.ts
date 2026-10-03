/**
 * P0-A1 — the unsafe form is unavailable, not merely unused.
 *
 * The tenant-isolation repair for hours of service is one boundary (server/hosScope.ts) that turns
 * a caller-supplied operator id into an operator the caller's organization owns, or refuses. The
 * regression this guards against is the easy one: a future procedure in the HOS router selecting
 * from `dutyRecords` or `operators` by an id from the input, because the tables were right there.
 *
 * So the check is structural, from the syntax tree, and narrow on purpose:
 *
 *   1. server/hosRouter.ts imports NEITHER `dutyRecords` NOR `operators` from the schema. With no
 *      binding for those tables, the unscoped select cannot be written in that file at all.
 *   2. server/hosRouter.ts imports the boundary, and the two functions the operator-keyed
 *      procedures need are among what it imports.
 *   3. server/db.ts no longer exports `listDutyRecords`, the unscoped list that returned every
 *      organization's records when no operator was named.
 *   4. The `dutyRecords` block of server/routers.ts (from its `dutyRecords: router({` to the next
 *      sibling router) names the boundary and none of the retired helpers. This one is a bounded
 *      text check on a delimited region, not a repository-wide pattern: it answers only "does
 *      this block call what it must and nothing it must not".
 *
 * None of this is a substitute for server/tenantScopeHos.db.test.ts, which proves the behaviour
 * through the real router against a database. This pins the shape that makes that behaviour hard
 * to lose.
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

describe("the HOS router reaches duty and operator rows only through the boundary", () => {
  const imports = namedImports(read("server/hosRouter.ts"), "hosRouter.ts");

  it("has no binding for the duty-record or operator tables, from any module", () => {
    const offending: string[] = [];
    for (const [mod, names] of imports) {
      for (const n of ["dutyRecords", "operators"]) if (names.has(n)) offending.push(`${n} from ${mod}`);
      if (names.has("*") && /drizzle\/schema$/.test(mod)) offending.push(`namespace import of ${mod}`);
    }
    expect(offending).toEqual([]);
  });

  it("imports the boundary, including the operator resolver and the scoped duty read", () => {
    const boundary = imports.get("./hosScope");
    expect(boundary, "hosRouter.ts must import from ./hosScope").toBeDefined();
    expect([...boundary!]).toEqual(expect.arrayContaining(["hosScopeFor", "requireHosOperatorInScope", "dutyEntriesInScope"]));
  });
});

describe("the unscoped duty-record list is gone", () => {
  it("db.ts exports no listDutyRecords", () => {
    expect("listDutyRecords" in db).toBe(false);
  });

  it("the dutyRecords router block calls the boundary and none of the retired helpers", () => {
    const src = read("server/routers.ts");
    const marker = "dutyRecords: router({";
    const start = src.indexOf(marker);
    expect(start, "routers.ts must still mount dutyRecords").toBeGreaterThan(0);
    const end = src.indexOf(": router({", start + marker.length);
    const block = src.slice(start, end > 0 ? end : undefined);
    expect(block).toContain("hosScopeFor(");
    expect(block).toContain("listDutyRecordsInScope(");
    expect(block).toContain("requireHosOperatorInScope(");
    expect(block).toContain("selfOperatorInScope(");
    for (const retired of ["listDutyRecords(", "operatorForUser(", "operatorInScope("]) expect(block).not.toContain(retired);
  });
});
