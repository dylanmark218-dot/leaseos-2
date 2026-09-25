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
    removed: ["detectBookingConflicts", "BookingConflict"],
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
