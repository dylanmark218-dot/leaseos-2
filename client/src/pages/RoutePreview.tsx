/**
 * v22.20 — the route preview: what road, and what may be said on it.
 *
 * Read-only by design. Computing a route must not persist a communication plan,
 * for the same reason the office screen reads status rather than fetching: a
 * record saying a plan was made for this trip is a claim about the world, and
 * opening a screen is not a claim about anything. Saving one is a separate,
 * deliberate act that does not belong on a preview.
 *
 * The distinction the screen exists to hold: **a road connection is not a
 * permission to drive it.** The procedure returns `path_only` when no vehicle
 * and no checks were supplied, and its own words are that this "is not a
 * permission to drive it". A map line without that sentence beside it is the
 * most dangerous thing this screen could render, because a route that appears
 * is a route that looks approved.
 *
 * Five outcomes, kept apart because they send you to five different places: no
 * graph means nobody has imported that area; an unreachable origin means the
 * site is off the network; a path with no verdict means nobody asked about this
 * vehicle; and evaluated means the limits were actually checked.
 */
import { useState } from "react";
import { AlertTriangle, MapPin, Radio, Route as RouteIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TONE_CLASS, transmitTone } from "@/lib/commsView";

type Point = { lat: string; lng: string };

const num = (v: string): number | null => {
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
};

export default function RoutePreview() {
  const [from, setFrom] = useState<Point>({ lat: "", lng: "" });
  const [to, setTo] = useState<Point>({ lat: "", lng: "" });
  const [asked, setAsked] = useState<{ fromLatitude: number; fromLongitude: number; toLatitude: number; toLongitude: number } | null>(null);

  const route = trpc.geo.routeCompute.useQuery(
    {
      fromLatitude: asked?.fromLatitude ?? 0, fromLongitude: asked?.fromLongitude ?? 0,
      toLatitude: asked?.toLatitude ?? 0, toLongitude: asked?.toLongitude ?? 0,
      includeCommunications: true,
    },
    { enabled: asked !== null, retry: false },
  );

  const compute = () => {
    const fromLatitude = num(from.lat), fromLongitude = num(from.lng);
    const toLatitude = num(to.lat), toLongitude = num(to.lng);
    if (fromLatitude == null || fromLongitude == null || toLatitude == null || toLongitude == null) return;
    setAsked({ fromLatitude, fromLongitude, toLatitude, toLongitude });
  };

  const data = route.data;
  /* Narrowed on the outcome. Three of the five carry no path and no
     communications at all, so reaching for them unconditionally would be
     reading fields that are not there. */
  const path = data && "path" in data ? data.path : null;
  const communications = data && "communications" in data ? data.communications : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Routing · preview
        </p>
        <h1 className="text-2xl font-medium tracking-tight md:text-3xl">Route preview</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          The road connection between two positions and what may be transmitted along it.
          Nothing is saved by looking — building a communication plan is a separate action.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Positions</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2">
          <Input value={from.lat} placeholder="From latitude" aria-label="From latitude"
            onChange={e => setFrom({ ...from, lat: e.target.value })} />
          <Input value={from.lng} placeholder="From longitude" aria-label="From longitude"
            onChange={e => setFrom({ ...from, lng: e.target.value })} />
          <Input value={to.lat} placeholder="To latitude" aria-label="To latitude"
            onChange={e => setTo({ ...to, lat: e.target.value })} />
          <Input value={to.lng} placeholder="To longitude" aria-label="To longitude"
            onChange={e => setTo({ ...to, lng: e.target.value })} />
          <Button className="col-span-2" onClick={compute}>Compute</Button>
        </CardContent>
      </Card>

      {route.isError && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardContent className="pt-6 text-sm">
            {route.error?.message ?? "That route could not be computed."}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* The outcome first, because four of the five are not a route. */}
          <Card className={data.outcome === "evaluated" ? undefined : "border-amber-300 dark:border-amber-800"}>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <RouteIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                {data.outcome.replace(/_/g, " ")}
              </CardTitle>
              {path && (
                <Badge variant="secondary" className="tabular-nums">{path.kilometres} km</Badge>
              )}
            </CardHeader>
            <CardContent>
              {/* The procedure's own sentences — including the one saying a
                  connection is not a permission. Paraphrasing that away is how
                  a preview starts looking like an approval. */}
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {data.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            </CardContent>
          </Card>

          {data.outcome === "path_only" && (
            <Card className="border-amber-400 dark:border-amber-700">
              <CardContent className="flex gap-3 pt-6">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
                <p className="text-sm">
                  No vehicle or checks were supplied, so no limit has been evaluated. This is the
                  road connection only. It is not a permission to drive it.
                </p>
              </CardContent>
            </Card>
          )}

          {path && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {path.segments.length} segment{path.segments.length === 1 ? "" : "s"}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                {path.segments.map(segment => (
                  <div key={segment.segmentId} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      {segment.label || segment.segmentId}
                      {segment.featureTypeLabel && (
                        <span className="text-muted-foreground"> · {segment.featureTypeLabel}</span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {segment.surfaceKind} · {segment.kilometres} km
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {communications && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Radio className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Communications along this path
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {communications.zones.map((zone, i) => (
                  <div
                    key={`${zone.fromKm}-${zone.toKm}-${i}`}
                    className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {zone.roadName ?? `${zone.fromKm.toFixed(1)}–${zone.toKm.toFixed(1)} km`}
                      </p>
                      {zone.unknownReason && (
                        <p className="text-sm text-muted-foreground">{zone.unknownReason}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {zone.channelKey && (
                        <span className="font-mono text-xs">{zone.channelKey}</span>
                      )}
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[transmitTone(zone.transmit)]}`}>
                        {zone.transmit}
                      </span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            A preview. No communication plan has been built and nothing has been recorded against
            a trip.
          </p>
        </>
      )}
    </div>
  );
}
