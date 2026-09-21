/**
 * 0167 — an approval can name the evaluation it was made from.
 *
 * `0165` freezes what was known at approval time as numbers: coverage per axis, the dependency
 * fingerprint, the segment list. The detail behind those numbers lives in `routeEvidenceEntries` —
 * source, version, verifiedAt and confidence for every check on every segment — and those rows were
 * tagged only with trip, job and segment.
 *
 * So a trip evaluated three times left three indistinguishable sets, and "show me the evidence this
 * approval rests on" had no answer. Not a policy question: evaluations simply had no identity. This
 * gives them one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router = readFileSync("server/spatialRouter.ts", "utf8");
const migration = readFileSync("drizzle/0167_route_evaluation_identity.sql", "utf8");

describe("an evaluation has an identity", () => {
  it("mints one per evaluation, not per row and not per trip", () => {
    // Per row would make it meaningless; per trip would merge the three evaluations it exists to
    // separate. It is minted once, above the loop that writes the evidence.
    const mint = router.indexOf("const evaluationRef = `RE-");
    const write = router.indexOf("insert(routeEvidenceEntries).values({ evaluationRef");
    expect(mint).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(mint);
    expect(router.match(/const evaluationRef = `RE-/g) ?? []).toHaveLength(1);
  });

  it("stamps it on every evidence row the evaluation writes", () => {
    expect(router).toMatch(/for \(const e of verdict\.evidence\) await db\.insert\(routeEvidenceEntries\)\.values\(\{ evaluationRef,/);
  });

  it("returns it, so an approval names the evaluation rather than guessing at one", () => {
    expect(router).toMatch(/return \{ evaluationRef, unitId: input\.unitId/);
  });
});

describe("an approval records which evaluation it approved", () => {
  it("accepts and stores the reference", () => {
    expect(router).toMatch(/evaluationRef: z\.string\(\)\.min\(1\)\.max\(64\)\.optional\(\)/);
    expect(router).toMatch(/insert\(routeApprovals\)\.values\(\{ approvalRef, evaluationRef: input\.evaluationRef \?\? null/);
  });

  it("stores null rather than borrowing the most recent evaluation when none is given", () => {
    /*
     * The tempting shortcut — "look up the latest evaluation for this trip" — is what this whole
     * change exists to prevent. An approval with no named evaluation is a weaker record and should
     * read as one; inferring the newest set would attach evidence to an approval that may never
     * have seen it.
     */
    expect(router).toMatch(/evaluationRef: input\.evaluationRef \?\? null/);
    expect(router).not.toMatch(/orderBy\([^)]*evaluatedAt[^)]*desc/i);
  });
});

describe("the columns exist and are indexed for the join they are for", () => {
  it("adds the reference to both tables", () => {
    expect(migration).toMatch(/ALTER TABLE `routeEvidenceEntries`\s*\n\s*ADD COLUMN `evaluationRef`/);
    expect(migration).toMatch(/ALTER TABLE `routeApprovals`\s*\n\s*ADD COLUMN `evaluationRef`/);
  });

  it("indexes the evidence side, which is the side that gets searched", () => {
    // The question is always "the rows for this ref", never "the ref for this row".
    expect(migration).toMatch(/CREATE INDEX `ree_evaluation` ON `routeEvidenceEntries` \(`evaluationRef`\)/);
  });

  it("is additive — nothing is backfilled, because nothing can be", () => {
    /*
     * Existing evidence rows genuinely cannot be assigned to an evaluation: that is the information
     * that was never recorded. Inventing a backfill would manufacture exactly the false precision
     * this is meant to remove, so historical rows stay null and read as unattributable.
     */
    expect(migration).not.toMatch(/UPDATE `routeEvidenceEntries`/);
    expect(migration).not.toMatch(/UPDATE `routeApprovals`/);
  });
});
