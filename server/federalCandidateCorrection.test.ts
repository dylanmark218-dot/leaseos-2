/**
 * 0093A — the federal north/south candidate correction.
 *
 * The defect: the northern schedule reused the southern daily driving figure.
 * These tests make it hard for a future refactor to "simplify" the schedules by
 * copying southern daily limits north again.
 *
 * Nothing here verifies anything. Both figures remain unverified candidates.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_HOS_PROFILE_SEEDS, HOS_SEED_CAVEAT } from "./_core/hosRuleSeeds";

const seedFor = (profileKey: string) => {
  const p = ALL_HOS_PROFILE_SEEDS.find((x) => x.profileKey === profileKey);
  if (!p) throw new Error(`no seed ${profileKey}`);
  return p;
};

const limitOf = (profileKey: string, limitKey: string) => {
  const l = seedFor(profileKey).limits.find((x) => x.limitKey === limitKey);
  if (!l) throw new Error(`${profileKey} carries no ${limitKey}`);
  return l;
};

describe("the two divisions carry different daily driving candidates", () => {
  it("does not reuse the south-of-60 daily driving candidate north of 60", () => {
    const south = limitOf("CA_FEDERAL_SOUTH60", "daily_drive_minutes");
    const north = limitOf("CA_FEDERAL_NORTH60", "daily_drive_minutes");

    expect(south.value).toBe(780);
    expect(south.sourceSection).toBe("12(1)");

    expect(north.value).toBe(900);
    expect(north.sourceSection).toBe("39(1)");

    // Corrected, not verified.
    expect(north.verificationStatus).toBe("unverified");
    expect(south.verificationStatus).toBe("unverified");
  });

  it("never cites the southern section under the northern scope", () => {
    const north = seedFor("CA_FEDERAL_NORTH60");
    expect(north.applicability.latitudeRule).toBe("north_of_60");

    // The invariant that survives a refactor: a northern limit citing 12(1)
    // means somebody copied the southern schedule again.
    for (const l of north.limits) {
      expect(l.sourceSection, `${l.limitKey} under north_of_60`).not.toBe("12(1)");
    }
  });

  it("keeps the two schedules scoped apart", () => {
    expect(seedFor("CA_FEDERAL_SOUTH60").applicability.latitudeRule).toBe("south_of_60");
    expect(seedFor("CA_FEDERAL_NORTH60").applicability.latitudeRule).toBe("north_of_60");
  });

  it("differs on the day, not only at the cycle", () => {
    // The precise claim the old seed comment got wrong.
    const south = limitOf("CA_FEDERAL_SOUTH60", "daily_drive_minutes").value;
    const north = limitOf("CA_FEDERAL_NORTH60", "daily_drive_minutes").value;
    expect(north).not.toBe(south);
  });
});

describe("the correction keeps its own history", () => {
  const src = readFileSync(new URL("./_core/hosRuleSeeds.ts", import.meta.url), "utf8");
  const northern = src.slice(src.indexOf("CA_FEDERAL_NORTH60"));

  it("records that this once carried the southern value", () => {
    // "This once said 780" is the part a reviewer most needs and the part a
    // silent correction destroys.
    expect(northern).toContain("previously reused the southern 13-hour value");
    expect(northern).toContain("HISTORY");
  });

  it("names the sections rather than asserting a bare number", () => {
    expect(northern).toContain("s. 37");
    expect(northern).toContain("39(1)");
    expect(northern).toContain("s. 76");
  });

  it("flags the on-duty figure as still contested rather than correcting it unasked", () => {
    // One good correction should not become three unexamined ones.
    expect(northern).toContain("STILL CONTESTED");
    expect(northern).toContain("daily_on_duty_minutes");
    // And it really was left alone.
    expect(limitOf("CA_FEDERAL_NORTH60", "daily_on_duty_minutes").value)
      .toBe(limitOf("CA_FEDERAL_SOUTH60", "daily_on_duty_minutes").value);
  });
});

describe("a corrected candidate is still only a candidate", () => {
  it("seeds every federal limit unverified", () => {
    for (const key of ["CA_FEDERAL_SOUTH60", "CA_FEDERAL_NORTH60"]) {
      for (const l of seedFor(key).limits) {
        expect(l.verificationStatus, `${key}.${l.limitKey}`).toBe("unverified");
      }
      expect(seedFor(key).verificationStatus).toBe("unverified");
    }
  });

  it("still says that nothing here determines anything", () => {
    expect(HOS_SEED_CAVEAT).toContain("determines anything until a controller verifies it");
    expect(HOS_SEED_CAVEAT).toContain("UNKNOWN");
  });
});
