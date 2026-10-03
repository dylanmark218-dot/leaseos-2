/**
 * The Asset Detail screen — the view. Props in, DOM out.
 *
 * One unit: its identity and lifecycle, the portfolio's derived state with every reason and the act
 * that lifts it, the unit-side readiness (explicitly not a dispatch verdict), holds, components,
 * meters, documents, defects, work orders and history — three levels of disclosure (summary, detail,
 * evidence: expires, verified by, source). Controls are offered; the server is the only authority on
 * whether this caller may use them, so a FORBIDDEN answer withdraws the control and says why.
 */
import { useState } from "react";
import { Badge } from "./FleetListView";
import { presentAssetClass, presentUnitSide, TONE_CLASS, TONE_GLYPH } from "./fleetPresentation";

export type Reason = { code: string; status: string; category: string; label: string; source: { table: string; ref: string }; since: string | Date | null; liftedBy: string };
export type Finding = { code: string; label: string; severity: string; subject: string; overrideClass?: string; domain?: string };
export type HoldRow = { holdRef: string; holdType: string; dispatchEffect: string; reason: string; status: string; placedAt: string | Date; placedByRole: string; releasedAt?: string | Date | null; releaseReason?: string | null; sourceKind: string };
export type ComponentRow = { componentRef: string; direction: "attached" | "attached_to"; otherUnitId: number; otherUnitNumber: string; relationship: string; removable: boolean; installedAt: string | Date; removedAt: string | Date | null; criticalDefectOpen?: boolean; safetyHold?: boolean };
export type DocumentRow = { id: number; docType: string; title: string; identifier: string | null; issuedAt: string | Date | null; expiresAt: string | Date | null; verificationStatus: string; validity: string };
export type MeterRow = { meterType: string; trust: string; current: { value: number; recordedAt: string | Date; source: string } | null };
export type EventRow = { eventRef: string; eventType: string; subjectType: string; subjectRef: string; detail: string | null; actorUserId: number | null; actorRole: string | null; occurredAt: string | Date };

export type AssetDetail = {
  identity: { unitId: number; unitNumber: string; assetClass: string | null; assetType: string | null; assetSubtype: string | null; vehicleType: string; vin: string | null; serialNumber: string | null; plate: string | null; plateJurisdiction: string | null; make: string | null; model: string | null; modelYear: number | null; manufacturer: string | null; ownershipType: string | null; acquiredAt: string | Date | null; homeTerminal: string | null; assignedBranchRef: string | null; assignedDivision: string | null; regulatoryClass: string | null; companyAssetNumber: string | null; notes: string | null };
  lifecycle: { status: string; changedAt: string | Date | null; reason: string | null; retiredAt: string | Date | null };
  state: { status: string; reasons: Reason[]; restrictions: string[]; since: string | Date | null; notEvaluated: readonly { domain: string; reason: string }[] };
  driverNotice: string;
  readiness: { verdict: string; findings: Finding[]; notEvaluated: readonly { axis: string; reason: string }[] } | null;
  assignment: { operatorName: string | null; jobCode: string | null } | null;
  holds: HoldRow[];
  components: ComponentRow[];
  meters: MeterRow[];
  documents: DocumentRow[];
  insurance: { status: string; reason: string } | null;
  defects: { id: number; title: string; severity: string; status: string; reportedAt: string | Date }[];
  workOrders: { id: number; workOrderNumber: string; status: string; priority: string; openedAt: string | Date }[];
  inspections: { id: number; type: string; status: string; observedAt: string | Date }[];
  events: EventRow[];
};

export type DetailState = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; detail: AssetDetail };

export type Actions = {
  forbidden: Record<string, string>;
  placeHold: (args: { holdType: string; reason: string }) => void;
  releaseHold: (args: { holdRef: string; reason: string }) => void;
  setLifecycle: (args: { to: string; reason: string }) => void;
  detachComponent: (args: { componentRef: string; reason: string }) => void;
  busy: string | null;
  lastError: string | null;
};

const TABS = ["Overview", "Maintenance", "Inspections", "Defects", "Documents", "Equipment", "History"] as const;
export type Tab = (typeof TABS)[number];

const when = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title} className="rounded-2xl border border-[#dfe5ee] bg-white p-5"><h2 className="mb-2 text-xs uppercase tracking-wide text-[#5b6b82]">{title}</h2>{children}</section>;
}

function Field({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3 py-1 text-sm"><span className="text-[#5b6b82]">{k}</span><span className="text-right text-[#172033]">{v ?? "—"}</span></div>;
}

export function FleetAssetDetailView({ state, actions, initialTab = "Overview" }: { state: DetailState; actions: Actions; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [holdType, setHoldType] = useState("maintenance");
  const [holdReason, setHoldReason] = useState("");
  const [lifecycleTo, setLifecycleTo] = useState("seasonal_storage");
  const [lifecycleReason, setLifecycleReason] = useState("");

  if (state.kind === "loading") return <p className="text-sm text-[#5b6b82]">Reading the unit…</p>;
  if (state.kind === "failed") return <p role="alert" className="text-sm text-[#b42318]">{state.message}</p>;
  const d = state.detail;
  const ready = d.readiness ? presentUnitSide(d.readiness.verdict) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-4">
        <div className="text-xs uppercase tracking-wide text-[#5b6b82]">LeaseOS · Fleet</div>
        <h1 className="mt-1 text-xl font-semibold">Unit {d.identity.unitNumber} <span className="text-base font-normal text-[#5b6b82]">· {d.identity.assetType ? d.identity.assetType.replace(/_/g, " ") : presentAssetClass(d.identity.assetClass)}</span></h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Badge status={d.state.status} kind="operational" />
          <Badge status={d.lifecycle.status} kind="lifecycle" />
          {d.assignment?.operatorName ? <span className="text-[#5b6b82]">Driver: {d.assignment.operatorName}{d.assignment.jobCode ? ` · ${d.assignment.jobCode}` : ""}</span> : <span className="text-[#5b6b82]">No driver assigned now</span>}
        </div>
        <p className="mt-2 text-sm text-[#172033]">{d.driverNotice}</p>
        {actions.lastError && <p role="alert" className="mt-2 text-sm text-[#b42318]">{actions.lastError}</p>}
      </header>

      <div role="tablist" aria-label="Sections" className="mb-4 flex flex-wrap gap-2 text-sm">
        {TABS.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1 ${tab === t ? "bg-white shadow" : "text-[#5b6b82]"}`}>{t}</button>)}
      </div>

      {tab === "Overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Dispatch readiness, unit side">
            {ready ? (
              <>
                <div className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[ready.tone]}`}><span aria-hidden>{TONE_GLYPH[ready.tone]}</span>{ready.label}</div>
                <p className="mt-1 text-xs text-[#5b6b82]">{ready.meaning} This is not a dispatch verdict; the one gate decides that with the driver, the job and the route.</p>
                <ul className="mt-2 divide-y divide-[#eef2f7]">
                  {d.readiness!.findings.map(f => <li key={f.code} className="py-1 text-sm"><span className="font-medium">{f.label}</span><div className="text-xs text-[#5b6b82]">{f.severity} · {f.code} · {f.subject}{f.overrideClass ? ` · ${f.overrideClass}` : ""}</div></li>)}
                  {d.readiness!.findings.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No unit-side finding stood.</li>}
                </ul>
                <p className="mt-2 text-xs text-[#5b6b82]">Not evaluated here: {d.readiness!.notEvaluated.map(n => n.axis).join(", ")}.</p>
              </>
            ) : <p className="text-sm text-[#5b6b82]">Unit-side readiness was not read.</p>}
          </Card>
          <Card title="State and reasons">
            <ul className="divide-y divide-[#eef2f7]">
              {d.state.reasons.map(r => <li key={`${r.code}:${r.source.ref}`} className="py-1 text-sm"><span className="font-medium">{r.label}</span><div className="text-xs text-[#5b6b82]">{r.status.replace(/_/g, " ")} · {r.category} · since {when(r.since)} · source {r.source.table} {r.source.ref} · lifted by {r.liftedBy}</div></li>)}
              {d.state.reasons.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No reason stands against this unit.</li>}
            </ul>
            {d.state.restrictions.length > 0 && <p className="mt-2 text-xs text-[#c4620a]">Restrictions: {d.state.restrictions.join("; ")}</p>}
            <p className="mt-2 text-xs text-[#5b6b82]">Not evaluated by this state: {d.state.notEvaluated.map(n => n.domain.replace(/_/g, " ")).join(", ")}.</p>
          </Card>
          <Card title="Identity">
            <Field k="Class" v={presentAssetClass(d.identity.assetClass)} />
            <Field k="Type" v={d.identity.assetType?.replace(/_/g, " ")} />
            <Field k="Legacy vehicle type" v={d.identity.vehicleType} />
            <Field k="VIN" v={d.identity.vin} />
            <Field k="Serial" v={d.identity.serialNumber} />
            <Field k="Plate" v={d.identity.plate ? `${d.identity.plate}${d.identity.plateJurisdiction ? ` (${d.identity.plateJurisdiction})` : ""}` : null} />
            <Field k="Make / model / year" v={[d.identity.make, d.identity.model, d.identity.modelYear].filter(Boolean).join(" ") || null} />
            <Field k="Ownership" v={d.identity.ownershipType?.replace(/_/g, " ")} />
            <Field k="Acquired" v={d.identity.acquiredAt ? when(d.identity.acquiredAt) : null} />
            <Field k="Home terminal" v={d.identity.homeTerminal} />
            <Field k="Branch / division" v={[d.identity.assignedBranchRef, d.identity.assignedDivision].filter(Boolean).join(" / ") || null} />
            <Field k="Company asset number" v={d.identity.companyAssetNumber} />
            <Field k="Regulatory class" v={d.identity.regulatoryClass} />
          </Card>
          <Card title="Lifecycle">
            <Field k="Status" v={<Badge status={d.lifecycle.status} kind="lifecycle" />} />
            <Field k="Changed" v={d.lifecycle.changedAt ? when(d.lifecycle.changedAt) : null} />
            <Field k="Reason" v={d.lifecycle.reason} />
            {"setLifecycle" in actions.forbidden ? <p className="mt-2 text-xs text-[#5b6b82]">{actions.forbidden.setLifecycle}</p> : (
              <form className="mt-3 flex flex-col gap-2 text-sm" onSubmit={e => { e.preventDefault(); actions.setLifecycle({ to: lifecycleTo, reason: lifecycleReason }); }}>
                <select aria-label="Lifecycle to" value={lifecycleTo} onChange={e => setLifecycleTo(e.target.value)} className="rounded-lg border border-[#dfe5ee] px-2 py-1">
                  <option value="active">Return to fleet</option><option value="seasonal_storage">Seasonal storage</option><option value="retired">Retire</option><option value="sold">Sold</option>
                </select>
                <input aria-label="Lifecycle reason" value={lifecycleReason} onChange={e => setLifecycleReason(e.target.value)} placeholder="Why (recorded)" className="rounded-lg border border-[#dfe5ee] px-2 py-1" />
                <button disabled={actions.busy != null || lifecycleReason.trim().length < 5} className="rounded-lg bg-[#132a4a] px-3 py-1 text-white disabled:opacity-50">Record lifecycle change</button>
              </form>
            )}
          </Card>
          <Card title="Holds">
            <ul className="divide-y divide-[#eef2f7]">
              {d.holds.map(h => <li key={h.holdRef} className="py-1 text-sm"><span className="font-medium">{h.holdType} · {h.dispatchEffect.replace(/_/g, " ")}</span> — {h.reason}<div className="text-xs text-[#5b6b82]">{h.holdRef} · placed {when(h.placedAt)} by {h.placedByRole} · {h.sourceKind}</div>
                {h.status === "active" && h.sourceKind === "manual" && !("releaseHold" in actions.forbidden) && <button disabled={actions.busy != null} onClick={() => { const reason = window.prompt("Why is this hold released? (recorded)"); if (reason) actions.releaseHold({ holdRef: h.holdRef, reason }); }} className="mt-1 rounded-lg border border-[#dfe5ee] px-2 py-0.5 text-xs">Release</button>}
              </li>)}
              {d.holds.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No active hold.</li>}
            </ul>
            {"placeHold" in actions.forbidden ? <p className="mt-2 text-xs text-[#5b6b82]">{actions.forbidden.placeHold}</p> : (
              <form className="mt-3 flex flex-col gap-2 text-sm" onSubmit={e => { e.preventDefault(); actions.placeHold({ holdType, reason: holdReason }); setHoldReason(""); }}>
                <select aria-label="Hold type" value={holdType} onChange={e => setHoldType(e.target.value)} className="rounded-lg border border-[#dfe5ee] px-2 py-1">
                  {["safety", "maintenance", "inspection", "compliance", "damage", "administrative"].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input aria-label="Hold reason" value={holdReason} onChange={e => setHoldReason(e.target.value)} placeholder="Why (recorded; at least ten characters)" className="rounded-lg border border-[#dfe5ee] px-2 py-1" />
                <button disabled={actions.busy != null || holdReason.trim().length < 10} className="rounded-lg bg-[#132a4a] px-3 py-1 text-white disabled:opacity-50">Place hold</button>
              </form>
            )}
          </Card>
          <Card title="Usage">
            {d.meters.map(m => <Field key={m.meterType} k={m.meterType.replace(/_/g, " ")} v={m.current ? `${m.current.value} (${m.current.source}, ${when(m.current.recordedAt)})${m.trust === "UNTRUSTED_METER_SEQUENCE" ? " · sequence untrusted" : ""}` : "no accepted reading"} />)}
            {d.meters.length === 0 && <p className="text-sm text-[#5b6b82]">No meter observation on record.</p>}
          </Card>
        </div>
      )}

      {tab === "Maintenance" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Work orders">
            <ul className="divide-y divide-[#eef2f7]">{d.workOrders.map(w => <li key={w.id} className="py-1 text-sm">{w.workOrderNumber} · {w.status.replace(/_/g, " ")} · {w.priority} · opened {when(w.openedAt)}</li>)}{d.workOrders.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No work order.</li>}</ul>
          </Card>
          <Card title="Meters">
            {d.meters.map(m => <Field key={m.meterType} k={m.meterType.replace(/_/g, " ")} v={m.current ? `${m.current.value} · ${m.current.source} · ${when(m.current.recordedAt)} · ${m.trust}` : "none"} />)}
          </Card>
        </div>
      )}

      {tab === "Inspections" && <Card title="Inspections"><ul className="divide-y divide-[#eef2f7]">{d.inspections.map(i => <li key={i.id} className="py-1 text-sm">{i.type.replace(/_/g, " ")} · {i.status.replace(/_/g, " ")} · {when(i.observedAt)}</li>)}{d.inspections.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No inspection on record.</li>}</ul></Card>}

      {tab === "Defects" && <Card title="Defects"><ul className="divide-y divide-[#eef2f7]">{d.defects.map(x => <li key={x.id} className="py-1 text-sm"><span className="font-medium">{x.title}</span><div className="text-xs text-[#5b6b82]">{x.severity.replace(/_/g, " ")} · {x.status.replace(/_/g, " ")} · reported {when(x.reportedAt)}</div></li>)}{d.defects.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No open or critical defect.</li>}</ul></Card>}

      {tab === "Documents" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Documents">
            <ul className="divide-y divide-[#eef2f7]">{d.documents.map(x => <li key={x.id} className="py-1 text-sm"><span className="font-medium">{x.title}</span><div className="text-xs text-[#5b6b82]">{x.docType} · {x.validity.replace(/_/g, " ")} · {x.verificationStatus.replace(/_/g, " ")} · issued {when(x.issuedAt)} · expires {when(x.expiresAt)}{x.identifier ? ` · ${x.identifier}` : ""}</div></li>)}{d.documents.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No document on record for this unit.</li>}</ul>
          </Card>
          <Card title="Insurance">{d.insurance ? <p className="text-sm">{d.insurance.status.replace(/_/g, " ")} — {d.insurance.reason}</p> : <p className="text-sm text-[#5b6b82]">Not read.</p>}</Card>
        </div>
      )}

      {tab === "Equipment" && (
        <Card title="Components">
          <ul className="divide-y divide-[#eef2f7]">
            {d.components.map(c => <li key={c.componentRef} className="py-1 text-sm">
              <span className="font-medium">{c.direction === "attached" ? `Carries unit ${c.otherUnitNumber}` : `Mounted on unit ${c.otherUnitNumber}`}</span> · {c.relationship}{c.removable ? "" : " · fixed"}
              <div className="text-xs text-[#5b6b82]">{c.componentRef} · installed {when(c.installedAt)}{c.removedAt ? ` · removed ${when(c.removedAt)}` : ""}{c.criticalDefectOpen ? " · critical defect open on the component" : ""}{c.safetyHold ? " · component out of service" : ""}</div>
              {!c.removedAt && c.direction === "attached" && !("detachComponent" in actions.forbidden) && <button disabled={actions.busy != null} onClick={() => { const reason = window.prompt("Why is it detached? (recorded)"); if (reason) actions.detachComponent({ componentRef: c.componentRef, reason }); }} className="mt-1 rounded-lg border border-[#dfe5ee] px-2 py-0.5 text-xs">Detach</button>}
            </li>)}
            {d.components.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">Nothing attached, and not attached to anything.</li>}
          </ul>
          {"detachComponent" in actions.forbidden && <p className="mt-2 text-xs text-[#5b6b82]">{actions.forbidden.detachComponent}</p>}
        </Card>
      )}

      {tab === "History" && <Card title="History"><ul className="divide-y divide-[#eef2f7]">{d.events.map(e => <li key={e.eventRef} className="py-1 text-sm"><span className="font-medium">{e.eventType.replace(/_/g, " ")}</span> · {e.subjectType} {e.subjectRef}<div className="text-xs text-[#5b6b82]">{when(e.occurredAt)} · {e.actorRole ?? "system"}{e.actorUserId ? ` #${e.actorUserId}` : ""}{e.detail ? ` · ${e.detail}` : ""}</div></li>)}{d.events.length === 0 && <li className="py-1 text-sm text-[#5b6b82]">No portfolio event yet.</li>}</ul></Card>}
    </div>
  );
}
