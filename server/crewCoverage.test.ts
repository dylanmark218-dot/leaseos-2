/**
 * v22.20 — the crew that is numerically full and cannot do the work.
 */
import { describe, expect, it } from "vitest";
import {
  coverageWarning, coverageWarnings, headcountForecast, isAvailable, problemDays, qualifiedForecast,
  requirementsOf, type CrewMember,
} from "./_core/crewCoverage";

const FROM = new Date("2026-09-21T00:00:00Z");
const day = (n: number) => new Date(FROM.getTime() + n * 86_400_000);
const sevenSeven = { onDays: 7, offDays: 7, anchor: FROM, label: "7/7" };

const member = (name: string, o: Partial<CrewMember> = {}): CrewMember => ({
  userId: name.length, name, roles: ["driver"], currentQualifications: ["TDG"],
  existingAssignments: [], rotation: sevenSeven, awayOn: [], ...o,
});

describe("who is expected to be working", () => {
  it("follows the rotation", () => {
    const m = member("Jordan");
    expect(isAvailable(m, day(0))).toBe(true);
    expect(isAvailable(m, day(7))).toBe(false);
    expect(isAvailable(m, day(14))).toBe(true);
  });

  it("treats a known absence as absent whatever the rotation says", () => {
    expect(isAvailable(member("Sam", { awayOn: [day(2)] }), day(2))).toBe(false);
  });

  it("counts somebody with no rotation as working — no pattern is not the same as not working", () => {
    expect(isAvailable(member("Chris", { rotation: null }), day(9))).toBe(true);
  });
});

describe("headcount", () => {
  const crew = ["A", "B", "C", "D"].map(n => member(n));

  it("reports covered, tight and short, and names the shortfall", () => {
    const covered = headcountForecast({ crew, from: FROM, days: 1, neededPerDay: 2 })[0];
    expect(covered.state).toBe("covered");

    const tight = headcountForecast({ crew, from: FROM, days: 1, neededPerDay: 4 })[0];
    expect(tight.state).toBe("tight");
    expect(tight.shortfall).toBe(0);

    const short = headcountForecast({ crew, from: FROM, days: 1, neededPerDay: 6 })[0];
    expect(short).toMatchObject({ state: "short", shortfall: 2 });
    expect(short.line).toContain("6 needed / 4 available   SHORT — short 2");
  });

  it("says tight rather than covered when exactly enough — one sickness away from a shortage", () => {
    expect(headcountForecast({ crew, from: FROM, days: 1, neededPerDay: 4 })[0].state).toBe("tight");
  });

  it("follows the rotation across a hitch change", () => {
    const f = headcountForecast({ crew, from: FROM, days: 14, neededPerDay: 1 });
    expect(f[0].available).toBe(4);
    expect(f[7].available).toBe(0);   // whole crew off
    expect(f[7].state).toBe("short");
  });
});

describe("full on headcount and unable to do the work", () => {
  // Four people on shift; only one holds the client orientation.
  const crew = [
    member("A", { currentQualifications: ["TDG", "CLIENT_ORIENTATION"] }),
    member("B", { currentQualifications: ["TDG"] }),
    member("C", { currentQualifications: ["TDG"] }),
    member("D", { currentQualifications: ["TDG"] }),
  ];
  const forecast = () => qualifiedForecast({
    crew, from: FROM, days: 3, neededPerDay: 3,
    requirements: [{ qualification: "TDG", neededHolders: 3 }, { qualification: "CLIENT_ORIENTATION", neededHolders: 3 }],
  });

  it("does not read green just because the seats are filled", () => {
    const d0 = forecast()[0];
    expect(d0.headcount.state).toBe("covered");
    expect(d0.state).toBe("short_qualification");
    expect(d0.line).toContain("headcount met (4/3) but short on CLIENT_ORIENTATION (1/3)");
  });

  it("names who does hold it, so the gap is actionable", () => {
    const gap = forecast()[0].gaps.find(g => g.qualification === "CLIENT_ORIENTATION")!;
    expect(gap).toMatchObject({ holders: 1, needed: 3, shortfall: 2 });
    expect(gap.holderNames).toEqual(["A"]);
  });

  it("does not count somebody whose qualification nobody has established", () => {
    // An expired or unverified qualification is simply absent from the list,
    // and absent is not covered.
    const unknown = [...crew.slice(0, 3), member("D", { currentQualifications: [] })];
    const f = qualifiedForecast({ crew: unknown, from: FROM, days: 1, neededPerDay: 4, requirements: [{ qualification: "TDG", neededHolders: 4 }] })[0];
    expect(f.gaps[0]).toMatchObject({ holders: 3, shortfall: 1 });
    expect(f.state).toBe("short_qualification");
  });

  it("reports short_people ahead of a qualification gap, because nobody there is the bigger problem", () => {
    const f = qualifiedForecast({ crew, from: FROM, days: 1, neededPerDay: 9, requirements: [{ qualification: "CLIENT_ORIENTATION", neededHolders: 9 }] })[0];
    expect(f.state).toBe("short_people");
  });

  it("gives back only the days somebody has to act on", () => {
    const f = forecast();
    expect(f).toHaveLength(3);
    expect(problemDays(f)).toHaveLength(3);
    const clean = qualifiedForecast({ crew, from: FROM, days: 2, neededPerDay: 2, requirements: [{ qualification: "TDG", neededHolders: 2 }] });
    expect(problemDays(clean)).toHaveLength(0);
  });
});

describe("the sentence safety needs", () => {
  const crew = [
    member("A", { currentQualifications: ["ORIENTATION"] }),
    member("B", { currentQualifications: ["ORIENTATION"] }),
    member("C", { currentQualifications: [] }),
  ];

  it("names the window and the qualification, not a count of red days", () => {
    const f = qualifiedForecast({ crew, from: FROM, days: 3, neededPerDay: 3, requirements: [{ qualification: "ORIENTATION", neededHolders: 3 }] });
    expect(coverageWarning(f)).toBe("2026-09-21 to 2026-09-23: only 2 of the 3 people this work needs hold ORIENTATION");
  });

  it("says nothing when there is nothing to say", () => {
    const f = qualifiedForecast({ crew, from: FROM, days: 1, neededPerDay: 2, requirements: [{ qualification: "ORIENTATION", neededHolders: 2 }] });
    expect(coverageWarning(f)).toBeNull();
  });

  it("takes an assignment's own requirements rather than a crew's habits", () => {
    const assignment = { assignmentRef: "A-1", startsAt: FROM, endsAt: day(1), requiredQualifications: ["TDG", "H2S"], requiredRole: "driver" };
    expect(requirementsOf(assignment, 3)).toEqual([
      { qualification: "TDG", neededHolders: 3 },
      { qualification: "H2S", neededHolders: 3 },
    ]);
  });
});

describe("two gaps at once", () => {
  // Three seats, three people on shift. One holds ORIENTATION, none hold H2S.
  const crew = [
    member("A", { currentQualifications: ["ORIENTATION"] }),
    member("B", { currentQualifications: [] }),
    member("C", { currentQualifications: [] }),
  ];
  const forecast = () => qualifiedForecast({
    crew, from: FROM, days: 2, neededPerDay: 3,
    requirements: [{ qualification: "ORIENTATION", neededHolders: 3 }, { qualification: "H2S", neededHolders: 3 }],
  });

  it("returns both rather than silently picking one", () => {
    const w = coverageWarnings(forecast());
    expect(w.map(x => x.qualification).sort()).toEqual(["H2S", "ORIENTATION"]);
  });

  it("ranks by shortfall, so the worst is first and the one-liner is the worst", () => {
    const w = coverageWarnings(forecast());
    expect(w[0].qualification).toBe("H2S");   // 0 of 3, against ORIENTATION's 1 of 3
    expect(w[0].shortfall).toBe(3);
    expect(coverageWarning(forecast())).toBe(w[0].line);
    expect(coverageWarning(forecast())).toContain("only 0 of the 3 people this work needs hold H2S");
  });

  it("reports the worst day's numbers, not the first day's", () => {
    // B holds ORIENTATION on day one only; day two is worse.
    const varying = [
      member("A", { currentQualifications: ["ORIENTATION"] }),
      member("B", { currentQualifications: ["ORIENTATION"], awayOn: [day(1)] }),
      member("C", { currentQualifications: [] }),
    ];
    const w = coverageWarnings(qualifiedForecast({
      crew: varying, from: FROM, days: 2, neededPerDay: 2,
      requirements: [{ qualification: "ORIENTATION", neededHolders: 2 }],
    }));
    expect(w[0].holders).toBe(1);   // the worse day, not the first
    expect(w[0].shortfall).toBe(1);
  });

  it("reports a plain shortage of people as its own warning, with no qualification attached", () => {
    const w = coverageWarnings(qualifiedForecast({
      crew, from: FROM, days: 1, neededPerDay: 9,
      requirements: [{ qualification: "ORIENTATION", neededHolders: 9 }],
    }));
    const people = w.find(x => x.qualification === null)!;
    expect(people.shortfall).toBe(6);
    expect(people.line).toContain("short 6 of 9");
  });

  it("says nothing at all when nothing is short", () => {
    const fine = qualifiedForecast({
      crew, from: FROM, days: 1, neededPerDay: 1,
      requirements: [{ qualification: "ORIENTATION", neededHolders: 1 }],
    });
    expect(coverageWarnings(fine)).toEqual([]);
    expect(coverageWarning(fine)).toBeNull();
  });
});
