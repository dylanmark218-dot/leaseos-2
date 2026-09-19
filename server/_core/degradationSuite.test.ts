/**
 * P8.1 — the standing suite the automation decision asked for: "feed each engine a disabled
 * dependency (NOT_EVALUATED) and assert it degrades instead of failing."
 *
 * It was the one named deliverable of that decision with nothing behind it, and the cost showed up
 * on its own: `DISPATCH_REQUIRED_ALWAYS` made HOS required for every tenant, so a mapping-only
 * customer who never bought hours-of-service could not dispatch a truck — the exact failure the
 * NOT_EVALUATED contract was written to prevent, surviving in the one place it mattered. A suite
 * like this one would have caught it the day it was wired.
 *
 * What makes it *standing* rather than a set of cases: it enumerates the capabilities and the
 * consumers from the source, so a capability added without a degradation case fails here, and so
 * does a new engine that starts consuming the contract without one. A suite that has to be
 * remembered is a suite that stops covering things.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateBillingReadiness } from "./billing";
import { combineForConsumer } from "./interEngineStatus";
import { BILLING_CAPABILITY, CAPABILITY, billingContractFor, dispatchContractFor } from "./readinessCapabilities";
import type { CapabilityResult } from "./interEngineStatus";

const CAPABILITIES = Object.values(CAPABILITY);

/** A capability that answered nothing, for the reason given. */
const notEvaluated = (capability: string, reason: CapabilityResult["reason"]): CapabilityResult =>
  ({ capability, status: "NOT_EVALUATED", reason, detail: `${capability} did not answer (${reason})` });

const evaluated = (capability: string): CapabilityResult =>
  ({ capability, status: "PASS", detail: `${capability} passed` });

describe("a capability the company never bought does not stall dispatch", () => {
  it.each(CAPABILITIES)("degrades when %s is not licensed", (capability) => {
    /*
     * "Unlicensed features are absent, not off." An unlicensed capability must not appear as a
     * blocker of any severity: a customer who bought routing and nothing else is not failing a
     * check, they are not taking it.
     */
    const contract = dispatchContractFor({ routingInUse: true, destinationRequired: true, mechanicReleaseApplicable: true, notLicensed: [capability] });
    const results = CAPABILITIES.map(c => c === capability ? notEvaluated(c, "not_licensed") : evaluated(c));
    const combined = combineForConsumer(contract, results);
    expect(combined.status, `${capability} unlicensed should not block dispatch`).not.toBe("BLOCKED");
    // Degrades means surfaces and moves on — not silently dropped either.
    expect(combined.notEvaluated.map(r => r.capability)).toContain(capability);
  });

  it.each(CAPABILITIES)("still surfaces %s when the feed is broken rather than unbought", (capability) => {
    /*
     * The distinction the whole thing turns on. A company that did not buy a module has made a
     * decision; a module that should be answering and is not has a fault. Treating the second like
     * the first is how a broken feed becomes an invisible green light.
     */
    const contract = dispatchContractFor({ routingInUse: true, destinationRequired: true, mechanicReleaseApplicable: true });
    const results = CAPABILITIES.map(c => c === capability ? notEvaluated(c, "no_data_source_loaded") : evaluated(c));
    const combined = combineForConsumer(contract, results);
    expect(combined.notEvaluated.map(r => r.capability)).toContain(capability);
    if (contract.requires.includes(capability)) {
      expect(combined.status, `a required ${capability} with no data source must not read as PASS`).not.toBe("PASS");
    }
  });
});

describe("billing carries what did not answer rather than rounding it up", () => {
  it.each(Object.values(BILLING_CAPABILITY))("keeps %s visible when it was not evaluated", (capability) => {
    const contract = billingContractFor({ lineNeedsSupportingEvidence: true });
    const combined = combineForConsumer(contract, [notEvaluated(capability, "module_disabled")]);
    expect(combined.status).not.toBe("PASS");   // never rounded up
    expect(combined.notEvaluated.map(r => r.capability)).toContain(capability);
  });

  it("does not turn an unevaluated capability into an invoice blocker that reads like a failure", () => {
    // Billing may legitimately proceed on less than dispatch needs — the decision says each consumer
    // decides its own required set. What it may not do is present "we never asked" as "we checked".
    const r = evaluateBillingReadiness(
      {
        tripsComplete: 1, loadsTotal: 1, loadTicketsPresent: 1, disposalTicketsVerified: 1,
        disposalTicketsRequired: 1, unconfirmedValues: 0, dailyLogsComplete: true,
        fieldTicketStatus: "accepted", afeOrPoPresent: true, rateCardAssigned: true,
        customerSignatureRequired: true, amendmentsAfterSignature: 0,
      } as never,
      [notEvaluated(BILLING_CAPABILITY.fieldTicket, "module_disabled")],
    );
    const text = JSON.stringify(r).toLowerCase();
    expect(text).not.toMatch(/passed|verified|confirmed/);
  });
});

describe("the suite stays standing", () => {
  it("covers every capability the contract knows about", () => {
    // Adding a capability without a degradation case fails here rather than silently going untested.
    const src = readFileSync("server/_core/readinessCapabilities.ts", "utf8");
    const declared = Array.from(src.matchAll(/^\s{2}(\w+): "([^"]+)",$/gm))
      .map(m => m[2]!)
      .filter(v => CAPABILITIES.includes(v as never));
    expect(new Set(declared)).toEqual(new Set(CAPABILITIES));
  });

  it("names every engine that consumes the contract, so a new one cannot arrive untested", () => {
    /*
     * The consumers are found, not listed from memory. When a fourth engine starts importing the
     * contract, this fails and somebody has to decide what degradation means for it — which is the
     * conversation the decision wanted, rather than a fourth engine quietly treating absence as a
     * pass.
     */
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() && e.name !== "node_modules" ? walk(`${dir}/${e.name}`)
          : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [`${dir}/${e.name}`] : []);
    const consumers = walk("server")
      .filter(f => !f.endsWith("interEngineStatus.ts") && !f.endsWith("readinessCapabilities.ts"))
      .filter(f => /combineForConsumer|dispatchContractFor|billingContractFor/.test(readFileSync(f, "utf8")))
      .map(f => f.replace(/^server\//, ""));
    /*
     * `auditRouter` is here because it rebuilds the dispatch contract to render a stored decision.
     * It is a consumer even though it decides nothing: if its contract disagreed with the one the
     * composer used, the audit package would re-render a past decision against a different rule.
     */
    expect(consumers.sort(), "an engine consumes the inter-engine contract with no degradation case in this suite")
      .toEqual(["_core/billing.ts", "auditRouter.ts", "readinessComposer.ts"]);
  });
});
