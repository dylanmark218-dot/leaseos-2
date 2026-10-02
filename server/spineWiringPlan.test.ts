/**
 * The SPINE moratorium is self-proving, or it is not a moratorium.
 *
 * `docs/register/SPINE_WIRING_PLAN.md` was cited by the reachability census, by the
 * Secretary moratorium document and by SPINE item 1 for two days while it did not exist
 * in this repository — it lived in the sibling, and every claim of compliance here rested
 * on a quotation. This guard makes that impossible to repeat:
 *
 *     canonical plan exists, byte-identical to its provenance record
 *         ↓
 *     the moratorium sentence and the ordering section are in it
 *         ↓
 *     the engines it places on the spine are real, and the census names them
 *         ↓
 *     nothing in the tree cites the plan by any other path
 *
 * It reads headings, table rows and sentences, never line numbers. A citation that says
 * `SPINE_WIRING_PLAN.md:47-49` is not checked for its numbers here; what is checked is
 * that the file it names exists and still says what is quoted from it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PLAN = "docs/register/SPINE_WIRING_PLAN.md";
const PROVENANCE = "docs/register/SPINE_WIRING_PLAN_PROVENANCE.md";
const CENSUS = "server/engineReachability.test.ts";

/** Prose wraps at 100 columns; compare sentences with whitespace collapsed. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const walk = (dir: string, keep: (name: string) => boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") return [];
    const path = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(path, keep) : keep(e.name) ? [path] : [];
  });

const plan = existsSync(PLAN) ? readFileSync(PLAN, "utf8") : null;
const text = plan === null ? "" : flat(plan);

describe("the canonical SPINE plan exists", () => {
  it("is at the path the code cites", () => {
    expect(plan, `${PLAN} is missing; the moratorium has no text`).not.toBeNull();
  });

  it("matches the hash its provenance record states", () => {
    const record = readFileSync(PROVENANCE, "utf8");
    const stated = record.match(/sha256\s*\|\s*`([0-9a-f]{64})`/)?.[1];
    expect(stated, `${PROVENANCE} states no sha256`).toBeDefined();
    const actual = createHash("sha256").update(readFileSync(PLAN)).digest("hex");
    // The canonical copy is the sibling repository's. A change lands there first and is
    // restored here with a new hash in the record — never edited in place under this name.
    expect(actual).toBe(stated);
  });
});

describe("the moratorium is in it", () => {
  it("states the rule the census and the Secretary layer are held to", () => {
    expect(text).toContain("The moratorium stands: no new engines until this path is wired.");
  });

  it("orders the work, and the order is the one the dependencies force", () => {
    expect(plan).toMatch(/^## The ordering the dependencies force$/m);
    const ordering = text.slice(text.indexOf("The ordering the dependencies force"));
    const items = [
      "1. **Per-boundary confirmation on `tripStops`.**",
      "2. **Resolve the four duplications before wiring any of them.**",
      "3. **`offlineCapability` → HS1.**",
      "4. **Then the rest of the spine**",
    ];
    let cursor = 0;
    for (const item of items) {
      const at = ordering.indexOf(item, cursor);
      expect(at, `ordering item not found in sequence: ${item}`).toBeGreaterThan(-1);
      cursor = at + item.length;
    }
  });

  it("says what kind of work the moratorium permits", () => {
    expect(text).toContain(
      "Nothing above needs a new engine. Every item is either a deletion, a resolver, or a router over something already written — which is the point of the moratorium."
    );
  });
});

describe("the reachability census is consistent with it", () => {
  /** The engines the plan places on the spine, read from its table. */
  const spineEngines = (): string[] => {
    const heading = plan!.match(/^## On the spine — (\d+) engines$/m);
    expect(heading, "the plan has no 'On the spine' heading").not.toBeNull();
    const section = plan!.slice(heading!.index!).split(/\n## /)[0];
    const names = Array.from(section.matchAll(/^\| `([A-Za-z0-9_/]+)` \|/gm)).map(m => m[1]!);
    expect(names.length, "the heading's count and the table disagree").toBe(Number(heading![1]));
    return names;
  };

  it("names only engines that exist under server/_core", () => {
    for (const name of spineEngines()) {
      expect(existsSync(`server/_core/${name}.ts`), `${name} is on the spine but not in the tree`).toBe(true);
    }
  });

  it("names only engines the census accounts for, declared or reached", () => {
    const census = readFileSync(CENSUS, "utf8");
    // Every production source, _core included: the reachability census counts an engine reached
    // when any wired production module imports it, transitively — complianceDocumentValidity is
    // reached through marketplaceReadiness (0192) and no router names it directly. Reading only the
    // routers here called that "neither declared nor reached" while the census called it wired.
    const production = walk("server", n => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n))
      .map(p => readFileSync(p, "utf8"))
      .join("\n");
    for (const name of spineEngines()) {
      const declared = new RegExp(`^\\s*"?${name}"?:`, "m").test(census);
      const reached = new RegExp(`/${name}["']`).test(production);
      expect(declared || reached, `${name} is on the spine, and the census neither declares nor reaches it`).toBe(true);
    }
  });

  it("is what the census cites as the moratorium's text, and by this path", () => {
    // The census invokes the plan as its reason for declaring the Secretary layer unwired
    // (on the branch that carries that layer). Whether or not it does on this branch, any
    // citation anywhere in the tree must name the file that exists.
    const files = [
      ...walk("server", n => /\.tsx?$/.test(n)),
      ...walk("docs", n => n.endsWith(".md")),
      ...readdirSync(".").filter(n => n.endsWith(".md")),
    ];
    const wrong: string[] = [];
    for (const file of files) {
      const body = readFileSync(file, "utf8");
      for (const m of body.matchAll(/([A-Za-z0-9_./-]*SPINE_WIRING_PLAN\.md)/g)) {
        const cited = m[1]!;
        if (cited !== PLAN && cited !== "SPINE_WIRING_PLAN.md") wrong.push(`${file}: ${cited}`);
      }
    }
    expect(wrong, "a citation names the plan by a path that is not the canonical one").toEqual([]);
  });
});
