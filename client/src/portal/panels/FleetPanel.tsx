/**
 * The Fleet panel — the container. Reads `fleet.list` with the filters the person set, hands the
 * rows to the view, and opens a unit. It decides nothing about a unit's state: that arrives from
 * the server, derived, with its reasons.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { FleetListView, type FleetListFilters, type FleetListState } from "@/fleet/FleetListView";

export function FleetPanel({ onOpen }: { onOpen: (unitId: number) => void }) {
  const [filters, setFilters] = useState<FleetListFilters>({ status: null, lifecycle: null, assetClass: null, q: "" });
  const list = trpc.fleet.list.useQuery(
    { status: (filters.status as never) ?? null, lifecycle: (filters.lifecycle as never) ?? null, assetClass: (filters.assetClass as never) ?? null, q: filters.q || null },
    { retry: false, staleTime: 0 },
  );
  const state: FleetListState =
    list.isError ? { kind: "failed", message: list.error.message }
    : list.isPending ? { kind: "loading" }
    : { kind: "loaded", rows: list.data.units, total: list.data.total, cap: list.data.cap };
  return <FleetListView state={state} filters={filters} onFilter={setFilters} onOpen={onOpen} />;
}
