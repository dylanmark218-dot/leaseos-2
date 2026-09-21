/**
 * No durable read capability for stored objects.
 *
 * `/manus-storage/{key}` was an Express route that took a key straight from the
 * URL and minted a signed GET with the server's own storage credential — no
 * session, no role, no tenant, no ownership lookup, no rate limit and no access
 * event. Possession of a key was the entire access check, and for a restricted
 * record the access log would have read clean while being wrong.
 *
 * It was deleted rather than gated: a gated proxy would be a second
 * authorization path to the same bytes, and the aligned one already exists —
 * `storageGetSignedUrl` called inside a role-gated procedure that has resolved
 * the object to its owning record.
 *
 * ## Why this test checks the mint site and not just the string
 *
 * The first audit of this concluded "no production column holds a
 * /manus-storage/ path" from a grep for that literal. It was wrong. The literal
 * appears in exactly one place — `storage.ts`, where the string was built — and
 * flowed everywhere else as `stored.url`, including into `evidenceRecords`
 * (`routers.ts`) and out of `_core/imageGeneration.ts`. A value-flow defect is
 * invisible to a literal search by construction.
 *
 * So the invariant is enforced at the source: **`storagePut` cannot return a
 * URL.** Its declared return type is `{ key: string }`, so there is no `.url` to
 * assign, and `tsc` rejects any caller that tries. That is a stronger guarantee
 * than any scan of consumers, because it makes the bad value unconstructable
 * rather than merely unobserved.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() && e.name !== "node_modules" ? walk(`${dir}/${e.name}`)
      : /\.(ts|tsx|sql)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : []);

const TREES = ["server", "scripts", "client/src", "drizzle"].filter(existsSync);
const files = TREES.flatMap(walk);
const source = (f: string) => readFileSync(f, "utf8");

/**
 * Comments removed before scanning. The headers explaining why this path was
 * deleted name it, and a path named in its own obituary is not a carrier — the
 * same false positive `engineReachability` hit when a module appeared to import
 * itself out of a usage example.
 */
const code = (f: string) =>
  source(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*--.*$/gm, "")     // SQL
    // A path named in order to REFUSE it is not a carrier either. The input
    // refinements in `routers.ts` and the retiring migration's WHERE clause both
    // have to spell it out to reject or clear it.
    .replace(/startsWith\("\/manus-storage\/"\)/g, "")

describe("stored objects have no durable read capability", () => {
  it("has no storagePut that can return a URL", () => {
    const storage = source("server/storage.ts");
    // The mint site. If this returns only a key, no `.url` exists downstream.
    expect(storage).toMatch(/export async function storagePut[\s\S]*?\): Promise<\{ key: string \}>/);
    expect(storage).not.toMatch(/url:\s*`\/manus-storage/);
  });

  it("has deleted the proxy rather than gating it", () => {
    expect(existsSync("server/_core/storageProxy.ts")).toBe(false);
    for (const f of files) {
      expect(code(f), `${f} registers a storage proxy route`).not.toMatch(/manus-storage\/\*/);
    }
  });

  it("carries the path in no production file, migration included", () => {
    // Still worth asserting — it is the literal half of the rule. It is simply
    // not the whole rule, which is why the test above exists.
    // One exemption, and only one: the migration that retires the path has to name
    // it in a WHERE clause to clear the rows already carrying it. Nothing else may.
    const RETIRING_MIGRATION = "drizzle/0168_retire_storage_capability_urls.sql";
    const carriers = files.filter(f => f !== RETIRING_MIGRATION && /\/manus-storage\//.test(code(f)));
    expect(carriers).toEqual([]);
  });

  it("never persists a storagePut result into a storageUrl column", () => {
    const offenders = files.filter(f => /storageUrl:\s*stored\.|storageUrl:\s*\w+\.url\b/.test(code(f)));
    expect(offenders, "a mint result is being persisted as a durable URL").toEqual([]);
  });

  it("keeps the authorized read path available", () => {
    // Deleting the proxy must not have removed the way objects are legitimately read.
    const storage = source("server/storage.ts");
    expect(storage).toMatch(/export async function storageGetSignedUrl/);
    expect(storage).not.toMatch(/export async function storageGet\b/);  // the dead one is gone
  });
});
