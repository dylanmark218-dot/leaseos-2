/**
 * The context builder cannot reach the restricted vault or driver medical
 * records — proved by reading its source, not by promising in a comment.
 *
 * Two guards, because either alone fails in a different way.
 *
 * The **type guard** proves the shape has nowhere to put a reason: eligibility
 * is three values and carries no underlying fact. That is what stops a
 * well-meaning "include the reason so the driver knows why" from compiling.
 *
 * The **source guard** proves the module imports nothing that could read those
 * tables. It is the one that survives somebody adding a field in good faith
 * two years from now, because it fails on the import rather than on the field.
 *
 * `server/knowledgeWritePaths.test.ts` uses the same technique on the same
 * kind of rule, and the note there applies here too: a pass means the path
 * cannot reach that data, not that nothing else can.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildContextPack, contextRefs, renderContextPack } from "./context/contextPack";

const SOURCE = readFileSync("server/ai/context/contextPack.ts", "utf8");

/**
 * Tables and modules that hold records outside the operations perimeter.
 *
 * Drawn from `drizzle/schema.ts` and `server/_core/restrictedVault.ts`: the
 * vault itself, and the places a driver's medical and background facts live.
 */
const RESTRICTED = [
  "restrictedVault",
  "driverMedical",
  "medicalFitness",
  "driverAbstract",
  "backgroundCheck",
  "criminalRecord",
  "drugAlcohol",
  "consentRecords",
];

describe("the context builder's source", () => {
  it("imports nothing at all — it is handed projections, it does not fetch them", () => {
    // The strongest form of the rule: a module with no imports cannot reach a
    // table by any route, including one added later through a helper.
    const imports = SOURCE.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
  });

  it("names no restricted table", () => {
    for (const name of RESTRICTED) {
      expect(SOURCE, `contextPack.ts mentions ${name}`).not.toMatch(
        new RegExp(`\\b${name}\\b`)
      );
    }
  });

  it("reaches no database, no schema and no router", () => {
    expect(SOURCE).not.toMatch(/drizzle\/schema|getDb|\bdb\.|appRouter|createCaller/);
  });
});

describe("eligibility crosses the perimeter; the fact underneath it does not", () => {
  it("carries yes, no or unknown and has nowhere to put a reason", () => {
    const pack = buildContextPack({
      formKey: "unload_stop",
      formVersion: 1,
      driverMayOperate: "yes",
    });
    const item = pack.items.find(i => i.kind === "eligibility");
    expect(item?.value).toBe("yes");
    // An ContextItem is { id, kind, label, value } and nothing else. There is
    // no field a medical fact could be attached to.
    expect(Object.keys(item ?? {}).sort()).toEqual(["id", "kind", "label", "value"]);
  });

  it("distinguishes unknown from no", () => {
    const unknown = buildContextPack({
      formKey: "unload_stop",
      formVersion: 1,
      driverMayOperate: "unknown",
    });
    const no = buildContextPack({
      formKey: "unload_stop",
      formVersion: 1,
      driverMayOperate: "no",
    });
    expect(unknown.items.find(i => i.kind === "eligibility")?.value).toBe("unknown");
    expect(no.items.find(i => i.kind === "eligibility")?.value).toBe("no");
  });

  it("omits eligibility entirely when nobody asked", () => {
    const pack = buildContextPack({ formKey: "unload_stop", formVersion: 1 });
    expect(pack.items.some(i => i.kind === "eligibility")).toBe(false);
  });
});

describe("what the model may cite", () => {
  it("offers an id for every item and nothing beyond them", () => {
    const pack = buildContextPack({
      formKey: "unload_stop",
      formVersion: 1,
      tripRef: "TRIP-1",
      unitNumber: "T-118",
      openTicketNumbers: ["CW-4471", "CW-4480"],
    });
    expect([...contextRefs(pack)].sort()).toEqual(
      ["form", "open_ticket_1", "open_ticket_2", "trip", "unit"].sort()
    );
  });

  it("renders as labelled facts, with nothing that reads as an instruction", () => {
    const rendered = renderContextPack(
      buildContextPack({ formKey: "unload_stop", formVersion: 1, tripRef: "TRIP-1" })
    );
    expect(rendered).toContain("- trip: Trip = TRIP-1");
    expect(rendered).not.toMatch(/\byou (must|should|will)\b/i);
  });
});
