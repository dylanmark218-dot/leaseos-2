/**
 * The driver's disposal finder — the container. Wires the pure view to the facility
 * directory: lsdFind (grid first, theoretical fallback), driverView, call-ahead and wait
 * reports. The waste-stream list comes from the vocabulary, not a hard-coded enum.
 */
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { DisposalFinderView, type CallAheadDraft } from "./DisposalFinderView";

export default function DisposalFinder() {
  const [lsd, setLsd] = useState("");
  const [wasteCode, setWasteCode] = useState("");
  const [query, setQuery] = useState<{ lsd: string; wasteCode?: string } | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const vocabulary = trpc.facilityDirectory.vocabulary.list.useQuery();
  const find = trpc.facilityDirectory.lsdFind.useQuery(query ? { lsd: query.lsd, wasteCode: query.wasteCode as never, radiusKm: 150 } : { lsd: "00-00-000-00 W0M" }, { enabled: query !== null });
  const view = trpc.facilityDirectory.driverView.useQuery({ facilityKey: selectedKey ?? "" }, { enabled: selectedKey !== null });
  const refresh = () => { if (selectedKey) void utils.facilityDirectory.driverView.invalidate({ facilityKey: selectedKey }); };
  const callAhead = trpc.facilityDirectory.callAhead.record.useMutation({ onSuccess: r => { toast.success(`Call-ahead ${r.callAheadRef} recorded${r.validUntil ? " — valid until " + new Date(r.validUntil).toLocaleString() : ""}`); refresh(); }, onError: e => toast.error(e.message) });
  const wait = trpc.facilityDirectory.wait.report.useMutation({ onSuccess: () => { toast.success("Wait reported"); refresh(); }, onError: e => toast.error(e.message) });
  const onCallAhead = (d: CallAheadDraft) => { if (!selectedKey) return; callAhead.mutate({ facilityKey: selectedKey, outcome: d.outcome, spokeTo: d.spokeTo.trim() || undefined, conditions: d.conditions.trim() || undefined, quotedWaitMinutes: d.quotedWaitMinutes.trim() ? Number(d.quotedWaitMinutes) : undefined, validForHours: d.validForHours.trim() ? Number(d.validForHours) : 12, wasteCode: (wasteCode || undefined) as never }); };
  return (
    <DisposalFinderView
      lsd={lsd} onLsdChange={setLsd} wasteCode={wasteCode} onWasteCodeChange={setWasteCode} wasteCodes={(vocabulary.data ?? []).map(v => v.internalCode)}
      onFind={() => { setSelectedKey(null); setQuery({ lsd: lsd.trim(), wasteCode: wasteCode || undefined }); }} finding={find.isFetching}
      result={query && find.data ? (find.data as never) : null} selectedKey={selectedKey} onSelect={setSelectedKey}
      view={selectedKey && view.data ? (view.data as never) : null} viewLoading={view.isFetching}
      onCallAhead={onCallAhead} callAheadBusy={callAhead.isPending}
      onWaitReport={(minutes, trucks) => { if (selectedKey) wait.mutate({ facilityKey: selectedKey, waitMinutes: minutes, trucksInQueue: trucks ?? undefined }); }} waitBusy={wait.isPending}
    />
  );
}
