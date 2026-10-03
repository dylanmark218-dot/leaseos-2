/**
 * A person's operator record has one resolver: `operatorForUserInScope` (server/db.ts), which filters
 * `operators.userId` by the acting organization's ownership and refuses two rows. Every other
 * lookup by `operators.userId` on main @ b35bac4 was `.limit(1)` with no organization filter
 * (docs/register/OPERATOR_IDENTITY_SCOPE_HARDENING.md, OPID-1..6), and a seventh arrived with the
 * marketplace award (OPID-7). This keeps the next one from arriving: no production file under
 * server/ FILTERS operators by `userId` except the resolver and one named, organization-scoped batch.
 *
 * Reading `operators.userId` as a column (operator id → its person) is not a lookup of a person's
 * record and is not restricted here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "server";
/** Comments blanked with their newlines kept, so a doc comment that names the column is not a read and line numbers stay true. */
const code = (body: string) => body
  .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, " "))
  .replace(/^\s*\/\/.*$/gm, "");
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : productionFiles(join(dir, e.name)))
      : /\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) ? [join(dir, e.name)] : []);
}
/** A filter on the person link: `eq(operators.userId, …)`, `inArray(operators.userId, …)` and the like. */
const FILTER = /\b(eq|inArray|or|and|isNull|isNotNull)\(\s*operators\.userId\b/;

/**
 * The only places allowed to filter by it, and what each must carry on the same line.
 * boardIdentity: display names for a page of authors, one batched read, scoped to the organization.
 */
const ALLOWED: Record<string, RegExp> = {
  "server/db.ts": /ownershipScopeWhere\("operator", operators\.id, scope\)\)\)\.limit\(2\)/,
  "server/boardIdentity.ts": /ownershipScopeWhere\("operator", operators\.id, scope\)/,
};

describe("a person's operator record is looked up in one place", () => {
  it("only operatorForUserInScope (and one scoped display batch) filters operators by userId", () => {
    const sites = productionFiles(ROOT).flatMap(file =>
      code(readFileSync(file, "utf8")).split("\n").flatMap((line, i) => FILTER.test(line) ? [{ file, line: i + 1, text: line }] : []));
    const unexpected = sites.filter(s => !ALLOWED[s.file]).map(s => `${s.file}:${s.line}`);
    expect(unexpected).toEqual([]);
    for (const s of sites) expect(s.text, `${s.file}:${s.line} must stay organization-scoped`).toMatch(ALLOWED[s.file]!);
    expect(sites.map(s => s.file).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("the resolver refuses a second row rather than choosing one", () => {
    const db = code(readFileSync(join(ROOT, "db.ts"), "utf8"));
    const start = db.indexOf("export async function operatorForUserInScope");
    const body = db.slice(start, db.indexOf("\n}\n", start));
    expect(body).toMatch(/rows\.length > 1\) return \{ kind: "ambiguous" \}/);
  });
});
