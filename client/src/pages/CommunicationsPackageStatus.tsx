/**
 * v22.20 — the office view of a radio package: is it still true, and who took it.
 *
 * The counterpart to the field screen. A dispatcher's question is not "what
 * channel" — it is whether the plan the driver is carrying still matches the
 * world, and who is out there on an old one.
 *
 * Deliberately `packageStatus` rather than `packageFetch`. Fetching is the
 * first half of the carry handshake: it records a download, meaning somebody
 * took this onto a device. A dispatcher glancing at a package must not
 * manufacture a record saying a package went into the field, because that
 * record is what the staleness answer is later computed against.
 *
 * The distinction the screen keeps: a carried package being out of date is not
 * the same fact as a driver being unreachable. LeaseOS knows what was
 * downloaded and acknowledged. It does not know what is on a device that has
 * not spoken since.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, PackageCheck, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { carrierNeedsAction, carrierTone, TONE_CLASS } from "@/lib/commsView";

const when = (v: string | Date | null | undefined): string =>
  v ? new Date(v).toLocaleString() : "—";



export default function CommunicationsPackageStatus() {
  const [label, setLabel] = useState("");
  const [asked, setAsked] = useState<string | null>(null);

  const status = trpc.comms.packageStatus.useQuery(
    { label: asked ?? "" },
    { enabled: asked !== null && asked.length > 0, retry: false },
  );

  // The procedure's own types. The previous local copy expected `reason` and
  // `outdated`; the server says `note`, `behind` and `stale`, so a driver on a
  // superseded package was shown the grey reserved for "unknown".
  const carriers = status.data?.carriedBy ?? [];
  const reasons = status.data?.reasons ?? [];
  const counts = status.data?.counts;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Communications · office
        </p>
        <h1 className="text-2xl font-medium tracking-tight md:text-3xl">Package status</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Whether this radio plan still matches what it was built from, and who took it into
          the field. Looking here records nothing — no download is created by reading.
        </p>
      </header>

      <Card>
        <CardContent className="flex gap-2 pt-6">
          <Input
            value={label}
            placeholder="Package label"
            aria-label="Package label"
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && label.trim()) setAsked(label.trim()); }}
          />
          <Button onClick={() => label.trim() && setAsked(label.trim())} disabled={!label.trim()}>
            Check
          </Button>
        </CardContent>
      </Card>

      {status.isError && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardContent className="pt-6 text-sm">
            {status.error?.message ?? "That package could not be checked."}
          </CardContent>
        </Card>
      )}

      {status.data && (
        <>
          <Card className={status.data.stale ? "border-amber-400 dark:border-amber-700" : undefined}>
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                {status.data.stale
                  ? <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
                  : <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />}
                {status.data.label} · v{status.data.version}
              </CardTitle>
              <Badge variant={status.data.stale ? "secondary" : "default"}>{status.data.status}</Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {/* The server's reasons, including its reason for saying nothing
                  changed. Silence would read as "not checked". */}
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {reasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>

              {counts && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                  <div><dt className="text-muted-foreground">Zones</dt><dd className="tabular-nums">{counts.zones}</dd></div>
                  <div><dt className="text-muted-foreground">Channels</dt><dd className="tabular-nums">{counts.channels}</dd></div>
                  <div><dt className="text-muted-foreground">Must call</dt><dd className="tabular-nums">{counts.mustCall}</dd></div>
                  {/* Counted and shown rather than folded into a total: a zone
                      with no channel and an unverified one are different gaps. */}
                  <div>
                    <dt className="text-muted-foreground">Unverified channels</dt>
                    <dd className="tabular-nums">{counts.unverifiedChannels}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Zones without a channel</dt>
                    <dd className="tabular-nums">{counts.zonesWithoutChannel}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Retired, excluded</dt>
                    <dd className="tabular-nums">{counts.retiredExcluded}</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
                Carried by
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {carriers.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nobody has taken this package onto a device.
                </p>
              )}
              {carriers.map((carrier, i) => (
                <div
                  key={`${carrier.userId}-${i}`}
                  className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <PackageCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      User {carrier.userId} · {carrier.deviceRef ?? "device not named"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Taken {when(carrier.downloadedAt)}
                      {/* Downloaded and acknowledged are different facts: the
                          first says it was sent, the second that it arrived and
                          verified on the device. */}
                      {carrier.acknowledged ? " · acknowledged" : " · not acknowledged"}
                    </p>
                    {/* The server's own note: "a newer package has been built",
                        "the latest built is out of date". Both mean do not
                        depart, and they need different fixes. */}
                    <p className="text-sm text-muted-foreground">{carrier.note}</p>
                  </div>
                  <span className={`w-fit shrink-0 rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[carrierTone(carrier.state)]}`}>
                    {carrier.state}
                    {carrierNeedsAction(carrier.state) && " — do not depart"}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            This is what LeaseOS was told. A device that has not synchronized since it took the
            package may be carrying something else, and that is not knowable from here.
          </p>
        </>
      )}
    </div>
  );
}
