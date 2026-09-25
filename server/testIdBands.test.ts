/**
 * No two suites draw user ids from the same band.
 *
 * The database-backed suites each invent user ids from a random base:
 *
 *     let seq = 20_000_000 + Math.floor(Math.random() * 60_000);
 *
 * and then hand those ids to `grantUserRole`. `userRoleAssignments` carries a
 * generated `activeGrantKey` under a UNIQUE index (`0021_active_role_uniqueness`),
 * and `grantUserRole` inserts with no conflict handling — so two suites whose
 * ranges overlap on the same (user, role) make the second insert fail with a
 * duplicate key, in whichever suite happens to run second.
 *
 * The convention that prevents this is one band per suite, and 44 of them
 * follow it. Four pairs did not, which is why CI failed on
 * `messageLifecycleCanonical` with
 *
 *     Failed query: insert into `userRoleAssignments` … params: 20025302,dispatcher,global,1
 *
 * while `crewChannelApi` drew from the identical `20_000_000 + random(60_000)`
 * window. Nothing had changed in either file; the two simply collided that run.
 *
 * That is the shape of failure worth a guard rather than a retry. It is
 * probabilistic, so it passes far more often than it fails, and every failure
 * lands on an innocent suite that will look flaky to whoever reads it next. A
 * birthday collision between two 60,000-wide windows is not rare enough to
 * ignore and not frequent enough to catch by running the suite again.
 *
 * This reads the bands out of the source rather than from a list somebody
 * maintains, so a suite added tomorrow with a copied-and-pasted base fails here
 * instead of failing somewhere else a month later.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `let seq = 20_000_000 + Math.floor(Math.random() * 60_000)` → base and width. */
const BAND = /let\s+seq\s*=\s*([0-9_]+)\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*([0-9_]+)\s*\)/;

const num = (s: string) => Number(s.replace(/_/g, ""));

type Band = { file: string; base: number; width: number };

/** Comments stripped: this file quotes the idiom in its own header, and a guard
 *  that cannot tell a citation from a declaration fails on its documentation. */
const stripComments = (body: string) =>
  body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SELF = "testIdBands.test.ts";

function bands(): Band[] {
  const out: Band[] = [];
  for (const name of readdirSync("server")) {
    if (!name.endsWith(".test.ts") || name === SELF) continue;
    const m = BAND.exec(stripComments(readFileSync(`server/${name}`, "utf8")));
    if (m) out.push({ file: `server/${name}`, base: num(m[1]), width: num(m[2]) });
  }
  return out.sort((a, b) => a.base - b.base);
}

describe("test user-id bands", () => {
  it("finds the bands, so a pass is not vacuous", () => {
    // If the regex stops matching — someone reformats the idiom — this guard
    // would silently protect nothing. It has to see most of them or say so.
    expect(bands().length).toBeGreaterThan(30);
  });

  it("gives every suite its own base", () => {
    const byBase = new Map<number, string[]>();
    for (const b of bands()) {
      byBase.set(b.base, [...(byBase.get(b.base) ?? []), b.file]);
    }
    const shared = [...byBase.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([base, files]) => `${base.toLocaleString("en-US")}: ${files.join(", ")}`);

    expect(
      shared,
      "these suites draw user ids from the same window and will collide on " +
        "userRoleAssignments.activeGrantKey whenever their ranges overlap"
    ).toEqual([]);
  });

  it("leaves no band overlapping the next one's base", () => {
    // Distinct bases are not enough on their own: a base 20,000,000 window
    // 60,000 wide reaches 20,060,000, and a neighbour starting at 20,030,000
    // would overlap while looking distinct.
    const all = bands();
    const overlaps: string[] = [];
    for (let i = 0; i + 1 < all.length; i++) {
      const a = all[i];
      const b = all[i + 1];
      if (a.base + a.width > b.base) {
        overlaps.push(`${a.file} (${a.base}+${a.width}) reaches into ${b.file} (${b.base})`);
      }
    }
    expect(overlaps).toEqual([]);
  });
});
