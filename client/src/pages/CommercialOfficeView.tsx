/**
 * P7.9 — the Commercial Office, the view. Pure: facts in through props, actions out through
 * callbacks. Four screens that need no approval-ladder answer: organizations (clients and
 * vendors, roles, link candidates), documents (the registry), disposal reconciliation (open
 * statement lines), and month close (AR/AP aging by organization, GL export readiness,
 * profitability). It never applies a link candidate itself, never hides a GL blocker, and
 * shows "not derivable" as what it is.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export type OfficeTab = "organizations" | "documents" | "disposal" | "month_close";
export type OrgRow = { orgRef: string; name: string; status: string; roles: { roleKey: string; commercialNumber: string | null }[] };
export type RoleType = { roleKey: string; label: string };
export type LinkCandidate = { recordType: string; recordId: number; capturedName: string; orgRef: string; organizationName: string; evidence: string; applied: boolean };
export type DocRow = { documentRef: string; documentType: string; title: string; version: number; status: string; contentHash: string; counterpartyOrgRef: string | null; issuedAt: Date | string | null; retentionClass: string | null };
export type DocDetail = { document: DocRow; retention: string; links: { recordType: string; recordRef: string }[]; deliveries: { deliveryRef: string; channel: string; status: string; failureReason: string | null }[]; versions: { documentRef: string; version: number; status: string }[] };
export type StatementRow = { statementRef: string; facilityOrgRef: string | null; periodStart: string | Date; periodEnd: string | Date; lineCount: number; matchedCount: number; varianceCount: number; unmatchedCount: number; ambiguousCount: number; status: string; openLines: number };
export type StatementLine = { lineNo: number; facilityTicketNumber: string | null; matchOutcome: string; resolution: string | null; variances: string[] | null; candidateTicketIds: number[] | null; quantity: number | null; amountCents: number | null };
export type Aging = { organizations: { orgRef: string | null; label: string; invoiceCount?: number; billCount?: number; buckets: Record<string, number>; totalOutstandingCents: number }[]; unlinked: { label: string; totalOutstandingCents: number }[]; note?: string } | null;
export type GlReadiness = { state: "READY" | "BLOCKED"; blockers: { key?: string; reason?: string; [k: string]: unknown }[] } | null;
export type Profitability = { dimension: string; derivable: string; basis?: string; note?: string; rows: { key: string; label?: string; revenueCents?: number; costCents?: number; marginCents?: number; [k: string]: unknown }[] } | null;
export type LineResolution = "accepted" | "ticket_needs_correction" | "facility_error" | "disputed";

export type CommercialOfficeViewProps = {
  tab: OfficeTab; onTab: (t: OfficeTab) => void;
  orgQuery: string; onOrgQuery: (v: string) => void; organizations: OrgRow[]; roleTypes: RoleType[];
  onCreateOrganization: (name: string, roleKey: string | null) => void; creating: boolean; onAssignRole: (orgRef: string, roleKey: string) => void;
  candidateType: "vendor" | "facility" | "job_customer"; onCandidateType: (t: "vendor" | "facility" | "job_customer") => void; candidates: LinkCandidate[]; unlinkedCount: number; onLink: (c: LinkCandidate) => void;
  docFilter: { documentType: string; recordType: string; recordRef: string; includeSuperseded: boolean }; onDocFilter: (f: CommercialOfficeViewProps["docFilter"]) => void; documents: DocRow[]; selectedDoc: DocDetail | null; onSelectDoc: (ref: string) => void;
  statements: StatementRow[]; selectedStatement: string | null; onSelectStatement: (ref: string) => void; lines: StatementLine[]; onResolveLine: (statementRef: string, lineNo: number, resolution: LineResolution, note: string, chosenDisposalTicketId?: number) => void; resolving: boolean;
  entityId: string; onEntityId: (v: string) => void; period: { from: string; to: string }; onPeriod: (p: { from: string; to: string }) => void; arAging: Aging; apAging: Aging; glReadiness: GlReadiness; profitability: Profitability; profitDimension: string; onProfitDimension: (d: string) => void;
};

const money = (c: number) => (c / 100).toLocaleString(undefined, { style: "currency", currency: "CAD" });
const tabs: { key: OfficeTab; label: string }[] = [{ key: "organizations", label: "Organizations" }, { key: "documents", label: "Documents" }, { key: "disposal", label: "Disposal reconciliation" }, { key: "month_close", label: "Month close" }];

export function CommercialOfficeView(p: CommercialOfficeViewProps) {
  const [newOrg, setNewOrg] = useState({ name: "", roleKey: "" });
  const [resolve, setResolve] = useState<{ lineNo: number | null; resolution: LineResolution; note: string; chosen: string }>({ lineNo: null, resolution: "accepted", note: "", chosen: "" });
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="commercial-office">
      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map(t => <Button key={t.key} role="tab" aria-selected={p.tab === t.key} variant={p.tab === t.key ? "default" : "outline"} size="sm" onClick={() => p.onTab(t.key)}>{t.label}</Button>)}
      </div>

      {p.tab === "organizations" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Clients, vendors, facilities</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Input aria-label="Search organizations" placeholder="search by name" value={p.orgQuery} onChange={e => p.onOrgQuery(e.target.value)} />
              <ul className="space-y-1" data-testid="org-list">
                {p.organizations.map(o => (
                  <li key={o.orgRef} className="rounded border p-2">
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">{o.name}</span><span className="text-xs text-muted-foreground">{o.orgRef}</span></div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {o.roles.length === 0 && <Badge variant="outline">no role yet</Badge>}
                      {o.roles.map(r => <Badge key={r.roleKey} variant="outline">{r.roleKey}{r.commercialNumber ? ` · ${r.commercialNumber}` : " · no number"}</Badge>)}
                      {p.roleTypes.filter(rt => !o.roles.some(r => r.roleKey === rt.roleKey)).slice(0, 3).map(rt => <Button key={rt.roleKey} size="sm" variant="ghost" onClick={() => p.onAssignRole(o.orgRef, rt.roleKey)}>+ {rt.label}</Button>)}
                    </div>
                  </li>
                ))}
                {p.organizations.length === 0 && <li className="text-muted-foreground">No organizations match.</li>}
              </ul>
              <fieldset className="space-y-2 rounded border p-2" data-testid="new-org">
                <legend className="px-1 text-xs text-muted-foreground">New organization</legend>
                <Input aria-label="Organization name" placeholder="legal or trading name" value={newOrg.name} onChange={e => setNewOrg({ ...newOrg, name: e.target.value })} />
                <select aria-label="First role" className="rounded border bg-background px-2" value={newOrg.roleKey} onChange={e => setNewOrg({ ...newOrg, roleKey: e.target.value })}>
                  <option value="">role later</option>
                  {p.roleTypes.map(rt => <option key={rt.roleKey} value={rt.roleKey}>{rt.label}</option>)}
                </select>
                <Button size="sm" disabled={p.creating || newOrg.name.trim().length < 2} onClick={() => { p.onCreateOrganization(newOrg.name.trim(), newOrg.roleKey || null); setNewOrg({ name: "", roleKey: "" }); }} data-testid="create-org">Create</Button>
              </fieldset>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Link candidates — proposed, never applied</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <select aria-label="Record type" className="rounded border bg-background px-2" value={p.candidateType} onChange={e => p.onCandidateType(e.target.value as never)}>
                <option value="vendor">vendors</option><option value="facility">facilities</option><option value="job_customer">job customers</option>
              </select>
              <p className="text-muted-foreground">{p.unlinkedCount} unlinked record{p.unlinkedCount === 1 ? "" : "s"} of this type; {p.candidates.length} with an exact-name match.</p>
              <ul className="space-y-1" data-testid="candidates">
                {p.candidates.map(c => (
                  <li key={`${c.recordType}:${c.recordId}:${c.orgRef}`} className="flex items-center justify-between gap-2 rounded border p-2">
                    <span>"{c.capturedName}" → <strong>{c.organizationName}</strong> <span className="text-xs text-muted-foreground">({c.evidence.replaceAll("_", " ")})</span></span>
                    <Button size="sm" onClick={() => p.onLink(c)}>Link</Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      {p.tab === "documents" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Document registry</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Document type" placeholder="type (invoice, manifest…)" className="max-w-[12rem]" value={p.docFilter.documentType} onChange={e => p.onDocFilter({ ...p.docFilter, documentType: e.target.value })} />
                <Input aria-label="Record type" placeholder="record type (job, invoice…)" className="max-w-[12rem]" value={p.docFilter.recordType} onChange={e => p.onDocFilter({ ...p.docFilter, recordType: e.target.value })} />
                <Input aria-label="Record reference" placeholder="record ref" className="max-w-[12rem]" value={p.docFilter.recordRef} onChange={e => p.onDocFilter({ ...p.docFilter, recordRef: e.target.value })} />
                <label className="flex items-center gap-1"><input type="checkbox" checked={p.docFilter.includeSuperseded} onChange={e => p.onDocFilter({ ...p.docFilter, includeSuperseded: e.target.checked })} /> include superseded</label>
              </div>
              <ul className="space-y-1" data-testid="doc-list">
                {p.documents.map(d => (
                  <li key={d.documentRef}>
                    <button type="button" className="w-full rounded border p-2 text-left" onClick={() => p.onSelectDoc(d.documentRef)}>
                      <div className="flex items-center justify-between gap-2"><span className="font-medium">{d.title}</span><span className="text-xs text-muted-foreground">{d.documentRef}</span></div>
                      <div className="mt-1 flex flex-wrap gap-1"><Badge variant="outline">{d.documentType}</Badge><Badge variant="outline">v{d.version}</Badge><Badge variant={d.status === "current" ? "default" : "destructive"}>{d.status}</Badge><Badge variant="outline">{d.retentionClass ?? "retention unknown"}</Badge></div>
                    </button>
                  </li>
                ))}
                {p.documents.length === 0 && <li className="text-muted-foreground">No documents match.</li>}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{p.selectedDoc?.document.title ?? "Pick a document"}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {p.selectedDoc && (
                <>
                  <div><span className="text-muted-foreground">sha256 </span><code>{p.selectedDoc.document.contentHash}</code></div>
                  <div><span className="text-muted-foreground">retention </span>{p.selectedDoc.retention}</div>
                  <div data-testid="doc-versions"><span className="text-muted-foreground">versions </span>{p.selectedDoc.versions.map(v => `v${v.version} ${v.status}`).join(" → ")}</div>
                  <div><span className="text-muted-foreground">links </span>{p.selectedDoc.links.map(l => `${l.recordType}:${l.recordRef}`).join(", ") || "none"}</div>
                  <div data-testid="doc-deliveries"><span className="text-muted-foreground">deliveries </span>{p.selectedDoc.deliveries.length ? p.selectedDoc.deliveries.map(d => `${d.channel} ${d.status}${d.failureReason ? ` (${d.failureReason})` : ""}`).join("; ") : "none"}</div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {p.tab === "disposal" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Facility statements — open lines</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm" data-testid="statements">
              {p.statements.map(s => (
                <button key={s.statementRef} type="button" aria-pressed={p.selectedStatement === s.statementRef} className={`w-full rounded border p-2 text-left ${p.selectedStatement === s.statementRef ? "border-primary" : ""}`} onClick={() => p.onSelectStatement(s.statementRef)}>
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{s.statementRef}</span><Badge variant={s.openLines ? "destructive" : "outline"}>{s.openLines} open</Badge></div>
                  <div className="text-xs text-muted-foreground">{s.facilityOrgRef ?? "facility not linked"} · {String(s.periodStart).slice(0, 10)}–{String(s.periodEnd).slice(0, 10)} · {s.matchedCount} matched, {s.varianceCount} variance, {s.unmatchedCount} unmatched, {s.ambiguousCount} ambiguous</div>
                </button>
              ))}
              {p.statements.length === 0 && <p className="text-muted-foreground">No open statements.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Unresolved lines</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm" data-testid="lines">
              {p.lines.map(l => (
                <div key={l.lineNo} className="rounded border p-2">
                  <div className="flex items-center justify-between gap-2"><span>Line {l.lineNo} · {l.facilityTicketNumber ?? "no ticket number"}</span><Badge variant="outline">{l.matchOutcome.replaceAll("_", " ")}</Badge></div>
                  {l.variances?.length ? <div className="text-xs text-muted-foreground">variance: {l.variances.join(", ")}</div> : null}
                  {l.matchOutcome === "ambiguous" && <div className="text-xs text-muted-foreground">candidates: {(l.candidateTicketIds ?? []).join(", ")} — pick one</div>}
                  {resolve.lineNo === l.lineNo ? (
                    <div className="mt-2 space-y-1">
                      <select aria-label="Resolution" className="rounded border bg-background px-2" value={resolve.resolution} onChange={e => setResolve({ ...resolve, resolution: e.target.value as LineResolution })}>
                        <option value="accepted">accepted</option><option value="ticket_needs_correction">ticket needs correction</option><option value="facility_error">facility error</option><option value="disputed">disputed</option>
                      </select>
                      {l.matchOutcome === "ambiguous" && <Input aria-label="Chosen ticket id" placeholder="chosen ticket id" value={resolve.chosen} onChange={e => setResolve({ ...resolve, chosen: e.target.value })} />}
                      <Input aria-label="Resolution note" placeholder="why (at least 10 characters)" value={resolve.note} onChange={e => setResolve({ ...resolve, note: e.target.value })} />
                      <Button size="sm" disabled={p.resolving || resolve.note.trim().length < 10 || (l.matchOutcome === "ambiguous" && !/^\d+$/.test(resolve.chosen))} onClick={() => { if (p.selectedStatement) p.onResolveLine(p.selectedStatement, l.lineNo, resolve.resolution, resolve.note.trim(), resolve.chosen ? Number(resolve.chosen) : undefined); setResolve({ lineNo: null, resolution: "accepted", note: "", chosen: "" }); }} data-testid={`resolve-${l.lineNo}`}>Resolve</Button>
                    </div>
                  ) : <Button size="sm" variant="outline" className="mt-1" onClick={() => setResolve({ lineNo: l.lineNo, resolution: "accepted", note: "", chosen: "" })}>Resolve…</Button>}
                </div>
              ))}
              {p.selectedStatement && p.lines.length === 0 && <p className="text-muted-foreground">Nothing unresolved on this statement.</p>}
            </CardContent>
          </Card>
        </div>
      )}

      {p.tab === "month_close" && (
        <div className="space-y-4">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-2 pt-4 text-sm">
              <label className="grid">Financial entity id<Input aria-label="Financial entity id" inputMode="numeric" className="max-w-[10rem]" value={p.entityId} onChange={e => p.onEntityId(e.target.value)} /></label>
              <label className="grid">From<Input aria-label="Period from" type="date" value={p.period.from} onChange={e => p.onPeriod({ ...p.period, from: e.target.value })} /></label>
              <label className="grid">To<Input aria-label="Period to" type="date" value={p.period.to} onChange={e => p.onPeriod({ ...p.period, to: e.target.value })} /></label>
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {[{ title: "Receivables by organization", aging: p.arAging, id: "ar" }, { title: "Payables by organization", aging: p.apAging, id: "ap" }].map(x => (
              <Card key={x.id}>
                <CardHeader><CardTitle>{x.title}</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm" data-testid={`aging-${x.id}`}>
                  {x.aging?.organizations.map(o => <div key={o.orgRef ?? o.label} className="flex justify-between gap-2"><span>{o.label}</span><span>{money(o.totalOutstandingCents)}</span></div>)}
                  {x.aging?.unlinked.map(o => <div key={o.label} className="flex justify-between gap-2 text-muted-foreground"><span>{o.label} <Badge variant="outline">unlinked</Badge></span><span>{money(o.totalOutstandingCents)}</span></div>)}
                  {!x.aging && <p className="text-muted-foreground">Enter a financial entity.</p>}
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardHeader><CardTitle>GL export readiness</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm" data-testid="gl">
                {p.glReadiness ? <>
                  <Badge variant={p.glReadiness.state === "READY" ? "default" : "destructive"}>{p.glReadiness.state}</Badge>
                  <ul className="list-disc pl-5">{p.glReadiness.blockers.map((b, i) => <li key={i}>{String(b.reason ?? b.key ?? JSON.stringify(b))}</li>)}</ul>
                  {p.glReadiness.state === "READY" && <p className="text-muted-foreground">Every posted key is mapped. Nothing is exported from this screen.</p>}
                </> : <p className="text-muted-foreground">Enter a financial entity and period.</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Profitability by dimension</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm" data-testid="profitability">
                <select aria-label="Dimension" className="rounded border bg-background px-2" value={p.profitDimension} onChange={e => p.onProfitDimension(e.target.value)}>
                  {["client", "job", "load", "unit", "driver", "branch", "contractor"].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                {p.profitability && (p.profitability.derivable === "no" || p.profitability.derivable === "not_derivable") && <p className="text-muted-foreground">Not derivable: {p.profitability.note ?? p.profitability.basis ?? "no evidence links carry this dimension"}</p>}
                {p.profitability?.note && p.profitability.derivable !== "no" && <p className="text-muted-foreground">{p.profitability.note}</p>}
                {p.profitability?.rows.map(r => <div key={r.key} className="flex justify-between gap-2"><span>{r.label ?? r.key}</span><span>{r.marginCents !== undefined ? money(r.marginCents) : r.costCents !== undefined ? `cost ${money(r.costCents)}` : "—"}</span></div>)}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
