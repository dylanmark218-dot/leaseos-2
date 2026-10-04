import type { QuickCaptureAction } from "./viewModels";

/**
 * Six big buttons. Each hands a capture kind to the field runtime's outbox
 * when the shell is present (`window.leaseosRuntime.capture`), and otherwise
 * to the existing upload path. The capture is saved locally before anything
 * else happens — that is the runtime's rule, not the button's.
 */
/**
 * The one way a client surface starts a capture: hand it to the field runtime, whose outbox passes
 * HS1 and the offline rule before anything is saved (SPINE item 3), or, with no runtime, send the
 * worker to the authoritative evidence surface. No surface opens the camera or a file picker itself.
 */
export function startQuickCapture(a: QuickCaptureAction): void {
  const rt = (globalThis as { leaseosRuntime?: { capture?: (a: QuickCaptureAction) => Promise<unknown> } }).leaseosRuntime;
  if (rt?.capture) void rt.capture(a);
  else window.location.assign(`/evidence?capture=${encodeURIComponent(a.kind)}`);
}

export function QuickCapture({ actions }: { actions: QuickCaptureAction[] }) {
  const start = startQuickCapture;
  return (
    <section aria-label="Quick capture" className="mt-6 rounded-2xl border border-[#dfe5ee] bg-white p-5">
      <div className="text-xs uppercase text-[#5b6b82]">Quick capture</div>
      <div className="mt-3 grid grid-cols-3 gap-3 md:grid-cols-6">
        {actions.map(a => (
          <button key={a.key} onClick={() => start(a)} className="min-h-20 rounded-xl bg-[#132a4a] text-base font-medium text-white active:scale-95">{a.label}</button>
        ))}
      </div>
    </section>
  );
}
