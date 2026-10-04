/**
 * Mounts a field runtime on `window.leaseosRuntime` for the shell to use.
 *
 * On a device with the native shell, the shell mounts its own runtime on the
 * encrypted store, vault and keystore before the app loads, and this file
 * does nothing. In a plain browser it mounts the in-memory adapters — the
 * outbox, the queue and the sync protocol without at-rest protection — and
 * says so, so a worker on a laptop gets "saved locally, queued, syncing" and
 * never a false sense that the tablet's vault is under them.
 */

import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, memoryProbes } from "../runtime/adapters/memory";
import { Outbox } from "../runtime/outbox";
import { SyncEngine } from "../runtime/syncEngine";
import type { OutboxStatus, QuickCaptureAction } from "./viewModels";
import type { Transport } from "../runtime/contracts";
import type { SessionObservation } from "@shared/clientContract";
import { captureGate } from "../runtime/capabilities";

export type MountedRuntime = { kind: "native" | "browser_fallback"; outboxStatus: () => Promise<OutboxStatus>; capture: (a: QuickCaptureAction, args?: { jobId?: number | null; unitId?: number | null; fields?: Record<string, unknown>; files?: { bytes: Uint8Array; fileName: string; mimeType: string }[] }) => Promise<{ localId: string }>; syncNow: () => Promise<unknown> };

/**
 * `session` is `observeSession` over `session.context`. Given, the engine sends a
 * queue only under the person and company it was captured for (shared/clientContract.ts).
 */
export function mountBrowserFallbackRuntime(transport: Transport, session?: () => Promise<SessionObservation>): MountedRuntime {
  const g = globalThis as { leaseosRuntime?: MountedRuntime };
  if (g.leaseosRuntime) return g.leaseosRuntime;
  const tickingClock = { now: () => new Date() };
  const keystore = new MemoryKeystore(tickingClock, "software");
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const connectivity = new FlagConnectivity(true);
  // SPINE item 3: every capture passes HS1 and the one offline rule before it is saved.
  const outbox = new Outbox(store, vault, tickingClock, captureGate({ probes: memoryProbes(), connectivity }));
  // HS5: the engine sends a queue only under the person and company it was captured for.
  const engine = new SyncEngine({ store, vault, keystore, transport, connectivity, clock: tickingClock, platform: "web", session });
  if (typeof window !== "undefined") {
    // The connection coming back is a reason to try now, not after the back-off.
    window.addEventListener("online", () => { connectivity.isOnline = true; void engine.syncOnce({ force: true }); });
    window.addEventListener("offline", () => { connectivity.isOnline = false; });
    connectivity.isOnline = navigator.onLine;
  }
  const mounted: MountedRuntime = {
    kind: "browser_fallback",
    outboxStatus: () => outbox.status(),
    capture: async (a, args) => {
      const c = await outbox.saveDraft({ kind: a.kind as never, formKey: a.formKey, title: a.label, category: a.category, fields: args?.fields ?? {}, files: args?.files, jobId: args?.jobId ?? null, unitId: args?.unitId ?? null });
      if (c.jobId != null || c.unitId != null) { await outbox.queue(c.localId); void engine.syncOnce(); }
      return { localId: c.localId };
    },
    // A person asked: skip the back-off. A held queue (sign in / update) stays held.
    syncNow: () => engine.syncOnce({ force: true }),
  };
  g.leaseosRuntime = mounted;
  return mounted;
}
