/**
 * P0-A3 — the unsafe form is unavailable, not merely unused.
 *
 * The regression this guards against: a project procedure resolving a quote, account or budget by
 * the reference in the input (the `quoteByRef` / `accountByRef` helpers that used to live in the
 * router), a commercial-office aggregate reading whatever book the input names, or search, the
 * chain and the timeline reading records without the caller's scope. The checks are structural,
 * from the syntax tree, and narrow on purpose:
 *
 *   1. server/projectRouter.ts declares no top-level function other than `dbOrThrow` and
 *      `priceForAccount` (which takes an account the boundary already proved), and imports the
 *      boundary resolvers it uses from ./financeScope.
 *   2. server/commercialOfficeRouter.ts declares `ownedBook`, and `bookFor(` is not called by any
 *      procedure whose input takes `financialEntityId` (a bounded check on each such procedure's block).
 *   3. server/surfacesService.ts exports `searchEverything`, `loadTimeline` and `resolveChainAround`
 *      with a `scope: FinanceScope` parameter, and server/surfacesRouter.ts never calls them without
 *      `scopeFor(`.
 *   4. server/closeoutRouter.ts imports no `actingScopeFor` from ./db: its one resolver is the local
 *      strict one, and the account/terms/adjustment/revision resolvers come from ./financeScope.
 *   5. server/_core/entityScope.ts resolves the money scope through `resolveActingScopeStrict` and
 *      never through the non-strict resolver.
 *
 * The live-router net (`financeScopeCoverage.test.ts`) pins that every `project.*` procedure is
 * `moneyScoped`; `tenantScopeProjectFinance.db.test.ts` proves the behaviour against a database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);

function namedImports(sf: ts.SourceFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const names = out.get(st.moduleSpecifier.text) ?? new Set<string>();
    const clause = st.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) names.add((el.propertyName ?? el.name).text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add("*");
    out.set(st.moduleSpecifier.text, names);
  }
  return out;
}
function declaredFunctions(sf: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const out = new Map<string, ts.FunctionDeclaration>();
  for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
  return out;
}
const paramNames = (fn: ts.FunctionDeclaration, sf: ts.SourceFile) => fn.parameters.map(p => p.name.getText(sf));
const paramTypes = (fn: ts.FunctionDeclaration, sf: ts.SourceFile) => fn.parameters.map(p => p.type?.getText(sf) ?? "");

describe("the project router resolves nothing by reference on its own", () => {
  const sf = parse("server/projectRouter.ts");
  it("declares only dbOrThrow and priceForAccount — no quoteByRef, accountByRef or any other lookup", () => {
    expect([...declaredFunctions(sf).keys()].sort()).toEqual(["dbOrThrow", "priceForAccount"]);
  });
  it("imports the boundary resolvers it uses from ./financeScope", () => {
    const fin = namedImports(sf).get("./financeScope");
    expect(fin, "projectRouter.ts must import from ./financeScope").toBeDefined();
    expect([...fin!]).toEqual(expect.arrayContaining(["customerAccountInScope", "quoteInScope", "projectBudgetInScope", "rfiInScope", "requireJob", "ownedAccountWhere"]));
    expect([...(namedImports(sf).get("./_core/trpc") ?? [])]).toContain("moneyScoped");
  });
});

describe("the commercial-office aggregates prove the book they are asked about", () => {
  const src = read("server/commercialOfficeRouter.ts");
  it("declares ownedBook, and no procedure that takes financialEntityId calls bookFor", () => {
    expect(declaredFunctions(parse("server/commercialOfficeRouter.ts")).has("ownedBook")).toBe(true);
    // Each block runs from one `roleProcedure("` to the next; a block whose input names a book must prove it.
    const blocks = src.split(/(?=roleProcedure\(")/).slice(1);
    const offending = blocks.filter(b => /financialEntityId: z\./.test(b) && /bookFor\(/.test(b)).map(b => b.slice('roleProcedure("'.length, b.indexOf('"', 'roleProcedure("'.length)));
    expect(offending).toEqual([]);
    expect(blocks.filter(b => /financialEntityId: z\./.test(b)).length, "the four aggregates are still there").toBeGreaterThanOrEqual(4);
  });
});

describe("search, the chain and the timeline take the caller's scope", () => {
  const sf = parse("server/surfacesService.ts");
  const fns = declaredFunctions(sf);
  it("each exported reader has a scope: FinanceScope parameter", () => {
    expect(paramNames(fns.get("searchEverything")!, sf)).toEqual(["q", "scope"]);
    expect(paramTypes(fns.get("searchEverything")!, sf)[1]).toBe("FinanceScope");
    expect(paramNames(fns.get("loadTimeline")!, sf)).toEqual(["args", "scope"]);
    expect(paramTypes(fns.get("loadTimeline")!, sf)[1]).toBe("FinanceScope");
    expect(paramNames(fns.get("resolveChainAround")!, sf)).toEqual(["anchor", "can", "scope"]);
    expect(paramTypes(fns.get("resolveChainAround")!, sf)[2]).toBe("FinanceScope");
  });
  it("the router never calls them without scopeFor(", () => {
    const src = read("server/surfacesRouter.ts");
    for (const call of ["searchEverything(", "resolveChainAround(", "loadTimeline("]) {
      const at = src.indexOf(call);
      expect(at, `${call} must be called`).toBeGreaterThan(0);
      expect(src.slice(at, src.indexOf(")", at) + 120), `${call} must carry scopeFor(`).toContain("scopeFor(ctx.user.id)");
    }
  });
});

describe("closeout and the money scope use the strict resolver", () => {
  it("closeoutRouter.ts imports no actingScopeFor from ./db and takes its resolvers from ./financeScope", () => {
    const imports = namedImports(parse("server/closeoutRouter.ts"));
    expect(imports.get("./db")?.has("actingScopeFor")).toBe(false);
    expect([...(imports.get("./financeScope") ?? [])]).toEqual(expect.arrayContaining(["customerAccountInScope", "contractTermsInScope", "clientAdjustmentInScope", "requireTicket", "ticketRevisionInScope"]));
    expect([...(imports.get("./_core/entityScope") ?? [])]).toContain("financeScopeFor");
  });
  it("entityScope.ts resolves the money scope through resolveActingScopeStrict only", () => {
    const imports = namedImports(parse("server/_core/entityScope.ts")).get("./actingScope") ?? new Set();
    expect(imports.has("resolveActingScopeStrict")).toBe(true);
    expect(imports.has("resolveActingScope")).toBe(false);
    expect(imports.has("RevivedFallbackRefused")).toBe(true);
  });
});
