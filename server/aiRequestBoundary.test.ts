/**
 * Model inference does not run inside a request handler — except the one call we already know about.
 *
 * The rule (docs/register/AI_AGENT_RUNTIME_ARCHITECTURE.md §18, §22): a model call belongs in the
 * worker, behind the outbox, never in a tRPC handler, where a slow or failing provider holds a
 * request open and a retry by the client is a second, unrecorded inference. Today exactly one
 * handler breaks the rule — `assistant.draft` calls `invokeLLM()` synchronously — and retiring it
 * is SPINE work waiting on the owner's carve-out ruling. Until then it is pinned, not fixed:
 *
 *   one known violation → green;
 *   a second one anywhere in server code → red, naming the new site;
 *   the known one gone → red, telling you to lower the pin to zero.
 *
 * The third case is deliberate. A pin that silently tolerates "fewer" would let the count drop to
 * zero and then quietly rise back to one somewhere else.
 *
 * How it looks, and why not a regex. Every production `.ts` file under `server/` is parsed with the
 * TypeScript compiler already in the dependencies, so comments, strings and documentation examples
 * are invisible to it (this file's own prose mentions `invokeLLM(` and is not counted), and an
 * aliased (`import { invokeLLM as ask }`) or namespace (`import * as llm`) import is still followed
 * to its call. A type-only import (`import type { OutputSchema } from "./llm"`, which
 * `assistantExtraction.ts` has) calls nothing and is ignored. A dynamic `import()` or a re-export of
 * an inference module counts as a violation on its own: both are ways to reach the model that a
 * call-site count would otherwise miss.
 *
 * Scope. The whole server tree is scanned, not just router files, so a helper in `_core/` that
 * wraps `invokeLLM` is itself a finding rather than a way around the guard. The inference modules
 * are the three that reach a model endpoint on this tree: `_core/llm.ts`, `_core/voiceTranscription.ts`
 * and `_core/imageGeneration.ts`. The declared-unwired Secretary layer (`server/_core/ai/`, PR #7)
 * carries its own worker-boundary test and is not anticipated here; if it lands and trips this
 * guard, that is the guard working and the PR updates it knowingly.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Modules whose value exports reach a model endpoint. Paths from the repository root, no extension. */
const INFERENCE_MODULES = ["server/_core/llm", "server/_core/voiceTranscription", "server/_core/imageGeneration"];

/**
 * The pin. Each entry is one known request-handler inference call, identified by file, the
 * procedure it sits in and the function it calls — so swapping one violation for another fails too.
 * Lower this list when a call is moved to the worker; never raise it.
 */
const KNOWN_VIOLATIONS = [
  { file: "server/routers.ts", procedure: "assistant.draft", callee: "invokeLLM" },
] as const;

type Finding = { file: string; line: number; kind: "call" | "dynamic_import" | "re_export"; callee: string; procedure: string | null };

const PROCEDURE_BUILDERS = new Set(["roleProcedure", "protectedProcedure", "publicProcedure", "adminProcedure"]);

/** Resolve an import specifier to a root-relative module path without extension, or null if external. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith(".")) target = normalize(join(dirname(fromFile), spec));
  else if (spec.startsWith("server/")) target = normalize(spec); // baseUrl-relative, as imageGeneration.ts uses
  else return null;
  return target.replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
}

const isInference = (fromFile: string, spec: string) => {
  const r = resolveSpecifier(fromFile, spec);
  return r !== null && INFERENCE_MODULES.includes(r);
};

/** The tRPC procedure a node sits inside: the string passed to the builder at the root of its call chain. */
function enclosingProcedure(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isCallExpression(n)) continue;
    let e: ts.Expression = n.expression;
    // Walk `roleProcedure("x").input(...).mutation` down to `roleProcedure("x")`.
    while (true) {
      if (ts.isPropertyAccessExpression(e)) { e = e.expression; continue; }
      if (ts.isCallExpression(e)) {
        if (ts.isIdentifier(e.expression) && PROCEDURE_BUILDERS.has(e.expression.text)) {
          const arg = e.arguments[0];
          return arg && ts.isStringLiteralLike(arg) ? arg.text : e.expression.text;
        }
        e = e.expression;
        continue;
      }
      break;
    }
  }
  return null;
}

/** Every inference call, dynamic import and re-export in one source file.  */
function scanSource(file: string, text: string): Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const named = new Map<string, string>(); // local name → exported name
  const namespaces = new Set<string>();
  const findings: Finding[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && isInference(file, stmt.moduleSpecifier.text)) {
      const clause = stmt.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) named.set(clause.name.text, "default");
      const b = clause.namedBindings;
      if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
      if (b && ts.isNamedImports(b)) {
        for (const el of b.elements) if (!el.isTypeOnly) named.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
      && isInference(file, stmt.moduleSpecifier.text)) {
      findings.push({ file, line: at(stmt), kind: "re_export", callee: stmt.moduleSpecifier.text, procedure: null });
    }
  }

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (c.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && isInference(file, arg.text)) {
          findings.push({ file, line: at(n), kind: "dynamic_import", callee: arg.text, procedure: enclosingProcedure(n) });
        }
      } else if (ts.isIdentifier(c) && named.has(c.text)) {
        findings.push({ file, line: at(n), kind: "call", callee: named.get(c.text)!, procedure: enclosingProcedure(n) });
      } else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text)) {
        findings.push({ file, line: at(n), kind: "call", callee: c.name.text, procedure: enclosingProcedure(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${dir}/${e.name}`))
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [`${dir}/${e.name}`] : []);

/** Server production files, minus the inference modules themselves (they are the model, not callers of it). */
const serverFiles = () =>
  walk("server").map(f => relative(".", f)).filter(f => !INFERENCE_MODULES.includes(f.replace(/\.tsx?$/, "")));

const describeFinding = (f: Finding) => `${f.file}:${f.line} ${f.kind} ${f.callee} in ${f.procedure ?? "(no procedure)"}`;

describe("scanner — what counts as a model call (fixtures, no tree)", () => {
  const F = "server/fixture.ts";

  it("counts a direct call and names the procedure it sits in", () => {
    const src = `import { invokeLLM } from "./_core/llm";
      export const r = { draft: roleProcedure("assistant.draft").input(z.any()).mutation(async () => invokeLLM({ messages: [] })) };`;
    expect(scanSource(F, src)).toMatchObject([{ kind: "call", callee: "invokeLLM", procedure: "assistant.draft" }]);
  });

  it("follows an alias and a namespace import to the call", () => {
    const src = `import { invokeLLM as ask } from "./_core/llm";
      import * as stt from "./_core/voiceTranscription";
      ask({}); stt.transcribeAudio({});`;
    expect(scanSource(F, src).map(f => f.callee)).toEqual(["invokeLLM", "transcribeAudio"]);
  });

  it("resolves baseUrl-relative specifiers", () => {
    expect(scanSource(F, `import { generateImage } from "server/_core/imageGeneration"; generateImage({});`)).toHaveLength(1);
  });

  it("ignores comments, strings and template text", () => {
    const src = `import { invokeLLM } from "./_core/llm";
      // invokeLLM({ messages })
      /* await invokeLLM(x) */
      const doc = "invokeLLM({})"; const t = \`invokeLLM(\${1})\`;`;
    expect(scanSource(F, src)).toEqual([]);
  });

  it("ignores type-only imports and an unrelated function of the same name", () => {
    const src = `import type { OutputSchema } from "./_core/llm";
      import { type Message } from "./_core/llm";
      function invokeLLM() {} invokeLLM();`;
    expect(scanSource(F, src)).toEqual([]);
  });

  it("counts a dynamic import and a re-export as violations on their own", () => {
    const src = `export { invokeLLM } from "./_core/llm";
      async function f() { const m = await import("./_core/llm"); }`;
    expect(scanSource(F, src).map(f => f.kind).sort()).toEqual(["dynamic_import", "re_export"]);
  });

  it("does not count a module that merely shares a name", () => {
    expect(scanSource(F, `import { invokeLLM } from "./other/llm"; invokeLLM();`)).toEqual([]);
  });
});

describe("request handlers do not call a model, except the one pinned", () => {
  it("has the inference modules it claims to guard", () => {
    for (const m of INFERENCE_MODULES) expect(existsSync(`${m}.ts`), `${m}.ts is guarded but does not exist`).toBe(true);
  });

  const findings = serverFiles().flatMap(f => scanSource(f, readFileSync(f, "utf8")));

  it("introduces no request-handler model call beyond the known one", () => {
    expect(
      findings.length,
      `Model inference must run in the worker, behind the outbox — not in server request code. ` +
      `Pinned at ${KNOWN_VIOLATIONS.length}; found ${findings.length}:\n  ${findings.map(describeFinding).join("\n  ")}`,
    ).toBeLessThanOrEqual(KNOWN_VIOLATIONS.length);
  });

  it("still finds the known violation — if it is gone, lower the pin", () => {
    expect(
      findings.length,
      `The known request-handler model call is gone (${KNOWN_VIOLATIONS.map(v => `${v.procedure} → ${v.callee}`).join(", ")}). ` +
      `Good — now remove it from KNOWN_VIOLATIONS in server/aiRequestBoundary.test.ts so the pin is zero ` +
      `and cannot quietly come back somewhere else.`,
    ).toBeGreaterThanOrEqual(KNOWN_VIOLATIONS.length);
  });

  it("is exactly the known violation, not a different one in its place", () => {
    expect(findings.map(f => ({ file: f.file, procedure: f.procedure, callee: f.callee }))).toEqual([...KNOWN_VIOLATIONS]);
  });
});
