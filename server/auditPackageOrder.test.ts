/**
 * An audit package is byte-reproducible only if the rows it reads arrive in the same order every time.
 *
 * `assemble` numbers items in the order the builder pushes them and hashes the manifest, so a list query
 * without ORDER BY makes the hash depend on the plan the database happens to pick. MariaDB gives no order
 * without one, and a plan can change between two preparations when other writers move the table's
 * statistics: P7.8's "preparing the same package again yields the same manifest hash" failed that way in
 * CI. Every multi-row read in the builder is therefore ordered; a single-row lookup (`.limit(1)`) is not
 * a list and needs none.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("server/auditRouter.ts", "utf8");
const BUILDER = SRC.slice(SRC.indexOf("async function registryDocumentsFor"), SRC.indexOf("\n}\n", SRC.indexOf("async function gather(")) + 3);

/** Each `.from(T).where(…)` in the builder with what follows its balanced `where(…)`. */
function reads(src: string): { table: string; next: string }[] {
  const out: { table: string; next: string }[] = [];
  const pat = /\.from\(([A-Za-z_$][\w$]*)\)\.where\(/g;
  for (let m = pat.exec(src); m; m = pat.exec(src)) {
    let j = m.index + m[0].length, depth = 1;
    while (depth && j < src.length) { if (src[j] === "(") depth++; else if (src[j] === ")") depth--; j++; }
    out.push({ table: m[1]!, next: src.slice(j, j + 9) });
  }
  return out;
}

describe("audit package builder reads in a defined order", () => {
  it("finds the builder's reads, so a pass is not vacuous", () => {
    expect(BUILDER.length).toBeGreaterThan(1000);
    expect(reads(BUILDER).length).toBeGreaterThan(40);
  });

  it("orders every multi-row read", () => {
    const unordered = reads(BUILDER).filter(r => !r.next.startsWith(".orderBy") && !r.next.startsWith(".limit(1)")).map(r => r.table);
    expect(unordered).toEqual([]);
  });

  it("catches an unordered read", () => {
    expect(reads("await db.select().from(vendorBills).where(eq(vendorBills.vendorId, v.id));").filter(r => !r.next.startsWith(".orderBy"))).toHaveLength(1);
  });
});
