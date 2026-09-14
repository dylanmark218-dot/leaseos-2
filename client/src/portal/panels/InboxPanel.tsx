import type { InboxItem } from "../viewModels";

export function InboxPanel({ items, counts, onGo }: { items: InboxItem[]; counts: Record<string, number>; onGo: (l: { portal: string; route: string }) => void }) {
  return (
    <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
      <div className="flex flex-wrap gap-2 text-xs text-[#5b6b82]">{Object.entries(counts).map(([k, n]) => <span key={k} className="rounded-full bg-[#eef2f7] px-2 py-0.5">{k.replace(/_/g, " ")} · {n}</span>)}</div>
      {items.length === 0 ? <div className="mt-3 text-sm text-[#5b6b82]">Nothing for you to do.</div> : (
        <ul className="mt-3 divide-y divide-[#eef2f7]">
          {items.map(i => (
            <li key={`${i.kind}:${i.ref}`} className="py-3">
              <div className="text-xs uppercase text-[#5b6b82]">{i.kind.replace(/_/g, " ")}</div>
              <button onClick={() => onGo(i.deepLink)} className="text-left font-medium">{i.title}</button>
              {i.detail && <div className="text-sm text-[#5b6b82]">{i.detail}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
