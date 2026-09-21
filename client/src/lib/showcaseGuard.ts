/**
 * The showcase guard. A showcase surface may read; it may never write. The
 * flag is raised by ShowcaseFrame while a showcase page is mounted, and the
 * tRPC link refuses every mutation while it is raised — before the request
 * is built, so nothing leaves the browser. The refusal is a visible error,
 * not a silent drop.
 */
import { TRPCClientError } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

let showcase = false;
export function setShowcaseMode(on: boolean) { showcase = on; }
export function isShowcaseMode() { return showcase; }

export function refusesShowcaseWrite(op: { type: string }): string | null {
  if (!showcase) return null;
  if (op.type !== "mutation") return null;
  return "Showcase surface: this page carries demonstration data and does not write to production. Use the authoritative surface for real records.";
}

export function showcaseGuardLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return () => ({ op, next }) => observable(observer => {
    const refusal = refusesShowcaseWrite(op);
    if (refusal) { observer.error(new TRPCClientError(refusal)); return; }
    const sub = next(op).subscribe(observer);
    return () => sub.unsubscribe();
  });
}
