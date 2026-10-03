/**
 * Procedure census — what constructors the production routers actually use, from the syntax tree.
 *
 * Gate 5 used to be `grep -cE '\w+:\s*protectedProcedure\b'` over a filename glob. Two things were
 * outside that glob's sight, and the 2026-09-30 diagnostic found both: `server/_core/systemRouter.ts`
 * is mounted on the app router but does not match `server/*Router*.ts`, and `publicProcedure` was not
 * a token the grep looked for at all. A tenant-data `publicProcedure` added under `_core/` would have
 * passed every gate.
 *
 * This walks every non-test TypeScript file under `server/`, finds each identifier that is BOUND BY AN
 * IMPORT from the trpc / recordsAuthorization modules and whose name ends in `Procedure`, and records
 * where it is used as an expression. Comments, string literals, type positions and property NAMES
 * (`testProcedure: z.string()` is a data field) are not expressions, so they are not counted — that
 * is the whole reason to read the tree rather than the text.
 *
 * It enforces two things and pins a third:
 *   1. zero `protectedProcedure` references anywhere in production `server/` — the invariant the old
 *      gate held for its glob, now for the whole tree;
 *   2. the census is non-empty — a walker that finds nothing has broken, and must not pass;
 *   3. every `publicProcedure` / `adminProcedure` site matches the pinned list, so adding one anywhere
 *      is a deliberate, reviewed change to the pin rather than a silent widening.
 *
 * Run: `pnpm exec tsx scripts/procedure-census.ts --enforce` (the gate), or `--json` to see the census.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ProcedureSite = {
  file: string;
  line: number;
  kind: string;
  /** The property the procedure is assigned to, when it is one (`health: publicProcedure…`). */
  procedure: string | null;
};

export type Census = {
  sites: ProcedureSite[];
  byKind: Record<string, number>;
  filesScanned: number;
};

/** Modules that export procedure constructors. A name imported from anywhere else is not one. */
const CONSTRUCTOR_MODULES = /(^|\/)(_core\/)?(trpc|recordsAuthorization)$/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) yield full;
  }
}

/**
 * Every name ending in `Procedure` that a constructor module exports, classified. The census
 * refuses an unclassified one: a new export from those modules must be decided here, not defaulted.
 *
 *   gated      — role-authorised; the ordinary kind
 *   ungated    — bypasses role authorisation; every site is pinned
 *   forbidden  — the pre-B20.2 kind; zero sites, anywhere
 *   helper     — a function about procedures, not a procedure builder; not a site
 */
export const KIND_CLASS = {
  roleProcedure: "gated", externalProcedure: "gated", integrationProcedure: "gated",
  publicProcedure: "ungated", adminProcedure: "ungated",
  // #64 (v23.26): signed in and audited, but no role or permission is checked, so every site is
  // pinned like a public one. Its names are also pinned in SESSION_PROCEDURE_PERMISSIONS.
  sessionProcedure: "ungated",
  protectedProcedure: "forbidden",
  permissionForProcedure: "helper", externalPermissionForProcedure: "helper", integrationPermissionForProcedure: "helper",
} as const satisfies Record<string, "gated" | "ungated" | "forbidden" | "helper">;

/**
 * Local name -> imported name, for every `*Procedure` this file imports from a constructor module.
 * `import { publicProcedure as open }` binds `open` locally and is counted as `publicProcedure`.
 */
function importedConstructors(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!CONSTRUCTOR_MODULES.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const el of clause.namedBindings.elements) {
      const original = (el.propertyName ?? el.name).text;
      if (/Procedure$/.test(original)) names.set(el.name.text, original);
    }
  }
  return names;
}

/** True when this identifier is an expression, not a declaration, a property name, or a type. */
function isExpressionUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p)) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isShorthandPropertyAssignment(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  return true;
}

/** Walk up a `.input(…).query(…)` chain to the property it is assigned to, if any. */
function assignedProperty(node: ts.Node): string | null {
  let cur: ts.Node = node;
  while (cur.parent && (ts.isCallExpression(cur.parent) || ts.isPropertyAccessExpression(cur.parent))) cur = cur.parent;
  const p = cur.parent;
  if (p && ts.isPropertyAssignment(p) && p.initializer === cur) return p.name.getText();
  return null;
}

export function censusOf(root: string): Census {
  const sites: ProcedureSite[] = [];
  let filesScanned = 0;
  for (const file of walk(path.join(root, "server"))) {
    filesScanned++;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constructors = importedConstructors(sf);
    if (constructors.size === 0) continue;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && constructors.has(node.text) && isExpressionUse(node)) {
        sites.push({
          file: path.relative(root, file),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          kind: constructors.get(node.text)!,
          procedure: assignedProperty(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const byKind: Record<string, number> = {};
  for (const s of sites) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { sites, byKind, filesScanned };
}

/** Kinds that bypass role authorisation. Every site of these must be pinned. */
export const UNGATED_KINDS = ["publicProcedure", "adminProcedure", "sessionProcedure"] as const;

export type Pin = { file: string; procedure: string | null; kind: string }[];

export function pinnedSites(census: Census): Pin {
  return census.sites
    .filter(s => (UNGATED_KINDS as readonly string[]).includes(s.kind))
    .map(({ file, procedure, kind }) => ({ file, procedure, kind }));
}

export type Verdict = { ok: true } | { ok: false; reasons: string[] };

/**
 * The gate's judgement. Pure, so the test can hand it a synthetic census and a synthetic pin.
 * A census that scanned nothing or found nothing is a broken walker, not a clean tree.
 */
export function judge(census: Census, pin: Pin): Verdict {
  const reasons: string[] = [];
  if (census.filesScanned === 0 || census.sites.length === 0) {
    reasons.push(`census found ${census.sites.length} procedure sites in ${census.filesScanned} files — the walker is broken, refusing to pass on an empty census`);
    return { ok: false, reasons };
  }
  for (const s of census.sites) {
    const cls = (KIND_CLASS as Record<string, string>)[s.kind];
    if (!cls) reasons.push(`unclassified procedure kind ${s.kind} at ${s.file}:${s.line} — classify it in KIND_CLASS; the census does not guess`);
    else if (cls === "forbidden") reasons.push(`bare ${s.kind} at ${s.file}:${s.line}${s.procedure ? ` (${s.procedure})` : ""}`);
  }
  const key = (p: { file: string; procedure: string | null; kind: string }) => `${p.kind} ${p.file} ${p.procedure ?? "?"}`;
  const want = new Set(pin.map(key));
  const have = new Set(pinnedSites(census).map(key));
  for (const k of have) if (!want.has(k)) reasons.push(`unpinned ungated procedure: ${k} — add it to the pin deliberately or gate it`);
  for (const k of want) if (!have.has(k)) reasons.push(`pinned site no longer exists: ${k} — remove it from the pin`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export const PIN_PATH = "server/_core/procedureCensus.pin.json";

if (process.argv[1] && /procedure-census\.ts$/.test(process.argv[1])) {
  const root = process.cwd();
  const census = censusOf(root);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(census, null, 1));
  } else if (process.argv.includes("--write-pin")) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(root, PIN_PATH), JSON.stringify(pinnedSites(census), null, 1) + "\n");
    console.log(`wrote ${PIN_PATH}: ${pinnedSites(census).length} ungated sites`);
  } else {
    const pin: Pin = JSON.parse(readFileSync(path.join(root, PIN_PATH), "utf8"));
    const v = judge(census, pin);
    console.log(`procedure census: ${census.sites.length} sites in ${census.filesScanned} files — ${Object.entries(census.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    if (!v.ok) { for (const r of v.reasons) console.error(`FAIL: ${r}`); process.exit(1); }
    console.log(`bare protectedProcedure: 0; ungated sites pinned: ${pin.length}`);
  }
}
