import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { searchGroups } from "./viewModels";

export function UniversalSearch({ onPick }: { onPick: (l: { portal: string; route: string }) => void }) {
  const [q, setQ] = useState("");
  const query = trpc.surfaces.search.useQuery({ q }, { enabled: q.trim().length >= 2 });
  const groups = searchGroups((query.data?.hits ?? []) as never);
  return (
    <div className="relative">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find anything — unit, job, ticket, invoice…" aria-label="Search" className="w-64 rounded-full border border-[#dfe5ee] px-3 py-1 text-sm" />
      {q.trim().length >= 2 && (
        <div className="absolute right-0 z-20 mt-1 max-h-96 w-96 overflow-auto rounded-xl border border-[#dfe5ee] bg-white p-2 shadow-lg">
          {groups.length === 0 && <div className="p-2 text-sm text-[#5b6b82]">{query.isLoading ? "Searching…" : "Nothing you may read matches."}</div>}
          {groups.map(g => (
            <div key={g.label} className="mb-2">
              <div className="px-2 text-xs uppercase text-[#5b6b82]">{g.label}</div>
              {g.hits.map(h => (
                <button key={`${h.entityType}:${h.entityId}`} onClick={() => { onPick(h.deepLink); setQ(""); }} className="block w-full rounded-lg px-2 py-1 text-left text-sm hover:bg-[#eef2f7]">
                  {h.label}{h.status && <span className="ml-2 text-xs text-[#5b6b82]">{h.status}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
