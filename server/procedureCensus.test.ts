/**
 * Gate 5, as a census of the syntax tree rather than a grep over a glob.
 *
 * The three properties below are each one edit away from being false, and each was false on
 * 2026-09-30: `server/_core/systemRouter.ts` was outside the glob; `publicProcedure` was not a token
 * the grep knew; and a data field named `testProcedure` would have matched a text search. The cases
 * plant the exact things the old gate could not see and require the new one to refuse them.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { censusOf, judge, KIND_CLASS, pinnedSites, PIN_PATH, type Pin } from "../scripts/procedure-census";
import { readFileSync } from "node:fs";

/** A throwaway tree with the trpc module in the same relative place production files import it from. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "census-"));
  mkdirSync(path.join(root, "server/_core"), { recursive: true });
  writeFileSync(path.join(root, "server/_core/trpc.ts"),
    `export const publicProcedure = 1 as any; export const protectedProcedure = 2 as any; export const adminProcedure = 3 as any; export const roleProcedure = (k: string) => 4 as any; export const router = (x: any) => x;\n`);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const roots: string[] = [];
const make = (files: Record<string, string>) => { const r = tree(files); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const OK_ROUTER = `import { roleProcedure, router } from "./_core/trpc";\nexport const okRouter = router({ list: roleProcedure("x.list").query(() => 1) });\n`;

describe("the census reads the tree, not the text", () => {
  it("sees a procedure declared under _core, where the old glob did not look", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/_core/systemRouter.ts": `import { publicProcedure, router } from "./trpc";\nexport const systemRouter = router({ health: publicProcedure.query(() => "ok") });\n`,
    });
    const c = censusOf(root);
    expect(c.sites.map(s => [s.file, s.kind, s.procedure])).toContainEqual(["server/_core/systemRouter.ts", "publicProcedure", "health"]);
  });

  it("does not count a data field, a comment, a string or a type that happens to end in Procedure", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/shopRouter.ts": `import { roleProcedure, router } from "./_core/trpc";\n` +
        `// protectedProcedure was used here before B20.2\n` +
        `type T = { testProcedure?: string };\n` +
        `const label = "publicProcedure";\n` +
        `export const shopRouter = router({ repair: roleProcedure("shop.repair").input((x: T) => ({ testProcedure: x.testProcedure })).mutation(() => label) });\n`,
    });
    const c = censusOf(root);
    expect(c.byKind).toEqual({ roleProcedure: 2 });
  });

  it("follows the local name of an aliased import", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/aliasRouter.ts": `import { publicProcedure as open, router } from "./_core/trpc";\nexport const aliasRouter = router({ ping: open.query(() => 1) });\n`,
    });
    expect(censusOf(root).byKind).toEqual({ roleProcedure: 1, publicProcedure: 1 });
  });

  it("ignores a Procedure-named import from any other module", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/other.ts": `export const hasFabricatedProcedure = () => true;\n`,
      "server/user.ts": `import { hasFabricatedProcedure } from "./other";\nexport const x = hasFabricatedProcedure();\n`,
    });
    expect(censusOf(root).byKind).toEqual({ roleProcedure: 1 });
  });
});

describe("the judgement", () => {
  it("refuses a bare protectedProcedure anywhere, including under _core", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/_core/hiddenRouter.ts": `import { protectedProcedure, router } from "./trpc";\nexport const hiddenRouter = router({ leak: protectedProcedure.query(() => 1) });\n`,
    });
    const v = judge(censusOf(root), []);
    expect(v.ok).toBe(false);
    expect((v as { reasons: string[] }).reasons.join("\n")).toMatch(/bare protectedProcedure at server\/_core\/hiddenRouter\.ts:2 \(leak\)/);
  });

  it("refuses an unpinned publicProcedure and names it", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/_core/systemRouter.ts": `import { publicProcedure, router } from "./trpc";\nexport const systemRouter = router({ health: publicProcedure.query(() => "ok") });\n`,
    });
    const v = judge(censusOf(root), []);
    expect(v.ok).toBe(false);
    expect((v as { reasons: string[] }).reasons.join("\n")).toMatch(/unpinned ungated procedure: publicProcedure server\/_core\/systemRouter\.ts health/);
  });

  it("passes when every ungated site is pinned, and refuses when a pinned site disappears", () => {
    const root = make({
      "server/okRouter.ts": OK_ROUTER,
      "server/_core/systemRouter.ts": `import { publicProcedure, router } from "./trpc";\nexport const systemRouter = router({ health: publicProcedure.query(() => "ok") });\n`,
    });
    const census = censusOf(root);
    const pin: Pin = pinnedSites(census);
    expect(judge(census, pin)).toEqual({ ok: true });
    expect(judge(census, [...pin, { file: "server/_core/gone.ts", procedure: "x", kind: "adminProcedure" }]).ok).toBe(false);
  });

  it("fails closed on an empty census — a walker that finds nothing is broken, not clean", () => {
    const root = make({});
    const v = judge(censusOf(root), []);
    expect(v.ok).toBe(false);
    expect((v as { reasons: string[] }).reasons[0]).toMatch(/walker is broken/);
  });
});

describe("the real tree", () => {
  const census = censusOf(process.cwd());

  it("holds zero bare protectedProcedure and every ungated site is the pinned one", () => {
    const pin: Pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
    const v = judge(census, pin);
    expect(v, JSON.stringify(v)).toEqual({ ok: true });
  });

  it("includes systemRouter's public health procedure — the site the old gate could not see", () => {
    expect(census.sites).toContainEqual(expect.objectContaining({ file: "server/_core/systemRouter.ts", kind: "publicProcedure", procedure: "health" }));
  });

  it("finds only classified kinds, and the gated one dominates", () => {
    for (const kind of Object.keys(census.byKind)) expect(Object.keys(KIND_CLASS), kind).toContain(kind);
    expect(census.byKind.roleProcedure).toBeGreaterThan(600);
    expect(census.byKind.protectedProcedure ?? 0).toBe(0);
  });

  it("refuses a kind it has not classified — a new export must be decided, not defaulted", () => {
    const v = judge({ ...census, sites: [...census.sites, { file: "server/x.ts", line: 1, kind: "mysteryProcedure", procedure: "y" }] }, JSON.parse(readFileSync(PIN_PATH, "utf8")));
    expect(v.ok).toBe(false);
    expect((v as { reasons: string[] }).reasons.join("\n")).toMatch(/unclassified procedure kind mysteryProcedure/);
  });
});
