import type { MyDayView, OfficeDayView } from "../viewModels";

const TONE: Record<string, string> = { critical: "text-[#b42318]", high: "text-[#c4620a]", medium: "text-[#8a6d1c]", low: "text-[#5b6b82]" };

export function MyDayPanel({ view, office, onGo }: { view: MyDayView; office?: OfficeDayView; onGo: (l: { portal: string; route: string }) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
        <h1 className="text-lg font-semibold tracking-wide">{view.greeting}</h1>
        {view.assignment ? (
          <button onClick={() => onGo(view.assignment!.deepLink)} className="mt-4 block w-full rounded-xl bg-[#eef2f7] p-4 text-left">
            <div className="text-xs uppercase text-[#5b6b82]">Current assignment</div>
            <div className="mt-1 font-medium">{view.assignment.title}</div>
            {view.assignment.detail && <div className="text-sm text-[#5b6b82]">{view.assignment.detail}</div>}
          </button>
        ) : <div className="mt-4 text-sm text-[#5b6b82]">No assignment on your list.</div>}
        {view.next && (
          <button onClick={() => onGo(view.next!.deepLink)} className="mt-4 block w-full rounded-xl border border-[#132a4a] p-4 text-left">
            <div className="text-xs uppercase text-[#5b6b82]">Next</div>
            <div className="mt-1 font-medium">{view.next.title}</div>
            <div className="text-sm text-[#5b6b82]">{view.next.action}</div>
          </button>
        )}
        {view.waitingFor.count > 0 && <div className="mt-4 text-sm text-[#5b6b82]">Waiting for {view.waitingFor.count} — {view.waitingFor.first}</div>}
      </section>
      <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5">
        <h2 className="font-medium">{view.attention.headline}</h2>
        <ul className="mt-3 space-y-2">
          {view.attention.items.map(i => (
            <li key={i.title}><button onClick={() => onGo(i.deepLink)} className={`text-left text-sm ${TONE[i.severity]}`}>⚠ {i.title}</button></li>
          ))}
        </ul>
        {view.attention.more > 0 && <div className="mt-2 text-xs text-[#5b6b82]">and {view.attention.more} more</div>}
        {office && (
          <table className="mt-5 w-full text-sm"><tbody>
            {office.rows.map(r => (
              <tr key={r.label} className="border-t border-[#eef2f7]">
                <td className="py-1"><button onClick={() => r.deepLink && onGo(r.deepLink)} className="text-left">{r.label}</button></td>
                <td className="py-1 text-right tabular-nums">{r.count}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </section>
    </div>
  );
}
