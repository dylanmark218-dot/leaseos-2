/**
 * A person's operator record has one reader: `operatorForUserInScope` (server/db.ts), which filters
 * `operators.userId` by the acting organization's ownership and refuses two rows. Every other
 * `operators.userId` read on main @ b35bac4 was `.limit(1)` with no organization filter
 * (docs/register/OPERATOR_IDENTITY_SCOPE_HARDENING.md, OPID-1..6). This keeps a seventh from
 * arriving: outside that resolver, no production file under server/ reads `operators.userId`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "server";
/** Comments stripped, so a doc comment that names the column is not a read of it. */
const code = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : productionFiles(join(dir, e.name)))
      : /\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) ? [join(dir, e.name)] : []);
}

describe("a person's operator record is read in one place", () => {
  it("only operatorForUserInScope reads operators.userId", () => {
    const sites = productionFiles(ROOT).flatMap(file =>
      code(readFileSync(file, "utf8")).split("\n").flatMap((line, i) => /operators\.userId\b/.test(line) ? [`${file}:${i + 1}`] : []));
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/^server\/db\.ts:/);
    const db = code(readFileSync(join(ROOT, "db.ts"), "utf8"));
    const resolver = db.slice(db.indexOf("export async function operatorForUserInScope"));
    expect(resolver.slice(0, resolver.indexOf("\n}\n"))).toMatch(/operators\.userId[\s\S]*ownershipScopeWhere\("operator"[\s\S]*\.limit\(2\)/);
  });
});
