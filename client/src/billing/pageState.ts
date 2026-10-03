/** v23.32 — the billing containers' one adapter from a tRPC query to the shared PageState. A refusal is "unauthorized", never "empty". */
import type { PageState } from "../commercial/shared";

export const isDenied = (e: { data?: { code?: string } | null } | null | undefined) => e?.data?.code === "FORBIDDEN" || e?.data?.code === "UNAUTHORIZED";
export function stateOf<T>(q: { isPending: boolean; isError: boolean; error: { message: string; data?: { code?: string } | null } | null; data: unknown }, emptyNote: string, isEmpty: (d: T) => boolean): PageState<T> {
  if (q.isPending) return { kind: "loading" };
  if (q.isError) return isDenied(q.error) ? { kind: "unauthorized" } : { kind: "failed", message: q.error?.message ?? "unknown error" };
  const d = q.data as T;
  return isEmpty(d) ? { kind: "empty", note: emptyNote } : { kind: "loaded", data: d };
}
export const offline = () => typeof navigator !== "undefined" && !navigator.onLine;
