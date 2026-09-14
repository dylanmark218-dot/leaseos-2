import { useState } from "react";
import { trpc } from "@/lib/trpc";

export function TimelinePanel() {
  const [entityType, setEntityType] = useState<"unit" | "job" | "trip" | "load">("unit");
  const [entityId, setEntityId] = useState<string>("");
  const id = Number(entityId);
  const q = trpc.surfaces.timeline.useQuery({ entityType, entityId: id, limit: 200 }, { enabled: Number.isInteger(id) && id > 0 });
  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
      <div className="flex gap-2">
        <select value={entityType} onChange={e => setEntityType(e.target.value as never)} className="rounded-lg border border-[#dfe5ee] px-2 py-1 text-sm">
          {["unit", "job", "trip", "load"].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={entityId} onChange={e => setEntityId(e.target.value)} placeholder="id" inputMode="numeric" className="w-24 rounded-lg border border-[#dfe5ee] px-2 py-1 text-sm" />
      </div>
      {q.data && (
        <ol className="mt-4 space-y-2 text-sm">
          {q.data.events.map((e, i) => (
            <li key={i} className="border-l-2 border-[#dfe5ee] pl-3">
              <div className="text-xs text-[#5b6b82]">{new Date(e.occurredAt).toLocaleString()}{e.recordedAt && new Date(e.recordedAt).getTime() !== new Date(e.occurredAt).getTime() ? ` · recorded ${new Date(e.recordedAt).toLocaleString()}` : ""}</div>
              <div className="font-medium">{e.title}</div>
              {e.detail && <div className="text-[#5b6b82]">{e.detail}</div>}
            </li>
          ))}
          {q.data.events.length === 0 && <li className="text-[#5b6b82]">Nothing you may read has happened to this {entityType}.</li>}
        </ol>
      )}
    </section>
  );
}
