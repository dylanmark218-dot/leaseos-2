/**
 * HS1 — what this runtime can physically do, probed rather than assumed.
 *
 * The surface is frozen in `docs/hybrid-seam/HS_CONTRACTS.md` §1: `CapabilityMatrix` with exactly
 * six booleans and `capabilities(): Promise<CapabilityMatrix>`. It answers a hardware question. It is
 * not an offline policy (`shared/offlinePolicy.ts`) and not an authorization: a device that can take a
 * photograph has not thereby been allowed to commit anything.
 *
 * Also here: HS0's guard — no direct hardware call site outside the runtime adapters — and the
 * showcase, which keeps its route and loses its bypass.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { capabilities, probeCapabilities, type CapabilityMatrix, type CapabilityProbes } from "../client/src/runtime/capabilities";
import { BrowserFilePickerScanner } from "../client/src/runtime/adapters/browserFilePicker";
import { NotOnDeviceError } from "../client/src/runtime/contracts";

const FROZEN_KEYS = ["camera", "fileVault", "keystore", "localStore", "location", "network"];
const probes = (o: Partial<Record<keyof CapabilityMatrix, () => Promise<unknown>>> = {}): CapabilityProbes => ({
  localStore: async () => false, fileVault: async () => false, keystore: async () => false,
  camera: async () => false, location: async () => false, network: async () => false,
  ...o,
} as CapabilityProbes);

describe("the matrix is exactly the frozen contract", () => {
  it("has the six frozen keys and no others", async () => {
    expect(Object.keys(await probeCapabilities(probes())).sort()).toEqual(FROZEN_KEYS);
    expect(Object.keys(await capabilities()).sort()).toEqual(FROZEN_KEYS);
  });

  it("reports a supported capability as available", async () => {
    const m = await probeCapabilities(probes({ camera: async () => true }));
    expect(m.camera).toBe(true);
  });

  it("reports an unsupported capability as unavailable", async () => {
    expect((await probeCapabilities(probes())).camera).toBe(false);
  });

  it("does not turn a hopeful answer into true: only a probe that says exactly true counts", async () => {
    const m = await probeCapabilities(probes({ camera: async () => "yes", location: async () => 1, keystore: async () => ({}) }));
    expect(m).toMatchObject({ camera: false, location: false, keystore: false });
  });

  it("is safe when platform detection fails: a throwing probe reads unavailable and the rest still answer", async () => {
    const m = await probeCapabilities(probes({ camera: async () => { throw new Error("plugin exploded"); }, network: async () => true }));
    expect(m.camera).toBe(false);
    expect(m.network).toBe(true);
  });

  it("cannot be widened after the fact by a workflow that wants a capability", async () => {
    const m = await probeCapabilities(probes());
    expect(() => { (m as { camera: boolean }).camera = true; }).toThrow();
    expect(m.camera).toBe(false);
  });

  it("gives the same answer for the same environment", async () => {
    expect(await capabilities()).toEqual(await capabilities());
  });

  it("in this container — no native shell — reports every native binding unavailable", async () => {
    const m = await capabilities();
    expect(m).toMatchObject({ localStore: false, fileVault: false, keystore: false, camera: false, location: false });
  });

  it("carries no offline or authorization meaning", () => {
    const body = readFileSync("client/src/runtime/capabilities.ts", "utf8");
    expect(body).not.toMatch(/offlineClass|offlinePolicy|permission|authoriz/i);
  });
});

describe("no direct hardware call site outside the runtime adapters (HS0 §5, HS1 re-spec (b))", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(e => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e) ? [p] : [];
  });
  const HARDWARE = /type=["']file["']|navigator\.geolocation|navigator\.mediaDevices|getUserMedia|watchPosition|\.type\s*=\s*["']file["']/;

  it("finds none in client code, the routed showcase included", () => {
    const offenders = walk("client/src")
      .filter(p => !p.startsWith(join("client", "src", "runtime", "adapters")))
      .filter(p => HARDWARE.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("is not vacuous: the adapter that does touch the hardware is where the guard expects it", () => {
    expect(HARDWARE.test(readFileSync("client/src/runtime/adapters/browserFilePicker.ts", "utf8"))).toBe(true);
  });
});

describe("the showcase keeps its route and goes through the device abstraction", () => {
  const home = readFileSync("client/src/showcase/Home.tsx", "utf8");

  it("is still routed", () => {
    expect(readFileSync("client/src/App.tsx", "utf8")).toMatch(/path="\/showcase"/);
  });

  it("acquires files through the DocumentScanner adapter, not a file input of its own", () => {
    expect(home).toMatch(/from "@\/runtime\/adapters\/browserFilePicker"/);
    expect(home).not.toMatch(/fileInputRef|<input/);
  });

  it("the adapter is a DocumentScanner: unavailable without a document, and it reports no quality it did not measure", async () => {
    const scanner = new BrowserFilePickerScanner({ accept: "image/*" });
    expect(await scanner.available()).toBe(false);   // node: no DOM
    await expect(scanner.scan({ maxPages: 1, allowGallery: true })).rejects.toBeInstanceOf(NotOnDeviceError);
  });
});
