/**
 * Guards for the widget tiles' operator identity (see widgetOperatorIdentity.db.test.ts for the
 * behaviour). Two ways back to the defect are closed here without a database:
 *
 *   - the type: where the tile reader expects an operator id, a plain number does not fit;
 *   - the source: the tile reader uses the caller's user id for exactly one thing, acting as them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operatorIdFromRecord, type OperatorId } from "./_core/operatorIdentity";
import type { widgetReaderFor } from "./widgetSources";

type ReadinessSubject = Parameters<NonNullable<Parameters<typeof widgetReaderFor>[3]>>[0];

describe("an operator id is not a user id", () => {
  it("a plain number does not satisfy OperatorId where the reader asks for one", () => {
    const userId: number = 42;
    // @ts-expect-error a user id is a plain number, and a plain number is not an operator id
    const fromUser: OperatorId = userId;
    // @ts-expect-error the readiness subject takes an operator id, not whatever number is to hand
    const subject: ReadinessSubject = { operatorId: userId, unitId: null, trailerId: null, jobId: null };
    const fromRecord: ReadinessSubject = { operatorId: operatorIdFromRecord(7), unitId: null, trailerId: null, jobId: null };
    // The brand is a type, not a value: at runtime an operator id is still the number it was.
    expect([fromUser, subject.operatorId, fromRecord.operatorId]).toEqual([42, 42, 7]);
  });

  it("the tile reader uses the caller's user id only to act as them", () => {
    const source = readFileSync(new URL("./widgetSources.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const uses = source.match(/actor\.userId/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(source).toContain("callerFor(actor.userId)");
  });
});
