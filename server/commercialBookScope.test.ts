/**
 * F4's classification, enforced against the migrations rather than a comment.
 *
 * The commercial office reads two kinds of table through `bookOrgRef`, and a
 * NULL means the opposite thing in each:
 *
 *   SEEDED CONFIGURATION — 0133 inserts rows with `bookOrgRef` NULL as the
 *   platform default. A business's own row wins; with no own row the default
 *   governs. Reads must see BOTH layers or a new organization has no role
 *   types, no document types and no approval tier.
 *
 *   BUSINESS DATA — nothing seeds it, so a NULL row is one company's own record
 *   whose ownership was never established. Reads must see ONE layer, because
 *   unknown ownership is not shared ownership.
 *
 * Both readings are one nullable column, so nothing at a call site distinguishes
 * them. That is exactly how a single `bookWhere` helper came to serve both and
 * let a member read the unowned pool as if it were shared (F4). The fix split
 * the helper; this test is what stops the split from silently rotting, because
 * the next person to add a `bookOrgRef` table will copy a nearby line.
 *
 * It derives the truth from the migrations — does any migration insert a
 * default-layer row for this table? — rather than from a hand-kept list, so a
 * table that GAINS or LOSES a seeded default is caught on the same run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTER = join(__dirname, "commercialOfficeRouter.ts");
const DRIZZLE = join(__dirname, "..", "drizzle");

/** Every table read through each helper, as the router actually calls them. */
function callSites(source: string, helper: string): Set<string> {
  const found = new Set<string>();
  const re = new RegExp(`${helper}\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*,`, "g");
  for (const m of source.matchAll(re)) found.add(m[1]!);
  return found;
}

/**
 * Split on commas that are not inside parentheses.
 *
 * Positional, because that is the only way to tell which expression is
 * `bookOrgRef`'s: a tuple's third value is the third column's, and a nested
 * `CONCAT(a, b)` must not count as two.
 */
function topLevelParts(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Remove comments and string literals, keeping one placeholder per literal.
 *
 * Done FIRST, because the seed data is full of prose that breaks naive SQL
 * scanning: `'QuickBooks Online (first export target; core is
 * accounting-neutral)'` carries both an unbalanced-looking paren and a
 * semicolon, and `'owner_decision_2026-09-17 (CLI-000123)'` carries more
 * parens. Reading positions out of the raw text put `commercialSettings` and
 * `commercialNumberingPolicies` in the wrong class — they ARE seeded — so the
 * literals go before anything is counted. The placeholder is a single token so
 * column positions are preserved exactly.
 */
function stripLiterals(sql: string): string {
  let out = "", quote: string | null = null, i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote) {
      if (ch === "\\") { i += 2; continue; }          // escaped char inside the literal
      if (ch === quote) { quote = null; out += "§"; } // one token for the whole literal
      i++; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    out += ch; i++;
  }
  return out;
}

/**
 * Does any migration insert a default-layer row for this table?
 *
 * "Default layer" means `bookOrgRef` NULL specifically — a migration that
 * backfilled OWNED rows does not make a table configuration, so a table seeded
 * with owned rows only is still correctly classified as business data.
 *
 * Both insert forms count, because 0133 uses both: `VALUES (NULL, …)` for the
 * flat seeds and `INSERT … SELECT NULL, …` for the approval tiers, which are a
 * cross join of categories and ladder rungs.
 */
function hasSeededDefaultLayer(table: string): boolean {
  for (const file of readdirSync(DRIZZLE).filter(f => f.endsWith(".sql"))) {
    const sql = stripLiterals(readFileSync(join(DRIZZLE, file), "utf8"));
    const re = new RegExp(`INSERT\\s+(?:IGNORE\\s+)?INTO\\s+\`?${table}\`?\\s*\\(([^)]*)\\)([\\s\\S]*?);`, "gi");
    for (const m of sql.matchAll(re)) {
      const at = m[1]!.split(",").map(c => c.trim().replace(/`/g, "")).indexOf("bookOrgRef");
      if (at === -1) continue;
      const body = m[2]!;
      const isNullAt = (expr: string | undefined) => expr?.trim().toUpperCase() === "NULL";

      const values = body.match(/^\s*VALUES([\s\S]*)$/i);
      if (values) {
        // Each row is a parenthesised tuple at depth 0 of the VALUES list.
        let depth = 0, cur = "";
        for (const ch of values[1]!) {
          if (ch === "(") { if (depth++ === 0) { cur = ""; continue; } }
          else if (ch === ")") { if (--depth === 0) { if (isNullAt(topLevelParts(cur)[at])) return true; continue; } }
          if (depth > 0) cur += ch;
        }
        continue;
      }
      const select = body.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i);
      if (select && isNullAt(topLevelParts(select[1]!)[at])) return true;
    }
  }
  return false;
}

describe("the commercial book's two readings of bookOrgRef", () => {
  const source = readFileSync(ROUTER, "utf8");
  const overlaid = callSites(source, "seededConfigLayer");
  const strict = callSites(source, "myBookOnly");

  it("reads both layers only where a default layer is actually seeded", () => {
    // A table read through the overlay with nothing seeding it is the F4 bug:
    // every unattributed row in it becomes visible to every member.
    const unseeded = [...overlaid].filter(t => !hasSeededDefaultLayer(t)).sort();
    expect(unseeded, `read through seededConfigLayer but no migration seeds a bookOrgRef IS NULL row: ${unseeded.join(", ")}. If these rows are business data, read them with myBookOnly — unknown ownership is not shared ownership.`).toEqual([]);
  });

  it("reads one layer wherever the NULL rows are somebody's data", () => {
    const seeded = [...strict].filter(t => hasSeededDefaultLayer(t)).sort();
    expect(seeded, `read through myBookOnly although a migration seeds a default-layer row: ${seeded.join(", ")}. Strict reads would hide that default from every business, which breaks the flow rather than securing it.`).toEqual([]);
  });

  it("classifies every bookOrgRef table the router reads, and never both ways", () => {
    // A table read through both helpers means two call sites disagree about
    // what its NULL rows are; one of them is wrong.
    const both = [...overlaid].filter(t => strict.has(t)).sort();
    expect(both, `read through both helpers: ${both.join(", ")}`).toEqual([]);
    // And the classification is not vacuous in either direction — if a refactor
    // emptied one set this suite would otherwise pass while proving nothing.
    expect(overlaid.size).toBeGreaterThan(0);
    expect(strict.size).toBeGreaterThan(0);
  });

  it("keeps the fail-open helper from coming back", () => {
    // `bookWhere` was the single helper that served both readings. A new one
    // under any name is fine; this one returning is a regression to F4.
    expect(/\bbookWhere\s*\(/.test(source.replace(/`bookWhere`/g, ""))).toBe(false);
  });
});
