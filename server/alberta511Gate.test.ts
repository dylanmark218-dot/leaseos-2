/**
 * Alberta 511 — the gate stays closed, and the two registries are not the same gate.
 *
 * A developer key now exists for `511.alberta.ca`. Possessing a key is not permission to use the
 * data commercially: 511 Alberta publishes no licence alongside the API, so what the key buys is
 * access, and what LeaseOS needs is a right. The registry records both as `unknown`, which is the
 * honest state until somebody writes the permission down.
 *
 * This file exists so that state cannot drift quietly — a source flipped to `yes` without a
 * recorded assessment should fail here rather than ship.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNVERIFIED_DATA_SOURCES, VERIFIED_DATA_SOURCES } from "./_core/externalSourceSeeds";

const ab511 = [...VERIFIED_DATA_SOURCES, ...UNVERIFIED_DATA_SOURCES].find(s => s.sourceKey === "ab511");

describe("511 Alberta is registered and refused", () => {
  it("sits in the UNVERIFIED list, not the verified one", () => {
    // The separation is the point: a source moves lists when somebody records why it may move.
    expect(UNVERIFIED_DATA_SOURCES.some(s => s.sourceKey === "ab511")).toBe(true);
    expect(VERIFIED_DATA_SOURCES.some(s => s.sourceKey === "ab511")).toBe(false);
  });

  it("is in the registry under `ab511`", () => {
    // Named precisely: the key is `ab511`, not `gov-ab-511`. A permission recorded against the
    // wrong key leaves the real gate shut and reads as though it were open.
    expect(ab511, "ab511 must be seeded").toBeDefined();
    expect(ab511!.authority).toMatch(/Government of Alberta/);
  });

  it("records no licence, because 511 publishes none with the API", () => {
    expect(ab511!.licenceName).toBeNull();
    expect(ab511!.licenceUrl).toBeNull();
  });

  it("holds commercial use and redistribution at unknown, not at no and not at yes", () => {
    /*
     * `unknown` is doing real work here. `no` would assert a refusal nobody has issued; `yes` would
     * assert a permission nobody has given. Unknown is the only one of the three that is true, and
     * the import gate refuses on anything that is not `yes`.
     */
    expect(ab511!.commercialUsePermitted).toBe("unknown");
    expect(ab511!.redistributionPermitted).toBe("unknown");
    expect(ab511!.status).toBe("unverified");
  });

  it("is refused by the import gate on both counts", () => {
    // geoRouter's sourceGate: FORBIDDEN unless commercialUsePermitted === "yes", and
    // PRECONDITION_FAILED unless status === "verified". ab511 fails both, independently.
    const src = readFileSync("server/geoRouter.ts", "utf8");
    expect(src).toMatch(/commercialUsePermitted !== "yes"/);
    expect(src).toMatch(/s\.status !== "verified"/);
    expect(ab511!.commercialUsePermitted).not.toBe("yes");
    expect(ab511!.status).not.toBe("verified");
  });

  it("keeps the throttle the developer page actually states", () => {
    // Verified verbatim even though the licence is not: ten calls every 60 seconds.
    expect(ab511!.rateLimitCalls).toBe(10);
    expect(ab511!.rateLimitWindowSeconds).toBe(60);
  });
});

describe("the data gate and the assistant gate are different gates", () => {
  it("keeps them in separate modules against separate registries", () => {
    /*
     * Worth pinning because they are easy to confuse and the confusion fails silently. Recording a
     * permission against `knowledgeSources` would let the assistant quote 511 while every import
     * still refuses — and the reverse leaves the assistant blocked while data flows. Two registries,
     * two gates, two decisions.
     */
    const dataGate = readFileSync("server/geoRouter.ts", "utf8");
    const knowledgeGate = readFileSync("server/_core/knowledge/sourceGate.ts", "utf8");
    expect(dataGate).toMatch(/externalDataSources/);
    expect(knowledgeGate).toMatch(/rag_ingestion|commercial_redisplay/);
    expect(dataGate).not.toMatch(/rag_ingestion/);
  });
});

describe("no credential is committed", () => {
  it("has no API key literal anywhere in the tree", () => {
    /*
     * A 511 developer key was pasted into a chat transcript and into two screenshots. That one is
     * being rotated; this stops the next one being pasted into the repository instead, where it
     * would outlive the rotation.
     *
     * The shape matched is a bare 32-character hex string — long enough not to fire on a git short
     * hash or a colour, specific enough to catch a key sitting in a config or a fixture.
     */
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() && !["node_modules", ".git", "dist", "build"].includes(e.name) ? walk(`${dir}/${e.name}`)
          : /\.(ts|tsx|json|env|sql|md|yml|yaml)$/.test(e.name) ? [`${dir}/${e.name}`] : []);
    const offenders: string[] = [];
    for (const f of [...walk("server"), ...walk("client/src"), ...walk("scripts")]) {
      if (f.endsWith("alberta511Gate.test.ts")) continue;   // this file describes the shape in order to forbid it
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b[0-9a-f]{32}\b/g)) {
        // A migration checksum or a content hash in a fixture is not a credential; a key assigned
        // to something that reads like one is.
        const line = src.slice(0, m.index).split("\n").length;
        const text = src.split("\n")[line - 1] ?? "";
        if (/key|token|secret|credential/i.test(text)) offenders.push(`${f}:${line}`);
      }
    }
    expect(offenders, "a credential-shaped literal is committed").toEqual([]);
  });
});

describe("the three sources awaiting a written answer stay shut", () => {
  /*
   * P6.3, P6.8, P6.9. Requests drafted in `docs/P6_DATA_PERMISSION_REQUESTS.md`; each source is
   * seeded so a reply has somewhere to land, and each stays `unknown` until one arrives.
   *
   * The failure this guards is not somebody forging a permission. It is the slow one: a source sits
   * at `unknown` for months, nobody remembers whether the email was ever answered, and a developer
   * needing the data flips it to `yes` on the reasoning that it is probably fine. Silence is not
   * consent, and no amount of elapsed time converts an unanswered question into a permission.
   */
  const all = [...VERIFIED_DATA_SOURCES, ...UNVERIFIED_DATA_SOURCES];
  const awaiting = ["ab511", "aer_st107", "sk_iris", "mb_petroleum"] as const;

  it.each(awaiting)("has %s seeded, so an answer has somewhere to land", (key) => {
    expect(all.find(s => s.sourceKey === key), `${key} must be seeded`).toBeDefined();
  });

  it.each(awaiting)("keeps %s at unknown with no licence recorded", (key) => {
    const src = all.find(s => s.sourceKey === key)!;
    expect(src.commercialUsePermitted).toBe("unknown");
    expect(src.redistributionPermitted).toBe("unknown");
    expect(src.status).toBe("unverified");
    // A licence name with no document behind it is the shape a remembered conversation takes.
    expect(src.licenceName).toBeNull();
  });

  it("keeps commercial use and redistribution as separate answers", () => {
    /*
     * v22.74 established this the hard way: permission for one purpose proves nothing about
     * another. An authority may well allow us to store its data and not to show it to a customer,
     * and a single boolean would round that to whichever answer someone wrote first.
     */
    for (const key of awaiting) {
      const src = all.find(s => s.sourceKey === key)!;
      expect(Object.keys(src)).toContain("commercialUsePermitted");
      expect(Object.keys(src)).toContain("redistributionPermitted");
    }
  });
});
