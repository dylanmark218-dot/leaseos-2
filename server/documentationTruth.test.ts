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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/* ------------------------------------------------------------------ */

/**
 * v22.20 — the document's safety claims, bound to the code that makes them true.
 *
 * The counts in the current-state document are generated and cannot lie. The
 * prose around them is written by hand and, over this checkpoint, lied three
 * times — each caught by a human reader rather than by CI. Every entry below
 * pairs a sentence the document makes with the artifact that makes it true, and
 * asserts both.
 *
 * That is deliberately strict in both directions. Delete the safeguard and keep
 * the sentence: fails. Keep the safeguard and quietly drop the sentence: fails.
 * Either is a change somebody should have to make on purpose.
 */
describe("every safety claim the document makes is backed by code", () => {
  const enforcementRouter = readFileSync("server/enforcementRouter.ts", "utf8");
  const shopRouter = readFileSync("server/shopRouter.ts", "utf8");
  const commsRouter = readFileSync("server/commsRouter.ts", "utf8");
  const enforcementCore = readFileSync("server/_core/enforcement.ts", "utf8");
  const commRoute = readFileSync("server/_core/commRoute.ts", "utf8");
  const commPackage = readFileSync("server/_core/commPackage.ts", "utf8");

  const CLAIMS: { claim: RegExp; why: string; holds: () => boolean }[] = [
    {
      claim: /server-owned records/i,
      why: "the release loads repairs from the shop rather than from the request",
      holds: () => enforcementRouter.includes("repairsForOrder") && !/repairs:\s*z\./.test(enforcementRouter),
    },
    {
      claim: /repair-complete-pending-release/i,
      why: "a completed repair reaches its own state and stops there",
      holds: () => enforcementCore.includes("repair_complete_pending_release"),
    },
    {
      claim: /authenticated caller/i,
      why: "the technician on a mechanic release comes from context, never the body",
      holds: () => /technicianUserId:\s*ctx\.user\.id/.test(shopRouter) && !/technicianUserId:\s*z\./.test(shopRouter),
    },
    {
      claim: /approved by a different one/i,
      why: "a policy's proposer cannot approve it",
      holds: () => /proposedByUserId === ctx\.user\.id/.test(commsRouter),
    },
    {
      claim: /moves forward only/i,
      why: "a work order does not go backwards and a closed one is not reopened",
      holds: () => /does not move from .* back to/.test(shopRouter) && /not reopened by changing a status/.test(shopRouter),
    },
    {
      claim: /never deleted/i,
      why: "an order leaves the active list by being released or rescinded",
      holds: () => enforcementRouter.includes("never deleted"),
    },
    {
      claim: /answers hold/i,
      why: "an order the server cannot vouch for does not lift a device's latch",
      holds: () => /keep blocking/.test(enforcementRouter),
    },
    {
      claim: /a citation with no out-of-service marking stops nothing/i,
      why: "a ticket does not ground a truck",
      holds: () => /this does not stop the vehicle/.test(enforcementCore),
    },
    {
      claim: /retired service out entirely/i,
      why: "a shut-down service is left out of the package a driver carries",
      holds: () => commPackage.includes("retiredExcluded") && commRoute.includes("no longer transmits"),
    },
  ];

  for (const { claim, why, holds } of CLAIMS) {
    it(`states and honours: ${why}`, () => {
      expect(state).toMatch(claim);
      expect(holds()).toBe(true);
    });
  }

  it("covers the claims this checkpoint added, so the set cannot quietly shrink", () => {
    // A dropped entry is a safeguard nobody is checking any more.
    expect(CLAIMS).toHaveLength(9);
  });
});

describe("bash never interprets the prose", () => {
  const script = readFileSync("scripts/current-state.sh", "utf8");

  it("uses a quoted heredoc, so nothing in the body is shell syntax", () => {
    // Escaping prose against a shell that reads it was the wrong shape of fix.
    // Backticks were the form that bit; $HOME, $(date) and $((1+1)) would each
    // have gone wrong differently, and one of them silently.
    expect(script).toContain("cat > \"$TEMPLATE\" <<'MD'");
    expect(script).not.toContain("<<MD");
  });

  it("substitutes only named placeholders and refuses to ship an unresolved one", () => {
    expect(script).toContain("unresolved placeholders");
    // Bounded at the terminator: running to end-of-file swept up a token
    // written in a comment below it, which is not part of the document.
    const start = script.indexOf("<<'MD'");
    const body = script.slice(start, script.indexOf("\nMD\n", start));
    expect(body.length).toBeGreaterThan(1000);
    const tokens = new Set(Array.from(body.matchAll(/@@([A-Z0-9_]+)@@/g)).map(m => m[1]));
    const allowed = new Set((script.match(/ALLOWED="([^"]+)"/)?.[1] ?? "").split(" "));
    for (const t of tokens) expect(allowed.has(t)).toBe(true);
  });

  it("generates to a named path, exits clean and says nothing", () => {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const out = `/tmp/current-state-probe-${process.pid}.md`;
    const run = spawnSync("bash", ["scripts/current-state.sh", "v-probe", out], { encoding: "utf8" });
    // Asserted separately: masking the exit code with `|| true` would have
    // proved only that stderr was empty, not that generation succeeded.
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");

    // Written to a temporary file rather than over the repository's own copy,
    // which a test has no business rewriting while other tests read it.
    const rendered = readFileSync(out, "utf8");
    expect(rendered).not.toMatch(/@@[A-Z0-9_]+@@/);
    require("node:fs").unlinkSync(out);
  });

  it("renders the technical terms it quotes, in the output and not just the source", () => {
    const doc = readFileSync("LEASEOS_CURRENT_STATE.md", "utf8");
    for (const term of ["prohibited", "not_authorized", "requires_posted_channel"]) {
      expect(doc).toContain(`\`${term}\``);
      // The first fix over-escaped and printed a visible backslash. Checking
      // the script was escaped could not have caught that; checking the page
      // can.
      expect(doc).not.toContain(`\\\`${term}`);
    }
  });
});

describe("the document does not describe an implementation that is gone", () => {
  const script = readFileSync("scripts/current-state.sh", "utf8");
  const doc = readFileSync("LEASEOS_CURRENT_STATE.md", "utf8");

  it("does not claim the heredoc is unquoted while it is quoted", () => {
    // The implementation became correct and its own truth document became
    // stale in the same change. A green gate proves the assertions it makes,
    // and none of them was about this.
    const quoted = script.includes("<<'MD'");
    expect(quoted).toBe(true);
    expect(doc).not.toMatch(/heredoc is unquoted/);
    expect(doc).not.toMatch(/checked for\s+unescaped backticks/);
  });

  it("describes the safeguard that exists rather than the one that did", () => {
    expect(doc).toContain("body is now a quoted heredoc");
    expect(doc).toContain("unresolved one fails generation");
  });

  it("removes its temporary template even when generation fails", () => {
    // The unresolved-placeholder check exits before any later line, so an
    // explicit rm at the end runs only on the path that did not need it.
    expect(script).toContain("trap 'rm -f \"$TEMPLATE\"' EXIT");
  });
});

describe("the tree that was tested is the tree that is reviewed", () => {
  it("carries no stray file named for a permission count", () => {
    // `set -- $PERMS` clobbered $2, so the generator wrote the document to a
    // file named 112 and that file reached a review diff.
    expect(existsSync("112")).toBe(false);
    const strays = readdirSync(".").filter(f => /^\d+$/.test(f));
    expect(strays).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Release marker — ported from the v23.29 line (ec9b427), manifest B2  */
/* ------------------------------------------------------------------ */

describe("the release marker and the generated document name the same release", () => {
  /*
   * `LEASEOS_RELEASE` was introduced as THE explicit release source of truth, replacing a generator
   * that inferred the label from the newest checkpoint filename. It then drifted anyway, and
   * silently, on the line this test comes from: nothing consulted the marker, and nothing noticed
   * when it sat at v22.20 while the document advanced through v23.x. A source of truth that no
   * check reads is not one. This is that check.
   */
  it("keeps LEASEOS_RELEASE equal to the Release row of LEASEOS_CURRENT_STATE.md", () => {
    const marker = readFileSync("LEASEOS_RELEASE", "utf8").trim();
    const documented = state.match(/\| Release \| \*\*([^*]+)\*\*/)?.[1]?.trim();
    expect(marker.length).toBeGreaterThan(0);
    expect(documented).toBeDefined();
    expect(
      marker,
      `LEASEOS_RELEASE says ${marker} and LEASEOS_CURRENT_STATE.md says ${documented}. ` +
      `These name one release; regenerate the document with that release, or correct the marker.`,
    ).toBe(documented);
  });
});
