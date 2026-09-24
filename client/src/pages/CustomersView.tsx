/**
 * v23.26 — Customers: the list and the profile, pure. Facts in through props, actions out through
 * callbacks. The profile's eight sections are the ones the checkpoint names; each renders its
 * empty state rather than a blank, and the archived state is a banner, not a hidden record.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { CONTACT_ROLE_KEYS, CUSTOMER_TYPES } from "@shared/commercialVocabulary";
import { Alert, cents, day, Field, HistoryList, human, type PageState, Section, StateBlock, StatusBadge, TabBar } from "../commercial/shared";

export type CustomerRow = { accountRef: string; customerNumber: string | null; name: string; legalName: string | null; customerType: string; status: string; holdReason: string | null; province: string | null; archivedAt: Date | string | null; paymentTermsDays: number };
export type CustomerProfile = CustomerRow & {
  tradeName: string | null; taxStatus: string; gstNumber: string | null; defaultCurrency: string; creditLimitCents: number | null; requiresPurchaseOrder: boolean; requiresAfe: boolean; requiredReferenceKinds: string[]; billingFrequency: string; notes: string | null;
  billingAddress: Record<string, string> | null; physicalAddress: Record<string, string> | null; country: string; rowVersion: number; archiveReason: string | null; createdAt: Date | string; updatedAt: Date | string;
  contacts: { contactRef: string; displayName: string; title: string | null; company: string | null; phone: string | null; mobile: string | null; email: string | null; status: string; roles: { roleKey: string; isPrimary: boolean; status: string }[] }[];
  contracts: { contractRef: string; contractNumber: string; title: string; status: string; effectiveFrom: Date | string; effectiveTo: Date | string | null; version: number }[];
  rateSheets: { rateSheetRef: string; name: string; sheetNumber: string | null; status: string; currentVersion: { versionRef: string; version: number; effectiveFrom: Date | string; effectiveTo: Date | string | null } | null; pending: number }[];
  purchaseOrders: { poRef: string; poNumber: string; afeNumber: string | null; authorizedCents: number; validFrom: Date | string; validTo: Date | string | null; status: string }[];
  jobs: { snapshotRef: string; jobId: number; capturedAt: Date | string; contractRef: string | null; rateSheetVersionRef: string | null; poNumber: string | null; job: { jobCode: string; status: string; type: string; location: string } | null }[];
};
export type ProfileTab = "overview" | "contacts" | "contracts" | "rate_sheets" | "jobs" | "documents" | "billing" | "history";
export type HistoryRow = { id: number; eventType: string; fromStatus: string | null; toStatus: string | null; reason: string | null; actorUserId: number; actorRole: string; occurredAt: Date | string; changesJson?: string | null };
export type DocumentRow = { documentRef: string; documentType: string; title: string; version: number; status: string; registeredAt: Date | string };

export type CustomersViewProps = {
  offline: boolean;
  filter: { q: string; status: string; customerType: string; includeArchived: boolean }; onFilter: (f: CustomersViewProps["filter"]) => void;
  list: PageState<CustomerRow[]>;
  selected: string | null; onSelect: (accountRef: string | null) => void;
  profile: PageState<CustomerProfile>; tab: ProfileTab; onTab: (t: ProfileTab) => void;
  history: PageState<HistoryRow[]>; documents: PageState<DocumentRow[]>;
  canWrite: boolean; canArchive: boolean;
  onCreate: (input: { name: string; customerType: string; customerNumber: string | null; requiresPurchaseOrder: boolean; paymentTermsDays: number }) => void; creating: boolean; financialEntityId: string; onFinancialEntityId: (v: string) => void;
  onHold: (accountRef: string, hold: boolean, reason: string) => void; onArchive: (accountRef: string, reason: string) => void; onReactivate: (accountRef: string) => void;
  onContactCreate: (accountRef: string, input: { displayName: string; phone: string; email: string; roleKey: string }) => void;
  onOpenContract: (contractRef: string) => void; onOpenRateSheet: (rateSheetRef: string) => void; onOpenJob: (jobId: number) => void;
};

const TABS: { key: ProfileTab; label: string }[] = [{ key: "overview", label: "Overview" }, { key: "contacts", label: "Contacts" }, { key: "contracts", label: "Contracts" }, { key: "rate_sheets", label: "Rate sheets" }, { key: "jobs", label: "Jobs" }, { key: "documents", label: "Documents" }, { key: "billing", label: "Billing settings" }, { key: "history", label: "Audit history" }];
const addr = (a: Record<string, string> | null) => (a ? [a.attention, a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") : "—");

export function CustomersView(p: CustomersViewProps) {
  const [draft, setDraft] = useState({ name: "", customerType: "producer_operator", customerNumber: "", requiresPurchaseOrder: false, paymentTermsDays: "30" });
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState({ displayName: "", phone: "", email: "", roleKey: "site_contact" });
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="customers">
      <h1 className="text-xl font-semibold">Customers</h1>
      {p.offline && <StateBlock state={{ kind: "offline" }} what="customers" />}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          <Section title="Find a customer" id="find">
            <div className="grid gap-2">
              <Input aria-label="Search customers" placeholder="name or customer number" value={p.filter.q} onChange={e => p.onFilter({ ...p.filter, q: e.target.value })} />
              <label className="text-xs">Status
                <select aria-label="Filter by status" className="ml-2 rounded border bg-background px-2 py-1" value={p.filter.status} onChange={e => p.onFilter({ ...p.filter, status: e.target.value })}>
                  <option value="">any</option><option value="active">Active</option><option value="on_hold">On billing hold</option><option value="inactive">Inactive</option>
                </select>
              </label>
              <label className="text-xs">Account type
                <select aria-label="Filter by account type" className="ml-2 rounded border bg-background px-2 py-1" value={p.filter.customerType} onChange={e => p.onFilter({ ...p.filter, customerType: e.target.value })}>
                  <option value="">any</option>{CUSTOMER_TYPES.map(t => <option key={t} value={t}>{human(t)}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={p.filter.includeArchived} onChange={e => p.onFilter({ ...p.filter, includeArchived: e.target.checked })} /> include archived</label>
            </div>
          </Section>
          <StateBlock state={p.list} what="the customer list" />
          {p.list.kind === "loaded" && (
            <ul className="space-y-1" aria-label="Customer list" data-testid="customer-list">
              {p.list.data.map(c => (
                <li key={c.accountRef}>
                  <button className={`w-full rounded border p-2 text-left text-sm ${p.selected === c.accountRef ? "border-slate-900" : ""}`} onClick={() => p.onSelect(c.accountRef)} aria-current={p.selected === c.accountRef ? "true" : undefined}>
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">{c.name}</span><StatusBadge status={c.archivedAt ? "inactive" : c.status} /></div>
                    <div className="text-xs text-muted-foreground">{c.customerNumber ?? "no number"} · {human(c.customerType)}{c.province ? ` · ${c.province}` : ""}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {p.canWrite && (
            <Section title="New customer" id="new-customer">
              <form className="grid gap-2" onSubmit={e => { e.preventDefault(); p.onCreate({ name: draft.name.trim(), customerType: draft.customerType, customerNumber: draft.customerNumber.trim() || null, requiresPurchaseOrder: draft.requiresPurchaseOrder, paymentTermsDays: Number(draft.paymentTermsDays) || 30 }); }}>
                <Input aria-label="Financial entity id" placeholder="financial entity id" value={p.financialEntityId} onChange={e => p.onFinancialEntityId(e.target.value)} />
                <Input aria-label="Customer name" placeholder="legal or trading name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
                <Input aria-label="Customer number (blank to mint one)" placeholder="customer number — blank mints one" value={draft.customerNumber} onChange={e => setDraft({ ...draft, customerNumber: e.target.value })} />
                <select aria-label="Customer type" className="rounded border bg-background px-2 py-1 text-sm" value={draft.customerType} onChange={e => setDraft({ ...draft, customerType: e.target.value })}>{CUSTOMER_TYPES.map(t => <option key={t} value={t}>{human(t)}</option>)}</select>
                <Input aria-label="Payment terms in days" type="number" value={draft.paymentTermsDays} onChange={e => setDraft({ ...draft, paymentTermsDays: e.target.value })} />
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.requiresPurchaseOrder} onChange={e => setDraft({ ...draft, requiresPurchaseOrder: e.target.checked })} /> a purchase order is required before dispatch and billing</label>
                <Button type="submit" size="sm" disabled={p.creating || p.offline || !draft.name.trim() || !/^\d+$/.test(p.financialEntityId)}>{p.creating ? "Creating…" : "Create customer"}</Button>
              </form>
            </Section>
          )}
        </div>

        <div className="space-y-3">
          {!p.selected && <p className="text-sm text-muted-foreground" data-testid="no-selection">Select a customer to see its profile.</p>}
          {p.selected && <StateBlock state={p.profile} what={`customer ${p.selected}`} />}
          {p.selected && p.profile.kind === "loaded" && (() => {
            const c = p.profile.data;
            return (
              <div className="space-y-3" data-testid="customer-profile">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold">{c.name}</h2>
                    <div className="text-sm text-muted-foreground">{c.customerNumber ?? "no number"} · {human(c.customerType)} · {c.accountRef}</div>
                  </div>
                  <StatusBadge status={c.archivedAt ? "inactive" : c.status} />
                </div>
                {c.archivedAt && <Alert tone="note"><span data-testid="archived">Archived {day(c.archivedAt)}{c.archiveReason ? ` — ${c.archiveReason}` : ""}. The record and everything under it are kept; nothing new is created against it.</span></Alert>}
                {c.status === "on_hold" && <Alert tone="failed">On billing hold{c.holdReason ? `: ${c.holdReason}` : ""}. Dispatch is blocked until management lifts it.</Alert>}
                <TabBar tabs={TABS} active={p.tab} onTab={p.onTab} />

                {p.tab === "overview" && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Section title="Identity" id="identity"><dl className="space-y-1"><Field label="Legal name" value={c.legalName} /><Field label="Trade name" value={c.tradeName} /><Field label="Type" value={human(c.customerType)} /><Field label="Province / country" value={`${c.province ?? "—"} / ${c.country}`} /><Field label="GST" value={c.gstNumber} /><Field label="Tax status" value={human(c.taxStatus)} /></dl></Section>
                    <Section title="Addresses" id="addresses"><dl className="space-y-1"><Field label="Billing" value={addr(c.billingAddress)} /><Field label="Physical" value={addr(c.physicalAddress)} /></dl></Section>
                    <Section title="At a glance" id="glance"><dl className="space-y-1"><Field label="Contacts" value={c.contacts.filter(x => x.status === "active").length} /><Field label="Contracts" value={c.contracts.length} /><Field label="Rate sheets" value={c.rateSheets.length} /><Field label="Jobs (current snapshots)" value={c.jobs.length} /><Field label="Created" value={day(c.createdAt)} /><Field label="Updated" value={`${day(c.updatedAt)} · v${c.rowVersion}`} /></dl></Section>
                    {c.notes && <Section title="Notes" id="notes"><p className="whitespace-pre-wrap text-sm">{c.notes}</p></Section>}
                  </div>
                )}

                {p.tab === "contacts" && (
                  <div className="space-y-3">
                    {!c.contacts.length && <p className="text-sm text-muted-foreground" data-testid="empty">No contacts on this account yet.</p>}
                    <ul className="space-y-1" aria-label="Contacts">
                      {c.contacts.map(x => (
                        <li key={x.contactRef} className="rounded border p-2 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{x.displayName}{x.title ? `, ${x.title}` : ""}{x.company ? ` — ${x.company}` : ""}</span><StatusBadge status={x.status} /></div>
                          <div className="text-xs text-muted-foreground">{[x.phone, x.mobile, x.email].filter(Boolean).join(" · ") || "no contact details"}</div>
                          <div className="mt-1 flex flex-wrap gap-1">{x.roles.filter(r => r.status === "active").map(r => <span key={r.roleKey} className="rounded border px-1 text-xs">{human(r.roleKey)}{r.isPrimary ? " (primary)" : ""}</span>)}</div>
                        </li>
                      ))}
                    </ul>
                    {p.canWrite && !c.archivedAt && (
                      <Section title="Add a contact" id="new-contact">
                        <form className="grid gap-2 md:grid-cols-2" onSubmit={e => { e.preventDefault(); p.onContactCreate(c.accountRef, contact); setContact({ displayName: "", phone: "", email: "", roleKey: "site_contact" }); }}>
                          <Input aria-label="Contact name" placeholder="name" value={contact.displayName} onChange={e => setContact({ ...contact, displayName: e.target.value })} />
                          <select aria-label="Contact role" className="rounded border bg-background px-2 py-1 text-sm" value={contact.roleKey} onChange={e => setContact({ ...contact, roleKey: e.target.value })}>{CONTACT_ROLE_KEYS.map(r => <option key={r} value={r}>{human(r)}</option>)}</select>
                          <Input aria-label="Contact phone" placeholder="phone" value={contact.phone} onChange={e => setContact({ ...contact, phone: e.target.value })} />
                          <Input aria-label="Contact email" placeholder="email" type="email" value={contact.email} onChange={e => setContact({ ...contact, email: e.target.value })} />
                          <Button type="submit" size="sm" disabled={p.offline || !contact.displayName.trim()}>Add contact</Button>
                        </form>
                      </Section>
                    )}
                  </div>
                )}

                {p.tab === "contracts" && (
                  <div className="space-y-2">
                    {!c.contracts.length && <p className="text-sm text-muted-foreground" data-testid="empty">No contracts. A job may still be worked under the customer's own rate sheet.</p>}
                    <ul className="space-y-1" aria-label="Contracts">{c.contracts.map(k => <li key={k.contractRef}><button className="w-full rounded border p-2 text-left text-sm" onClick={() => p.onOpenContract(k.contractRef)}><div className="flex items-center justify-between gap-2"><span className="font-medium">{k.contractNumber} · {k.title}</span><StatusBadge status={k.status} /></div><div className="text-xs text-muted-foreground">v{k.version} · {day(k.effectiveFrom)} → {k.effectiveTo ? day(k.effectiveTo) : "open"}</div></button></li>)}</ul>
                  </div>
                )}

                {p.tab === "rate_sheets" && (
                  <div className="space-y-2">
                    {!c.rateSheets.length && <p className="text-sm text-muted-foreground" data-testid="empty">No rate sheets. Lines price UNKNOWN until one is approved.</p>}
                    <ul className="space-y-1" aria-label="Rate sheets">{c.rateSheets.map(s => <li key={s.rateSheetRef}><button className="w-full rounded border p-2 text-left text-sm" onClick={() => p.onOpenRateSheet(s.rateSheetRef)}><div className="flex items-center justify-between gap-2"><span className="font-medium">{s.sheetNumber ?? s.rateSheetRef} · {s.name}</span><StatusBadge status={s.currentVersion ? "approved" : s.pending ? "pending_approval" : "unknown"} /></div><div className="text-xs text-muted-foreground">{s.currentVersion ? `current v${s.currentVersion.version} from ${day(s.currentVersion.effectiveFrom)}` : "no approved version"}{s.pending ? ` · ${s.pending} awaiting` : ""}</div></button></li>)}</ul>
                  </div>
                )}

                {p.tab === "jobs" && (
                  <div className="space-y-2">
                    {!c.jobs.length && <p className="text-sm text-muted-foreground" data-testid="empty">No job has frozen a commercial basis against this customer yet.</p>}
                    <ul className="space-y-1" aria-label="Jobs">{c.jobs.map(j => <li key={j.snapshotRef}><button className="w-full rounded border p-2 text-left text-sm" onClick={() => p.onOpenJob(j.jobId)}><div className="flex items-center justify-between gap-2"><span className="font-medium">{j.job?.jobCode ?? `job ${j.jobId}`}</span><span className="text-xs">{day(j.capturedAt)}</span></div><div className="text-xs text-muted-foreground">{j.job ? `${j.job.type} · ${j.job.location} · ${human(j.job.status)}` : "job outside the readable window"} · {j.contractRef ?? "no contract"} · {j.rateSheetVersionRef ?? "no sheet version"} · {j.poNumber ? `PO ${j.poNumber}` : "no PO"}</div></button></li>)}</ul>
                  </div>
                )}

                {p.tab === "documents" && (
                  <div className="space-y-2">
                    <StateBlock state={p.documents} what="the documents" />
                    {p.documents.kind === "loaded" && (p.documents.data.length ? <ul className="space-y-1" aria-label="Documents">{p.documents.data.map(dd => <li key={dd.documentRef} className="rounded border p-2 text-sm"><div className="flex items-center justify-between gap-2"><span className="font-medium">{dd.title}</span><StatusBadge status={dd.status} /></div><div className="text-xs text-muted-foreground">{dd.documentRef} · {dd.documentType} · v{dd.version} · {day(dd.registeredAt)}</div></li>)}</ul> : <p className="text-sm text-muted-foreground" data-testid="empty">No registered document is linked to this customer. Documents are registered in the Commercial Office and linked by record.</p>)}
                  </div>
                )}

                {p.tab === "billing" && (
                  <div className="space-y-3">
                    <Section title="Terms" id="terms"><dl className="space-y-1"><Field label="Payment terms" value={`${c.paymentTermsDays} days`} /><Field label="Currency" value={c.defaultCurrency} /><Field label="Credit limit" value={cents(c.creditLimitCents, c.defaultCurrency)} /><Field label="Billing frequency" value={human(c.billingFrequency)} /><Field label="PO required" value={c.requiresPurchaseOrder ? "Yes" : "No"} /><Field label="AFE required" value={c.requiresAfe ? "Yes" : "No"} /><Field label="Other required references" value={c.requiredReferenceKinds.length ? c.requiredReferenceKinds.map(human).join(", ") : "none"} /></dl></Section>
                    <Section title="Purchase orders" id="pos">
                      {!c.purchaseOrders.length && <p className="text-sm text-muted-foreground" data-testid="empty">No purchase orders recorded.</p>}
                      <ul className="space-y-1 text-sm">{c.purchaseOrders.map(po => <li key={po.poRef} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"><span>{po.poNumber}{po.afeNumber ? ` · AFE ${po.afeNumber}` : ""} · {cents(po.authorizedCents, c.defaultCurrency)} · {day(po.validFrom)} → {po.validTo ? day(po.validTo) : "open"}</span><StatusBadge status={po.status} /></li>)}</ul>
                    </Section>
                    {(p.canWrite || p.canArchive) && !c.archivedAt && (
                      <Section title="Governance" id="governance">
                        <div className="grid gap-2">
                          <Input aria-label="Reason" placeholder="reason (recorded in the ledger)" value={reason} onChange={e => setReason(e.target.value)} />
                          <div className="flex flex-wrap gap-2">
                            {p.canWrite && c.status !== "on_hold" && <Button size="sm" variant="outline" disabled={p.offline || reason.trim().length < 3} onClick={() => { p.onHold(c.accountRef, true, reason.trim()); setReason(""); }}>Place billing hold</Button>}
                            {p.canWrite && c.status === "on_hold" && <Button size="sm" variant="outline" disabled={p.offline || reason.trim().length < 3} onClick={() => { p.onHold(c.accountRef, false, reason.trim()); setReason(""); }}>Release billing hold</Button>}
                            {p.canArchive && <Button size="sm" variant="destructive" disabled={p.offline || reason.trim().length < 3} onClick={() => { p.onArchive(c.accountRef, reason.trim()); setReason(""); }}>Archive customer</Button>}
                          </div>
                        </div>
                      </Section>
                    )}
                    {p.canArchive && c.archivedAt && <Button size="sm" variant="outline" disabled={p.offline} onClick={() => p.onReactivate(c.accountRef)}>Reactivate</Button>}
                  </div>
                )}

                {p.tab === "history" && (<div><StateBlock state={p.history} what="the audit history" />{p.history.kind === "loaded" && <HistoryList rows={p.history.data} />}</div>)}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
