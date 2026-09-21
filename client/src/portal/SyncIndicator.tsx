import { useEffect, useState } from "react";
import { syncIndicator, type OutboxStatus } from "./viewModels";

/**
 * Reads the field runtime's outbox status when a runtime is mounted on
 * `window.leaseosRuntime` (the native shell sets it); otherwise it shows only
 * online/offline. The browser without the shell has no durable outbox to
 * report, and says so by showing less rather than pretending.
 */
export function SyncIndicator({ online }: { online: boolean }) {
  const [status, setStatus] = useState<OutboxStatus | null>(null);
  useEffect(() => {
    const rt = (globalThis as { leaseosRuntime?: { outboxStatus?: () => Promise<OutboxStatus> } }).leaseosRuntime;
    if (!rt?.outboxStatus) return;
    let live = true;
    const tick = async () => { try { const s = await rt.outboxStatus!(); if (live) setStatus(s); } catch { /* keep last */ } };
    void tick();
    const h = setInterval(tick, 15_000);
    return () => { live = false; clearInterval(h); };
  }, []);
  const m = syncIndicator(status, online);
  const tone = m.tone === "ok" ? "bg-[#e6f4ea] text-[#1e6b3a]" : m.tone === "pending" ? "bg-[#fff4e5] text-[#8a4b0a]" : m.tone === "offline" ? "bg-[#eef2f7] text-[#5b6b82]" : "bg-[#fdecec] text-[#b42318]";
  return <span className={`rounded-full px-3 py-1 text-xs ${tone}`} aria-live="polite">{m.label}</span>;
}
