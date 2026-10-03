/**
 * The Fleet list — the view. Props in, DOM out.
 *
 * Exception-first (LEASEOS_B21_0): held and unestablished units sort above operational ones, and
 * every row carries the status word and glyph from `fleetPresentation`, never a colour alone. A
 * status this screen does not recognise renders "Unavailable" — the screen never promotes a unit.
 */
import { presentAssetClass, presentLifecycle, presentOperational, TONE_CLASS, TONE_GLYPH } from "./fleetPresentation";

export type FleetListRow = {
  unitId: number;
  unitNumber: string;
  assetClass: string | null;
  assetType: string | null;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  plate: string | null;
  lifecycleStatus: string;
  status: string;
  activeHolds: number;
  openCriticalDefects: number;
  assignedOperatorName: string | null;
};

export type FleetListFilters = {
  status: string | null;
  lifecycle: string | null;
  assetClass: string | null;
  q: string;
};

export type FleetListState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; rows: FleetListRow[]; total: number; cap: number };

const RANK: Record<string, number> = { out_of_service: 0, maintenance_hold: 1, indeterminate: 2, warning: 3, available: 4 };

export function Badge({ status, kind }: { status: string; kind: "operational" | "lifecycle" }) {
  const p = kind === "operational" ? presentOperational(status) : presentLifecycle(status);
  return <span title={p.meaning} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[p.tone]}`}><span aria-hidden>{TONE_GLYPH[p.tone]}</span>{p.label}</span>;
}

export function FleetListView({ state, filters, onFilter, onOpen }: {
  state: FleetListState;
  filters: FleetListFilters;
  onFilter: (next: FleetListFilters) => void;
  onOpen: (unitId: number) => void;
}) {
  return (
    <section aria-label="Fleet">
      <div className="mb-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col text-xs text-[#5b6b82]">Status
          <select aria-label="Status filter" value={filters.status ?? ""} onChange={e => onFilter({ ...filters, status: e.target.value || null })} className="rounded-lg border border-[#dfe5ee] bg-white px-2 py-1 text-sm text-[#172033]">
            <option value="">Any</option>
            <option value="available">Operational</option>
            <option value="warning">With warnings</option>
            <option value="maintenance_hold">Maintenance hold</option>
            <option value="out_of_service">Out of service</option>
            <option value="indeterminate">Not established</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-[#5b6b82]">Lifecycle
          <select aria-label="Lifecycle filter" value={filters.lifecycle ?? ""} onChange={e => onFilter({ ...filters, lifecycle: e.target.value || null })} className="rounded-lg border border-[#dfe5ee] bg-white px-2 py-1 text-sm text-[#172033]">
            <option value="">In fleet and stored</option>
            <option value="active">In fleet</option>
            <option value="seasonal_storage">In storage</option>
            <option value="retired">Retired</option>
            <option value="sold">Sold</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-[#5b6b82]">Class
          <select aria-label="Class filter" value={filters.assetClass ?? ""} onChange={e => onFilter({ ...filters, assetClass: e.target.value || null })} className="rounded-lg border border-[#dfe5ee] bg-white px-2 py-1 text-sm text-[#172033]">
            <option value="">Any</option>
            <option value="power_unit">Power units</option>
            <option value="trailer">Trailers</option>
            <option value="mounted_system">Mounted systems</option>
            <option value="portable_equipment">Portable equipment</option>
            <option value="component">Components</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-[#5b6b82]">Unit
          <input aria-label="Unit search" value={filters.q} onChange={e => onFilter({ ...filters, q: e.target.value })} placeholder="Unit number, plate, VIN" className="rounded-lg border border-[#dfe5ee] bg-white px-2 py-1 text-sm text-[#172033]" />
        </label>
      </div>

      {state.kind === "loading" && <p className="text-sm text-[#5b6b82]">Reading the fleet…</p>}
      {state.kind === "failed" && <p role="alert" className="text-sm text-[#b42318]">{state.message}</p>}
      {state.kind === "loaded" && state.rows.length === 0 && <p className="text-sm text-[#5b6b82]">No unit matches. The list is read from the server; an empty list is an empty answer, not a demonstration.</p>}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <div className="rounded-2xl border border-[#dfe5ee] bg-white">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-[#5b6b82]">
              <tr><th className="px-4 py-2">Unit</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">State</th><th className="px-4 py-2">Lifecycle</th><th className="px-4 py-2">Driver</th><th className="px-4 py-2">Holds</th></tr>
            </thead>
            <tbody className="divide-y divide-[#eef2f7]">
              {[...state.rows].sort((a, b) => (RANK[a.status] ?? -1) - (RANK[b.status] ?? -1) || a.unitNumber.localeCompare(b.unitNumber)).map(r => (
                <tr key={r.unitId} className="hover:bg-[#f7f9fc]">
                  <td className="px-4 py-2"><button onClick={() => onOpen(r.unitId)} className="font-medium text-[#132a4a] underline-offset-2 hover:underline">Unit {r.unitNumber}</button>{r.plate && <div className="text-xs text-[#5b6b82]">Plate {r.plate}</div>}</td>
                  <td className="px-4 py-2">{r.assetType ? r.assetType.replace(/_/g, " ") : <span className="text-[#5b6b82]">{presentAssetClass(r.assetClass)}</span>}{(r.make || r.model || r.modelYear) && <div className="text-xs text-[#5b6b82]">{[r.modelYear, r.make, r.model].filter(Boolean).join(" ")}</div>}</td>
                  <td className="px-4 py-2"><Badge status={r.status} kind="operational" /></td>
                  <td className="px-4 py-2"><Badge status={r.lifecycleStatus} kind="lifecycle" /></td>
                  <td className="px-4 py-2">{r.assignedOperatorName ?? <span className="text-[#5b6b82]">—</span>}</td>
                  <td className="px-4 py-2">{r.activeHolds > 0 ? `${r.activeHolds} active` : "—"}{r.openCriticalDefects > 0 && <div className="text-xs text-[#b42318]">{r.openCriticalDefects} critical defect{r.openCriticalDefects > 1 ? "s" : ""}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.total > state.rows.length && <p className="px-4 py-2 text-xs text-[#5b6b82]">Showing {state.rows.length} of {state.total} (the list reads at most {state.cap} at a time — narrow the filters).</p>}
        </div>
      )}
    </section>
  );
}
