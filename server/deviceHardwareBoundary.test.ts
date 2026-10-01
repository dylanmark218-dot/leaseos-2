/**
 * HS1 — the device's hardware is reached through the runtime adapter, nowhere else.
 *
 * `client/src/runtime/contracts.ts` puts the camera, GPS, keystore, encrypted
 * store and vault behind interfaces, and `adapters/capacitor.ts` is the one place
 * that loads a native plugin. A component that calls `navigator.geolocation` or
 * opens the camera itself gets a reading the outbox never sees: no vault, no
 * seal, no sync state, no capture time. This guard finds those call sites.
 *
 * HS0 counted one, `client/src/showcase/Home.tsx`, and proposed deleting the
 * showcase as unrouted. It is routed (`/showcase` in `App.tsx`), so it is not
 * deleted here; it is the one named exception, pinned at exactly one, and the
 * exception fails if it grows or if it is fixed without being removed from here.
 * Whether that demo route should capture through the outbox is the owner's call.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilities, nativeProbes, type CapabilityProbes } from "../client/src/runtime/capabilities";
import { FlagConnectivity } from "../client/src/runtime/adapters/memory";

const HARDWARE = [
  /navigator\.geolocation/,
  /navigator\.mediaDevices/,
  /getUserMedia/,
  /type=\{?["']file["']/,
  /\scapture=/,
  /from\s+["']@capacitor/,
  /import\(\s*["']@capacitor/,
];

/** Each exception names its count and why it stands. */
const EXCEPTIONS: Record<string, { count: number; why: string }> = {
  "client/src/showcase/Home.tsx": {
    count: 1,
    why: "the /showcase demo's evidence file picker (HS0 §5); routed, so not deleted; capturing through the outbox is an owner decision",
  },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(e => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return p.endsWith(join("runtime", "adapters")) ? [] : sources(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe("hardware is reached only through the runtime adapter", () => {
  it("finds no direct call site outside the adapter beyond the named exception", () => {
    const found: Record<string, number> = {};
    for (const file of sources("client/src")) {
      const lines = readFileSync(file, "utf8").split("\n");
      const hits = lines.filter(l => HARDWARE.some(re => re.test(l))).length;
      if (hits) found[file] = hits;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(EXCEPTIONS).map(([f, e]) => [f, e.count])));
  });

  it("gives every exception a reason", () => {
    for (const e of Object.values(EXCEPTIONS)) expect(e.why.length).toBeGreaterThan(20);
  });
});

describe("capabilities() reports what the runtime can do, probed", () => {
  const all = (v: boolean): CapabilityProbes => ({
    localStore: async () => v, fileVault: async () => v, keystore: async () => v,
    camera: async () => v, location: async () => v, network: async () => v,
  });

  it("passes each probe's answer through", async () => {
    expect(await capabilities(all(true))).toEqual({ localStore: true, fileVault: true, keystore: true, camera: true, location: true, network: true });
    expect(await capabilities(all(false))).toEqual({ localStore: false, fileVault: false, keystore: false, camera: false, location: false, network: false });
  });

  it("answers false for a probe that throws or says anything but true", async () => {
    const m = await capabilities({ ...all(true), camera: async () => { throw new Error("plugin crashed"); }, location: async () => "yes" as never });
    expect(m.camera).toBe(false);
    expect(m.location).toBe(false);
    expect(m.keystore).toBe(true);
  });

  it("on a machine with no native shell, reports every binding absent and network from the runtime's own flag", async () => {
    const connectivity = new FlagConnectivity(true);
    expect(await capabilities(nativeProbes(connectivity))).toEqual({ localStore: false, fileVault: false, keystore: false, camera: false, location: false, network: true });
    connectivity.isOnline = false;
    expect((await capabilities(nativeProbes(connectivity))).network).toBe(false);
  });
});
