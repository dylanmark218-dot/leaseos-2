/**
 * SPINE item 2 — a removed duplicate stays removed.
 *
 * Item 2 of the SPINE wiring plan is "resolve the duplications before wiring any of them". Where one
 * question had two answers, one was kept and the other deleted (docs/register/SPINE_ITEM2_DUPLICATIONS.md).
 * The risk after a deletion is quiet re-creation: someone needs "does this booking overlap?" and
 * writes the helper again beside the engine it was removed from, and there are two answers again.
 *
 * This fails if any declaration with a removed name reappears anywhere in server, shared or client
 * code, and if a surviving implementation disappears (so the pairing cannot be satisfied by deleting
 * both). Declarations are found with the TypeScript parser, so a comment or a string that mentions a
 * name — as this header and the register do — is not a declaration and is not counted.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** One row per removed duplicate: the names that must not be declared again, and where the survivor lives. */
const REMOVED = [
  {
    question: "is this resource already booked for an overlapping window?",
    removed: ["detectBookingConflicts", "Booking", "BookingConflict"],
    from: "server/_core/dispatchMatching.ts",
    survivor: { file: "server/_core/dispatchAward.ts", name: "decideAward" },
  },
  {
    question: "which ticket lines may be billed, and which wait or block?",
    removed: ["splitByDisposition"],
    from: "server/_core/fieldTicket.ts",
    survivor: { file: "server/_core/invoiceDraft.ts", name: "draftFromTicket" },
  },
  {
    question: "what sentence does a field-ticket signature record as agreed?",
    removed: ["buildSignedScopeStatement", "SignedScopeInput"],
    from: "server/_core/fieldTicket.ts",
    survivor: { file: "server/closeoutRouter.ts", name: "recordSignature" },
  },
  {
    question: "what is a field ticket's signature status?",
    removed: ["deriveSignatureStatus"],
    from: "server/_core/fieldTicket.ts",
    survivor: { file: "server/closeoutRouter.ts", name: "recordSignature" },
  },
  {
    question: "may this person take this posted shift?",
    removed: ["EligibilityReason"],
    from: "server/openShiftsRouter.ts",
    survivor: { file: "server/_core/openShifts.ts", name: "shiftEligibility" },
  },
] as const;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(`${dir}/${e.name}`))
      : /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [`${dir}/${e.name}`] : []);

/** Every name declared at any depth: functions, classes, types, interfaces, enums, variables. */
function declaredNames(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isTypeAliasDeclaration(n)
      || ts.isInterfaceDeclaration(n) || ts.isEnumDeclaration(n)) && n.name) names.push(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

const files = ["server", "shared", "client/src"].filter(existsSync).flatMap(walk);
const declared = new Map(files.map(f => [f, new Set(declaredNames(f, readFileSync(f, "utf8")))]));

describe("the parser sees declarations, not mentions", () => {
  it("finds declared names and ignores comments and strings", () => {
    const names = declaredNames("x.ts", `
      // function detectBookingConflicts() {}
      const s = "type BookingConflict = {}";
      export function kept() { const inner = 1; return inner; }
      type Alias = number;`);
    expect(names.sort()).toEqual(["Alias", "inner", "kept", "s"]);
  });
});

describe("SPINE item 2 — each question has one answer", () => {
  for (const row of REMOVED) {
    it(`"${row.question}" — ${row.removed.join(", ")} is not declared again anywhere`, () => {
      const found = [...declared].flatMap(([f, names]) => row.removed.filter(n => names.has(n)).map(n => `${f}: ${n}`));
      expect(found, `Removed from ${row.from} by SPINE item 2; the one answer is ${row.survivor.name} in ${row.survivor.file}. Use it rather than re-creating the duplicate.`).toEqual([]);
    });

    it(`"${row.question}" — the survivor ${row.survivor.name} still exists in ${row.survivor.file}`, () => {
      expect(declared.get(row.survivor.file)?.has(row.survivor.name), `${row.survivor.file} no longer declares ${row.survivor.name}`).toBe(true);
    });
  }
});

/**
 * openShifts: the router reads records and enforces the engine's verdict; it judges nothing. Both
 * the view and the work-taking action go through `shiftEligibility`, so they cannot disagree, and
 * none of the judging helpers or refusal codes appear in the router to start a second rule.
 */
describe("SPINE item 2 — the open-shift router enforces the one rule and holds none of its own", () => {
  const ROUTER = "server/openShiftsRouter.ts";
  const sf = ts.createSourceFile(ROUTER, readFileSync(ROUTER, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** The procedure name passed to roleProcedure("…") at the root of the chain a node sits in. */
  const procedureOf = (node: ts.Node): string | null => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (!ts.isCallExpression(n)) continue;
      let e: ts.Expression = n.expression;
      while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) {
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "roleProcedure") {
          const a = e.arguments[0];
          return a && ts.isStringLiteralLike(a) ? a.text : null;
        }
        e = ts.isPropertyAccessExpression(e) ? e.expression : e.expression;
      }
    }
    return null;
  };
  const calls: { callee: string; procedure: string | null }[] = [];
  const strings: string[] = [];
  const imported: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push({ callee: n.expression.text, procedure: procedureOf(n) });
    if (ts.isStringLiteralLike(n)) strings.push(n.text);
    if (ts.isImportSpecifier(n)) imported.push((n.propertyName ?? n.name).text);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  it("both the view (shifts.eligibility) and the action (shifts.expressInterest) ask shiftEligibility", () => {
    const asking = calls.filter(c => c.callee === "shiftEligibility").map(c => c.procedure).sort();
    expect(asking).toEqual(["shifts.eligibility", "shifts.expressInterest"]);
    expect(calls.some(c => c.callee === "expressInterest" && c.procedure === "shifts.expressInterest")).toBe(true);
  });

  it("imports none of the judging helpers the rule is made of", () => {
    for (const helper of ["readExpiry", "isAbsent", "isOnShift", "isAvailable", "missingFrom", "qualificationValidity", "candidatesFor"]) {
      expect(imported, `${ROUTER} imports ${helper} — eligibility is judged in _core/openShifts.ts`).not.toContain(helper);
    }
  });

  it("declares the rule in one place: shiftEligibility and candidatesFor exist only in _core/openShifts.ts", () => {
    const where = [...declared].filter(([, names]) => names.has("shiftEligibility") || names.has("candidatesFor")).map(([f]) => f);
    expect(where).toEqual(["server/_core/openShifts.ts"]);
  });

  it("names none of the rule's refusal codes", () => {
    const CODES = ["not_in_organization", "wrong_role", "not_rostered", "on_approved_leave", "overlaps_existing", "no_licence_recorded", "licence_expired", "qualification_unknown", "qualification_unverified", "qualification_expired"];
    expect(strings.filter(x => CODES.includes(x))).toEqual([]);
  });
});

/**
 * Field-ticket signature: whether a ticket carries the signature it needs is decided once, by
 * `fieldTicketSignatureVerdict` (_core/fieldTicketSignature.ts), from every signature row, every
 * revision and the ticket's record. Before it, invoicing asked "does any row say accepted?", closeout
 * "does the newest row exist?", and the portal read the denormalized column — three answers that
 * diverged on a stale or disagreeing record. This fails if a file that reads signatures compares a
 * signature's `result` or a ticket's `signatureStatus` to a signature outcome again, or if a consumer
 * stops asking the verdict. A row-existence check that locks the workflow (no second signature, no
 * edit after signing) is a lock, not a verdict, and is not what this counts.
 */
describe("SPINE item 2 — a field ticket's signature has one verdict", () => {
  const RULE = "server/_core/fieldTicketSignature.ts";
  const OUTCOMES = new Set(["unsigned", "accepted", "partially_accepted", "refused", "no_representative"]);
  const readers = files.filter(f => f !== RULE && !/\.test\.tsx?$/.test(f) && /fieldTicketSignatures|signatureStatus/.test(readFileSync(f, "utf8")));

  /** `a.result === "accepted"`, `t.signatureStatus !== "unsigned"` and the like: a signature outcome judged in place. */
  const judgedInPlace = (file: string, text: string): string[] => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found: string[] = [];
    const isField = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && (e.name.text === "result" || e.name.text === "signatureStatus");
    const isOutcome = (e: ts.Expression) => ts.isStringLiteralLike(e) && OUTCOMES.has(e.text);
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)
        && ((isField(n.left) && isOutcome(n.right)) || (isField(n.right) && isOutcome(n.left)))) {
        found.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText()}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  };

  it("finds an in-place judgement, and not a mention", () => {
    expect(judgedInPlace("x.ts", `const a = s.result === "accepted"; const b = "x.signatureStatus === 'refused'"; const c = s.kind === "accepted";`)).toHaveLength(1);
  });

  it("no file that reads signatures judges a signature outcome itself", () => {
    expect(readers.flatMap(f => judgedInPlace(f, readFileSync(f, "utf8"))), `Ask fieldTicketSignatureVerdict (${RULE}); a signature row is evidence, not the verdict`).toEqual([]);
  });

  it("invoicing, closeout and the portal's daily count ask the verdict; the draft and the closeout state take it", () => {
    for (const f of ["server/invoicingRouter.ts", "server/closeoutRouter.ts", "server/portalRouter.ts"]) {
      expect(readFileSync(f, "utf8"), `${f} no longer asks fieldTicketSignatureVerdict`).toMatch(/fieldTicketSignatureVerdict\(/);
    }
    expect(readFileSync("server/_core/invoiceDraft.ts", "utf8")).toMatch(/signature: SignatureVerdict/);
    expect(readFileSync("server/_core/siteCloseout.ts", "utf8")).toMatch(/signature: SignatureVerdict/);
    expect([...declared].filter(([, names]) => names.has("fieldTicketSignatureVerdict")).map(([f]) => f)).toEqual([RULE]);
  });
});
