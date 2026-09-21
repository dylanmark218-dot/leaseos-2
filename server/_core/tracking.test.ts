import { describe, expect, it } from "vitest";
import {
  advanceSequence,
  DEFAULT_FORMATS,
  formatChildNumber,
  formatTrackingNumber,
  parseTrackingNumber,
  periodKeyFor,
  type SequenceFormat,
} from "./tracking";

const AUG_2026 = new Date(Date.UTC(2026, 7, 29));
const JAN_2027 = new Date(Date.UTC(2027, 0, 2));
const SEP_2026 = new Date(Date.UTC(2026, 8, 1));

describe("formatTrackingNumber", () => {
  it("produces the default job format", () => {
    expect(formatTrackingNumber(DEFAULT_FORMATS.JOB, 1842, AUG_2026)).toBe(
      "JOB-2026-001842"
    );
  });

  it("honours a two-digit year and different padding without code changes", () => {
    const fmt: SequenceFormat = {
      prefix: "JOB",
      separator: "-",
      yearDigits: 2,
      sequenceDigits: 7,
      resetPeriod: "yearly",
    };
    expect(formatTrackingNumber(fmt, 1842, AUG_2026)).toBe("JOB-26-0001842");
  });

  it("prefixes a branch code when the company has multiple yards", () => {
    const fmt: SequenceFormat = {
      ...DEFAULT_FORMATS.JOB,
      branch: "CAL",
      sequenceDigits: 5,
    };
    expect(formatTrackingNumber(fmt, 182, AUG_2026)).toBe("CAL-JOB-2026-00182");
  });

  it("includes a month segment for monthly sequences like the daily log", () => {
    expect(formatTrackingNumber(DEFAULT_FORMATS.DL, 47, AUG_2026)).toBe(
      "DL-2026-08-0047"
    );
  });

  it("omits the year entirely when yearDigits is 0", () => {
    const fmt: SequenceFormat = {
      prefix: "WO",
      separator: "-",
      yearDigits: 0,
      sequenceDigits: 6,
      resetPeriod: "never",
    };
    expect(formatTrackingNumber(fmt, 2781, AUG_2026)).toBe("WO-002781");
  });
});

describe("formatChildNumber", () => {
  it("hangs loads off their parent trip rather than a global counter", () => {
    expect(formatChildNumber("TR-2026-004821", "LD", 1)).toBe(
      "LD-2026-004821-01"
    );
    expect(formatChildNumber("TR-2026-004821", "DT", 3)).toBe(
      "DT-2026-004821-03"
    );
  });
});

describe("periodKeyFor", () => {
  it("buckets yearly, monthly, and never correctly", () => {
    expect(periodKeyFor("yearly", AUG_2026)).toBe("2026");
    expect(periodKeyFor("monthly", AUG_2026)).toBe("2026-08");
    expect(periodKeyFor("never", AUG_2026)).toBe("all");
  });
});

describe("advanceSequence", () => {
  it("starts at 1 when no counter exists yet", () => {
    const r = advanceSequence(null, DEFAULT_FORMATS.JOB, AUG_2026);
    expect(r.issued).toBe(1);
    expect(r.state).toEqual({ periodKey: "2026", nextNumber: 2 });
  });

  it("increments within the same period", () => {
    const r = advanceSequence(
      { periodKey: "2026", nextNumber: 1842 },
      DEFAULT_FORMATS.JOB,
      AUG_2026
    );
    expect(r.issued).toBe(1842);
    expect(r.state.nextNumber).toBe(1843);
  });

  it("resets when the year rolls over", () => {
    const r = advanceSequence(
      { periodKey: "2026", nextNumber: 9001 },
      DEFAULT_FORMATS.JOB,
      JAN_2027
    );
    expect(r.issued).toBe(1);
    expect(r.state).toEqual({ periodKey: "2027", nextNumber: 2 });
  });

  it("resets monthly sequences at a month boundary, not a year boundary", () => {
    const r = advanceSequence(
      { periodKey: "2026-08", nextNumber: 64 },
      DEFAULT_FORMATS.DL,
      SEP_2026
    );
    expect(r.issued).toBe(1);
    expect(r.state.periodKey).toBe("2026-09");
  });

  it("never resets a never-reset sequence across a year boundary", () => {
    const fmt: SequenceFormat = { ...DEFAULT_FORMATS.WO, resetPeriod: "never" };
    const r = advanceSequence(
      { periodKey: "all", nextNumber: 2781 },
      fmt,
      JAN_2027
    );
    expect(r.issued).toBe(2781);
  });

  it("respects a configured starting number for a company migrating from paper", () => {
    const r = advanceSequence(null, DEFAULT_FORMATS.JOB, AUG_2026, 5000);
    expect(r.issued).toBe(5000);
    expect(r.state.nextNumber).toBe(5001);
  });
});

describe("parseTrackingNumber", () => {
  it("round-trips a formatted number", () => {
    const s = formatTrackingNumber(DEFAULT_FORMATS.JOB, 1842, AUG_2026);
    expect(parseTrackingNumber(s, DEFAULT_FORMATS.JOB)).toEqual({
      branch: undefined,
      prefix: "JOB",
      year: 2026,
      month: undefined,
      sequence: 1842,
    });
  });

  it("expands a two-digit year", () => {
    const fmt: SequenceFormat = { ...DEFAULT_FORMATS.JOB, yearDigits: 2 };
    expect(parseTrackingNumber("JOB-26-001842", fmt)?.year).toBe(2026);
  });

  it("parses a branch-prefixed number", () => {
    const fmt: SequenceFormat = { ...DEFAULT_FORMATS.JOB, branch: "CAL" };
    const p = parseTrackingNumber("CAL-JOB-2026-001842", fmt);
    expect(p?.branch).toBe("CAL");
    expect(p?.sequence).toBe(1842);
  });

  it("is case and whitespace tolerant, since office staff type these by hand", () => {
    expect(
      parseTrackingNumber("  job-2026-001842 ", DEFAULT_FORMATS.JOB)?.sequence
    ).toBe(1842);
  });

  it("returns null rather than throwing on junk input", () => {
    expect(parseTrackingNumber("", DEFAULT_FORMATS.JOB)).toBeNull();
    expect(parseTrackingNumber("NOTANUMBER", DEFAULT_FORMATS.JOB)).toBeNull();
    expect(
      parseTrackingNumber("JOB-20X6-001842", DEFAULT_FORMATS.JOB)
    ).toBeNull();
  });
});
