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

import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault } from "../runtime/adapters/memory";
import { Outbox } from "../runtime/outbox";
import { SyncEngine } from "../runtime/syncEngine";
import type { OutboxStatus, QuickCaptureAction } from "./viewModels";
import type { Transport } from "../runtime/contracts";

export type MountedRuntime = { kind: "native" | "browser_fallback"; outboxStatus: () => Promise<OutboxStatus>; capture: (a: QuickCaptureAction, args?: { jobId?: number | null; unitId?: number | null; fields?: Record<string, unknown>; files?: { bytes: Uint8Array; fileName: string; mimeType: string }[] }) => Promise<{ localId: string }>; syncNow: () => Promise<unknown> };

export function mountBrowserFallbackRuntime(transport: Transport): MountedRuntime {
  const g = globalThis as { leaseosRuntime?: MountedRuntime };
  if (g.leaseosRuntime) return g.leaseosRuntime;
  const tickingClock = { now: () => new Date() };
  const keystore = new MemoryKeystore(tickingClock, "software");
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const connectivity = new FlagConnectivity(true);
  const outbox = new Outbox(store, vault, tickingClock, connectivity);
  const engine = new SyncEngine({ store, vault, keystore, transport, connectivity, clock: tickingClock, platform: "web" });
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { connectivity.isOnline = true; void engine.syncOnce(); });
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
    syncNow: () => engine.syncOnce(),
  };
  g.leaseosRuntime = mounted;
  return mounted;
}
