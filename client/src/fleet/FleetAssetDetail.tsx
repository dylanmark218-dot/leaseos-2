/**
 * The Asset Detail screen — the container.
 *
 * Reads one unit (`fleet.get`) and its unit-side readiness (`fleet.unitReadiness`), and offers the
 * recorded acts: place or release a hold, record a lifecycle change, detach a component. The server
 * is the only authority on whether this caller may: a FORBIDDEN answer withdraws that control and
 * shows the server's reason, as the dispatch detail does. Every settled mutation re-reads the unit.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { FleetAssetDetailView, type Actions, type DetailState } from "./FleetAssetDetailView";

export default function FleetAssetDetail({ unitId }: { unitId: number }) {
  const valid = Number.isInteger(unitId) && unitId > 0;
  const utils = trpc.useUtils();
  const [forbidden, setForbidden] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const unit = trpc.fleet.get.useQuery({ unitId }, { enabled: valid, retry: false, staleTime: 0, gcTime: 0 });
  const readiness = trpc.fleet.unitReadiness.useQuery({ unitId }, { enabled: valid, retry: false, staleTime: 0, gcTime: 0 });

  const settle = (name: string) => ({
    onMutate: () => { setBusy(name); setLastError(null); },
    onError: (e: { data?: { code?: string } | null; message: string }) => {
      if (e.data?.code === "FORBIDDEN") setForbidden(f => ({ ...f, [name]: e.message }));
      else setLastError(e.message);
    },
    onSettled: async () => { setBusy(null); await utils.fleet.get.invalidate({ unitId }); await utils.fleet.unitReadiness.invalidate({ unitId }); },
  });
  const placeHold = trpc.fleet.holdPlace.useMutation(settle("placeHold"));
  const releaseHold = trpc.fleet.holdRelease.useMutation(settle("releaseHold"));
  const setLifecycle = trpc.fleet.lifecycleSet.useMutation(settle("setLifecycle"));
  const detachComponent = trpc.fleet.componentDetach.useMutation(settle("detachComponent"));

  const state: DetailState =
    !valid ? { kind: "failed", message: `"${String(unitId)}" is not a unit.` }
    : unit.isError ? { kind: "failed", message: unit.error.message }
    : unit.isPending ? { kind: "loading" }
    : { kind: "loaded", detail: { ...unit.data, readiness: readiness.data ?? null } as never };

  const actions: Actions = {
    forbidden, busy, lastError,
    placeHold: a => placeHold.mutate({ unitId, holdType: a.holdType as never, reason: a.reason }),
    releaseHold: a => releaseHold.mutate({ holdRef: a.holdRef, reason: a.reason }),
    setLifecycle: a => setLifecycle.mutate({ unitId, to: a.to as never, reason: a.reason, expectedFrom: (unit.data?.lifecycle.status as never) ?? null }),
    detachComponent: a => detachComponent.mutate({ componentRef: a.componentRef, reason: a.reason }),
  };
  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-3 text-sm text-[#5b6b82]"><a className="underline" href="/fleet">← Fleet</a></div>
      <FleetAssetDetailView state={state} actions={actions} />
    </div>
  );
}
