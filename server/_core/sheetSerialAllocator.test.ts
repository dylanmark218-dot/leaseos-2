import { describe, it, expect } from "vitest";
import { affectedRowsFrom, assertExactlyOneRowUpdated, singleNumberFrom } from "./sheetSerialAllocator";

describe("affectedRowsFrom recognises real driver shapes and fails closed otherwise", () => {
  it("reads mysql2 affectedRows", () => { expect(affectedRowsFrom({ affectedRows: 1, insertId: 0 })).toBe(1); });
  it("reads a rowsAffected shape", () => { expect(affectedRowsFrom({ rowsAffected: 1 })).toBe(1); });
  it("reads the header out of a [header, fields] tuple", () => {
    expect(affectedRowsFrom([{ affectedRows: 1 }, []])).toBe(1);
  });
  it("reports zero as zero rather than throwing", () => { expect(affectedRowsFrom({ affectedRows: 0 })).toBe(0); });
  // The bug this replaces: `undefined === 0` is false, so the old guard was a no-op.
  it("throws on an unrecognised shape instead of yielding undefined", () => {
    expect(() => affectedRowsFrom({ someOtherName: 1 })).toThrow();
    expect(() => affectedRowsFrom(null)).toThrow();
    expect(() => affectedRowsFrom(undefined)).toThrow();
    expect(() => affectedRowsFrom("1")).toThrow();
  });
  it("throws when the count is present but not a number", () => {
    expect(() => affectedRowsFrom({ affectedRows: "1" })).toThrow();
  });
});

describe("assertExactlyOneRowUpdated", () => {
  it("passes on exactly one", () => { expect(assertExactlyOneRowUpdated(1, "T1.X")).toBe(undefined); });
  it("throws on zero — this is the stale-LAST_INSERT_ID defence", () => {
    expect(() => assertExactlyOneRowUpdated(0, "T1.X")).toThrow();
  });
  it("throws on more than one — a wrong scope key matched several counters", () => {
    expect(() => assertExactlyOneRowUpdated(2, "T1.X")).toThrow();
  });
  it("names the scope and the count so the failure is diagnosable", () => {
    let msg = "";
    try { assertExactlyOneRowUpdated(0, "T1.CVTDGROAD20261"); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("T1.CVTDGROAD20261");
    expect(msg).toContain("0");
  });
});

describe("singleNumberFrom", () => {
  it("reads a plain row array", () => { expect(singleNumberFrom([{ firstSequence: 1201 }], "firstSequence")).toBe(1201); });
  it("reads a [rows, fields] tuple", () => { expect(singleNumberFrom([[{ firstSequence: 7 }], []], "firstSequence")).toBe(7); });
  it("coerces a bigint, which is what LAST_INSERT_ID can return", () => {
    expect(singleNumberFrom([{ firstSequence: BigInt(99) }], "firstSequence")).toBe(99);
  });
  it("coerces a numeric string", () => { expect(singleNumberFrom([{ firstSequence: "42" }], "firstSequence")).toBe(42); });
  // Zero is what a wrong-connection read returns. buildSerial would mint 000000.
  it("refuses zero", () => { expect(() => singleNumberFrom([{ firstSequence: 0 }], "firstSequence")).toThrow(); });
  it("refuses a missing column, empty result, or null", () => {
    expect(() => singleNumberFrom([{ other: 1 }], "firstSequence")).toThrow();
    expect(() => singleNumberFrom([], "firstSequence")).toThrow();
    expect(() => singleNumberFrom(null, "firstSequence")).toThrow();
  });
  it("refuses a non-integer", () => { expect(() => singleNumberFrom([{ firstSequence: 1.5 }], "firstSequence")).toThrow(); });
});
