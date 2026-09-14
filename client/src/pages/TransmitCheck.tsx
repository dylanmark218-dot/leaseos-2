/**
 * v22.20 — may this unit transmit on this channel, and why.
 *
 * Layout from the workspace prototype; the decision is the server's. The
 * prototype computed transmit authorization in the browser from a bundled
 * channel list — which is the shape that produces a screen confidently
 * disagreeing with the system it is a screen for.
 *
 * The thing this page does that a status light would not: it shows **every
 * gate**, not only the failing one. A driver told "blocked" learns nothing and
 * asks the office; a driver told the licence is verified, the unit is approved,
 * and the province is not covered knows exactly who to call and what to say.
 * The reasons come from the engine word for word — a paraphrase here is a
 * second opinion nobody asked for.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Radio, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { conditionTone, gateView, TONE_CLASS, transmitTone, type Tone } from "@/lib/commsView";



/**
 * The mark for a tone, with the four outcomes kept distinct.
 *
 * `warn` is not a soft failure: a channel requiring a posted number is usable
 * where a sign says which one, and a red cross there would send a driver to the
 * office over a road they may lawfully drive.
 */
function toneIcon(tone: Tone) {
  switch (tone) {
    case "good": return <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="established" />;
    case "bad": return <XCircle className="h-4 w-4 text-red-600" aria-label="failed" />;
    case "warn": return <AlertTriangle className="h-4 w-4 text-amber-600" aria-label="requires a posted channel" />;
    case "muted": return <CircleHelp className="h-4 w-4 text-muted-foreground" aria-label="not established" />;
  }
}

export default function TransmitCheck() {
  const [channelKey, setChannelKey] = useState("");
  const [unitId, setUnitId] = useState("");
  const [asked, setAsked] = useState<{ channelKey: string; unitId?: number } | null>(null);

  const check = trpc.comms.transmitCheck.useQuery(
    { channelKey: asked?.channelKey ?? "", unitId: asked?.unitId },
    { enabled: asked !== null, retry: false },
  );

  const ask = () => {
    const key = channelKey.trim();
    if (!key) return;
    const parsed = Number(unitId.trim());
    setAsked({ channelKey: key, unitId: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined });
  };

  // No local shapes. These are the procedure's own types, so a vocabulary
  // change breaks the build rather than the screen.
  const gates = check.data?.gates ?? [];
  const reasons = check.data?.reasons ?? [];
  /**
   * Conditions rather than the company authorization: the procedure returns the
   * authorization *result*, not the context it was computed from. Whether a
   * licence is on file is already a gate, and reading it twice from two shapes
   * is how the two answers start to differ.
   */
  const conditions = check.data?.conditions ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Communications
        </p>
        <h1 className="text-2xl font-medium tracking-tight md:text-3xl">Transmit check</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Whether this unit may transmit on this channel, and every gate the answer rests on.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Channel and unit</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={channelKey}
            placeholder="Channel key"
            aria-label="Channel key"
            onChange={e => setChannelKey(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") ask(); }}
          />
          <Input
            value={unitId}
            placeholder="Unit id (optional)"
            aria-label="Unit id"
            inputMode="numeric"
            onChange={e => setUnitId(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") ask(); }}
          />
          <Button onClick={ask} disabled={!channelKey.trim()}>Check</Button>
        </CardContent>
      </Card>

      {asked === null && (
        <p className="text-sm text-muted-foreground">
          Name a channel. Leaving the unit out asks whether anybody may use it, which is a
          different question from whether this truck may.
        </p>
      )}

      {check.isError && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardContent className="pt-6 text-sm">
            {check.error?.message ?? "That channel could not be checked."}
          </CardContent>
        </Card>
      )}

      {check.data && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Radio className="h-4 w-4 text-muted-foreground" aria-hidden />
                {check.data.alias ?? check.data.channelKey}
              </CardTitle>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[transmitTone(check.data.status)]}`}>
                {check.data.status}
              </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {(check.data.rxMHz != null || check.data.txMHz != null) && (
                <p className="font-mono text-xs tabular-nums text-muted-foreground">
                  {check.data.rxMHz != null && <>RX {check.data.rxMHz} MHz</>}
                  {check.data.rxMHz != null && check.data.txMHz != null && " · "}
                  {check.data.txMHz != null && <>TX {check.data.txMHz} MHz</>}
                </p>
              )}

              {/* Every gate, not only the failing one. "Blocked" alone sends a
                  driver to the office; the full list tells them who to call. */}
              <ul className="flex flex-col gap-1.5">
                {gates.length === 0 && (
                  <li className="text-sm text-muted-foreground">No gates were evaluated.</li>
                )}
                {gates.map(gate => {
                  const view = gateView(gate);
                  return (
                    <li key={view.key} className="flex items-start gap-2 text-sm">
                      <span className="mt-0.5 shrink-0">{toneIcon(view.tone)}</span>
                      <span className="min-w-0">
                        <span className="font-medium">{view.label}</span>
                        {/* The engine's sentence, unedited. */}
                        <span className="text-muted-foreground"> — {view.reason}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {reasons.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Why</CardTitle>
              </CardHeader>
              <CardContent>
                {/* The engine's words. A paraphrase here is a second opinion. */}
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                  {reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                </ul>
              </CardContent>
            </Card>
          )}

          {conditions.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Conditions</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {conditions.map((condition, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0">{toneIcon(conditionTone(condition.result))}</span>
                      <span className="min-w-0">
                        <span className="font-medium">{condition.condition.kind}</span>
                        {/* The engine states the arithmetic — "39 km south of
                            the line", not "restricted". Shown as written. */}
                        {condition.reason && <span className="text-muted-foreground"> — {condition.reason}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {asked?.unitId === undefined && (
            <Badge variant="secondary" className="w-fit">
              Checked without a unit — this does not answer for any particular truck
            </Badge>
          )}
        </>
      )}
    </div>
  );
}
