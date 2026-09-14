import { useEffect, useState } from "react";
import { portalClient } from "./portalClient";

export function AlertsPanel() {
  const [alerts, setAlerts] = useState<Awaited<ReturnType<typeof portalClient.portal.alerts.query>>["alerts"]>([]);
  const [prefs, setPrefs] = useState<Awaited<ReturnType<typeof portalClient.portal.alertPreferences.query>>["preferences"]>([]);
  const load = () => { void portalClient.portal.alerts.query().then(r => setAlerts(r.alerts)); void portalClient.portal.alertPreferences.query().then(r => setPrefs(r.preferences)); };
  useEffect(load, []);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5"><div className="font-medium">Alerts</div><ul className="mt-3 divide-y divide-[#eef2f7] text-sm">{alerts.map(a => <li key={a.id} className="py-2"><div className="font-medium">{a.title}</div><div>{a.body}</div><div className="text-xs text-[#5b6b82]">{new Date(a.queuedAt).toLocaleString()} · {a.status}{a.status !== "acknowledged" && <button className="ml-2 underline" onClick={() => void portalClient.portal.alertAcknowledge.mutate({ id: a.id }).then(load)}>acknowledge</button>}</div></li>)}{alerts.length === 0 && <li className="py-2 text-[#5b6b82]">No alerts.</li>}</ul></section>
      <section className="rounded-2xl border border-[#dfe5ee] bg-white p-5"><div className="font-medium">What you want to hear about</div><div className="text-xs text-[#5b6b82]">Only customer-safe events exist here; nothing private has a switch.</div><ul className="mt-3 text-sm">{prefs.map(p => <li key={p.eventKind}><label><input type="checkbox" checked={p.enabled} onChange={ev => void portalClient.portal.alertPreferencesSet.mutate({ eventKind: p.eventKind, enabled: ev.target.checked }).then(load)} /> {p.eventKind.replace(/_/g, " ")}{p.isDefault ? "" : " (yours)"}</label></li>)}</ul></section>
    </div>
  );
}
