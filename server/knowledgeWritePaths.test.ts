/**
 * P4.4 — reproduced text has exactly the write paths we chose.
 *
 * Two tables hold other people's words, under two different rules:
 *
 *   the corpus (`knowledgeSources` / `knowledgeDocuments` / `knowledgeChunks`) — sourced material,
 *     written **only** through `_core/knowledge/repository.ts`, behind the licence gate, every chunk
 *     carrying `authorizedByAssessmentId` so a revoked licence can find its rows;
 *   the passage library (`knowledgePassages`) — what the assistant quotes back, written through
 *     `assistant.addPassage`, which since `0150` requires a stated basis: the organization's own
 *     document with the person who said so, or a licence assessment that permits showing it to a
 *     person (`commercial_redisplay`, the gate's most demanding purpose).
 *
 * The rule is easy to break by accident: an insert added anywhere else bypasses both. This reads
 * the source and fails if a write path appears that is not one of the two, which is the failure
 * mode a licence obligation actually has.
 *
 * What a pass here does and does not mean, stated precisely because an earlier version of this note
 * got it wrong and called the guard vacuous.
 *
 * It DOES prove the authorized writer exists. The corpus assertion is
 * `toEqual(["server/_core/knowledge/repository.ts"])`, not a subset check, so the file has to
 * contain a write to each of the three tables or this goes red — `repository.ts` inserts
 * `knowledgeSources` (line 67), `knowledgeDocuments` (131) and `knowledgeChunks` (229). Delete
 * those and the test fails. It also enumerates its subjects from source rather than from a list
 * somebody maintains: every file under `server`, `scripts`, `drizzle` and `client/src` is scanned
 * for three shapes of insert, so a writer added anywhere fails this without being remembered.
 *
 * It does NOT prove anything CALLS the writer. Nothing in production imports
 * `_core/knowledge/repository.ts`, so the rule is enforced over a path that exists and is not
 * reached. That is a real gap and it is a different guard's job —
 * `engineReachability.test.ts` declares `knowledge/repository` unwired, which is where the
 * unreachability is recorded. The two guards together say the true thing: the write path is
 * correct, singular, and not yet connected.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() && e.name !== "node_modules" ? walk(`${dir}/${e.name}`)
      : /\.(ts|tsx|mjs|js|sql)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : []);

/* Every production tree that could hold a writer, not only the router we happen to know about:
 * server code, the scripts an operator runs (importers, backfills, seeds) and the migration SQL. A
 * raw INSERT in an import script bypasses the gate exactly as an ORM call does. */
const TREES = ["server", "scripts", "drizzle", "client/src"].filter(existsSync);
const files = TREES.flatMap(walk);
const CORPUS = ["knowledgeSources", "knowledgeDocuments", "knowledgeChunks"];

/** The chosen paths. Anything else writing these tables is the finding. */
const ALLOWED: Record<string, string> = {
  "drizzle/0150_passage_reproduction_basis.sql": "adds the basis columns and backfills pre-rule rows to 'unstated'; it classifies nothing and admits no new text",
  "drizzle/0151_passage_basis_correction.sql": "separates sourceId from the stamped assessment and moves 0150's misplaced value; it admits no new text",
  "server/_core/knowledge/repository.ts": "the corpus's only writer, by design; it runs the licence gate and stamps the authorizing assessment",
  "server/assistantAskRouter.ts": "the passage library's only writer; since 0150 it requires a stated reproduction basis and records who stated it",
};

/* Three ways a row gets in, all of them counted: the ORM call, raw SQL through a pool or a
 * `sql` template, and a migration that seeds rows rather than only shaping the table. Matching only
 * `insert(table)` would have let an importer using pool.execute("INSERT INTO ...") through. */
const writersOf = (table: string) =>
  files.filter(f => {
    const src = readFileSync(f, "utf8");
    return new RegExp(`insert\\(${table}\\)`).test(src)
      || new RegExp(`(INSERT\\s+INTO|REPLACE\\s+INTO|LOAD\\s+DATA[\\s\\S]{0,80}INTO\\s+TABLE)\\s+\`?${table}\`?`, "i").test(src);
  }).sort();

describe("reproduced text has exactly the write paths we chose", () => {
  it("lets nothing but the repository write the corpus tables", () => {
    for (const table of CORPUS) {
      expect(writersOf(table), `${table} is written outside the repository`).toEqual(["server/_core/knowledge/repository.ts"]);
    }
  });

  it("lets nothing but the assistant router write the passage library", () => {
    expect(writersOf("knowledgePassages")).toEqual(["server/assistantAskRouter.ts"]);
  });

  it("names every writer of a table that holds other people's words, with its reason", () => {
    const writers = new Set([...CORPUS, "knowledgePassages"].flatMap(t => writersOf(t)));
    for (const w of writers) expect(ALLOWED[w], `${w} writes reproduced text with no recorded reason`).toBeTruthy();
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(30);
  });

  it("keeps the database defaults that back the rules up", () => {
    const repo = readFileSync("server/_core/knowledge/repository.ts", "utf8");
    expect(repo).toMatch(/authorizedByAssessmentId/);          // a chunk says what permitted it
    expect(repo).toMatch(/checkSourceGate|licenceFor/);        // and the gate decided
    const router = readFileSync("server/assistantAskRouter.ts", "utf8");
    expect(router).toMatch(/reproductionBasis/);
    expect(router).toMatch(/loadedByUserId: ctx\.user\.id/);   // an anonymous copy is not a record
    expect(router).toMatch(/commercial_redisplay/);            // quoting to a person is that purpose
  });

  it("keeps the licence test seam out of production code: a licence is granted by an assessment, not by a call", () => {
    // sourceGate guards it at runtime (it throws outside a test), but a call in production code
    // would still be a line that reads as if code can grant a licence. Nothing outside a test may
    // name it.
    const callers = files.filter(f => /__registerAssessmentForTest|__clearTestAssessments/.test(readFileSync(f, "utf8")));
    expect(callers, "production code names the licence test seam").toEqual(["server/_core/knowledge/sourceGate.ts"]);
    const gate = readFileSync("server/_core/knowledge/sourceGate.ts", "utf8");
    expect(gate).toMatch(/process\.env\.VITEST/);            // and the runtime guard is still there
    expect(gate).toMatch(/REAL_SOURCE_IDS/);                  // clearing restores the real set, not a hard-coded id
  });
});
