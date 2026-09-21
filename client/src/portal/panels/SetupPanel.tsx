/**
 * v22.12 — The first-run setup wizard, inside the authoritative portal shell.
 *
 * Every step calls the real procedure and shows the server's answer. The
 * wizard proposes; approval is a second person's; readiness is the server's
 * projection, never a checkbox the screen ticks for itself.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { SERVICE_CATALOGUE, dollarsToMillis, nextStep, percentToBps, stepStates, type StepKey } from "../setupModel";

const box = "rounded-2xl border border-[#dfe5ee] bg-white p-4";
const input = "w-full rounded-lg border border-[#cfd6e0] px-3 py-2 text-sm";
const button = "rounded-lg bg-[#132a4a] px-4 py-2 text-sm text-white disabled:opacity-50";
const muted = "text-sm text-[#5b6b82]";

export function SetupPanel() {
  const entities = trpc.finance.entitiesList.useQuery();
  const [entityId, setEntityId] = useState<number | null>(null);
  const readiness = trpc.commercialSetup.goLiveReadiness.useQuery({ financialEntityId: entityId ?? 0 }, { enabled: entityId != null });
  const steps = useMemo(() => stepStates(readiness.data ?? null, entityId != null), [readiness.data, entityId]);
  const [step, setStep] = useState<StepKey | null>(null);
  const current = step ?? nextStep(steps);
  const utils = trpc.useUtils();
  const refresh = () => { void utils.commercialSetup.goLiveReadiness.invalidate(); void utils.commercialSetup.definitionList.invalidate(); void utils.commercialSetup.profileGet.invalidate(); };

  return (
    <div className="grid gap-4 md:grid-cols-[240px_1fr]">
      <nav className={box}>
        <div className="text-xs uppercase tracking-wide text-[#5b6b82]">Setup</div>
        {steps.map(s => (
          <button key={s.key} onClick={() => setStep(s.key)} className={`mt-2 block w-full rounded-lg px-3 py-2 text-left text-sm ${current === s.key ? "bg-[#eef2f7]" : ""}`}>
            <span className={`mr-2 inline-block h-2 w-2 rounded-full ${s.status === "done" ? "bg-[#1a7f37]" : s.status === "pending" ? "bg-[#b8860b]" : s.status === "missing" ? "bg-[#b42318]" : "bg-[#9aa5b5]"}`} />
            {s.title}
            <div className="text-xs text-[#5b6b82]">{s.detail}</div>
          </button>
        ))}
      </nav>
      <section className="space-y-4">
        {current === "company" && <CompanyStep entities={(entities.data ?? []) as { id: number; entityRef: string; legalName: string }[]} entityId={entityId} onSelect={id => { setEntityId(id); setStep(null); }} onCreated={() => void entities.refetch()} />}
        {entityId == null && current !== "company" && <div className={box}><p className={muted}>Select the financial entity first — every rate, guardrail and readiness check belongs to one.</p></div>}
        {entityId != null && current === "services" && <ServicesStep entityId={entityId} onSaved={refresh} />}
        {entityId != null && current === "guardrails" && <ServicesStep entityId={entityId} onSaved={refresh} guardrailsOnly />}
        {entityId != null && (current === "rates" || current === "customers" || current === "vendors" || current === "units") && <RatesStep entityId={entityId} focus={current} onChanged={refresh} />}
        {entityId != null && current === "terms" && <div className={box}><h2 className="font-semibold">Billing terms</h2><p className={muted}>Contract terms are recorded per customer account from the closeout (terms record, approve by a second person). This wizard shows whether any are approved; it does not record them here.</p><p className="mt-2 text-sm">{steps.find(s => s.key === "terms")?.detail}</p></div>}
        {entityId != null && current === "readiness" && <ReadinessStep readiness={readiness.data ?? null} loading={readiness.isLoading} />}
      </section>
    </div>
  );
}

function CompanyStep({ entities, entityId, onSelect, onCreated }: { entities: { id: number; entityRef: string; legalName: string }[]; entityId: number | null; onSelect: (id: number) => void; onCreated: () => void }) {
  const create = trpc.finance.entityCreate.useMutation({ onSuccess: onCreated });
  const [form, setForm] = useState({ entityRef: "", legalName: "", operatingName: "", jurisdiction: "CA-AB", fiscalYearEndMonth: "12", fiscalYearEndDay: "31" });
  return (
    <div className={box}>
      <h2 className="font-semibold">Company</h2>
      <p className={muted}>The financial entity that dispatches, bills and pays. Select one, or create it.</p>
      <div className="mt-3 space-y-2">
        {entities.map(e => <button key={e.id} onClick={() => onSelect(e.id)} className={`block w-full rounded-lg border px-3 py-2 text-left text-sm ${entityId === e.id ? "border-[#132a4a] bg-[#eef2f7]" : "border-[#dfe5ee]"}`}>{e.legalName} <span className="text-[#5b6b82]">· {e.entityRef}</span></button>)}
        {!entities.length && <p className={muted}>No entity yet.</p>}
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <input className={input} placeholder="Entity reference (e.g. NORTHERN-HYDROVAC)" value={form.entityRef} onChange={e => setForm({ ...form, entityRef: e.target.value })} />
        <input className={input} placeholder="Legal name" value={form.legalName} onChange={e => setForm({ ...form, legalName: e.target.value })} />
        <input className={input} placeholder="Operating name" value={form.operatingName} onChange={e => setForm({ ...form, operatingName: e.target.value })} />
        <input className={input} placeholder="Jurisdiction (CA-AB)" value={form.jurisdiction} onChange={e => setForm({ ...form, jurisdiction: e.target.value })} />
      </div>
      <button className={`${button} mt-3`} disabled={create.isPending || form.entityRef.length < 2 || !form.legalName} onClick={() => create.mutate({ entityRef: form.entityRef, legalName: form.legalName, operatingName: form.operatingName || form.legalName, jurisdiction: form.jurisdiction, fiscalYearEndMonth: Number(form.fiscalYearEndMonth), fiscalYearEndDay: Number(form.fiscalYearEndDay) } as never)}>Create entity</button>
      {create.error && <p className="mt-2 text-sm text-[#b42318]">{create.error.message}</p>}
    </div>
  );
}

function ServicesStep({ entityId, onSaved, guardrailsOnly }: { entityId: number; onSaved: () => void; guardrailsOnly?: boolean }) {
  const profile = trpc.commercialSetup.profileGet.useQuery({ financialEntityId: entityId });
  const set = trpc.commercialSetup.profileSet.useMutation({ onSuccess: onSaved });
  const [services, setServices] = useState<string[] | null>(null);
  const [g, setG] = useState({ target: "30", warning: "20", minimum: "15", office: "25", management: "20", controller: "0" });
  const chosen = services ?? profile.data?.services ?? [];
  const toggle = (code: string) => setServices(chosen.includes(code) ? chosen.filter(c => c !== code) : [...chosen, code]);
  const save = () => set.mutate({ financialEntityId: entityId, services: chosen, targetMarginBps: percentToBps(g.target), warningMarginBps: percentToBps(g.warning), minimumAuthorityMarginBps: percentToBps(g.minimum), discountAuthority: { office: percentToBps(g.office) ?? 0, management: percentToBps(g.management) ?? 0, controller: percentToBps(g.controller) ?? 0 }, openBookCustomerRefs: profile.data?.openBookCustomerRefs ?? [] });
  return (
    <div className={box}>
      <h2 className="font-semibold">{guardrailsOnly ? "Margin guardrails" : "What do you do?"}</h2>
      {!guardrailsOnly && <div className="mt-3 grid gap-2 md:grid-cols-3">{SERVICE_CATALOGUE.map(s => <label key={s.code} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={chosen.includes(s.code)} onChange={() => toggle(s.code)} />{s.label}</label>)}</div>}
      <div className="mt-4 grid gap-2 md:grid-cols-3">
        <label className="text-sm">Target margin %<input className={input} value={g.target} onChange={e => setG({ ...g, target: e.target.value })} /></label>
        <label className="text-sm">Warning margin %<input className={input} value={g.warning} onChange={e => setG({ ...g, warning: e.target.value })} /></label>
        <label className="text-sm">Minimum authority %<input className={input} value={g.minimum} onChange={e => setG({ ...g, minimum: e.target.value })} /></label>
        <label className="text-sm">Office may discount to %<input className={input} value={g.office} onChange={e => setG({ ...g, office: e.target.value })} /></label>
        <label className="text-sm">Management to %<input className={input} value={g.management} onChange={e => setG({ ...g, management: e.target.value })} /></label>
        <label className="text-sm">Controller to %<input className={input} value={g.controller} onChange={e => setG({ ...g, controller: e.target.value })} /></label>
      </div>
      <p className={`${muted} mt-2`}>Business policy, not law: the resolver names who must approve a price below the caller's authority.</p>
      <button className={`${button} mt-3`} disabled={set.isPending} onClick={save}>Save</button>
      {set.error && <p className="mt-2 text-sm text-[#b42318]">{set.error.message}</p>}
    </div>
  );
}

const RATE_KINDS = { rates: "sell", customers: "sell", vendors: "vendor_payable", units: "internal_cost" } as const;
function RatesStep({ entityId, focus, onChanged }: { entityId: number; focus: "rates" | "customers" | "vendors" | "units"; onChanged: () => void }) {
  const kind = RATE_KINDS[focus];
  const list = trpc.commercialSetup.definitionList.useQuery({ financialEntityId: entityId, rateKind: kind });
  const propose = trpc.commercialSetup.definitionPropose.useMutation({ onSuccess: () => { void list.refetch(); onChanged(); } });
  const approve = trpc.commercialSetup.definitionApprove.useMutation({ onSuccess: () => { void list.refetch(); onChanged(); } });
  const [f, setF] = useState({ serviceCode: "", rate: "", unit: "hour", scopeLevel: focus === "customers" ? "customer_contract" : "company", customerAccountRef: "", vendorRef: "", unitId: "", minimumHours: "", incrementMinutes: "", sourceClause: "" });
  const submit = () => {
    const rateMillis = dollarsToMillis(f.rate);
    if (rateMillis == null || !f.serviceCode) return;
    propose.mutate({ financialEntityId: entityId, rateKind: kind, serviceCode: f.serviceCode, pricingMethod: "per_unit", unit: f.unit as never, rateMillis, scopeLevel: f.scopeLevel as never, customerAccountRef: f.customerAccountRef || undefined, vendorRef: f.vendorRef || undefined, unitId: f.unitId ? Number(f.unitId) : undefined, minimumQuantityMillis: f.minimumHours ? dollarsToMillis(f.minimumHours) ?? undefined : undefined, billingIncrementMillis: f.incrementMinutes ? Math.round(Number(f.incrementMinutes) / 60 * 1000) : undefined, effectiveFrom: new Date(), sourceKind: "human", sourceClause: f.sourceClause || undefined });
  };
  const title = { rates: "Rates — what you charge", customers: "Customer-specific rates", vendors: "Vendor payables — what you owe", units: "Internal cost per unit" }[focus];
  return (
    <div className="space-y-4">
      <div className={box}>
        <h2 className="font-semibold">{title}</h2>
        <p className={muted}>A definition is proposed here and prices nothing until a different person approves it. Amounts are stored as integers; a rate keeps three decimals.</p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <input className={input} placeholder="Service code (hydrovac)" value={f.serviceCode} onChange={e => setF({ ...f, serviceCode: e.target.value })} />
          <input className={input} placeholder="Rate (325.00)" value={f.rate} onChange={e => setF({ ...f, rate: e.target.value })} />
          <select className={input} value={f.unit} onChange={e => setF({ ...f, unit: e.target.value })}>{["hour", "day", "load", "km", "m3", "tonne", "litre", "each"].map(u => <option key={u} value={u}>{u}</option>)}</select>
          <select className={input} value={f.scopeLevel} onChange={e => setF({ ...f, scopeLevel: e.target.value })}>{["company", "branch", "customer_rate_card", "customer_contract", "project_site", "po_afe"].map(s => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select>
          {(focus === "customers" || f.scopeLevel.startsWith("customer") || f.scopeLevel === "project_site") && <input className={input} placeholder="Customer account ref" value={f.customerAccountRef} onChange={e => setF({ ...f, customerAccountRef: e.target.value })} />}
          {focus === "vendors" && <input className={input} placeholder="Vendor ref" value={f.vendorRef} onChange={e => setF({ ...f, vendorRef: e.target.value })} />}
          {focus === "units" && <input className={input} placeholder="Unit id (blank = class-wide)" value={f.unitId} onChange={e => setF({ ...f, unitId: e.target.value })} />}
          <input className={input} placeholder="Minimum hours (optional)" value={f.minimumHours} onChange={e => setF({ ...f, minimumHours: e.target.value })} />
          <input className={input} placeholder="Increment minutes (optional)" value={f.incrementMinutes} onChange={e => setF({ ...f, incrementMinutes: e.target.value })} />
          <input className={input} placeholder="Source clause (MSA §4.2)" value={f.sourceClause} onChange={e => setF({ ...f, sourceClause: e.target.value })} />
        </div>
        <button className={`${button} mt-3`} disabled={propose.isPending || !f.serviceCode || dollarsToMillis(f.rate) == null} onClick={submit}>Propose</button>
        {propose.error && <p className="mt-2 text-sm text-[#b42318]">{propose.error.message}</p>}
        {propose.data && <p className="mt-2 text-sm">{propose.data.message}</p>}
      </div>
      <div className={box}>
        <h3 className="font-semibold">Definitions</h3>
        {!list.data?.length && <p className={muted}>None yet.</p>}
        {list.data?.map(d => (
          <div key={d.definitionRef} className="mt-2 flex items-center justify-between rounded-lg border border-[#dfe5ee] px-3 py-2 text-sm">
            <div><span className="font-medium">{d.serviceCode}</span> · {d.rateMillis != null ? `$${(d.rateMillis / 1000).toFixed(3)}/${d.unit}` : d.pricingMethod} · {d.scopeLevel.replace(/_/g, " ")} · <span className={d.approvalStatus === "approved" ? "text-[#1a7f37]" : d.approvalStatus === "proposed" ? "text-[#b8860b]" : "text-[#5b6b82]"}>{d.approvalStatus}</span>{d.sourceClause ? ` · ${d.sourceClause}` : ""}</div>
            {d.approvalStatus === "proposed" && <button className={button} disabled={approve.isPending} onClick={() => approve.mutate({ definitionRef: d.definitionRef })}>Approve</button>}
          </div>
        ))}
        {approve.error && <p className="mt-2 text-sm text-[#b42318]">{approve.error.message}</p>}
      </div>
    </div>
  );
}

function ReadinessStep({ readiness, loading }: { readiness: { percent: number; ready: boolean; missing: string[]; checks: { key: string; ok: boolean; detail: string }[] } | null; loading: boolean }) {
  if (loading) return <div className={box}><p className={muted}>Projecting readiness…</p></div>;
  if (!readiness) return <div className={box}><p className={muted}>No projection yet.</p></div>;
  return (
    <div className={box}>
      <h2 className="font-semibold">Go-live readiness: {readiness.percent}%</h2>
      <p className={muted}>{readiness.ready ? "Every check passes." : "What remains before LeaseOS can dispatch, bill and pay with confidence:"}</p>
      <ul className="mt-3 space-y-1 text-sm">{readiness.checks.map(c => <li key={c.key}><span className={`mr-2 inline-block h-2 w-2 rounded-full ${c.ok ? "bg-[#1a7f37]" : "bg-[#b42318]"}`} />{c.detail}</li>)}</ul>
    </div>
  );
}
