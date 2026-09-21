/**
 * The driver's disposal finder — the view. Pure: every fact it shows arrived through props,
 * every action leaves through a callback. What it never does: draw a directions link for a
 * site whose coordinates nobody verified, show a wait time older than the server says is
 * current, or let an "accepted" call-ahead be recorded without who at the facility said so.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useState } from "react";

export type FinderSite = {
  facilityKey: string; name: string; municipality: string | null; province: string | null; facilityType: string | null; distanceKm: number;
  coordinatePrecision: string; routable: boolean; phone: string | null; dispatchPhone: string | null; afterHoursPhone: string | null; websiteUrl: string | null;
  commercialAccess: string; lifecycle: string; acceptance?: string; distanceNote?: string; accessNote?: string; lifecycleNote?: string; legalLocation: string | null;
};
export type FinderOrigin = { latitude: number; longitude: number; basis: "ats_grid" | "theoretical"; descriptor: string; note: string };
export type FinderResult = { outcome: "located"; origin: FinderOrigin; facilities: FinderSite[]; note: string } | { outcome: "invalid"; reason: string } | null;
export type DriverViewData = {
  facility: { name: string; coordinatePrecision: string; routable: boolean; commercialAccess: string; lifecycle: string; legalLocation: string | null; physicalAddress: string | null; regulatorRef: string | null; preapprovalRequired: boolean | null; manifestRequired: boolean | null; normAccepted: boolean | null; sourAccepted: boolean | null; twentyFourHourCallout: boolean | null };
  contact: { phone: string | null; dispatchPhone: string | null; afterHoursPhone: string | null; email: string | null; websiteUrl: string | null; gateInstructions: string | null };
  links: { call: string | null; googleDirections: string | null; appleDirections: string | null; website: string | null };
  warnings: string[];
  hoursToday: { state: "as_stated"; opensAt: string | null; closesAt: string | null; closed: boolean; source: string } | { state: "unknown"; note: string };
  currentWait: { state: "reported"; waitMinutes: number; trucksInQueue: number | null; ageMinutes: number; source: string } | { state: "unknown"; note: string };
  callAhead: { callAheadRef: string; outcome: string; spokeTo: string | null; conditions: string | null; validUntil: Date | string | null } | { state: "none_valid"; note: string };
  accepts: { wasteCode: string; acceptanceStatus: string; conditions: string | null }[];
};
export type CallAheadDraft = { outcome: "accepted" | "accepted_with_conditions" | "refused" | "no_answer" | "call_back"; spokeTo: string; conditions: string; quotedWaitMinutes: string; validForHours: string };

export type DisposalFinderViewProps = {
  lsd: string; onLsdChange: (v: string) => void; wasteCode: string; onWasteCodeChange: (v: string) => void; wasteCodes: string[]; onFind: () => void; finding: boolean;
  result: FinderResult; selectedKey: string | null; onSelect: (key: string) => void;
  view: DriverViewData | null; viewLoading: boolean;
  onCallAhead: (draft: CallAheadDraft) => void; callAheadBusy: boolean;
  onWaitReport: (minutes: number, trucks: number | null) => void; waitBusy: boolean;
};

const badgeFor = (precision: string) => precision === "verified_entrance" || precision === "verified_site" ? "verified" : precision === "approximate_site" ? "±2 km" : precision === "community_only" ? "town only" : "location unknown";

export function DisposalFinderView(p: DisposalFinderViewProps) {
  const [draft, setDraft] = useState<CallAheadDraft>({ outcome: "accepted", spokeTo: "", conditions: "", quotedWaitMinutes: "", validForHours: "12" });
  const [wait, setWait] = useState({ minutes: "", trucks: "" });
  const accepted = draft.outcome === "accepted" || draft.outcome === "accepted_with_conditions";
  const callAheadValid = !accepted || (draft.spokeTo.trim().length > 0 && (draft.outcome !== "accepted_with_conditions" || draft.conditions.trim().length > 0));
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4" data-testid="disposal-finder">
      <Card>
        <CardHeader><CardTitle>Find a disposal site from a legal land description</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Legal land description" placeholder="e.g. 07-18-053-18 W5M" value={p.lsd} onChange={e => p.onLsdChange(e.target.value)} className="max-w-xs" />
            <select aria-label="Waste stream" className="rounded border bg-background px-2" value={p.wasteCode} onChange={e => p.onWasteCodeChange(e.target.value)}>
              <option value="">any waste stream</option>
              {p.wasteCodes.map(c => <option key={c} value={c}>{c.replaceAll("_", " ")}</option>)}
            </select>
            <Button onClick={p.onFind} disabled={p.finding || p.lsd.trim().length < 4}>{p.finding ? "Finding…" : "Find sites"}</Button>
          </div>
          {p.result?.outcome === "invalid" && <p role="alert" className="text-sm text-destructive">{p.result.reason}</p>}
          {p.result?.outcome === "located" && (
            <p className="text-sm text-muted-foreground" data-testid="origin-note">
              From {p.result.origin.descriptor} — {p.result.origin.basis === "ats_grid" ? "surveyed grid centroid" : "theoretical centroid, ±2 km"} ({p.result.origin.latitude.toFixed(4)}, {p.result.origin.longitude.toFixed(4)}). {p.result.note}
            </p>
          )}
        </CardContent>
      </Card>

      {p.result?.outcome === "located" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Nearest sites</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {p.result.facilities.length === 0 && <p className="text-sm text-muted-foreground">Nothing within range. Widen the search or call dispatch.</p>}
              {p.result.facilities.map(f => (
                <button key={f.facilityKey} type="button" onClick={() => p.onSelect(f.facilityKey)} aria-pressed={p.selectedKey === f.facilityKey}
                  className={`w-full rounded border p-2 text-left text-sm ${p.selectedKey === f.facilityKey ? "border-primary" : ""}`} data-testid={`site-${f.facilityKey}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{f.name}</span>
                    <span className="whitespace-nowrap">{f.distanceKm} km</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant={f.routable ? "default" : "outline"}>{badgeFor(f.coordinatePrecision)}</Badge>
                    {f.acceptance && <Badge variant={f.acceptance === "verified" ? "default" : "outline"}>{f.acceptance.replaceAll("_", " ")}</Badge>}
                    {f.lifecycleNote && <Badge variant="destructive">{f.lifecycleNote}</Badge>}
                    {f.accessNote && <Badge variant="outline">{f.accessNote}</Badge>}
                  </div>
                  {f.distanceNote && <div className="mt-1 text-xs text-muted-foreground">{f.distanceNote}</div>}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{p.view?.facility.name ?? (p.viewLoading ? "Loading…" : "Pick a site")}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {p.view && (
                <>
                  {p.view.warnings.length > 0 && <ul className="space-y-1" data-testid="warnings">{p.view.warnings.map(w => <li key={w} className="rounded border border-amber-500/50 px-2 py-1">{w}</li>)}</ul>}
                  <div className="grid gap-1">
                    <div><span className="text-muted-foreground">Site </span>{p.view.contact.phone ? <a href={`tel:${p.view.contact.phone.replace(/[^+\d]/g, "")}`}>{p.view.contact.phone}</a> : "—"}</div>
                    <div><span className="text-muted-foreground">Dispatch </span>{p.view.contact.dispatchPhone ?? "—"}</div>
                    <div><span className="text-muted-foreground">After hours </span>{p.view.contact.afterHoursPhone ?? "—"}{p.view.facility.twentyFourHourCallout ? " · 24-hour callout" : ""}</div>
                    <div><span className="text-muted-foreground">Location </span>{p.view.facility.legalLocation ?? p.view.facility.physicalAddress ?? "not on file"} <Badge variant="outline">{badgeFor(p.view.facility.coordinatePrecision)}</Badge></div>
                    {p.view.facility.regulatorRef && <div><span className="text-muted-foreground">Regulator ref </span>{p.view.facility.regulatorRef}</div>}
                    <div><span className="text-muted-foreground">Hours today </span>{p.view.hoursToday.state === "as_stated" ? (p.view.hoursToday.closed ? "closed" : `${p.view.hoursToday.opensAt}–${p.view.hoursToday.closesAt} (${p.view.hoursToday.source.replaceAll("_", " ")})`) : p.view.hoursToday.note}</div>
                    <div data-testid="wait"><span className="text-muted-foreground">Wait </span>{p.view.currentWait.state === "reported" ? `${p.view.currentWait.waitMinutes} min${p.view.currentWait.trucksInQueue !== null ? `, ${p.view.currentWait.trucksInQueue} trucks` : ""} — ${p.view.currentWait.ageMinutes} min ago (${p.view.currentWait.source.replaceAll("_", " ")})` : p.view.currentWait.note}</div>
                    <div data-testid="call-ahead-state"><span className="text-muted-foreground">Call-ahead </span>{"callAheadRef" in p.view.callAhead ? `${p.view.callAhead.outcome.replaceAll("_", " ")} — ${p.view.callAhead.spokeTo ?? "?"}${p.view.callAhead.conditions ? ` (${p.view.callAhead.conditions})` : ""}` : p.view.callAhead.note}</div>
                    {p.view.accepts.length > 0 && <div><span className="text-muted-foreground">Accepts </span>{p.view.accepts.map(a => `${a.wasteCode.replaceAll("_", " ")}: ${a.acceptanceStatus.replaceAll("_", " ")}`).join("; ")}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.view.links.call && <Button asChild size="sm"><a href={p.view.links.call}>Call site</a></Button>}
                    {p.view.links.googleDirections ? <Button asChild size="sm" variant="outline"><a href={p.view.links.googleDirections} target="_blank" rel="noopener">Directions</a></Button> : <Badge variant="outline" data-testid="no-directions">No directions — coordinates not verified</Badge>}
                    {p.view.links.website && <Button asChild size="sm" variant="outline"><a href={p.view.links.website} target="_blank" rel="noopener">Website</a></Button>}
                  </div>

                  <fieldset className="space-y-2 rounded border p-2" data-testid="call-ahead-form">
                    <legend className="px-1 text-xs text-muted-foreground">Record the call-ahead</legend>
                    <select aria-label="Call outcome" className="rounded border bg-background px-2" value={draft.outcome} onChange={e => setDraft({ ...draft, outcome: e.target.value as CallAheadDraft["outcome"] })}>
                      <option value="accepted">accepted</option><option value="accepted_with_conditions">accepted with conditions</option><option value="refused">refused</option><option value="no_answer">no answer</option><option value="call_back">call back</option>
                    </select>
                    <Input aria-label="Who at the facility" placeholder="who at the facility (required for an acceptance)" value={draft.spokeTo} onChange={e => setDraft({ ...draft, spokeTo: e.target.value })} />
                    {draft.outcome === "accepted_with_conditions" && <Input aria-label="Conditions" placeholder="the conditions they gave" value={draft.conditions} onChange={e => setDraft({ ...draft, conditions: e.target.value })} />}
                    <div className="flex gap-2">
                      <Input aria-label="Quoted wait minutes" placeholder="quoted wait (min)" inputMode="numeric" value={draft.quotedWaitMinutes} onChange={e => setDraft({ ...draft, quotedWaitMinutes: e.target.value })} />
                      <Input aria-label="Valid for hours" placeholder="valid for (h)" inputMode="numeric" value={draft.validForHours} onChange={e => setDraft({ ...draft, validForHours: e.target.value })} />
                    </div>
                    <Button size="sm" disabled={!callAheadValid || p.callAheadBusy} onClick={() => p.onCallAhead(draft)} data-testid="save-call-ahead">Save call-ahead</Button>
                    {!callAheadValid && <p className="text-xs text-muted-foreground">An acceptance needs who at the facility said so{draft.outcome === "accepted_with_conditions" ? " and the conditions" : ""}.</p>}
                  </fieldset>

                  <fieldset className="space-y-2 rounded border p-2" data-testid="wait-form">
                    <legend className="px-1 text-xs text-muted-foreground">Report the wait you see</legend>
                    <div className="flex gap-2">
                      <Input aria-label="Wait minutes" placeholder="minutes" inputMode="numeric" value={wait.minutes} onChange={e => setWait({ ...wait, minutes: e.target.value })} />
                      <Input aria-label="Trucks in queue" placeholder="trucks in queue" inputMode="numeric" value={wait.trucks} onChange={e => setWait({ ...wait, trucks: e.target.value })} />
                      <Button size="sm" variant="outline" disabled={p.waitBusy || wait.minutes.trim() === "" || Number.isNaN(Number(wait.minutes))} onClick={() => p.onWaitReport(Number(wait.minutes), wait.trucks.trim() === "" ? null : Number(wait.trucks))}>Report</Button>
                    </div>
                  </fieldset>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
