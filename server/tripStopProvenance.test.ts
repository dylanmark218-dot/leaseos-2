/**
 * A trip stop names who recorded it.
 *
 * `tripStops` is the spine's own evidence table — every site baseline, every
 * billable minute and every passport package reads from it — and until `0179` (leaseos's `0169`, reconciled forward) it
 * recorded neither the actor nor the means. Both write paths had the actor in
 * hand: `tripStops.create` / `.update` are `roleProcedure`s holding `ctx.user.id`
 * and threw it away, and the table carried `createdAt` with no `updatedAt`, so an
 * edit left no trace at all.
 *
 * This reads the source rather than the database, because the defect was never a
 * runtime failure. Every write succeeded; the fact simply was not kept. A test
 * that exercised the procedure would have passed before the fix and after it.
 *
 * What is NOT asserted here: per-boundary confirmation. Which of the five
 * timestamps a person stands behind is a different fact — `siteBaseline` reads it
 * and it is still outstanding. Row provenance does not supply it and does not
 * claim to.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routers = readFileSync("server/routers.ts", "utf8");
const assistant = readFileSync("server/_core/assistantCommitService.ts", "utf8");
const schema = readFileSync("drizzle/schema.ts", "utf8");

/** The `proposalFields.source` vocabulary. A second one would be the defect. */
const SOURCE_VALUES = ["driver_voice", "driver_typed", "gps", "photo_ocr", "system_inferred", "imported", "human_corrected"];

const tripStopsBlock = (() => {
  const i = schema.indexOf('mysqlTable("tripStops"');
  return schema.slice(i, schema.indexOf("});", i));
})();

describe("tripStops records its actor", () => {
  it("carries the provenance columns", () => {
    for (const col of ["recordedByUserId", "recordedSource", "updatedByUserId", "updatedSource", "updatedAt"]) {
      expect(tripStopsBlock, `tripStops has no ${col}`).toContain(col);
    }
  });

  it("reuses the proposalFields vocabulary rather than minting a second one", () => {
    // The enum is spelled out in the schema; every member must be one of theirs.
    const declared = Array.from(tripStopsBlock.matchAll(/mysqlEnum\("(?:recorded|updated)Source", \[([^\]]+)\]/g))
      .flatMap(m => m[1]!.split(",").map(v => v.trim().replace(/"/g, "")));
    expect(declared.length).toBeGreaterThan(0);
    for (const v of declared) expect(SOURCE_VALUES, `${v} is not a proposalFields.source value`).toContain(v);
  });

  it("stamps the actor on the direct create path", () => {
    const i = routers.indexOf("return createTripStop({");
    const call = routers.slice(i, i + 900);
    expect(call).toContain("recordedByUserId: ctx.user.id");
    expect(call).toContain('recordedSource: "driver_typed"');
  });

  it("stamps the actor and a time on the direct update path", () => {
    const i = routers.indexOf("return updateTripStop(id, {");
    const call = routers.slice(i, i + 500);
    expect(call).toContain("updatedByUserId: ctx.user.id");
    expect(call).toContain("updatedAt: new Date()");
  });

  it("stamps the actor on the assistant path and deliberately leaves the source null", () => {
    const i = assistant.indexOf(".update(tripStops)");
    const call = assistant.slice(i, i + 1200);
    expect(call).toContain("updatedByUserId: actorUserId");
    // Not a row-level guess: the per-field provenance lives in proposalFields and
    // is reached through the commit receipt. A collapsed value would be less true.
    expect(call).not.toContain("updatedSource:");
  });

  it("has no write path left that discards the actor", () => {
    // Both writers, named. A third arriving without provenance is the thing this
    // test exists to catch — the derivation that inferred "a person typed it"
    // from the absence of an assistant receipt only held while there were two.
    const writers = [
      ...Array.from(routers.matchAll(/(?:create|update)TripStop\(/g)).map(() => "server/routers.ts"),
      ...Array.from(assistant.matchAll(/\.update\(tripStops\)/g)).map(() => "server/_core/assistantCommitService.ts"),
    ];
    expect(writers).toHaveLength(3);   // create + update in routers, one in the assistant service
  });
});
