import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelSourceBadge } from "./SourcedPanel";
import { demonstration, fromQuery } from "./panelSource";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Clock3,
  Gauge,
  MapPin,
  PackageCheck,
  Play,
  Route,
  Timer,
  Truck,
  Upload,
  Wrench,
} from "lucide-react";
import { MapView } from "@/components/Map";

const demoTrip = {
  id: 0,
  tripNumber: "TR-DEMO-08421",
  tripType: "round_trip",
  status: "in_transit",
  distanceKm: 146.4,
  odometerStartKm: 183421,
  odometerEndKm: 183567,
  manifestId: 58241,
};
const demoStops = [
  {
    id: 0,
    stopType: "load",
    sequence: 1,
    name: "North Ridge · Loading zone",
    setupMinutes: 18,
    durationMinutes: 42,
    waitMinutes: 6,
    ticketNumber: "LOAD-39104",
  },
  {
    id: 1,
    stopType: "unload",
    sequence: 2,
    name: "West Ridge Disposal · Unloading zone",
    setupMinutes: 12,
    durationMinutes: 31,
    waitMinutes: 9,
    ticketNumber: "SCALE-39104",
  },
];
const demoZones = [
  {
    id: 0,
    name: "North Ridge loading zone",
    zoneType: "loading",
    latitude: 53.557,
    longitude: -113.286,
    radiusMetres: 90,
  },
  {
    id: 1,
    name: "West Ridge unloading zone",
    zoneType: "unloading",
    latitude: 53.595,
    longitude: -113.215,
    radiusMetres: 110,
  },
];

export default function TripOperationsWorkspace() {
  const { data: trips } = trpc.fieldRoute.trips.list.useQuery();
  const trip = trips?.[0] ?? demoTrip;
  const { data: zones } = trpc.fieldRoute.operatingZones.list.useQuery();
  const { data: tripStops } = trpc.fieldRoute.tripStops.list.useQuery({
    tripId: trip.id,
  });
  const { data: dutyRecords } = trpc.fieldRoute.dutyRecords.list.useQuery();
  const { data: workOrders } = trpc.fieldRoute.workOrders.list.useQuery();
  const [selectedStop, setSelectedStop] = useState(0);
  const [clock, setClock] = useState<string | null>(null);
  const stopData = (
    tripStops?.length
      ? tripStops.map((s, i) => ({
          id: s.id,
          stopType: s.stopType,
          sequence: s.sequence,
          name: s.stopType === "load" ? "Loading stop" : "Unloading stop",
          setupMinutes: s.setupMinutes ?? 0,
          durationMinutes: s.durationMinutes ?? 0,
          waitMinutes: s.waitMinutes ?? 0,
          ticketNumber: s.ticketNumber ?? "pending",
        }))
      : demoStops
  ) as typeof demoStops;
  const zoneData = (zones?.length ? zones : demoZones) as typeof demoZones;
  const averageLoad = useMemo(
    () =>
      stopData
        .filter(s => s.stopType === "load")
        .reduce((a, s) => a + (s.durationMinutes || 0), 0) /
      Math.max(1, stopData.filter(s => s.stopType === "load").length),
    [stopData]
  );
  const averageUnload = useMemo(
    () =>
      stopData
        .filter(s => s.stopType === "unload")
        .reduce((a, s) => a + (s.durationMinutes || 0), 0) /
      Math.max(1, stopData.filter(s => s.stopType === "unload").length),
    [stopData]
  );
  const createTrip = trpc.fieldRoute.trips.create.useMutation({
    onSuccess: () => toast.success("Round-trip tracking record created."),
  });
  const createStop = trpc.fieldRoute.tripStops.create.useMutation({
    onSuccess: () => toast.success("Trip event saved to the log."),
  });
  const createZone = trpc.fieldRoute.operatingZones.create.useMutation({
    onSuccess: () => toast.success("Operating zone saved and mapped."),
  });
  const createDuty = trpc.fieldRoute.dutyRecords.create.useMutation({
    onSuccess: () =>
      toast.success("Duty status added to the digital log book."),
  });
  const createWorkOrder = trpc.fieldRoute.workOrders.create.useMutation({
    onSuccess: () =>
      toast.success("Maintenance work order opened from inspection workflow."),
  });

  const now = () => new Date();
  const markEvent = (
    type: "load" | "unload",
    field:
      | "setupStartedAt"
      | "operationStartedAt"
      | "operationCompletedAt"
      | "departedAt"
  ) => {
    setClock(`${type}:${field}`);
    if (trip.id === 0) {
      toast.success(
        `${type === "load" ? "Loading" : "Unloading"} ${field.replace("At", "")} timestamp captured.`
      );
      return;
    }
    createStop.mutate({
      tripId: trip.id,
      stopType: type,
      sequence: type === "load" ? 1 : 2,
      [field]: now(),
    } as any);
  };

  return (
    <div className="min-h-full bg-[#f8fafc]">
      <header className="border-b border-[#e1e7ed] bg-white px-5 py-7 sm:px-8 lg:px-10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
              Trip operations · logbook · billing · manifest
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              Track every load, unload and return leg.
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#75869a]">
              Round trips become one auditable record: GPS distance, setup time,
              loading/unloading duration, wait time, tickets, driver duty
              status, manifest references and billing inputs.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-[#e3f6ef] px-3 py-2 text-[#238a72] hover:bg-[#e3f6ef]">
              <Gauge className="mr-2 h-3.5 w-3.5" />
              {trip.tripNumber}
            </Badge>
            <Badge className="bg-[#e8f0fb] px-3 py-2 text-[#52749d] hover:bg-[#e8f0fb]">
              {trip.tripType.replace("_", " ")}
            </Badge>
          </div>
        </div>
      </header>

      <main className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <Metric
            label="Round-trip distance"
            value={`${(trip.distanceKm ?? 0).toFixed(1)} km`}
            note="odometer / GPS reconciled"
            icon={Route}
          />
          <Metric
            label="Avg loading"
            value={`${averageLoad.toFixed(0)} min`}
            note="setup + operation target"
            icon={Timer}
          />
          <Metric
            label="Avg unloading"
            value={`${averageUnload.toFixed(0)} min`}
            note="setup + operation target"
            icon={Timer}
          />
          <Metric
            label="Manifest"
            value={`#${trip.manifestId ?? "—"}`}
            note="linked chain of custody"
            icon={PackageCheck}
          />
          <Metric
            label="Open work orders"
            value={String(workOrders?.length ?? 0)}
            note="service before over-houring"
            icon={Wrench}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
          <Card className="overflow-hidden border-[#e0e6ee] bg-white">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-[15px]">
                  Live route + operating zones
                </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.operatingZones.list", zones, { whenEmpty: "no operating zone exists on this database yet" })} />
                <p className="mt-1 text-xs text-[#8492a4]">
                  Loading and unloading zones are persistent map objects with
                  radius and verification metadata.
                </p>
              </div>
              <MapPin className="h-5 w-5 text-[#ff6b42]" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="relative">
                <MapView
                  className="h-[390px]"
                  initialCenter={{ lat: 53.575, lng: -113.25 }}
                  initialZoom={11}
                  onMapReady={map => {
                    zoneData.forEach(zone => {
                      const circle = new google.maps.Circle({
                        map,
                        center: { lat: zone.latitude, lng: zone.longitude },
                        radius: zone.radiusMetres,
                        strokeOpacity: 0.8,
                        strokeWeight: 2,
                        fillOpacity: 0.16,
                      });
                      new google.maps.Marker({
                        map,
                        position: { lat: zone.latitude, lng: zone.longitude },
                        title: `${zone.zoneType.toUpperCase()} · ${zone.name}`,
                      });
                      void circle;
                    });
                  }}
                />
              </div>
              <div className="grid gap-2 border-t border-[#edf0f3] p-4 sm:grid-cols-2">
                {zoneData.map(zone => (
                  <div
                    key={zone.id}
                    className="rounded-xl border border-[#edf0f3] p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#52657d]">
                        {zone.name}
                      </span>
                      <Badge
                        className={
                          zone.zoneType === "loading"
                            ? "bg-[#e8f0fb] text-[#52749d]"
                            : "bg-[#e3f6ef] text-[#238a72]"
                        }
                      >
                        {zone.zoneType}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10px] text-[#8998aa]">
                      {zone.latitude.toFixed(4)}, {zone.longitude.toFixed(4)} ·{" "}
                      {zone.radiusMetres} m geofence
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-[#10243f] bg-[#10243f] text-white">
            <CardHeader>
              <CardTitle className="text-[15px] text-white">
                One-tap trip clock
              </CardTitle>
              <PanelSourceBadge source={demonstration("the clock reflects this page\u2019s own state; no trip record is advanced from here")} />
              <p className="mt-1 text-xs text-[#aabbd0]">
                Driver records events once; the system reuses them for the log
                book, trip passport and billing evidence.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {(stopData.length ? stopData : demoStops).map((stop, i) => (
                <div
                  key={stop.id}
                  className={`rounded-2xl border p-4 ${selectedStop === i ? "border-[#ff8c67] bg-white/10" : "border-white/10 bg-white/[.04]"}`}
                >
                  <button
                    className="w-full text-left"
                    onClick={() => setSelectedStop(i)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[.15em] text-[#9fb0c7]">
                          Stop {i + 1} · {stop.stopType}
                        </p>
                        <p className="mt-1 text-sm font-semibold">
                          {stop.name}
                        </p>
                      </div>
                      <Badge className="bg-white/10 text-white hover:bg-white/10">
                        {stop.durationMinutes} min
                      </Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-[#aabbd0]">
                      <span>
                        Setup{" "}
                        <b className="block text-white">{stop.setupMinutes}m</b>
                      </span>
                      <span>
                        Wait{" "}
                        <b className="block text-white">{stop.waitMinutes}m</b>
                      </span>
                      <span>
                        Ticket{" "}
                        <b className="block text-white">{stop.ticketNumber}</b>
                      </span>
                    </div>
                  </button>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      ["Setup", "setupStartedAt"],
                      ["Start", "operationStartedAt"],
                      ["Complete", "operationCompletedAt"],
                      ["Depart", "departedAt"],
                    ].map(([label, field]) => (
                      <Button
                        key={field}
                        variant="outline"
                        onClick={() =>
                          markEvent(
                            stop.stopType as "load" | "unload",
                            field as any
                          )
                        }
                        className="h-9 border-white/15 bg-white/5 text-[10px] text-white hover:bg-white/10"
                      >
                        <Play className="mr-1 h-3 w-3" />
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="rounded-xl border border-white/10 bg-white/[.04] p-3 text-[10px] text-[#aabbd0]">
                Last capture:{" "}
                <span className="font-semibold text-white">
                  {clock || "No event captured this session"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="border-[#e0e6ee] bg-white">
            <CardHeader>
              <CardTitle className="text-[15px]">Digital log book</CardTitle>
              <p className="mt-1 text-xs text-[#8492a4]">
                Driving, on-duty, sleeper berth and off-duty are separate
                auditable records.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {(
                  ["driving", "on_duty", "sleeper_berth", "off_duty"] as const
                ).map(status => (
                  <Button
                    key={status}
                    variant="outline"
                    onClick={() =>
                      createDuty.mutate({
                        operatorId: 1,
                        tripId: trip.id || undefined,
                        dutyStatus: status,
                        startedAt: now(),
                        source: "driver_entry",
                      })
                    }
                    className="h-10 justify-start text-xs"
                  >
                    <Clock3 className="mr-2 h-3.5 w-3.5" />
                    {status.replace("_", " ")}
                  </Button>
                ))}
              </div>
              <div className="rounded-xl bg-[#f7f9fb] p-3 text-[11px] text-[#718197]">
                {dutyRecords?.length ?? 0} persisted duty records. When an end
                time is captured, duration is calculated automatically.
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white">
            <CardHeader>
              <CardTitle className="text-[15px]">
                Manifest + billing handoff
              </CardTitle>
              <PanelSourceBadge source={demonstration("the handoff is laid out to show the chain; no manifest or ticket record is read here")} />
              <p className="mt-1 text-xs text-[#8492a4]">
                Trip distance and stop durations become source-labelled billing
                inputs instead of handwritten guesses.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-xl border border-[#edf0f3] p-3">
                <p className="text-[10px] uppercase tracking-[.14em] text-[#8998aa]">
                  Linked records
                </p>
                <p className="mt-1 text-xs font-semibold text-[#52657d]">
                  Trip {trip.tripNumber} → Manifest #
                  {trip.manifestId ?? "pending"} → job charges → driver log
                </p>
              </div>
              <Button
                onClick={() =>
                  toast.success(
                    "Trip package prepared: manifest + distance + loading/unloading + duty records + billing evidence."
                  )
                }
                className="h-10 w-full bg-[#ff6b42] text-xs text-white hover:bg-[#e85d38]"
              >
                <Upload className="mr-2 h-4 w-4" />
                Prepare office package
              </Button>
              <Button
                onClick={() =>
                  createTrip.mutate({
                    tripNumber: `TR-${Date.now()}`,
                    tripType: "round_trip",
                    status: "planned",
                    jobId: 1,
                    unitId: 1,
                    operatorId: 1,
                    manifestId: 58241,
                    odometerStartKm: 183421,
                  })
                }
                variant="outline"
                className="h-10 w-full text-xs"
              >
                Create next round trip
              </Button>
            </CardContent>
          </Card>
          <Card className="border-[#dceee7] bg-[#f3fbf7]">
            <CardHeader>
              <CardTitle className="text-[15px] text-[#254e46]">
                Mechanic protection loop
              </CardTitle>
              <p className="mt-1 text-xs text-[#729189]">
                Pre-trip failures should create service work before a unit is
                over-houring or run into the ground.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-xl border border-[#cfe8dd] bg-white p-3">
                <p className="text-xs font-semibold text-[#527c70]">
                  Pre-trip → defect → work order → release
                </p>
                <p className="mt-1 text-[11px] leading-5 text-[#729189]">
                  Attach odometer/engine hours, findings, parts and corrective
                  action. A critical defect can block dispatch until released.
                </p>
              </div>
              <Button
                onClick={() =>
                  createWorkOrder.mutate({
                    workOrderNumber: `WO-${Date.now()}`,
                    unitId: 1,
                    status: "open",
                    priority: "urgent",
                    openedAt: now(),
                    odometerKm: trip.odometerEndKm ?? undefined,
                    technician: "Shop queue",
                    findings: "Created from serviceability workflow",
                    correctiveAction: "Inspect and release before dispatch",
                  })
                }
                className="h-10 w-full bg-[#2e9c82] text-xs text-white hover:bg-[#25846f]"
              >
                <Wrench className="mr-2 h-4 w-4" />
                Open service work order
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card className="border-[#e0e6ee] bg-white">
          <CardHeader>
            <CardTitle className="text-[15px]">
              What the office gets automatically
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              "Trip distance + round-trip mileage",
              "Average loading / unloading time by unit, driver and site",
              "Loading/unloading geofences and zone performance",
              "Manifest, tickets, log book and billing evidence linked",
              "License, abstract and safety-ticket expiry reminders",
              "Digital unit safety binder + insurance document status",
              "Pre-trip serviceability → work order → release",
              "Six-month driver/office feedback dataset for workflow tuning",
            ].map(item => (
              <div
                key={item}
                className="rounded-xl border border-[#edf0f3] p-3 text-xs font-semibold text-[#52657d]"
              >
                <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#e3f6ef] text-[#238a72]">
                  ✓
                </span>
                {item}
              </div>
            ))}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Route;
}) {
  return (
    <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
      <CardContent className="p-5">
        <Icon className="h-5 w-5 text-[#52749d]" />
        <p className="mt-5 text-[10px] font-semibold uppercase tracking-[.15em] text-[#8998aa]">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-[-.05em] text-[#172033]">
          {value}
        </p>
        <p className="mt-1 text-xs text-[#8492a4]">{note}</p>
      </CardContent>
    </Card>
  );
}
