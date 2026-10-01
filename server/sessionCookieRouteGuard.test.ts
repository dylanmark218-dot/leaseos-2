/**
 * P0-B — the refresh cookie's path, the refresh request's path and the clearing path cannot drift
 * apart again, because none of them is spelled more than once.
 *
 * The regression this guards against: a cookie Path literal in one file, a mount literal in
 * another, a request URL literal in a third, each correct on its own and jointly wrong. The checks
 * are structural, from the syntax tree, and narrow on purpose:
 *
 *   1. `shared/const.ts` defines `TRPC_MOUNT_PATH` once, as a string literal.
 *   2. `server/_core/cookies.ts` initialises `REFRESH_COOKIE_PATH` from the identifier
 *      `TRPC_MOUNT_PATH`, not from a literal.
 *   3. `server/_core/api.ts` mounts `createExpressMiddleware` with the identifier as its path, and
 *      `server/_core/index.ts` registers the API through `registerApi` and mounts nothing itself.
 *   4. No production module other than `server/_core/cookies.ts` writes or clears the refresh
 *      cookie: every `res.cookie(REFRESH_COOKIE_NAME, …)` / `clearCookie(REFRESH_COOKIE_NAME, …)`
 *      lives there, and `issueRefreshCookie` and `clearRefreshCookie` both expire the legacy paths.
 *   5. The browser builds the refresh URL and the batch link URL from the same constant: neither
 *      `client/src/lib/sessionRefresh.ts` nor `client/src/main.tsx` contains a `/api/trpc` literal.
 *
 * `sessionCookiePathMatch.test.ts` proves the chosen path with a real cookie jar;
 * `sessionCookieTransport.http.db.test.ts` proves delivery over the real mount.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TRPC_MOUNT_PATH } from "@shared/const";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  const go = (n: ts.Node) => { visit(n); ts.forEachChild(n, go); };
  go(node);
}
function topLevelConst(sf: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
  }
  return undefined;
}
function stringLiterals(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(sf, n => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text); if (ts.isTemplateExpression(n)) out.push(n.head.text); });
  return out;
}
/** Every `<x>.cookie(REFRESH_COOKIE_NAME, …)` or `<x>.clearCookie(REFRESH_COOKIE_NAME, …)` in the file. */
function refreshCookieWrites(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  walk(sf, n => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const method = n.expression.name.text;
    if (method !== "cookie" && method !== "clearCookie") return;
    const first = n.arguments[0];
    if (first && ts.isIdentifier(first) && first.text === "REFRESH_COOKIE_NAME") out.push(method);
  });
  return out;
}
function productionServerFiles(): string[] {
  const out: string[] = [];
  const go = (dir: string) => {
    for (const e of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(path.join(root, rel)).isDirectory()) { if (e !== "node_modules") go(rel); continue; }
      if (rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.includes(".tmp.")) out.push(rel);
    }
  };
  go("server");
  return out;
}
function declaredFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
  return undefined;
}
function callsInside(fn: ts.FunctionDeclaration): string[] {
  const out: string[] = [];
  walk(fn, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push(n.expression.text); });
  return out;
}

describe("1. the mount path is defined once", () => {
  it("shared/const.ts defines TRPC_MOUNT_PATH as a string literal, and it is the value the server uses", () => {
    const d = topLevelConst(parse("shared/const.ts"), "TRPC_MOUNT_PATH")!;
    expect(d).toBeTruthy();
    expect(d.initializer && ts.isStringLiteral(d.initializer)).toBe(true);
    expect((d.initializer as ts.StringLiteral).text).toBe(TRPC_MOUNT_PATH);
    expect(TRPC_MOUNT_PATH.startsWith("/")).toBe(true);
    expect(TRPC_MOUNT_PATH.endsWith("/")).toBe(false);
  });
});

describe("2. the refresh cookie path is derived, not spelled", () => {
  it("REFRESH_COOKIE_PATH is initialised from the identifier TRPC_MOUNT_PATH", () => {
    const sf = parse("server/_core/cookies.ts");
    const d = topLevelConst(sf, "REFRESH_COOKIE_PATH")!;
    expect(d.initializer && ts.isIdentifier(d.initializer) && d.initializer.text).toBe("TRPC_MOUNT_PATH");
    expect(stringLiterals(sf)).not.toContain(TRPC_MOUNT_PATH);
  });
});

describe("3. the server mounts the router at that identifier, in one place", () => {
  it("server/_core/api.ts passes TRPC_MOUNT_PATH to app.use with createExpressMiddleware", () => {
    const sf = parse("server/_core/api.ts");
    let mounted = false;
    walk(sf, n => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "use") return;
      const [p, mw] = n.arguments;
      if (p && ts.isIdentifier(p) && p.text === "TRPC_MOUNT_PATH" && mw && ts.isCallExpression(mw) && ts.isIdentifier(mw.expression) && mw.expression.text === "createExpressMiddleware") mounted = true;
    });
    expect(mounted).toBe(true);
    expect(stringLiterals(sf)).not.toContain(TRPC_MOUNT_PATH);
  });
  it("the startup registers the API and mounts nothing itself; neither entrypoint mounts anything", () => {
    // P0-C moved the startup body into server/_core/startup.ts, shared by the production and the
    // development entrypoints; the mount still happens once, in api.ts, at the identifier.
    const sf = parse("server/_core/startup.ts");
    const calls: string[] = [];
    walk(sf, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text); });
    expect(calls).toContain("registerApi");
    expect(calls).not.toContain("createExpressMiddleware");
    expect(stringLiterals(sf)).not.toContain(TRPC_MOUNT_PATH);
    for (const entry of ["server/_core/index.ts", "server/_core/dev.ts"]) {
      const e = parse(entry);
      const entryCalls: string[] = [];
      walk(e, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) entryCalls.push(n.expression.text); });
      expect(entryCalls, entry).toContain("startServer");
      expect(entryCalls, entry).not.toContain("createExpressMiddleware");
      expect(stringLiterals(e), entry).not.toContain(TRPC_MOUNT_PATH);
    }
  });
});

describe("4. only the cookie module writes or clears the refresh cookie", () => {
  it("every res.cookie / clearCookie of REFRESH_COOKIE_NAME is in server/_core/cookies.ts", () => {
    const writers = productionServerFiles().filter(rel => refreshCookieWrites(parse(rel)).length > 0);
    expect(writers).toEqual(["server/_core/cookies.ts"]);
    expect(refreshCookieWrites(parse("server/_core/cookies.ts")).sort()).toEqual(["clearCookie", "clearCookie", "cookie"]);
  });
  it("issue and clear both expire the legacy paths, through the same function", () => {
    const sf = parse("server/_core/cookies.ts");
    expect(topLevelConst(sf, "LEGACY_REFRESH_COOKIE_PATHS")).toBeTruthy();
    for (const name of ["issueRefreshCookie", "clearRefreshCookie"]) {
      const fn = declaredFunction(sf, name)!;
      expect(fn, name).toBeTruthy();
      expect(callsInside(fn), `${name} must expire the legacy-path cookie`).toContain("expireLegacyRefreshCookies");
    }
    const legacy = declaredFunction(sf, "expireLegacyRefreshCookies")!;
    let loopsOverLegacy = false;
    walk(legacy, n => { if (ts.isForOfStatement(n) && n.expression.getText(sf) === "LEGACY_REFRESH_COOKIE_PATHS") loopsOverLegacy = true; });
    expect(loopsOverLegacy).toBe(true);
  });
  it("the auth procedures and the login go through the helpers", () => {
    const routers = parse("server/routers.ts");
    const imports = new Set<string>();
    for (const st of routers.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "./_core/cookies") continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.add((el.propertyName ?? el.name).text);
    }
    expect([...imports].sort()).toEqual(["clearAccessCookie", "clearRefreshCookie", "issueAccessCookie", "issueRefreshCookie"]);
    expect(imports.has("getSessionCookieOptions")).toBe(false);
    const login = parse("server/_core/browserSession.ts");
    const calls: string[] = [];
    walk(login, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n.expression.text); });
    expect(calls).toEqual(expect.arrayContaining(["issueAccessCookie", "issueRefreshCookie", "createSessionFamily"]));
    const oauth = parse("server/_core/oauth.ts");
    const oauthCalls: string[] = [];
    walk(oauth, n => { if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) oauthCalls.push(n.expression.text); });
    expect(oauthCalls).toContain("issueBrowserSession");
    expect(refreshCookieWrites(oauth)).toEqual([]);
  });
});

describe("5. the browser derives its URLs from the same constant", () => {
  it.each(["client/src/lib/sessionRefresh.ts", "client/src/main.tsx"])("%s imports TRPC_MOUNT_PATH from @shared/const and spells no /api/trpc literal", rel => {
    const sf = parse(rel);
    let imported = false;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "@shared/const") continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName ?? el.name).text === "TRPC_MOUNT_PATH") imported = true;
    }
    expect(imported).toBe(true);
    for (const lit of stringLiterals(sf)) expect(lit.startsWith(TRPC_MOUNT_PATH), `literal ${JSON.stringify(lit)}`).toBe(false);
  });
  it("the refresh request is `${TRPC_MOUNT_PATH}/auth.refresh`", () => {
    const sf = parse("client/src/lib/sessionRefresh.ts");
    let found = false;
    walk(sf, n => {
      if (!ts.isTemplateExpression(n) || n.head.text !== "" || n.templateSpans.length !== 1) return;
      const span = n.templateSpans[0]!;
      if (ts.isIdentifier(span.expression) && span.expression.text === "TRPC_MOUNT_PATH" && span.literal.text === "/auth.refresh") found = true;
    });
    expect(found).toBe(true);
  });
});
