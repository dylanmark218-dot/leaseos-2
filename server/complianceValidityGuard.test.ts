/**
 * SPINE item 2 — the guard that keeps "is this compliance document in force?" to ONE answer.
 *
 * `complianceValidityConsumers.test.ts` proves the consumers agree today. This file stops a
 * second answer from quietly returning tomorrow. It reads the source as a TypeScript AST, not as
 * prose, and it is deliberately narrow: ordinary date comparisons elsewhere in the repository are
 * none of its business. It protects three things.
 *
 *   1. Only the canonical modules reach `validityOf`. Anyone else wanting a verdict goes through
 *      `complianceDocumentValidity` (or `qualificationValidity`, its sibling for Academy rows).
 *
 *   2. The functions that consume a compliance-document verdict — dispatch's credential and
 *      medical reads, the documentExpiry tile, the insurance proof, `compliance.medicalEligibility`
 *      — call a canonical entry point, and contain none of the two shapes every retired inline copy
 *      was built from: a document's `verificationStatus` compared with a verification literal, or a
 *      document's `expiresAt` / `issuedAt` / `effectiveFrom` compared with a time.
 *
 *   3. The files that read `complianceDocuments` are a known list. A new reader fails here until
 *      someone has looked at whether it decides validity — the same census `tripStopProvenance`
 *      keeps for trip-stop writers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild(child => walk(child, visit));
}

/** A top-level or nested function, arrow-function const, or object-literal property, by name. */
function findNamed(file: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  walk(file, n => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
    else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === name) found = n.initializer;
  });
  return found;
}

/** The `case "<key>":` clause of a switch, for readers dispatched by widget key. */
function findCase(file: ts.SourceFile, key: string): ts.Node | null {
  let found: ts.Node | null = null;
  walk(file, n => {
    if (!found && ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === key) found = n;
  });
  return found;
}

const calls = (node: ts.Node, names: readonly string[]) => {
  let hit = false;
  walk(node, n => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && names.includes(name)) hit = true;
    }
  });
  return hit;
};

const VERIFICATION_LITERALS = new Set(["needs_review", "verified", "rejected", "uploaded", "extracted", "superseded"]);
const DATE_FIELDS = new Set(["expiresAt", "issuedAt", "effectiveFrom"]);
const RELATIONAL = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Does this expression read `<something>.<field>` for a field in `fields` (including `.field.getTime()`)? */
function readsField(e: ts.Expression, fields: ReadonlySet<string>, receiver?: (r: ts.Expression) => boolean): boolean {
  let hit = false;
  walk(e, n => {
    if (ts.isPropertyAccessExpression(n) && fields.has(n.name.text) && (!receiver || receiver(n.expression))) hit = true;
  });
  return hit;
}

/**
 * The inline-validity shapes inside `node`, as source text. `receiver`, when given, narrows which
 * objects count as a document: `assessCoverage` compares the POLICY's own `expiresAt`, which is the
 * policy's standing and not a document verdict.
 */
function inlineValidity(node: ts.Node, receiver?: (r: ts.Expression) => boolean): string[] {
  const out: string[] = [];
  walk(node, n => {
    if (!ts.isBinaryExpression(n)) return;
    const op = n.operatorToken.kind;
    if (RELATIONAL.has(op) && (readsField(n.left, DATE_FIELDS, receiver) || readsField(n.right, DATE_FIELDS, receiver))) out.push(n.getText());
    if (EQUALITY.has(op)) {
      const status = (e: ts.Expression) => readsField(e, new Set(["verificationStatus"]), receiver);
      const literal = (e: ts.Expression) => ts.isStringLiteral(e) && VERIFICATION_LITERALS.has(e.text);
      if ((status(n.left) && literal(n.right)) || (status(n.right) && literal(n.left))) out.push(n.getText());
    }
  });
  return out;
}

/** The canonical entry points. `candidateVerdict` is the passport's grouping over `complianceRequirementValidity`. */
const CANONICAL = ["complianceRequirementValidity", "documentExpiry", "proofFromDocuments", "complianceDocumentValidity", "candidateVerdict"] as const;

/**
 * Every place a compliance-document verdict is consumed. `mustCall` is false only for a pure
 * mapper that is HANDED the verdict and so has nothing to call.
 */
const CONSUMERS: { file: string; name: string; kind: "fn" | "case"; mustCall: boolean; receiver?: (r: ts.Expression) => boolean }[] = [
  { file: "server/readinessComposer.ts", name: "credentialState", kind: "fn", mustCall: true },
  { file: "server/readinessComposer.ts", name: "policiesCovering", kind: "fn", mustCall: true },
  { file: "server/readinessComposer.ts", name: "composeReadiness", kind: "fn", mustCall: true,
    // The composer compares plenty of other tables' dates (policies, bindings, supervisions). A
    // compliance document reaches it as `opCreds` / a `CredRow`; those are what may not be judged here.
    receiver: r => /\b(opCreds|medRow|medRows|cred|creds|docs?|proof)\b/.test(r.getText()) },
  { file: "server/widgetSources.ts", name: "documentExpiry", kind: "case", mustCall: true },
  { file: "server/widgetSources.ts", name: "presentVerdict", kind: "fn", mustCall: false },
  { file: "server/_core/insuranceRisk.ts", name: "proofFromDocuments", kind: "fn", mustCall: true },
  { file: "server/_core/insuranceRisk.ts", name: "assessCoverage", kind: "fn", mustCall: false,
    receiver: r => /\bdocument\b|\bverdict\b|\bproof\b/.test(r.getText()) },
  { file: "server/insuranceRouter.ts", name: "policiesFor", kind: "fn", mustCall: true },
  { file: "server/_core/compliancePassport.ts", name: "medicalFitnessForDispatch", kind: "fn", mustCall: false },
  { file: "server/complianceRouter.ts", name: "medicalEligibility", kind: "fn", mustCall: true },
  { file: "server/surfacesService.ts", name: "loadExceptionSources", kind: "fn", mustCall: true },
  { file: "server/_core/compliancePassport.ts", name: "evaluateRequirement", kind: "fn", mustCall: true,
    // The requirement's own dates (effectiveFrom, its verificationStatus) are the requirement's
    // standing, not a document's. A credential reaches it as a candidate, `best`, or `c`.
    receiver: r => /^(c|best|candidate|candidates|named|v)$/.test(r.getText()) },
  { file: "server/_core/compliancePassport.ts", name: "candidateVerdict", kind: "fn", mustCall: true },
  { file: "server/_core/requirementEngine.ts", name: "evaluateWorkContext", kind: "fn", mustCall: true,
    receiver: r => /^(c|allCredentials)$/.test(r.getText()) },
  { file: "server/trainingAcademyRouter.ts", name: "foreignTdgRoadRecognize", kind: "fn", mustCall: true,
    receiver: r => /^document$/.test(r.getText()) },
  { file: "server/_core/exceptionCentre.ts", name: "deriveExceptions", kind: "fn", mustCall: false,
    // The centre dates bills, purchase requests and policies too; a credential reaches it as `c` / `v`.
    receiver: r => /^(c|v|c\.verdict)$/.test(r.getText()) },
];

describe("one place decides whether a compliance document is in force", () => {
  it("only the canonical modules reach validityOf", () => {
    const importers = [
      "server/_core/complianceDocumentValidity.ts", "server/_core/qualificationValidity.ts",
      ...readdirTs("server").filter(f => !f.endsWith(".test.ts")),
    ].filter((f, i, all) => all.indexOf(f) === i).filter(f => {
      let hit = false;
      walk(parse(f), n => {
        if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
          && n.importClause.namedBindings.elements.some(e => (e.propertyName ?? e.name).text === "validityOf")) hit = true;
      });
      return hit;
    });
    expect(importers.sort()).toEqual(["server/_core/complianceDocumentValidity.ts", "server/_core/qualificationValidity.ts"]);
  });

  it.each(CONSUMERS)("$file › $name reads the canonical verdict and judges no document itself", ({ file, name, kind, mustCall, receiver }) => {
    const source = parse(file);
    const node = kind === "case" ? findCase(source, name) : findNamed(source, name);
    expect(node, `${name} not found in ${file} — if it moved, move this entry with it`).not.toBeNull();
    if (mustCall) expect(calls(node!, CANONICAL), `${name} must reach its verdict through ${CANONICAL.join(" / ")}`).toBe(true);
    expect(inlineValidity(node!, receiver), `${name} decides validity inline`).toEqual([]);
  });

  it("the guard itself sees the shapes it exists to catch", () => {
    // The retired tile, medical and proof copies, in miniature. If the detector stops seeing these,
    // every assertion above passes vacuously.
    const probe = ts.createSourceFile("probe.ts", `
      function tile(doc, now) { if (doc.verificationStatus === "rejected") return 1; if (new Date(doc.expiresAt).getTime() < now.getTime()) return 2; }
      function medical(c, now) { if (c.expiresAt && c.expiresAt <= now) return 3; if ("needs_review" === c.verificationStatus) return 4; }
      function proof(docs) { return docs.sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0]; }
      function fine(p, now) { return p.coveredUntil > now && p.count > 3; }
    `, ts.ScriptTarget.Latest, true);
    expect(inlineValidity(findNamed(probe, "tile")!)).toHaveLength(2);
    expect(inlineValidity(findNamed(probe, "medical")!)).toHaveLength(2);
    expect(inlineValidity(findNamed(probe, "fine")!)).toEqual([]);
    // Sorting by expiry is selection, not a comparison — which is why each consumer must also CALL
    // the canonical entry point, and `proof` would fail that half.
    expect(calls(findNamed(probe, "proof")!, CANONICAL)).toBe(false);
  });
});

/**
 * Every non-test file under server/ that imports the `complianceDocuments` table. Each entry says
 * how it stands with the canonical verdict. Adding a reader means adding it here, which means
 * saying whether it decides validity.
 */
const READERS: Record<string, string> = {
  "server/readinessComposer.ts": "dispatch: credentials, medical fitness and insurance proof, each through complianceRequirementValidity / proofFromDocuments",
  "server/insuranceRouter.ts": "insurance office: the entity's proof through proofFromDocuments",
  "server/complianceRouter.ts": "medicalEligibility through complianceRequirementValidity; the passport's credentials (with id, capture time and owner) for evaluateRequirement → candidateVerdict; writes decide nothing",
  "server/licenceReads.ts": "a person's driver-licence documents and legacy date for driverLicenceVerdict — open shifts and shift readiness read the licence only through it",
  "server/db.ts": "listComplianceDocuments (the documentExpiry tile's source) and writes; decides nothing",
  "server/surfacesService.ts": "the exception centre: flagged owners' whole history per type through complianceRequirementValidity; exceptionCentre.ts maps the verdicts",
  "server/requirementRouter.ts": "requirement-engine credentials (with id, capture time and owner) for evaluateRequirement → candidateVerdict",
  "server/auditRouter.ts": "copies rows into an audit package verbatim; decides nothing",
  "server/hosRouter.ts": "files a scanned paper log as a needs_review document; decides nothing",
  "server/workforceRouter.ts": "writes a verified credential from verified training; decides nothing",
  "server/trainingAcademyRouter.ts": "foreign TDG recognition requires the named document in force by complianceRequirementValidity",
  // Driver portfolio (#16), added on merging main: both hand the operator's rows to driverPortfolio, whose
  // credential items decide through complianceDocumentValidity. Their own date comparisons are share-link
  // and requirement-binding windows, not documents.
  "server/driverPortfolioRouter.ts": "wallet, dispatch view and credential history through driverPortfolio (complianceDocumentValidity); writes a driver-uploaded credential as needs_review",
  "server/driverPortfolioService.ts": "loads the operator's complianceDocuments rows for driverPortfolio; decides nothing itself",
  // C1b-3's D-05 read adapter (#57), added on merging main.
  "server/qualificationReads.ts": "an Academy grant's evidence document through complianceDocumentValidity; the grant itself through academyVerdict (qualificationValidity)",
};

function readdirTs(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : readdirTs(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

describe("the complianceDocuments readers are a known list", () => {
  it("has exactly the known readers, and a new one fails here until it is looked at", () => {
    const readers = readdirTs("server").filter(f => !/\.test\.tsx?$/.test(f)).filter(f => {
      let hit = false;
      walk(parse(f), n => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /drizzle\/schema$/.test(n.moduleSpecifier.text)
          && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)
          && n.importClause.namedBindings.elements.some(e => (e.propertyName ?? e.name).text === "complianceDocuments")) hit = true;
      });
      return hit;
    });
    expect(readers.sort()).toEqual(Object.keys(READERS).sort());
  });
});

/*
 * SPINE item 2 — "is this person's driver licence in force?" has one answer: driverLicenceVerdict.
 *
 * Open shifts and shift readiness used to read the legacy operators.licenseExpiresAt themselves and
 * treat a future date as in force, while dispatch held the same person at "licence unknown" (the
 * legacy date is an unverified claim, owner's ruling 2026-09-25). Now only the canonical module
 * judges it; these are the only two production files that may touch the legacy column, and both
 * hand it to the verdict.
 */
describe("the driver licence has one verdict", () => {
  it("only the licence adapter and the dispatch composer read operators.licenseExpiresAt, and both ask driverLicenceVerdict", () => {
    const readers = readdirTs("server").filter(f => !/\.test\.tsx?$/.test(f)).filter(f => {
      let hit = false;
      walk(parse(f), n => {
        // `input.licenseExpiresAt` is a procedure argument being written (workforce hiring), not a read.
        if (ts.isPropertyAccessExpression(n) && n.name.text === "licenseExpiresAt" && n.expression.getText() !== "input") hit = true;
      });
      return hit;
    });
    expect(readers.sort()).toEqual(["server/licenceReads.ts", "server/readinessComposer.ts"]);
    for (const f of readers) expect(calls(parse(f), ["driverLicenceVerdict"]), `${f} must judge the licence through driverLicenceVerdict`).toBe(true);
  });

  it("open shifts and shift readiness reach the licence only through the adapter", () => {
    for (const f of ["server/openShiftsService.ts", "server/readinessRouter.ts"]) {
      expect(calls(parse(f), ["driverLicenceStanding"]), `${f} must read the licence through licenceReads.driverLicenceStanding`).toBe(true);
    }
    expect(inlineValidity(findNamed(parse("server/_core/openShifts.ts"), "shiftEligibility")!)).toEqual([]);
  });
});
