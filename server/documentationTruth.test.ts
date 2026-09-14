/**
 * v21.13.1 — Documentation truth guards.
 *
 * Three drifts happened between v21.10 and v21.13: the inventory kept a
 * hand-written external-procedure count after it changed; it kept old
 * universal-permission counts as if current; and the generated current-state
 * document kept listing PDF rendering and the portal client UI as
 * unimplemented after both existed, because a replacement of the generator's
 * narrative anchored on text that did not match and silently did nothing.
 * These tests read the source and the documents together, so a claim that
 * contradicts the tree fails the gate.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { UNIVERSAL_PERMISSIONS, EXTERNAL_PROCEDURE_PERMISSIONS } from "./_core/recordsAuthorization";

const inventory = readFileSync("PROCEDURE_AUTHORIZATION_INVENTORY.md", "utf8");
const state = readFileSync("LEASEOS_CURRENT_STATE.md", "utf8");
const portalRouter = readFileSync("server/portalRouter.ts", "utf8");
const externalCount = (portalRouter.match(/externalProcedure\("/g) ?? []).length;
const integrationCount = (readFileSync("server/integrationRouter.ts", "utf8").match(/integrationProcedure\("/g) ?? []).length;

describe("the inventory carries no count it does not read", () => {
  it("does not hand-write the external procedure count", () => {
    const row = inventory.split("\n").find(l => l.includes("server/portalRouter.ts"))!;
    expect(row).not.toMatch(/\d+ procedures/);
    expect(row).toContain("LEASEOS_CURRENT_STATE.md");
  });
  it("states a universal-permission count only as history, and any current statement matches the source", () => {
    for (const line of inventory.split("\n")) {
      const m = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b universal permission/i.exec(line);
      if (!m) continue;
      const historical = /HISTORY|Resolved at B20|at that checkpoint/i.test(line);
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
      const n = words[m[1].toLowerCase()] ?? Number(m[1]);
      if (!historical) expect(n, line).toBe(UNIVERSAL_PERMISSIONS.length);
    }
  });
});

describe("the generated current state agrees with the tree", () => {
  it("reports the external-procedure and universal counts the source has", () => {
    expect(state).toContain(`| Externally-gated procedures (portal) | **${externalCount}** |`);
    expect(state).toContain(`| Universal (self-scoped) permissions | **${UNIVERSAL_PERMISSIONS.length}** |`);
    expect(state).toContain(`| Integration-gated procedures (machines) | **${integrationCount}** |`);
    expect(externalCount).toBe(Object.keys(EXTERNAL_PROCEDURE_PERMISSIONS).length);
  });
  it("does not list as unimplemented anything that exists in the tree", () => {
    const notImplemented = state.slice(state.indexOf("## Not implemented"), state.indexOf("## Blocked"));
    const claims: [RegExp, string][] = [
      [/PDF rendering/i, "server/_core/ticketPdf.ts"],
      [/Portal client UI/i, "client/src/portal/PortalShell.tsx"],
      [/customer portal shell/i, "client/src/portal/external/CustomerPortal.tsx"],
      [/site sign-off/i, "server/_core/siteCloseout.ts"],
      [/bank reconciliation/i, "server/_core/bankReconciliation.ts"],
      [/GST\/HST/i, "server/_core/gstReturn.ts"],
      [/IFTA/i, "server/_core/iftaEngine.ts"],
      [/external identit/i, "server/_core/externalIdentityPolicy.ts"],
      [/chain[- ]of[- ]custody view/i, "client/src/portal/external/ChainOfCustody.tsx"],
      [/signing screen/i, "client/src/portal/external/SignOffScreen.tsx"],
      [/alert[- ]preference/i, "client/src/portal/external/AlertsPanel.tsx"],
      [/integration gateway/i, "server/integrationRouter.ts"],
      [/capital assets/i, "server/assetRouter.ts"],
      [/fleet shop|parts, tires/i, "server/shopRouter.ts"],
      [/quotes, change orders/i, "server/projectRouter.ts"],
      [/telematics|video safety/i, "server/telematicsRouter.ts"],
      [/recruiting|onboarding/i, "server/workforceRouter.ts"],
      [/audit package/i, "server/auditRouter.ts"],
      [/LSD|survey grid|vehicle profile|road restriction/i, "server/spatialRouter.ts"],
      [/contract rules? that would decide|contract terms/i, "server/_core/contractTerms.ts"],
    ];
    for (const [phrase, path] of claims) if (existsSync(path)) expect(notImplemented, `${path} exists but the state claims "${phrase.source}" is not implemented`).not.toMatch(phrase);
  });
  it("names as implemented every subsystem whose router exists — a lost narrative fails the gate", () => {
    const implemented = state.slice(state.indexOf("## Implemented on the server"), state.indexOf("## Implemented on the client"));
    const must: [string, RegExp][] = [
      ["server/portalRouter.ts", /portal/i], ["server/closeoutRouter.ts", /sign-off chain/i], ["server/shopRouter.ts", /fleet shop/i], ["server/assetRouter.ts", /capital assets/i],
      ["server/projectRouter.ts", /commercial projects/i], ["server/integrationRouter.ts", /integration gateway/i], ["server/telematicsRouter.ts", /telematics/i],
      ["server/workforceRouter.ts", /workforce lifecycle/i], ["server/auditRouter.ts", /audit packages/i], ["server/spatialRouter.ts", /spatial foundation/i],
      ["server/_core/contractTerms.ts", /contract terms/i], ["server/_core/money.ts", /money precision/i], ["server/customerAlertService.ts", /customer transaction/i],
      ["client/src/lib/showcaseGuard.ts", /operational truth boundary/i], ["server/commercialSetupRouter.ts", /rate resolution/i], ["server/invoicingRouter.ts", /invoice path/i], ["server/geoRouter.ts", /mapping foundation/i], ["server/_core/roadGraph.ts", /routing graph/i], ["server/commercialSetupRouter.ts", /commercial setup/i],
    ];
    for (const [path, phrase] of must) if (existsSync(path)) expect(implemented, `${path} exists but the state's server narrative does not mention ${phrase.source}`).toMatch(phrase);
  });

  it("names the native bindings that still throw, so a claim of native support cannot appear without them changing", () => {
    const native = readFileSync("client/src/runtime/adapters/capacitor.ts", "utf8");
    const throws = (native.match(/NotOnDeviceError\(/g) ?? []).length;
    expect(state).toContain(`**${throws} throw \`NotOnDeviceError\`**`);
    if (throws > 0) expect(state.slice(state.indexOf("## Not implemented"))).toMatch(/Native shell/);
  });
});
