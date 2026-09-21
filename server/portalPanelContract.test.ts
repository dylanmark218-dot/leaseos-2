/**
 * P5.2 — the portal components match their contract. This reads the source: a procedure that
 * appears in a component but not in its contract fails here, and so does a contract entry no
 * component calls. It is the internal counterpart of the 7b/7c gates.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFFICE_PORTALS, PANEL_CONTRACTS, contractFor, mayMount } from "../client/src/portal/panelContract";

const DIR = "client/src/portal";
const proceduresIn = (file: string): string[] => {
  const src = readFileSync(`${DIR}/${file}`, "utf8");
  return Array.from(new Set(Array.from(src.matchAll(/trpc\.([a-zA-Z][\w.]*)\.use(?:Query|Mutation)/g)).map(m => m[1]!))).sort();
};

describe("a portal component mounts only what its contract allows", () => {
  it("matches every component's real calls to its contract, exactly", () => {
    for (const c of PANEL_CONTRACTS) {
      expect(proceduresIn(c.file), c.file).toEqual([...c.procedures].sort());
    }
  });

  it("covers every component in the portal tree, so a new one cannot arrive uncontracted", () => {
    const files = [
      ...readdirSync(DIR).filter(f => f.endsWith(".tsx")),
      ...readdirSync(`${DIR}/panels`).filter(f => f.endsWith(".tsx")).map(f => `panels/${f}`),
    ].filter(f => !f.endsWith(".test.tsx")).sort();
    expect(files).toEqual(PANEL_CONTRACTS.map(c => c.file).sort());
  });

  it("keeps office work out of a field portal, and says why", () => {
    const setup = contractFor("panels/SetupPanel.tsx")!;
    expect(setup.portals).not.toBe("every_portal");
    expect(setup.reason).toMatch(/office work/);
    expect(mayMount(setup, "field_workforce")).toBe(false);
    expect(mayMount(setup, "dispatch_operations")).toBe(false);
    expect(mayMount(setup, "customer")).toBe(false);
    expect(mayMount(setup, "finance_billing")).toBe(true);
    // Every procedure it mounts is commercial setup or the financial entities behind it — nothing else rides along.
    expect(setup.procedures.every(p => p.startsWith("commercialSetup.") || p.startsWith("finance."))).toBe(true);
  });

  it("mounts the restricted panel in the shell behind the same set the contract names", () => {
    const shell = readFileSync(`${DIR}/PortalShell.tsx`, "utf8");
    // The shell renders "setup" only inside an OFFICE_PORTALS guard, in the tab strip and in the body.
    expect(shell).toMatch(/OFFICE_PORTALS\.has\(portal\) \? \["setup" as PanelKey\] : \[\]/);
    expect(shell).toMatch(/panel === "setup" && OFFICE_PORTALS\.has\(portal\) &&/);
    const declared = shell.match(/const OFFICE_PORTALS = new Set<PortalKey>\(\[([^\]]*)\]\)/)?.[1] ?? "";
    const inShell = Array.from(declared.matchAll(/"([a-z_]+)"/g)).map(m => m[1]!).sort();
    expect(inShell, "the shell's office set and the contract's must not drift apart").toEqual([...OFFICE_PORTALS].sort());
  });
});
