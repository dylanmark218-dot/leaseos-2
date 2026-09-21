import type { ExceptionItem } from "../viewModels";

export function ExceptionsPanel({ items, summary, onGo }: { items: ExceptionItem[]; summary?: { headline: string } | null; onGo: (l: { portal: string; route: string }) => void }) {
  if (items.length === 0) return <div className="rounded-2xl border border-[#dfe5ee] bg-white p-5 text-sm text-[#5b6b82]">Nothing needs your attention.</div>;
  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
      <h2 className="font-medium">{summary?.headline ?? `${items.length} item(s)`}</h2>
      <ul className="mt-3 divide-y divide-[#eef2f7]">
        {items.map(x => (
          <li key={x.key} className="py-3">
            <div className="flex items-baseline gap-2">
              <span className={`text-xs uppercase ${x.severity === "critical" ? "text-[#b42318]" : x.severity === "high" ? "text-[#c4620a]" : "text-[#5b6b82]"}`}>{x.severity}</span>
              <span className="text-xs text-[#5b6b82]">{x.category}</span>
            </div>
            <div className="font-medium">{x.title}</div>
            <div className="text-sm text-[#5b6b82]">{x.reason}</div>
            <button onClick={() => onGo(x.deepLink)} className="mt-1 text-sm text-[#132a4a] underline">{x.action}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
