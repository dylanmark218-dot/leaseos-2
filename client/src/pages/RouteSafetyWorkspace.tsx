import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Gauge,
  Map,
  Navigation,
  ShieldAlert,
  Truck,
} from "lucide-react";

const alternatives = [
  {
    name: "Route A · Highway corridor",
    time: "2h 08m",
    note: "DG corridor · verified · 18 t bridge",
    risk: "moderate",
    color: "#e6f0fb",
  },
  {
    name: "Route B · Lease-road bypass",
    time: "2h 26m",
    note: "Back road · 4x4 recommended · washout watch",
    risk: "low",
    color: "#e3f6ef",
  },
  {
    name: "Route C · Seasonal detour",
    time: "2h 41m",
    note: "Seasonal restriction · 4.2 m clearance",
    risk: "high",
    color: "#fff0d2",
  },
];
export default function RouteSafetyWorkspace() {
  const facilityContext =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("facility")
      : null;
  const { data: decisions } = trpc.fieldRoute.routeDecisions.list.useQuery();
  const save = trpc.fieldRoute.routeDecisions.create.useMutation({
    onSuccess: () =>
      toast.success("Route decision and constraint snapshot saved."),
  });
  const [gvw, setGvw] = useState(38);
  const [axles, setAxles] = useState(5);
  const [height, setHeight] = useState(4.1);
  const [width, setWidth] = useState(3.1);
  const [length, setLength] = useState(18.5);
  const [vehicleType, setVehicleType] = useState(
    "Hydrovac commercial combination"
  );
  const [hazmatClass, setHazmatClass] = useState("Class 3 liquid");
  const [quantity, setQuantity] = useState("300 bbl");
  const [placard, setPlacard] = useState("Required · verified");
  const [ack, setAck] = useState(false);
  const [selected, setSelected] = useState(1);
  const selectedRoute = alternatives[selected];
  const blocked = gvw > 42 || height > 4.2 || width > 3.3;
  const risk = blocked ? "blocked" : selectedRoute.risk;
  const tradeoffs = [
    {
      label: "Surface / grade",
      value:
        selected === 1 ? "Gravel · moderate grade" : "Pavement · low grade",
    },
    {
      label: "Bridge rating",
      value: `${gvw <= 42 ? "Compatible" : "Blocked"} · ${gvw} t / 42 t`,
    },
    {
      label: "Clearance",
      value: `${height.toFixed(1)} m · ${height <= 4.2 ? "compatible" : "blocked"}`,
    },
    {
      label: "Seasonal / turnaround",
      value:
        selected === 2
          ? "Seasonal restriction · limited"
          : "No active restriction",
    },
    {
      label: "Operator exposure",
      value:
        selected === 1
          ? "Lower restricted-corridor exposure"
          : "Moderate · active DG corridor",
    },
  ];
  const saveDecision = () =>
    save.mutate({
      tripId: "TR-2026-000812",
      selectedRoute: selectedRoute.name,
      alternatives: JSON.stringify(alternatives),
      vehicleType,
      gvwTonnes: Math.round(gvw),
      axleCount: axles,
      heightMetres: Math.round(height),
      widthMetres: Math.round(width),
      lengthMetres: Math.round(length),
      hazmatClass,
      quantity,
      riskLevel: risk as "low" | "moderate" | "high" | "blocked",
      source: "Industrial road graph · Northern Alberta",
      confidence: "Imported + driver verified",
      driverAcknowledged: ack ? 1 : 0,
    });
  const checks = useMemo(
    () => [
      {
        label: "GVW / bridge rating",
        ok: gvw <= 42,
        value: `${gvw} t · limit 42 t`,
      },
      {
        label: "Clearance",
        ok: height <= 4.2,
        value: `${height.toFixed(1)} m · limit 4.2 m`,
      },
      {
        label: "Truck access",
        ok: width <= 3.3,
        value: `${width.toFixed(1)} m · route compatible`,
      },
      {
        label: "HazMat corridor",
        ok: true,
        value: "Class 3 · corridor marked",
      },
    ],
    [gvw, height, width]
  );
  return (
    <div>
      <header className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
          Field map · dangerous goods routing
        </p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              Choose the safer road.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Route decisions account for commercial vehicle dimensions, weight,
              axles, HazMat context, clearances, bridges, seasonal restrictions,
              and known road observations.
            </p>
          </div>
          <Badge className="w-fit bg-[#fff0d2] px-3 py-2 text-[#9b722c] hover:bg-[#fff0d2]">
            <ShieldAlert className="mr-2 h-3.5 w-3.5" />
            Human review required
          </Badge>
        </div>
      </header>
      <main className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid gap-6 xl:grid-cols-[.95fr_1.05fr]">
          <Card className="border-[#10243f] bg-[#10243f] text-white shadow-[0_12px_35px_rgba(16,36,63,0.16)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <Map className="h-5 w-5 text-[#ff9c7f]" />
                <CardTitle className="text-[15px] text-white">
                  Live route context
                </CardTitle>
              </div>
              <p className="mt-1 text-xs text-[#aabbd0]">
                {facilityContext || "Northern Alberta"} · JOB-08421 · Class 3
                liquid · 300 bbl
              </p>
            </CardHeader>
            <CardContent className="px-5 pb-5 sm:px-6">
              <div className="relative h-64 overflow-hidden rounded-2xl border border-white/10 bg-[#173454]">
                <div
                  className="absolute inset-0 opacity-60"
                  style={{
                    backgroundImage:
                      "linear-gradient(28deg, transparent 46%, #52749d 47%, #52749d 49%, transparent 50%), linear-gradient(145deg, transparent 40%, #2e9c82 41%, #2e9c82 43%, transparent 44%), linear-gradient(78deg, transparent 67%, #c45448 68%, #c45448 69%, transparent 70%)",
                  }}
                />
                <div className="absolute left-8 top-14 rounded-lg bg-[#e3f6ef] px-2 py-1 text-[10px] font-semibold text-[#238a72]">
                  ORIGIN · LSD 04-12
                </div>
                <div className="absolute left-10 bottom-8 rounded-lg bg-white/90 px-2 py-1 text-[10px] font-semibold text-[#52749d]">
                  DESTINATION · {facilityContext || "DISPOSAL SITE"}
                </div>
                <div className="absolute right-8 bottom-14 rounded-lg bg-[#ffebe7] px-2 py-1 text-[10px] font-semibold text-[#a64e45]">
                  DISPOSAL · SITE A
                </div>
                <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-[#ff6b42] px-3 py-2 text-[10px] font-semibold text-white shadow-lg">
                  <Truck className="h-3.5 w-3.5" />
                  UNIT 247 · ON ROUTE
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Legend label="DG corridor" color="bg-[#c45448]" />
                <Legend label="Verified road" color="bg-[#2e9c82]" />
                <Legend label="User reported" color="bg-[#52749d]" />
                <Legend label="Restricted" color="bg-[#ff6b42]" />
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <CardTitle className="text-[15px] text-[#172033]">
                Vehicle + load constraints
              </CardTitle>
              <p className="mt-1 text-xs text-[#8492a4]">
                The routing engine evaluates this snapshot before recommending
                alternatives.
              </p>
            </CardHeader>
            <CardContent className="grid gap-3 px-5 pb-5 sm:px-6 sm:grid-cols-2">
              {[
                ["GVW tonnes", gvw, setGvw, "42 t bridge limit"],
                ["Axles", axles, setAxles, "commercial combination"],
                ["Height metres", height, setHeight, "4.2 m clearance"],
                ["Width metres", width, setWidth, "3.3 m road limit"],
                ["Length metres", length, setLength, "turnaround context"],
              ].map(([label, value, setter, note]) => (
                <label
                  key={String(label)}
                  className="rounded-xl border border-[#edf0f3] p-3"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                    {label as string}
                  </span>
                  <input
                    type="number"
                    step="0.1"
                    value={value as number}
                    onChange={e =>
                      (setter as (v: number) => void)(Number(e.target.value))
                    }
                    className="mt-2 h-9 w-full rounded-lg border border-[#dfe6ee] px-2 text-sm text-[#52657d] outline-none focus:border-[#52749d]"
                  />
                  <span className="mt-1 block text-[10px] text-[#9aa6b4]">
                    {note as string}
                  </span>
                </label>
              ))}
              <label className="rounded-xl border border-[#edf0f3] p-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                  Vehicle type
                </span>
                <select
                  value={vehicleType}
                  onChange={e => setVehicleType(e.target.value)}
                  className="mt-2 h-9 w-full rounded-lg border border-[#dfe6ee] px-2 text-xs text-[#52657d]"
                >
                  <option>Hydrovac commercial combination</option>
                  <option>Vacuum trailer combination</option>
                  <option>Service truck</option>
                </select>
              </label>
              <label className="rounded-xl border border-[#edf0f3] p-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                  HazMat class
                </span>
                <input
                  value={hazmatClass}
                  onChange={e => setHazmatClass(e.target.value)}
                  className="mt-2 h-9 w-full rounded-lg border border-[#dfe6ee] px-2 text-xs text-[#52657d]"
                />
              </label>
              <label className="rounded-xl border border-[#edf0f3] p-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                  Quantity
                </span>
                <input
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                  className="mt-2 h-9 w-full rounded-lg border border-[#dfe6ee] px-2 text-xs text-[#52657d]"
                />
              </label>
              <label className="rounded-xl border border-[#edf0f3] p-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                  Placard status
                </span>
                <select
                  value={placard}
                  onChange={e => setPlacard(e.target.value)}
                  className="mt-2 h-9 w-full rounded-lg border border-[#dfe6ee] px-2 text-xs text-[#52657d]"
                >
                  <option>Required · verified</option>
                  <option>Required · review</option>
                  <option>Not required</option>
                </select>
              </label>
              <div className="rounded-xl border border-[#f2d5d1] bg-[#fff7f6] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a87872]">
                  Material on board
                </p>
                <p className="mt-1 text-xs font-semibold text-[#773d38]">
                  Class 3 liquid · UN source verified
                </p>
                <p className="mt-1 text-[10px] text-[#a87872]">
                  Paper shipping document remains required where configured.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Route alternatives
                </CardTitle>
                <p className="mt-1 text-xs text-[#8492a4]">
                  Back roads are compared by operator exposure, not just elapsed
                  time.
                </p>
              </div>
              <Navigation className="h-5 w-5 text-[#52749d]" />
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              {alternatives.map((route, i) => (
                <button
                  key={route.name}
                  onClick={() => setSelected(i)}
                  className={`w-full rounded-xl border p-4 text-left transition ${selected === i ? "border-[#ff6b42] shadow-[0_0_0_2px_rgba(255,107,66,0.12)]" : "border-[#edf0f3]"}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-[#52657d]">
                        {route.name}
                      </p>
                      <p className="mt-1 text-[11px] text-[#8492a4]">
                        {route.note}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-[#172033]">
                        {route.time}
                      </p>
                      <Badge
                        className={
                          route.risk === "low"
                            ? "bg-[#e3f6ef] text-[#238a72]"
                            : route.risk === "moderate"
                              ? "bg-[#e8f0fb] text-[#52749d]"
                              : "bg-[#fff0d2] text-[#9b722c]"
                        }
                      >
                        {route.risk} exposure
                      </Badge>
                    </div>
                  </div>
                </button>
              ))}
              <div className="grid gap-2 pt-2 sm:grid-cols-2">
                {tradeoffs.map(item => (
                  <div
                    key={item.label}
                    className="rounded-lg bg-[#f7f9fb] px-3 py-2 text-[11px] text-[#52657d]"
                  >
                    <span className="font-semibold">{item.label}</span>
                    <span className="ml-1 text-[#8492a4]">{item.value}</span>
                  </div>
                ))}
                {checks.map(check => (
                  <div
                    key={check.label}
                    className="flex items-center gap-2 rounded-lg bg-[#f7f9fb] px-3 py-2 text-[11px] text-[#52657d]"
                  >
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full ${check.ok ? "bg-[#e3f6ef] text-[#238a72]" : "bg-[#ffebe7] text-[#c45448]"}`}
                    >
                      <Check className="h-3 w-3" />
                    </span>
                    <span>
                      {check.label}
                      <b className="ml-1 font-semibold">{check.value}</b>
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <CardTitle className="text-[15px] text-[#254e46]">
                Driver route acknowledgement
              </CardTitle>
              <p className="mt-1 text-xs text-[#729189]">
                Persist the selected route and the constraint snapshot for the
                trip record.
              </p>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              <div className="rounded-xl border border-[#cfe8dd] bg-white p-4">
                <p className="text-xs font-semibold text-[#527c70]">
                  Selected: {selectedRoute.name}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[#729189]">
                  {blocked
                    ? "No verified route meets the current vehicle constraints. Escalate to dispatch."
                    : "Back-road alternative reduces restricted corridor exposure while adding 18 minutes."}
                </p>
              </div>
              <label className="flex items-start gap-2 rounded-xl border border-[#cfe8dd] bg-white p-3 text-[11px] text-[#527c70]">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={e => setAck(e.target.checked)}
                  className="mt-0.5"
                />
                I reviewed vehicle, load, road, bridge, clearance, and HazMat
                restrictions for this route.
              </label>
              <Button
                disabled={!ack || blocked}
                onClick={saveDecision}
                className="h-10 w-full rounded-xl bg-[#2e9c82] text-xs text-white hover:bg-[#25846f] disabled:opacity-50"
              >
                <Gauge className="mr-2 h-4 w-4" />
                Save route decision
              </Button>
              <p className="text-center text-[10px] text-[#8aa79f]">
                {decisions?.length || 0} route decisions retained · source +
                confidence recorded
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
function Legend({ label, color }: { label: string; color: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 text-[10px] text-[#d8e3ef]">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
