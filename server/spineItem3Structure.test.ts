/**
 * SPINE item 3 — the seam's shape, read from the TypeScript AST (comments and prose are invisible).
 *
 *   1. Hardware is reached only through the adapters (HS1, HS0 criterion (b)): no client code outside
 *      `client/src/runtime/adapters/` imports a Capacitor plugin, imports a module by a computed
 *      name, touches `navigator.mediaDevices`/`navigator.geolocation`, calls `getUserMedia`, or
 *      renders `<input type="file">`. No exception: the showcase is routed and bundled in production
 *      (App.tsx), so it starts captures through Quick Capture like every other surface (HS0 (c)).
 *   2. One offline policy: `requiresOnline` is read only in `server/_core/actionGateway.ts`.
 *   3. One evaluator: the seam's functions are declared once, in their canonical files, and no
 *      production code declares an `offlineClass` — it is derived.
 *   4. HS1 grants no authority: no server code but the composition imports HS1 or the composition.
 *   5. The runtime path is gated: every client `Outbox` that saves a draft is built with a gate.
 */
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${dir}/${e.name}`))
      : /\.tsx?$/.test(e.name) && !/\.(test|spec|dom\.test)\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [`${dir}/${e.name}`] : []);

const parse = (f: string) => ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const each = (sf: ts.SourceFile, fn: (n: ts.Node) => void) => { const v = (n: ts.Node): void => { fn(n); ts.forEachChild(n, v); }; v(sf); };
const line = (sf: ts.SourceFile, n: ts.Node) => `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

const CLIENT = walk("client/src");
const SERVER = walk("server");
const PRODUCTION = [...CLIENT, ...SERVER, ...walk("shared")];

/** Every direct hardware reach in a client file. */
const hardwareReaches = (f: string): string[] => reachesIn(parse(f));
function reachesIn(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  each(sf, n => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && /^@capacitor(-community|-mlkit)?\//.test(n.moduleSpecifier.text)) out.push(`${line(sf, n)} import ${n.moduleSpecifier.text}`);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (!a || !ts.isStringLiteralLike(a)) out.push(`${line(sf, n)} import(<computed>)`);
      else if (/^@capacitor(-community|-mlkit)?\//.test(a.text)) out.push(`${line(sf, n)} import(${a.text})`);
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "navigator" && ["mediaDevices", "geolocation"].includes(n.name.text)) out.push(`${line(sf, n)} navigator.${n.name.text}`);
    if (ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && n.expression.text === "getUserMedia") || (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "getUserMedia"))) out.push(`${line(sf, n)} getUserMedia()`);
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === "input") {
      const type = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(sf) === "type") as ts.JsxAttribute | undefined;
      if (type?.initializer && ts.isStringLiteral(type.initializer) && type.initializer.text === "file") out.push(`${line(sf, n)} <input type="file">`);
    }
  });
  return out;
}

describe("1. hardware is reached only through the adapters", () => {
  const reaches = CLIENT.filter(f => !f.startsWith("client/src/runtime/adapters/")).flatMap(hardwareReaches);
  it("no client code outside the adapters reaches hardware directly — production has no exception", () => {
    expect(reaches).toEqual([]);
  });
  it("the scanner catches each form it claims to, and ignores comments and strings (fixtures)", () => {
    const run = (src: string) => reachesIn(ts.createSourceFile("fx.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)).map(r => r.replace(/^fx\.tsx:\d+ /, ""));
    expect(run("// navigator.geolocation, getUserMedia(), <input type=\"file\" />\nconst s = 'import(\"@capacitor/camera\")';")).toEqual([]);
    expect(run("import { Camera } from '@capacitor/camera';")).toEqual(["import @capacitor/camera"]);
    expect(run("const m = await import(name);")).toEqual(["import(<computed>)"]);
    expect(run("navigator.geolocation.getCurrentPosition(f); navigator.mediaDevices.getUserMedia({});").sort()).toEqual(["getUserMedia()", "navigator.geolocation", "navigator.mediaDevices"]);
    expect(run("const x = <input type=\"file\" accept=\"image/*\" />;")).toEqual(["<input type=\"file\">"]);
  });
});

describe("2. one offline policy", () => {
  it("requiresOnline is read only in actionGateway.ts — everything else asks mayRunWithoutServer", () => {
    const readers = PRODUCTION.flatMap(f => { const sf = parse(f); const out: string[] = []; each(sf, n => { if (ts.isPropertyAccessExpression(n) && n.name.text === "requiresOnline") out.push(line(sf, n)); }); return out; });
    expect(readers.map(r => r.replace(/:\d+$/, ""))).toEqual(["server/_core/actionGateway.ts"]);
  });
});

describe("3. one evaluator", () => {
  const CANONICAL: Record<string, string> = {
    missingHardware: "shared/hardwareCapability.ts",
    mayRunWithoutServer: "server/_core/actionGateway.ts",
    offlineClassOf: "server/_core/offlineCapability.ts",
    runtimeAvailability: "server/_core/offlineCapability.ts",
    capabilities: "client/src/runtime/capabilities.ts",
    captureGate: "client/src/runtime/capabilities.ts",
  };
  it("each seam function is declared once, where it belongs; the pre-item-3 offlineOutcome is gone", () => {
    const found: Record<string, string[]> = {};
    for (const f of PRODUCTION) each(parse(f), n => {
      const fnVar = ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && !!n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer));
      if ((ts.isFunctionDeclaration(n) && n.name) || fnVar) {
        const name = (n.name as ts.Identifier).text;
        if (name in CANONICAL || name === "offlineOutcome") (found[name] ??= []).push(f);
      }
    });
    for (const [name, file] of Object.entries(CANONICAL)) expect(found[name], name).toEqual([file]);
    expect(found.offlineOutcome).toBeUndefined();
  });
  it("no production code declares an offlineClass; it is derived from requiresOnline and the risk", () => {
    const declared = PRODUCTION.flatMap(f => { const sf = parse(f); const out: string[] = []; each(sf, n => { if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "offlineClass") out.push(line(sf, n)); }); return out; });
    expect(declared.filter(d => !d.startsWith("server/_core/offlineCapability.ts"))).toEqual([]);
  });
});

describe("4. HS1 grants no authority", () => {
  it("no server code but the composition imports HS1 or the composition", () => {
    const importers = SERVER.filter(f => {
      if (f === "server/_core/offlineCapability.ts") return false;
      let hit = false;
      each(parse(f), n => { if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /hardwareCapability$|offlineCapability$/.test(n.moduleSpecifier.text)) hit = true; });
      return hit;
    });
    expect(importers).toEqual([]);
  });
});

describe("5. the runtime path is gated", () => {
  it("every client Outbox that saves drafts is constructed with a gate", () => {
    const ungated = CLIENT.flatMap(f => {
      const sf = parse(f);
      let saves = false; const news: ts.NewExpression[] = [];
      each(sf, n => {
        if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Outbox") news.push(n);
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "saveDraft") saves = true;
      });
      return saves ? news.filter(n => (n.arguments?.length ?? 0) < 4).map(n => line(sf, n)) : [];
    });
    expect(ungated).toEqual([]);
  });
});
