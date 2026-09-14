/**
 * v22.20 — the first screen over the communications engine.
 *
 * Layout adapted from the workspace prototype; the data is not. The prototype
 * shipped its own `comms` engine — authority tiers, transmit authorization,
 * coverage windows, plan blockers — running on a hardcoded trip. LeaseOS
 * already has all of those, with jurisdiction crossings, real geometry, sealed
 * packages and staleness the prototype has no notion of.
 *
 * Wiring the prototype's engine to these screens would have produced two
 * communications engines that never learn about each other, and the divergence
 * would surface on the day the screen says a transmit is authorized and the
 * server says it is not. So the engine went and the layout stayed.
 *
 * What this page will not do: invent a package when none is on file, or render
 * a stale one as though it were current. A radio plan that is quietly out of
 * date is worse than a blank screen, because a blank screen sends somebody to
 * ask.
 */
import { useState } from "react";
import { AlertTriangle, Radio, RefreshCw, Signpost } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TONE_CLASS, transmitTone } from "@/lib/commsView";

/**
 * The sealed shape, from the engine that seals it.
 *
 * The first version of this page invented `{ segmentId, label, status, reason }`
 * and cast the package into it. Only `channelKey` happened to exist, so every
 * zone rendered as "unknown" with no explanation — including the ones the
 * server had marked not authorized.
 */
import type { PackageContent } from "../../../server/_core/commPackage";

export default function CommunicationsPackage() {
  const [label, setLabel] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  /**
   * A mutation, not a query, and deliberately so on the server: fetching a
   * sealed package is a recorded access. Treating it as a cacheable read would
   * mean a driver could open the plan without the office ever knowing it was
   * opened, which is the opposite of what a sealed package is for.
   */
  const pkg = trpc.comms.packageFetch.useMutation();

  const fetchPackage = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    setSubmitted(trimmed);
    pkg.mutate({ label: trimmed });
  };

  const content = pkg.data?.content as PackageContent | undefined;
  const zones = content?.zones ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Communications
        </p>
        <h1 className="text-2xl font-medium tracking-tight md:text-3xl">Radio package</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          What this unit may transmit on, segment by segment, from the sealed package built for
          the route. Nothing here is computed in the browser.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Package</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            value={label}
            placeholder="Package label"
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && label.trim()) fetchPackage(); }}
            aria-label="Package label"
          />
          <Button onClick={fetchPackage} disabled={!label.trim() || pkg.isPending}>
            Fetch
          </Button>
        </CardContent>
      </Card>

      {submitted === null && (
        <p className="text-sm text-muted-foreground">
          Enter the label of a package that has been built for this route.
        </p>
      )}

      {pkg.isPending && submitted !== null && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> Fetching…
        </p>
      )}

      {/* No package is a real answer, and a better one than an invented plan. */}
      {pkg.isError && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardContent className="flex gap-3 pt-6">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">No package on file for that label</p>
              <p className="text-sm text-muted-foreground">
                {pkg.error?.message ?? "Nothing was found."} A radio plan has to be built before
                departure; this screen will not make one up.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {pkg.data && (
        <>
          {/* Staleness is the server's verdict, shown as prominently as it deserves. */}
          {pkg.data.warning && (
            <Card className="border-amber-400 dark:border-amber-700">
              <CardContent className="flex gap-3 pt-6">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
                <p className="text-sm">{pkg.data.warning}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
              <CardTitle className="text-sm font-medium">
                {zones.length} segment{zones.length === 1 ? "" : "s"}
              </CardTitle>
              <Badge variant={pkg.data.status === "current" ? "default" : "secondary"}>
                {pkg.data.status}
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {zones.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  This package carries no segments.
                </p>
              )}
              {zones.map((zone, i) => (
                <div
                  key={`${zone.fromKm}-${zone.toKm}-${i}`}
                  className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Signpost className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {zone.roadName ?? `${zone.fromKm.toFixed(1)}–${zone.toKm.toFixed(1)} km`}
                      </p>
                      {zone.roadName && (
                        <p className="font-mono text-xs tabular-nums text-muted-foreground">
                          {zone.fromKm.toFixed(1)}–{zone.toKm.toFixed(1)} km
                        </p>
                      )}
                      {/* The server's sentence for why it could not say. */}
                      {zone.unknownReason && (
                        <p className="text-sm text-muted-foreground">{zone.unknownReason}</p>
                      )}
                      {zone.mustCallKm.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Call at {zone.mustCallKm.map(k => `${k.toFixed(1)} km`).join(", ")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {zone.channelKey ? (
                      <span className="flex items-center gap-1.5 font-mono text-xs">
                        <Radio className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        {zone.channelKey}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">no channel</span>
                    )}
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[transmitTone(zone.transmit)]}`}>
                      {zone.transmit}
                    </span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Sealed package {pkg.data.packageRef ?? ""}. Authority, coverage and blockers are decided
            on the server; this screen renders the verdict and computes none of it.
          </p>
        </>
      )}
    </div>
  );
}
