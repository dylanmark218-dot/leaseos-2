/** DC-H — Document Control, the container: wires the pure view to documentControl.*. Read-only surfaces; every write stays on its own procedure. */
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { type DcTab, DocumentControlView, type DocRow, type LibraryFilter } from "./DocumentControlView";

const refFromUrl = () => { try { return new URLSearchParams(window.location.search).get("ref"); } catch { return null; } };

export default function DocumentControl() {
  const [tab, setTab] = useState<DcTab>(refFromUrl() ? "library" : "library");
  const [filter, setFilter] = useState<LibraryFilter>({ q: "", definitionKey: "", originKind: "", controlState: "", recordType: "", recordRef: "" });
  const [selectedDoc, setSelectedDoc] = useState<string | null>(refFromUrl());
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [gapQuery, setGapQuery] = useState<{ sequenceType: string; periodKey: string } | null>(null);

  const docs = trpc.documentControl.documents.list.useQuery(
    { q: filter.q || undefined, definitionKey: filter.definitionKey || undefined, originKind: (filter.originKind || undefined) as never, controlState: (filter.controlState || undefined) as never, recordType: (filter.recordType || undefined) as never, recordRef: filter.recordRef || undefined },
    { enabled: tab === "library" },
  );
  // The review queue is the register's own states, not a second queue: captured, awaiting classification, proposed by a reading.
  const captured = trpc.documentControl.documents.list.useQuery({ controlState: "captured" }, { enabled: tab === "review" });
  const unclassified = trpc.documentControl.documents.list.useQuery({ controlState: "needs_classification" }, { enabled: tab === "review" });
  const proposed = trpc.documentControl.documents.list.useQuery({ controlState: "proposed" }, { enabled: tab === "review" });
  const reviewQueue = useMemo(() => [...(captured.data ?? []), ...(unclassified.data ?? []), ...(proposed.data ?? [])] as unknown as DocRow[], [captured.data, unclassified.data, proposed.data]);
  const doc = trpc.documentControl.documents.get.useQuery({ documentRef: selectedDoc ?? "" }, { enabled: selectedDoc !== null });
  const templates = trpc.documentControl.templates.list.useQuery({ includeRetired: true }, { enabled: tab === "templates" });
  const template = trpc.documentControl.templates.get.useQuery({ templateRef: selectedTemplate ?? "" }, { enabled: tab === "templates" && selectedTemplate !== null });
  const definitions = trpc.documentControl.definitions.list.useQuery({ includeRetired: true }, { enabled: tab === "definitions" });
  const series = trpc.documentControl.series.list.useQuery(undefined, { enabled: tab === "series" });
  const gap = trpc.documentControl.series.gapReport.useQuery({ sequenceType: gapQuery?.sequenceType ?? "DOC", periodKey: gapQuery?.periodKey ?? "" }, { enabled: tab === "series" && gapQuery !== null });

  return (
    <DocumentControlView
      tab={tab} onTab={t => { setTab(t); setSelectedDoc(null); }}
      filter={filter} onFilter={setFilter} documents={(docs.data ?? []) as unknown as DocRow[]} selectedDoc={selectedDoc && doc.data ? (doc.data as never) : null} onSelectDoc={setSelectedDoc} loading={docs.isLoading}
      reviewQueue={reviewQueue}
      templates={(templates.data ?? []) as never} selectedTemplate={selectedTemplate && template.data ? (template.data as never) : null} onSelectTemplate={setSelectedTemplate}
      definitions={(definitions.data ?? []) as never}
      series={(series.data ?? []) as never} gapQuery={gapQuery ?? { sequenceType: "", periodKey: "" }} onGapQuery={setGapQuery} gapReport={(gapQuery && gap.data ? gap.data : null) as never}
    />
  );
}
