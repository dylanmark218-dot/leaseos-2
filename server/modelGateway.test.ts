/**
 * v22.20 — the model we may not ship, refused before it is chosen.
 */
import { describe, expect, it } from "vitest";
import {
  attribute, fitsResident, NoEligibleProvider, refusalFor, route, routeOrThrow,
  SameModelVerification, verifierFor, type Deployment, type ModelProvider,
} from "./_core/modelGateway";

const AT = new Date("2026-09-13T10:00:00Z");

/** A stand-in for the stack under consideration, licences as researched. */
const reasoner: ModelProvider = {
  providerKey: "local-reasoner", modelRef: "gpt-oss-20b", tasks: ["reason", "verify", "fast_chat"],
  licence: "Apache-2.0", licenceClass: "permissive", licenceNote: null, runsOffline: true, vramGb: 14,
};
const coder: ModelProvider = {
  providerKey: "local-coder", modelRef: "qwen3-coder-30b-a3b", tasks: ["code", "verify"],
  licence: "Apache-2.0", licenceClass: "permissive", licenceNote: null, runsOffline: true, vramGb: 20,
};
const speakCommercial: ModelProvider = {
  providerKey: "local-tts", modelRef: "kokoro-82m", tasks: ["speak"],
  licence: "Apache-2.0", licenceClass: "permissive", licenceNote: null, runsOffline: true, vramGb: 3,
};
/** The trap: excellent, free, and not shippable in a product you sell. */
const speakNonCommercial: ModelProvider = {
  providerKey: "nc-tts", modelRef: "a-non-commercial-tts", tasks: ["speak"],
  licence: "CC BY-NC 4.0", licenceClass: "non_commercial", licenceNote: "non-commercial only",
  runsOffline: true, vramGb: 8,
};
const conditional: ModelProvider = {
  providerKey: "conditional-reasoner", modelRef: "a-threshold-licensed-model", tasks: ["reason"],
  licence: "Custom", licenceClass: "conditional", licenceNote: "extra terms above a user threshold",
  runsOffline: true, vramGb: 16,
};
const unstated: ModelProvider = {
  providerKey: "unknown-licence", modelRef: "a-model-with-no-licence-metadata", tasks: ["speak"],
  licence: "unknown", licenceClass: "unstated", licenceNote: null, runsOffline: true, vramGb: 4,
};
const hosted: ModelProvider = {
  providerKey: "hosted", modelRef: "a-hosted-api", tasks: ["reason", "verify"],
  licence: "service terms", licenceClass: "permissive", licenceNote: null, runsOffline: false, vramGb: null,
};

const commercial: Deployment = { commercial: true, offline: false, acceptedLicenceClasses: ["permissive"] };

describe("a licence we may not ship is refused before anything else", () => {
  it("routes to the commercial-safe voice and refuses the non-commercial one", () => {
    const r = route({ task: "speak", providers: [speakNonCommercial, speakCommercial], deployment: commercial });
    expect(r.routed).toBe(true);
    if (!r.routed) return;
    expect(r.provider.modelRef).toBe("kokoro-82m");
    expect(r.refused[0]).toMatchObject({ reason: "licence_non_commercial" });
    expect(r.refused[0].detail).toContain("does not permit the commercial use this deployment makes");
  });

  it("refuses outright when the only voice available is non-commercial", () => {
    const r = route({ task: "speak", providers: [speakNonCommercial], deployment: commercial });
    expect(r.routed).toBe(false);
    if (r.routed) return;
    // Not "no model available" — the reason is the whole point.
    expect(r.detail).toContain("CC BY-NC 4.0");
  });

  it("permits the same model where the deployment is not commercial", () => {
    const internal: Deployment = { commercial: false, offline: false, acceptedLicenceClasses: ["permissive", "non_commercial"] };
    expect(route({ task: "speak", providers: [speakNonCommercial], deployment: internal }).routed).toBe(true);
  });

  it("refuses an unstated licence, because an unread one is not a permissive one", () => {
    const r = refusalFor(unstated, "speak", commercial)!;
    expect(r.reason).toBe("licence_unstated");
    expect(r.detail).toContain("An unread licence is not a permissive one");
  });

  it("refuses a conditional licence until the company has accepted that class", () => {
    expect(refusalFor(conditional, "reason", commercial)!.reason).toBe("licence_not_accepted");
    const accepting: Deployment = { ...commercial, acceptedLicenceClasses: ["permissive", "conditional"] };
    expect(refusalFor(conditional, "reason", accepting)).toBeNull();
  });

  it("checks the licence before the machine, since an unshippable model's memory is uninteresting", () => {
    const offlineCommercial: Deployment = { commercial: true, offline: true, acceptedLicenceClasses: ["permissive"] };
    // Non-commercial AND offline-capable: the licence still decides.
    expect(refusalFor(speakNonCommercial, "speak", offlineCommercial)!.reason).toBe("licence_non_commercial");
  });
});

describe("the truck with no signal", () => {
  const offline: Deployment = { commercial: true, offline: true, acceptedLicenceClasses: ["permissive"] };

  it("refuses a provider that needs the network and takes the local one", () => {
    const r = route({ task: "reason", providers: [hosted, reasoner], deployment: offline });
    expect(r.routed).toBe(true);
    if (!r.routed) return;
    expect(r.provider.modelRef).toBe("gpt-oss-20b");
    expect(r.refused[0]).toMatchObject({ reason: "requires_network" });
  });

  it("takes the hosted one when there is a network and it is preferred", () => {
    const r = route({ task: "reason", providers: [hosted, reasoner], deployment: commercial });
    expect(r.routed && r.provider.providerKey).toBe("hosted");
  });
});

describe("nothing above this layer names a model", () => {
  it("answers a task, and reports which model served it", () => {
    const p = routeOrThrow({ task: "code", providers: [reasoner, coder], deployment: commercial });
    expect(p.modelRef).toBe("qwen3-coder-30b-a3b");
    const a = attribute(p, "code", AT);
    expect(a).toMatchObject({ task: "code", modelRef: "qwen3-coder-30b-a3b", licence: "Apache-2.0" });
  });

  it("throws with the reason when nothing may serve", () => {
    expect(() => routeOrThrow({ task: "speak", providers: [speakNonCommercial], deployment: commercial }))
      .toThrow(NoEligibleProvider);
  });

  it("does not report a provider as refused merely for not doing the task", () => {
    const r = route({ task: "code", providers: [reasoner, coder], deployment: commercial });
    expect(r.routed && r.refused).toEqual([]);
  });
});

describe("a second opinion comes from somewhere else", () => {
  it("picks a different model to verify", () => {
    const answered = attribute(reasoner, "reason", AT);
    const v = verifierFor({ answeredBy: answered, providers: [reasoner, coder], deployment: commercial });
    expect(v.providerKey).toBe("local-coder");
  });

  it("refuses rather than letting a model check its own answer", () => {
    const answered = attribute(reasoner, "reason", AT);
    // A model asked whether it was right will usually say yes.
    expect(() => verifierFor({ answeredBy: answered, providers: [reasoner], deployment: commercial }))
      .toThrow(SameModelVerification);
    expect(() => verifierFor({ answeredBy: answered, providers: [reasoner], deployment: commercial }))
      .toThrow(/report this unverified rather than verified/);
  });
});

describe("what a box can hold", () => {
  it("adds the resident cost of every model, not the active parameters", () => {
    // 14 + 20 + 3 = 37GB: fits a 48GB card, not a 32GB one.
    expect(fitsResident([reasoner, coder, speakCommercial], 48)).toMatchObject({ fits: true, requiredGb: 37 });
    expect(fitsResident([reasoner, coder, speakCommercial], 32).fits).toBe(false);
  });

  it("does not claim a fit when a model's footprint is unknown", () => {
    const r = fitsResident([reasoner, hosted], 48);
    expect(r.fits).toBe(false);
    expect(r.unknown).toEqual(["a-hosted-api"]);
  });
});
