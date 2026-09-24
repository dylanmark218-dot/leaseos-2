/**
 * DC-H — Document Control, the view. Pure: facts in through props, actions out through
 * callbacks. Five screens on the one register: the Document Library (every document,
 * whatever its origin, with its origin badge, its LeaseOS number where it has one and the
 * other issuer's number where it has that), the Review Queue (what a person has not yet
 * confirmed — captured, awaiting classification, proposed), the Template Library (families
 * and revisions, released ones immutable), the Definitions (what a document can be, and how
 * LeaseOS is allowed to describe it), and the Number Series (counters, device blocks, and
 * every gap with its reason or as a finding).
 *
 * It never claims what the register does not: an unrecorded origin reads "origin
 * unrecorded", an unconfigured retention reads as such, a compliance record carries its
 * representation notice, and the audit timeline is shown as recorded — actor, source,
 * state before and after — never summarised into a verdict.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type DcTab = "library" | "review" | "templates" | "definitions" | "series";
export type DocRow = {
  documentRef: string; title: string; definitionKey: string | null; documentType: string; originKind: string | null; issuerKind: string | null; issuerName: string | null;
  controlNumber: string | null; controlState: string; status: string; version: number; templateRevisionRef: string | null; registeredAt: Date | string | null; issuedAt: Date | string | null; provenance: string;
};
export type DocDetail = {
  document: DocRow & { contentHash: string; byteLength: number | null; mimeType: string | null; evidenceRecordId: number | null; renderManifestHash: string | null; capturedByDeviceRef: string | null; importChannel: string | null };
  provenance: string; retention: string;
  definition: { definitionKey: string; displayName: string; documentClass: string; numberingPolicy: string; representationPolicy: string; representationNotice: string | null; revisionPolicy: string; primaryDomainOwner: string } | null;
  links: { id: number; recordType: string; recordRef: string; recordId: number | null; role: string | null; source: string | null; confirmationStatus: string | null }[];
  references: { referenceRef: string; referenceType: string; referenceValueRaw: string; issuerKind: string; issuerName: string | null; source: string; confirmationStatus: string; mirrorOfTable: string | null }[];
  versions: { documentRef: string; version: number; status: string; controlState: string }[];
  amendments: { fieldKey: string; originalValue: string | null; correctedValue: string | null; reason?: string | null; occurredAt?: Date | string | null }[];
  derivatives: { derivativeRef: string; derivativeKind: string; producer: string; producerVersion: string | null; contentHash: string; sourceContentHash: string; mimeType: string; byteLength: number; actorSource: string; createdAt: Date | string }[];
  extractions: { extractionRef: string; proposalId: string | null; ocrEngine: string; proposedDocumentType: string; classificationSource: string; status: string; fieldCount: number; askedCount: number; humanOnlyCount: number; extractedAt: Date | string }[];
  timeline: { sequence: number; eventType: string; actorUserId: number | null; actorSource: string | null; deviceRef: string | null; previousState: string | null; newState: string | null; detail: Record<string, unknown> | null; occurredAt: Date | string }[];
};
export type TemplateRow = { templateRef: string; templateKey: string; definitionKey: string; name: string; sourceKind: string; ownerKind: string; ownerName: string | null; status: string; layer: string; currentRevision: { revisionRef: string; revision: number; layoutKind: string; rendererKey: string; renderable: boolean; releasedAt: Date | string | null } | null };
export type TemplateDetail = { template: TemplateRow & { orgRef: string | null }; revisions: { revisionRef: string; revision: number; status: string; layoutKind: string; rendererKey: string; rendererVersion: string; fieldMappingHash: string; releaseManifestHash: string | null; releasedAt: Date | string | null; retiredAt: Date | string | null }[] };
export type DefinitionRow = { definitionKey: string; displayName: string; documentClass: string; primaryDomainOwner: string; numberingPolicy: string; numberSeriesType: string | null; externalReferencePolicy: string; representationPolicy: string; representationNotice: string | null; jurisdictionPolicy: string; status: string; layer?: string; label: string; source?: string };
export type SeriesRow = { sequenceType: string; periodKey: string; branch: string; handedOut?: number; nextNumber?: number; issued?: number; reserved?: number; voided?: number; blocks?: { blockRef: string; deviceRef: string; firstSequence: number; lastSequence: number; status: string }[] };
export type GapReport = { scopeKey: string; sequenceType: string; periodKey: string; issued: number; unexplained: number; explained: number; heldByDevice: number; rows: { sequence: number; state: string; formattedNumber?: string | null; reasonCode?: string | null; reasonText?: string | null; voidReason?: string | null; deviceRef?: string | null }[] } | null;

export type LibraryFilter = { q: string; definitionKey: string; originKind: string; controlState: string; recordType: string; recordRef: string };
export type DocumentControlViewProps = {
  tab: DcTab; onTab: (t: DcTab) => void;
  filter: LibraryFilter; onFilter: (f: LibraryFilter) => void; documents: DocRow[]; selectedDoc: DocDetail | null; onSelectDoc: (ref: string | null) => void; loading: boolean;
  reviewQueue: DocRow[];
  templates: TemplateRow[]; selectedTemplate: TemplateDetail | null; onSelectTemplate: (ref: string | null) => void;
  definitions: DefinitionRow[];
  series: SeriesRow[]; gapQuery: { sequenceType: string; periodKey: string }; onGapQuery: (q: { sequenceType: string; periodKey: string }) => void; gapReport: GapReport;
};

const tabs: { key: DcTab; label: string }[] = [{ key: "library", label: "Document Library" }, { key: "review", label: "Review Queue" }, { key: "templates", label: "Template Library" }, { key: "definitions", label: "Definitions" }, { key: "series", label: "Number Series" }];
const words = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ");
const when = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

/** The origin, as a badge a reader can trust: what the register recorded, or "origin unrecorded". */
export function OriginBadge({ originKind, issuerKind, issuerName }: { originKind: string | null; issuerKind: string | null; issuerName: string | null }) {
  if (!originKind) return <Badge variant="outline" data-testid="origin-badge">origin unrecorded</Badge>;
  const external = originKind.startsWith("external_");
  const who = issuerKind === "tenant" ? "LeaseOS-issued" : issuerName ? issuerName : issuerKind && issuerKind !== "unknown" ? `issued by ${words(issuerKind)}` : "issuer unknown";
  return <Badge variant={external ? "secondary" : "default"} data-testid="origin-badge" title={words(originKind)}>{external ? `${who} · ${words(originKind)}` : `${who} · ${words(originKind)}`}</Badge>;
}

function DocTable({ rows, onSelect, testId }: { rows: DocRow[]; onSelect: (ref: string) => void; testId: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground" data-testid={testId}>No documents match.</p>;
  return (
    <table className="w-full text-sm" data-testid={testId}>
      <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Number</th><th className="py-1 pr-2">Definition</th><th className="py-1 pr-2">Title</th><th className="py-1 pr-2">Origin</th><th className="py-1 pr-2">State</th><th className="py-1 pr-2">Registered</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.documentRef} className="border-t cursor-pointer hover:bg-muted/50" onClick={() => onSelect(r.documentRef)} data-testid={`doc-row-${r.documentRef}`}>
            <td className="py-1 pr-2 font-mono">{r.controlNumber ?? <span className="text-muted-foreground">{r.documentRef}</span>}</td>
            <td className="py-1 pr-2">{words(r.definitionKey ?? r.documentType)}</td>
            <td className="py-1 pr-2">{r.title}</td>
            <td className="py-1 pr-2"><OriginBadge originKind={r.originKind} issuerKind={r.issuerKind} issuerName={r.issuerName} /></td>
            <td className="py-1 pr-2">{words(r.controlState)}{r.status !== "current" ? ` (${words(r.status)})` : ""}</td>
            <td className="py-1 pr-2">{when(r.registeredAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DocumentDetail({ d, onClose }: { d: DocDetail; onClose: () => void }) {
  const prints = d.timeline.filter(e => e.eventType === "document.printed" || e.eventType === "document.reprinted");
  return (
    <Card data-testid="doc-detail">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle className="text-base">{d.document.controlNumber ?? d.document.documentRef} — {d.document.title}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p data-testid="provenance">{d.provenance}</p>
        {d.definition?.representationNotice && <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2" data-testid="representation-notice">NOTICE: {d.definition.representationNotice}</p>}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
          <div><span className="text-muted-foreground">Internal record</span><div className="font-mono">{d.document.documentRef} v{d.document.version}</div></div>
          <div><span className="text-muted-foreground">LeaseOS controlled number</span><div className="font-mono" data-testid="control-number">{d.document.controlNumber ?? "none — not a LeaseOS-numbered document"}</div></div>
          <div><span className="text-muted-foreground">Origin</span><div><OriginBadge originKind={d.document.originKind} issuerKind={d.document.issuerKind} issuerName={d.document.issuerName} /></div></div>
          <div><span className="text-muted-foreground">State</span><div>{words(d.document.controlState)} · {words(d.document.status)}</div></div>
          <div><span className="text-muted-foreground">Template revision</span><div className="font-mono">{d.document.templateRevisionRef ?? "none (no template)"}</div></div>
          <div><span className="text-muted-foreground">Definition</span><div>{d.definition ? `${d.definition.displayName} (${words(d.definition.numberingPolicy)})` : words(d.document.definitionKey ?? d.document.documentType)}</div></div>
          <div><span className="text-muted-foreground">Bytes</span><div className="font-mono text-xs">sha256 {d.document.contentHash.slice(0, 16)}… · {d.document.byteLength ?? "?"} B · {d.document.mimeType ?? "?"}</div></div>
          <div><span className="text-muted-foreground">Retention</span><div>{d.retention}</div></div>
          <div><span className="text-muted-foreground">Captured</span><div>{d.document.capturedByDeviceRef ? `device ${d.document.capturedByDeviceRef}` : "—"} · {words(d.document.importChannel) || "—"}</div></div>
        </div>
        <section data-testid="external-numbers">
          <h4 className="font-medium">External numbers (another issuer's, never LeaseOS's)</h4>
          {d.references.length ? <ul className="list-disc pl-5">{d.references.map(r => <li key={r.referenceRef}><span className="font-mono">{r.referenceValueRaw}</span> · {words(r.referenceType)} · {r.issuerName ?? words(r.issuerKind)} · {words(r.source)} · <b>{r.confirmationStatus}</b>{r.mirrorOfTable ? ` · mirrors ${r.mirrorOfTable}` : ""}</li>)}</ul> : <p className="text-muted-foreground">none</p>}
        </section>
        <section data-testid="related-records">
          <h4 className="font-medium">Related records</h4>
          {d.links.length ? <ul className="list-disc pl-5">{d.links.map(l => <li key={l.id}>{words(l.recordType)} <span className="font-mono">{l.recordRef}</span>{l.role ? ` · ${words(l.role)}` : ""} · {words(l.source ?? "")} · {l.confirmationStatus}</li>)}</ul> : <p className="text-muted-foreground">none</p>}
        </section>
        <section data-testid="revision-history">
          <h4 className="font-medium">Revision history</h4>
          <ol className="list-decimal pl-5">{d.versions.map(v => <li key={v.documentRef}><span className="font-mono">{v.documentRef}</span> v{v.version} · {words(v.status)} · {words(v.controlState)}{v.documentRef === d.document.documentRef ? " (this)" : ""}</li>)}</ol>
          {d.amendments.length > 0 && <ul className="list-disc pl-5 text-xs">{d.amendments.map((a, i) => <li key={i}>amended {a.fieldKey}: “{a.originalValue ?? "—"}” → “{a.correctedValue ?? "—"}”</li>)}</ul>}
        </section>
        <section data-testid="source-provenance">
          <h4 className="font-medium">Source and derivatives</h4>
          {d.extractions.length ? <ul className="list-disc pl-5">{d.extractions.map(x => <li key={x.extractionRef}>reading by {x.ocrEngine}: proposed {words(x.proposedDocumentType)} ({words(x.classificationSource)}), {x.fieldCount} fields, {x.askedCount + x.humanOnlyCount} for a person · <b>{x.status}</b> · {when(x.extractedAt)}</li>)}</ul> : null}
          {d.derivatives.length ? <ul className="list-disc pl-5">{d.derivatives.map(x => <li key={x.derivativeRef}>{words(x.derivativeKind)} by {x.producer}{x.producerVersion ? ` ${x.producerVersion}` : ""} · {x.byteLength} B · from original sha256 {x.sourceContentHash.slice(0, 12)}…</li>)}</ul> : null}
          {!d.extractions.length && !d.derivatives.length && <p className="text-muted-foreground">the original only</p>}
        </section>
        <section data-testid="print-history">
          <h4 className="font-medium">Print / reprint history</h4>
          {prints.length ? <ul className="list-disc pl-5">{prints.map(e => <li key={e.sequence}>{words(e.eventType.replace("document.", ""))} · {when(e.occurredAt)} · user {e.actorUserId ?? "?"}{e.deviceRef ? ` · ${e.deviceRef}` : ""}</li>)}</ul> : <p className="text-muted-foreground">not printed through LeaseOS yet — a reprint never mints a new number</p>}
        </section>
        <section data-testid="audit-timeline">
          <h4 className="font-medium">Audit timeline</h4>
          <ol className="pl-5">{d.timeline.map(e => <li key={e.sequence} className="border-l pl-2 text-xs"><span className="font-mono">#{e.sequence}</span> {when(e.occurredAt)} · <b>{e.eventType.replace("document.", "")}</b> · {e.actorSource ?? "?"} {e.actorUserId != null ? `user ${e.actorUserId}` : ""}{e.deviceRef ? ` · ${e.deviceRef}` : ""}{e.previousState || e.newState ? ` · ${e.previousState ?? "—"} → ${e.newState ?? "—"}` : ""}{e.detail ? ` · ${JSON.stringify(e.detail).slice(0, 160)}` : ""}</li>)}</ol>
        </section>
      </CardContent>
    </Card>
  );
}

export function DocumentControlView(p: DocumentControlViewProps) {
  return (
    <div className="space-y-4 p-4" data-testid="document-control">
      <div className="flex flex-wrap gap-2">{tabs.map(t => <Button key={t.key} variant={p.tab === t.key ? "default" : "outline"} size="sm" onClick={() => p.onTab(t.key)} data-testid={`tab-${t.key}`}>{t.label}</Button>)}</div>

      {p.tab === "library" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <Input aria-label="Search" placeholder="number, title, issuer's number" value={p.filter.q} onChange={e => p.onFilter({ ...p.filter, q: e.target.value })} />
            <Input aria-label="Definition" placeholder="definition key" value={p.filter.definitionKey} onChange={e => p.onFilter({ ...p.filter, definitionKey: e.target.value })} />
            <select aria-label="Origin" className="rounded border bg-background px-2 text-sm" value={p.filter.originKind} onChange={e => p.onFilter({ ...p.filter, originKind: e.target.value })}>
              <option value="">any origin</option>{["leaseos_generated", "system_rendered", "organization_template", "customer_template", "external_form_rendered", "external_scanned", "external_digital_import", "portal_submitted"].map(o => <option key={o} value={o}>{words(o)}</option>)}
            </select>
            <select aria-label="State" className="rounded border bg-background px-2 text-sm" value={p.filter.controlState} onChange={e => p.onFilter({ ...p.filter, controlState: e.target.value })}>
              <option value="">any state</option>{["captured", "needs_classification", "proposed", "confirmed", "issued", "void", "withdrawn"].map(o => <option key={o} value={o}>{words(o)}</option>)}
            </select>
            <Input aria-label="Record type" placeholder="job / load / facility…" value={p.filter.recordType} onChange={e => p.onFilter({ ...p.filter, recordType: e.target.value })} />
            <Input aria-label="Record ref" placeholder="JOB-… / L-… / DSP-…" value={p.filter.recordRef} onChange={e => p.onFilter({ ...p.filter, recordRef: e.target.value })} />
          </div>
          {p.loading ? <p className="text-sm text-muted-foreground">Loading…</p> : <DocTable rows={p.documents} onSelect={p.onSelectDoc} testId="library" />}
          {p.selectedDoc && <DocumentDetail d={p.selectedDoc} onClose={() => p.onSelectDoc(null)} />}
        </div>
      )}

      {p.tab === "review" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Scanned and imported documents a person has not confirmed: captured, awaiting classification, or proposed by a reading. Nothing here is a fact yet.</p>
          <DocTable rows={p.reviewQueue} onSelect={p.onSelectDoc} testId="review-queue" />
          {p.selectedDoc && <DocumentDetail d={p.selectedDoc} onClose={() => p.onSelectDoc(null)} />}
        </div>
      )}

      {p.tab === "templates" && (
        <div className="space-y-3">
          <table className="w-full text-sm" data-testid="templates">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Template</th><th className="py-1 pr-2">Definition</th><th className="py-1 pr-2">Source</th><th className="py-1 pr-2">Layer</th><th className="py-1 pr-2">Current revision</th><th className="py-1 pr-2">Renderable</th><th className="py-1 pr-2">Status</th></tr></thead>
            <tbody>{p.templates.map(t => (
              <tr key={t.templateRef} className="border-t cursor-pointer hover:bg-muted/50" onClick={() => p.onSelectTemplate(t.templateRef)} data-testid={`tpl-row-${t.templateKey}`}>
                <td className="py-1 pr-2">{t.name} <span className="font-mono text-xs text-muted-foreground">{t.templateKey}</span></td><td className="py-1 pr-2">{words(t.definitionKey)}</td><td className="py-1 pr-2">{words(t.sourceKind)}{t.ownerName ? ` · ${t.ownerName}` : ""}</td><td className="py-1 pr-2">{t.layer}</td>
                <td className="py-1 pr-2 font-mono">{t.currentRevision ? `r${t.currentRevision.revision} · ${words(t.currentRevision.layoutKind)}` : "none released"}</td><td className="py-1 pr-2">{t.currentRevision ? (t.currentRevision.renderable ? "yes" : "no — registered and printable as supplied") : "—"}</td><td className="py-1 pr-2">{t.status}</td>
              </tr>))}</tbody>
          </table>
          {p.selectedTemplate && (
            <Card data-testid="template-detail">
              <CardHeader className="flex flex-row items-start justify-between"><CardTitle className="text-base">{p.selectedTemplate.template.name}</CardTitle><Button variant="ghost" size="sm" onClick={() => p.onSelectTemplate(null)}>Close</Button></CardHeader>
              <CardContent className="text-sm">
                <ol className="list-decimal pl-5">{p.selectedTemplate.revisions.map(r => <li key={r.revisionRef}><span className="font-mono">{r.revisionRef}</span> · <b>{r.status}</b> · {words(r.layoutKind)} · {r.rendererKey} v{r.rendererVersion} · mapping {r.fieldMappingHash.slice(0, 12)}… · manifest {r.releaseManifestHash ? `${r.releaseManifestHash.slice(0, 12)}…` : "—"} · released {when(r.releasedAt)}{r.retiredAt ? ` · retired ${when(r.retiredAt)} (records on it stay on it)` : ""}</li>)}</ol>
                <p className="mt-2 text-xs text-muted-foreground">A released revision is immutable: a changed layout or mapping is a new revision. Documents already rendered stay on the revision they were rendered from.</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {p.tab === "definitions" && (
        <table className="w-full text-sm" data-testid="definitions">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Definition</th><th className="py-1 pr-2">Class · owner</th><th className="py-1 pr-2">Numbering</th><th className="py-1 pr-2">External refs</th><th className="py-1 pr-2">Representation</th><th className="py-1 pr-2">Jurisdiction</th><th className="py-1 pr-2">Layer</th></tr></thead>
          <tbody>{p.definitions.map(d => (
            <tr key={d.definitionKey} className="border-t" data-testid={`def-row-${d.definitionKey}`}>
              <td className="py-1 pr-2">{d.displayName} <span className="font-mono text-xs text-muted-foreground">{d.definitionKey}</span></td><td className="py-1 pr-2">{words(d.documentClass)} · {words(d.primaryDomainOwner)}</td><td className="py-1 pr-2">{words(d.numberingPolicy)}{d.numberSeriesType ? ` (${d.numberSeriesType})` : ""}</td><td className="py-1 pr-2">{words(d.externalReferencePolicy)}</td>
              <td className="py-1 pr-2">{d.label}{d.representationNotice ? <span className="block text-xs text-amber-700 dark:text-amber-400">{d.representationNotice}</span> : null}</td><td className="py-1 pr-2">{words(d.jurisdictionPolicy)}</td><td className="py-1 pr-2">{d.layer ?? (d.source ?? "platform")}{d.status !== "active" ? ` · ${d.status}` : ""}</td>
            </tr>))}</tbody>
        </table>
      )}

      {p.tab === "series" && (
        <div className="space-y-3">
          <table className="w-full text-sm" data-testid="series">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">Series</th><th className="py-1 pr-2">Period</th><th className="py-1 pr-2">Next</th><th className="py-1 pr-2">Issued</th><th className="py-1 pr-2">Reserved</th><th className="py-1 pr-2">Voided</th><th className="py-1 pr-2">Device blocks</th></tr></thead>
            <tbody>{p.series.map(s => (
              <tr key={`${s.sequenceType}-${s.periodKey}-${s.branch}`} className="border-t cursor-pointer hover:bg-muted/50" onClick={() => p.onGapQuery({ sequenceType: s.sequenceType, periodKey: s.periodKey })} data-testid={`series-row-${s.sequenceType}-${s.periodKey}`}>
                <td className="py-1 pr-2 font-mono">{s.sequenceType}{s.branch ? `/${s.branch}` : ""}</td><td className="py-1 pr-2">{s.periodKey}</td><td className="py-1 pr-2">{s.nextNumber ?? (s.handedOut != null ? s.handedOut + 1 : "—")}</td><td className="py-1 pr-2">{s.issued ?? "—"}</td><td className="py-1 pr-2">{s.reserved ?? "—"}</td><td className="py-1 pr-2">{s.voided ?? "—"}</td>
                <td className="py-1 pr-2 text-xs">{s.blocks?.length ? s.blocks.map(b => `${b.deviceRef}: ${b.firstSequence}–${b.lastSequence} (${b.status})`).join("; ") : "none"}</td>
              </tr>))}</tbody>
          </table>
          {p.gapReport && (
            <Card data-testid="gap-report">
              <CardHeader><CardTitle className="text-base">Gaps and voids — {p.gapReport.sequenceType} {p.gapReport.periodKey}</CardTitle></CardHeader>
              <CardContent className="text-sm">
                <p>{p.gapReport.issued} issued · {p.gapReport.explained} explained (voided with a reason) · {p.gapReport.heldByDevice} held by a device block · <b data-testid="unexplained">{p.gapReport.unexplained} unexplained</b>{p.gapReport.unexplained ? " — findings, not gaps" : ""}</p>
                {p.gapReport.rows.filter(r => r.state !== "issued").length ? <ul className="list-disc pl-5">{p.gapReport.rows.filter(r => r.state !== "issued").map(r => <li key={r.sequence}><span className="font-mono">#{r.sequence}</span> {r.formattedNumber ?? ""} · <b>{words(r.state)}</b>{r.reasonText ?? r.voidReason ?? r.reasonCode ? ` · ${r.reasonText ?? r.voidReason ?? r.reasonCode}` : ""}{r.deviceRef ? ` · ${r.deviceRef}` : ""}</li>)}</ul> : <p className="text-muted-foreground">every number in the period is issued</p>}
                <p className="mt-2 text-xs text-muted-foreground">A number is never recycled. A void keeps its number and its reason; a reprint is not a new number.</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
