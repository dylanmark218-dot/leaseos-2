/** P5.1 — a showcase panel that says where its content came from, on its face. */
import type { ReactNode } from "react";
import { sourceLabel, type PanelSource } from "./panelSource";

export function SourcedPanel({ title, source, children }: { title: string; source: PanelSource; children: ReactNode }) {
  const records = source.kind === "records";
  return (
    <section data-testid={`panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} data-panel-source={source.kind} className="rounded border">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2">
        <h3 className="font-medium">{title}</h3>
        <span className={`rounded px-2 py-0.5 text-xs ${records ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`} title={sourceLabel(source)}>
          {sourceLabel(source)}
        </span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** The same statement, sized to drop under an existing card title without restructuring the page. */
export function PanelSourceBadge({ source }: { source: PanelSource }) {
  const records = source.kind === "records";
  return (
    <span data-panel-source={source.kind} title={sourceLabel(source)}
      className={`mt-1 inline-block rounded px-2 py-0.5 text-[10px] ${records ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
      {sourceLabel(source)}
    </span>
  );
}
