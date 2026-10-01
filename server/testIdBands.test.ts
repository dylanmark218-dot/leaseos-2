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
 *
 * **What it reads (widened 2026-10-01).** The first version matched only a
 * variable literally named `seq`, in files directly under `server/`. Five
 * database-backed suites grant roles from a `userSeq` band, and older suites use
 * `nextId`, `nextUserId` or `assetId`; none of those was visible, so
 * `requirementRegistry.db.test.ts` (`userSeq`) and
 * `organizationScopedRoles.db.test.ts` (`seq`) both drew from exactly
 * 884,000,000 + random(…) with the guard green — the same latent collision this
 * file exists to catch. It now recognises the idiom under ANY variable name, in
 * every test file under `server/` and `client/src/` at any depth. Unit and
 * operator ids (`assetId`) are in scope too: a shared explicit-id window
 * collides on a primary key exactly as a shared user window collides on
 * `activeGrantKey`. A band must also fit in a signed INT column, which is what
 * every id it feeds is stored in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** `let <name> = 20_000_000 + Math.floor(Math.random() * 60_000)` → variable, base and width. */
const BAND = /let\s+(\w+)\s*=\s*([0-9_]+)\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*([0-9_]+)\s*\)/g;

const num = (s: string) => Number(s.replace(/_/g, ""));

/** The largest value a signed MySQL INT holds; every id these bands produce lands in one. */
const INT_MAX = 2_147_483_647;

type Band = { file: string; variable: string; base: number; width: number };

/** Comments stripped: this file quotes the idiom in its own header, and a guard
 *  that cannot tell a citation from a declaration fails on its documentation. */
const stripComments = (body: string) =>
  body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SELF = "server/testIdBands.test.ts";
const ROOTS = ["server", "client/src"];

/** Every test file under the roots, at any depth. */
function testFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]);
  return ROOTS.flatMap(walk).filter(f => /\.(test|spec)\.tsx?$/.test(f) && f !== SELF);
}

/** The bands declared in one source text. Exported shape, tested below on fixtures. */
function bandsIn(file: string, body: string): Band[] {
  return [...stripComments(body).matchAll(BAND)].map(m => ({ file, variable: m[1]!, base: num(m[2]!), width: num(m[3]!) }));
}

function bands(): Band[] {
  return testFiles().flatMap(f => bandsIn(f, readFileSync(f, "utf8"))).sort((a, b) => a.base - b.base);
}

describe("test id bands — the scanner sees what it claims to", () => {
  it("recognises the idiom under any variable name and ignores it in comments", () => {
    const fixture = [
      "let seq = 20_000_000 + Math.floor(Math.random() * 60_000);",
      "let userSeq = 380000 + Math.floor(Math.random() * 50000);",
      "let nextId = 910_000 + Math.floor( Math.random() * 50_000 );",
      "let assetId = 1_400_000_000 + Math.floor(Math.random() * 40_000_000);",
      "// let commented = 5 + Math.floor(Math.random() * 5);",
      "/* let blockCommented = 6 + Math.floor(Math.random() * 6); */",
    ].join("\n");
    expect(bandsIn("fixture", fixture).map(b => [b.variable, b.base, b.width])).toEqual([
      ["seq", 20_000_000, 60_000], ["userSeq", 380_000, 50_000], ["nextId", 910_000, 50_000], ["assetId", 1_400_000_000, 40_000_000],
    ]);
  });

  it("walks nested directories, not only the top of server/", () => {
    const files = testFiles();
    expect(files).toContain(join("server", "_core", "liveAssist", "session.test.ts"));
    expect(files).not.toContain(SELF);
  });

  it("sees the formerly invisible idioms in the tree", () => {
    const variables = new Set(bands().map(b => b.variable));
    for (const v of ["seq", "userSeq", "nextId", "assetId"]) expect(variables, v).toContain(v);
  });
});

describe("test id bands", () => {
  it("finds the bands, so a pass is not vacuous", () => {
    // If the regex stops matching — someone reformats the idiom — this guard
    // would silently protect nothing. It has to see most of them or say so.
    expect(bands().length).toBeGreaterThan(100);
  });

  it("gives every suite its own base", () => {
    const byBase = new Map<number, string[]>();
    for (const b of bands()) {
      byBase.set(b.base, [...(byBase.get(b.base) ?? []), `${b.file}:${b.variable}`]);
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
        overlaps.push(`${a.file}:${a.variable} (${a.base}+${a.width}) reaches into ${b.file}:${b.variable} (${b.base})`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("never takes a user id from AUTO_INCREMENT", () => {
    // AUTO_INCREMENT lands one above the highest id any earlier suite inserted explicitly. A suite that
    // inserts users row M and then grants a role to M + 1 without a row (the usual band pattern) hands
    // that role to whichever suite auto-increments next — fieldroute.test.ts, on 2026-10-01, whose
    // caller arrived holding `driver`. Every users row a test creates names its id from a declared band.
    const offenders: string[] = [];
    for (const f of testFiles()) {
      const body = stripComments(readFileSync(f, "utf8"));
      for (const m of body.matchAll(/\.insert\(\s*users\s*\)\s*\.values\(\s*(\[?\s*\{[\s\S]*?\}\s*\]?)/g)) {
        if (!/\bid\s*:/.test(m[1]!)) offenders.push(`${f}: insert(users) without an id`);
      }
      for (const m of body.matchAll(/INSERT\s+(?:IGNORE\s+)?INTO\s+`?users`?\s*\(([^)]*)\)/gi)) {
        if (!/(^|[\s,`])id([\s,`]|$)/.test(m[1]!)) offenders.push(`${f}: INSERT INTO users (${m[1]!.trim()})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every band inside a signed INT", () => {
    const outside = bands().filter(b => b.base < 1 || b.base + b.width - 1 > INT_MAX)
      .map(b => `${b.file}:${b.variable} (${b.base}+${b.width})`);
    expect(outside).toEqual([]);
  });
});
