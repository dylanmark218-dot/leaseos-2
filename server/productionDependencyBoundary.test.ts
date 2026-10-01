/**
 * P0-C — the production build reaches no development tool. Static early warning.
 *
 * The runtime proof is `scripts/prod-runtime-smoke.sh`, which boots the built artifact outside
 * the checkout with production dependencies alone; it runs after the build in the CI gate and is
 * authoritative. This suite is the check that runs before the build, over the source import graph,
 * so a bad edge is named by file while it is still being written.
 *
 * Walked from the syntax tree, not grepped: type-only imports are erased by the bundler and do
 * not count; dynamic `import()` of a bare package stays external under `--packages=external` and
 * does count. From each of the two bundled entrypoints the walk follows every relative, `@shared`
 * and `drizzle` import through the server sources and collects every bare specifier it meets.
 *
 *   1. No file in either production graph is `server/_core/vite.ts` or `vite.config.ts`.
 *   2. Every bare specifier in either graph names a Node builtin or a package in `dependencies`
 *      — never one in `devDependencies`, never one absent from package.json.
 *   3. The known build/development tools are not in either graph, by name.
 *   4. The scripts keep the shape the smoke relies on: `build` bundles exactly the two
 *      entrypoints, `start`/`worker` run the built JavaScript, `dev` runs the development
 *      entrypoint, and the development entrypoint is the only importer of `./vite`.
 *   5. The CI gate runs the smoke after the build.
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
const DEPS = new Set(Object.keys(pkg.dependencies));
const DEV_DEPS = new Set(Object.keys(pkg.devDependencies));
const BUILTINS = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const DEV_TOOLS = ["vite", "@vitejs/plugin-react", "@tailwindcss/vite", "@builder.io/vite-plugin-jsx-loc", "vite-plugin-manus-runtime", "vitest", "tsx", "typescript", "esbuild", "drizzle-kit", "@testing-library/react", "jsdom", "tough-cookie"];
const ENTRYPOINTS = ["server/_core/index.ts", "server/_core/worker.ts"];

const packageName = (spec: string) => spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;

/** The runtime import specifiers of one file: bare and relative, type-only imports excluded. */
function runtimeSpecifiers(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      const typeOnly = clause?.isTypeOnly
        || (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name
          && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly));
      if (!typeOnly) out.push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) {
      out.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Resolve a relative or aliased specifier to a repository file, or null for a bare package. */
function resolveLocal(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@shared/")) base = path.join("shared", spec.slice("@shared/".length));
  else if (spec.startsWith(".")) base = path.join(path.dirname(fromRel), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, path.join(base, "index.ts")]) {
    if (existsSync(path.join(root, cand)) && !cand.endsWith("/")) {
      const abs = path.join(root, cand);
      if (readFileSyncIsFile(abs)) return path.normalize(cand);
    }
  }
  throw new Error(`${fromRel}: cannot resolve ${spec}`);
}
function readFileSyncIsFile(abs: string): boolean {
  try { readFileSync(abs); return true; } catch { return false; }
}

type Graph = { files: Set<string>; bare: Map<string, Set<string>> };
/** Everything reachable from an entrypoint: the files, and each bare specifier with the files that import it. */
function productionGraph(entry: string): Graph {
  const files = new Set<string>();
  const bare = new Map<string, Set<string>>();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop()!;
    if (files.has(rel)) continue;
    files.add(rel);
    if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
    for (const spec of runtimeSpecifiers(rel)) {
      const local = resolveLocal(rel, spec);
      if (local) queue.push(local);
      else { const by = bare.get(spec) ?? new Set<string>(); by.add(rel); bare.set(spec, by); }
    }
  }
  return { files, bare };
}

const graphs = Object.fromEntries(ENTRYPOINTS.map(e => [e, productionGraph(e)])) as Record<string, Graph>;

describe("1. the production graphs reach no Vite module", () => {
  it.each(ENTRYPOINTS)("%s does not reach server/_core/vite.ts or vite.config.ts", entry => {
    const files = [...graphs[entry]!.files];
    expect(files).not.toContain("server/_core/vite.ts");
    expect(files.some(f => /(^|\/)vite\.config\.ts$/.test(f))).toBe(false);
    expect(files).not.toContain("server/_core/dev.ts");
  });
  it("the server graph does serve the built client", () => {
    expect([...graphs["server/_core/index.ts"]!.files]).toContain("server/_core/staticAssets.ts");
  });
});

describe("2./3. every bare import of the production graphs is a builtin or a production dependency", () => {
  it.each(ENTRYPOINTS)("%s imports nothing from devDependencies and nothing unlisted", entry => {
    const offenders: string[] = [];
    for (const [spec, by] of graphs[entry]!.bare) {
      if (BUILTINS.has(spec) || BUILTINS.has(packageName(spec))) continue;
      const name = packageName(spec);
      if (DEV_DEPS.has(name)) offenders.push(`${spec} (devDependency) ← ${[...by].join(", ")}`);
      else if (!DEPS.has(name)) offenders.push(`${spec} (not in package.json dependencies) ← ${[...by].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
  it.each(ENTRYPOINTS)("%s names none of the known build/development tools", entry => {
    const names = new Set([...graphs[entry]!.bare.keys()].map(packageName));
    expect(DEV_TOOLS.filter(t => names.has(t))).toEqual([]);
  });
  it("the worker graph is small and entirely production", () => {
    const names = [...graphs["server/_core/worker.ts"]!.bare.keys()].map(packageName).filter(n => !BUILTINS.has(n));
    expect(new Set(names)).toEqual(new Set(["dotenv", "mysql2", "drizzle-orm"]));
  });
});

describe("4. the scripts keep the production/development split", () => {
  it("build bundles exactly the two production entrypoints, external packages", () => {
    const build = pkg.scripts.build!;
    expect(build).toContain("vite build");
    expect(build).toContain("esbuild server/_core/index.ts server/_core/worker.ts");
    expect(build).toContain("--packages=external");
    expect(build).not.toContain("dev.ts");
  });
  it("start and worker run the built JavaScript under NODE_ENV=production", () => {
    expect(pkg.scripts.start).toBe("NODE_ENV=production node dist/index.js");
    expect(pkg.scripts.worker).toBe("NODE_ENV=production node dist/worker.js");
  });
  it("dev runs the development entrypoint, the only importer of ./vite", () => {
    expect(pkg.scripts.dev).toBe("NODE_ENV=development tsx watch server/_core/dev.ts");
    expect(runtimeSpecifiers("server/_core/dev.ts")).toContain("./vite");
    const importers = ["server/_core/index.ts", "server/_core/startup.ts", "server/_core/staticAssets.ts", "server/_core/api.ts"].filter(f => runtimeSpecifiers(f).includes("./vite"));
    expect(importers).toEqual([]);
  });
});

describe("5. the CI gate boots the artifact after building it", () => {
  it("scripts/ci-gate.sh runs prod-runtime-smoke.sh after pnpm build", () => {
    const gate = read("scripts/ci-gate.sh");
    const build = gate.indexOf("pnpm build");
    const smoke = gate.indexOf("bash scripts/prod-runtime-smoke.sh");
    expect(build).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(build);
    expect(existsSync(path.join(root, "scripts/prod-runtime-smoke.sh"))).toBe(true);
  });
});
