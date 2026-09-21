/** P7.9 — the Commercial Office, the container: wires the pure view to commercialOffice.*. Approval screens wait for P6.6/P6.7. */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { CommercialOfficeView, type LineResolution, type OfficeTab } from "./CommercialOfficeView";

const thisMonth = () => { const d = new Date(); const from = new Date(d.getFullYear(), d.getMonth(), 1); const to = new Date(d.getFullYear(), d.getMonth() + 1, 0); const f = (x: Date) => x.toISOString().slice(0, 10); return { from: f(from), to: f(to) }; };

export default function CommercialOffice() {
  const [tab, setTab] = useState<OfficeTab>("organizations");
  const [orgQuery, setOrgQuery] = useState("");
  const [candidateType, setCandidateType] = useState<"vendor" | "facility" | "job_customer">("vendor");
  const [docFilter, setDocFilter] = useState({ documentType: "", recordType: "", recordRef: "", includeSuperseded: false });
  const [selectedDocRef, setSelectedDocRef] = useState<string | null>(null);
  const [selectedStatement, setSelectedStatement] = useState<string | null>(null);
  const [entityId, setEntityId] = useState("");
  const [period, setPeriod] = useState(thisMonth());
  const [profitDimension, setProfitDimension] = useState("job");
  const utils = trpc.useUtils();
  const err = (e: { message: string }) => toast.error(e.message);

  const organizations = trpc.commercialOffice.organizations.list.useQuery({ q: orgQuery || undefined }, { enabled: tab === "organizations" });
  const roleTypes = trpc.commercialOffice.roleTypes.list.useQuery(undefined, { enabled: tab === "organizations" });
  const candidates = trpc.commercialOffice.links.candidates.useQuery({ recordType: candidateType }, { enabled: tab === "organizations" });
  const refreshOrgs = () => { void utils.commercialOffice.organizations.list.invalidate(); void utils.commercialOffice.links.candidates.invalidate(); };
  const assignRole = trpc.commercialOffice.roles.assign.useMutation({ onSuccess: r => { toast.success(r.commercialNumber ? `Role assigned — ${r.commercialNumber}` : "Role assigned (no numbering policy for it)"); refreshOrgs(); }, onError: err });
  const createOrg = trpc.commercialOffice.organizations.create.useMutation({ onSuccess: r => { toast.success(`${r.name} created as ${r.orgRef}`); refreshOrgs(); }, onError: err });
  const linkSet = trpc.commercialOffice.links.set.useMutation({ onSuccess: () => { toast.success("Linked"); refreshOrgs(); }, onError: err });

  const docs = trpc.commercialOffice.documents.list.useQuery({ documentType: docFilter.documentType || undefined, recordType: docFilter.recordType || undefined, recordRef: docFilter.recordRef || undefined, includeSuperseded: docFilter.includeSuperseded }, { enabled: tab === "documents" });
  const doc = trpc.commercialOffice.documents.get.useQuery({ documentRef: selectedDocRef ?? "" }, { enabled: tab === "documents" && selectedDocRef !== null });

  const statements = trpc.commercialOffice.disposal.statements.useQuery({ status: "open" }, { enabled: tab === "disposal" });
  const lines = trpc.commercialOffice.disposal.statementLines.useQuery({ statementRef: selectedStatement ?? "", unresolvedOnly: true }, { enabled: tab === "disposal" && selectedStatement !== null });
  const resolveLine = trpc.commercialOffice.disposal.lineResolve.useMutation({ onSuccess: () => { toast.success("Line resolved"); void utils.commercialOffice.disposal.statementLines.invalidate(); void utils.commercialOffice.disposal.statements.invalidate(); }, onError: err });

  const eid = /^\d+$/.test(entityId) ? Number(entityId) : null;
  const closeOn = tab === "month_close" && eid !== null;
  const ar = trpc.commercialOffice.ar.agingByOrganization.useQuery({ financialEntityId: eid ?? 0 }, { enabled: closeOn });
  const ap = trpc.commercialOffice.ap.agingByOrganization.useQuery({ financialEntityId: eid ?? 0 }, { enabled: closeOn });
  const gl = trpc.commercialOffice.gl.exportReadiness.useQuery({ financialEntityId: eid ?? 0, from: new Date(period.from), to: new Date(period.to + "T23:59:59") }, { enabled: closeOn && !!period.from && !!period.to });
  const profit = trpc.commercialOffice.profitability.byDimension.useQuery({ financialEntityId: eid ?? 0, dimension: profitDimension as never, from: new Date(period.from), to: new Date(period.to + "T23:59:59") }, { enabled: closeOn && !!period.from && !!period.to });

  return (
    <CommercialOfficeView
      tab={tab} onTab={setTab}
      orgQuery={orgQuery} onOrgQuery={setOrgQuery} organizations={(organizations.data ?? []) as never} roleTypes={(roleTypes.data ?? []).map((r: { roleKey: string; label: string }) => ({ roleKey: r.roleKey, label: r.label }))}
      onCreateOrganization={(name, roleKey) => createOrg.mutate({ name }, { onSuccess: r => { if (roleKey) assignRole.mutate({ orgRef: r.orgRef, roleKey }); } })} creating={createOrg.isPending} onAssignRole={(orgRef, roleKey) => assignRole.mutate({ orgRef, roleKey })}
      candidateType={candidateType} onCandidateType={setCandidateType} candidates={(candidates.data?.candidates ?? []) as never} unlinkedCount={candidates.data?.unlinked ?? 0} onLink={c => linkSet.mutate({ recordType: c.recordType as never, recordId: c.recordId, orgRef: c.orgRef })}
      docFilter={docFilter} onDocFilter={setDocFilter} documents={(docs.data ?? []) as never} selectedDoc={selectedDocRef && doc.data ? (doc.data as never) : null} onSelectDoc={setSelectedDocRef}
      statements={(statements.data ?? []) as never} selectedStatement={selectedStatement} onSelectStatement={setSelectedStatement} lines={(lines.data?.lines ?? []) as never}
      onResolveLine={(statementRef, lineNo, resolution: LineResolution, note, chosenDisposalTicketId) => resolveLine.mutate({ statementRef, lineNo, resolution, note, chosenDisposalTicketId })} resolving={resolveLine.isPending}
      entityId={entityId} onEntityId={setEntityId} period={period} onPeriod={setPeriod} arAging={(closeOn && ar.data ? ar.data : null) as never} apAging={(closeOn && ap.data ? ap.data : null) as never} glReadiness={(closeOn && gl.data ? gl.data : null) as never} profitability={(closeOn && profit.data ? profit.data : null) as never} profitDimension={profitDimension} onProfitDimension={setProfitDimension}
    />
  );
}
