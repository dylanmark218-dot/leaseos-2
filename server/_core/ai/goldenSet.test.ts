/**
 * The golden set in CI, against the mock provider and no network.
 *
 * Every case is scored by the same `scoreCase` the live `eval:secretary` uses,
 * so the number CI enforces and the number a developer sees against a real
 * model are produced by one piece of code. What differs is the bar: here the
 * answers are fixtures, so exact agreement is required.
 */
import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "./llm/mockProvider";
import { loadGoldenSet, mockFixturesFrom } from "./eval/goldenSet";
import { scoreCase } from "./eval/scoreCase";

const cases = loadGoldenSet();
const provider = () => new MockLlmProvider(mockFixturesFrom(cases));

describe("the golden set", () => {
  it("has the cases the checkpoint named", () => {
    const ids = cases.map(c => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    // The ugly ones, by name, so removing one is a visible act.
    expect(ids).toContain("02-ambiguous-units");
    expect(ids).toContain("03-am-pm-unknown");
    expect(ids).toContain("05-fabricated-quote");
    expect(ids).toContain("06-unknown-ticket");
    expect(ids).toContain("07-injected-scan");
    expect(ids).toContain("08-second-voice");
    expect(ids).toContain("09-out-of-scope");
  });

  it("makes no network call: every answerable case has a fixture", () => {
    const fixtures = mockFixturesFrom(cases);
    expect(fixtures).toHaveLength(cases.filter(c => c.modelResponse !== null).length);
  });

  for (const testCase of cases) {
    it(`${testCase.id}: ${testCase.note}`, async () => {
      const score = await scoreCase(testCase, provider());
      expect(score.mismatches).toEqual([]);
    });
  }

  it("has no unexpected silent guess anywhere in the set", async () => {
    // The metric the whole extraction contract exists to hold at zero. Two
    // cases contain a deliberate fabrication; this counts the ones nobody
    // planned for.
    let unexpected = 0;
    for (const testCase of cases) {
      const score = await scoreCase(testCase, provider());
      unexpected += score.unexpectedSilentGuesses;
    }
    expect(unexpected).toBe(0);
  });

  it("scores every field the cases pin", async () => {
    let correct = 0;
    let checked = 0;
    for (const testCase of cases) {
      const score = await scoreCase(testCase, provider());
      correct += score.fieldsCorrect;
      checked += score.fieldsChecked;
    }
    expect(checked).toBeGreaterThan(0);
    expect(correct).toBe(checked);
  });
});
