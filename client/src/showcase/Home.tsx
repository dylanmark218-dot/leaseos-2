import { MapView } from "@/components/Map";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelSourceBadge } from "./SourcedPanel";
import { demonstration, fromQuery } from "./panelSource";
import { startQuickCapture } from "@/portal/QuickCapture";
import { quickCaptureActions, type QuickCaptureAction } from "@/portal/viewModels";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BatteryMedium,
  BriefcaseBusiness,
  Bell,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  ClipboardCheck,
  CloudOff,
  Compass,
  Crosshair,
  Eye,
  FileCheck2,
  FileText,
  Filter,
  Gauge,
  HardHat,
  Layers3,
  MapPin,
  Mic,
  MoreHorizontal,
  Navigation,
  PackageCheck,
  Pause,
  Phone,
  Play,
  Plus,
  Radio,
  Ruler,
  Route,
  Search,
  ShieldAlert,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
  Timer,
  Truck,
  Upload,
  UserRound,
  Warehouse,
  Wifi,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

/**
 * HS1 (SPINE item 3): the showcase opens no camera or file picker of its own. Its capture buttons hand
 * the same actions Quick Capture uses to the field runtime — gated by the device's capabilities — or,
 * with no runtime, to the authoritative evidence surface. (Its old private upload was refused by the
 * showcase write guard anyway.)
 */
const SHOWCASE_CAPTURE: Record<"photo" | "document", QuickCaptureAction> = {
  photo: quickCaptureActions("field_workforce").find(a => a.key === "photo")!,
  document: { key: "document", label: "Document", kind: "scanned_document", formKey: null, category: "document", needsPhoto: true, needsVoice: false },
};

const jobs = [
  {
    id: "JOB-08421",
    mode: "hydrovac",
    type: "Hydrovac disposal",
    location: "14-22 W5 / North Ridge",
    customer: "Northline Energy",
    vehicle: "Hydrovac 42",
    status: "In transit",
    eta: "09:40",
    progress: 66,
    tone: "orange",
    driver: "MP",
  },
  {
    id: "JOB-08420",
    mode: "transport",
    type: "Water transfer",
    location: "Horizon pad 07",
    customer: "Crestfield Resources",
    vehicle: "Tanker 18",
    status: "Loading",
    eta: "10:15",
    progress: 42,
    tone: "blue",
    driver: "JS",
  },
  {
    id: "JOB-08419",
    mode: "general",
    type: "Lease access check",
    location: "03-14 W5 / Elk Creek",
    customer: "Redwood Operating",
    vehicle: "Scout 03",
    status: "On site",
    eta: "Complete",
    progress: 88,
    tone: "green",
    driver: "AL",
  },
  {
    id: "JOB-08416",
    mode: "recovery",
    type: "Waste manifest pickup",
    location: "West disposal facility",
    customer: "Mosaic Field Services",
    vehicle: "Vac 27",
    status: "Awaiting docs",
    eta: "11:30",
    progress: 24,
    tone: "slate",
    driver: "KD",
  },
] as const;

const procedureSteps = {
  hydrovac: [
    "Utility locate confirmed",
    "Work authorization and PPE",
    "Volume and load tracking",
    "Disposal ticket and sign-off",
  ],
  recovery: [
    "Dispatch and CAD details",
    "Condition photos captured",
    "Tow authorization confirmed",
    "Impound gate pass and release",
  ],
  transport: [
    "Vehicle and cargo check",
    "Route restrictions reviewed",
    "Load / unload evidence",
    "Proof of delivery signed",
  ],
  general: [
    "Pre-job safety review",
    "Confirm access and route",
    "Capture field evidence",
    "Customer sign-off",
  ],
} as const;

const mapMarkers = [
  {
    id: "lease",
    label: "14-22 W5",
    type: "Lease",
    lat: 53.557,
    lng: -113.286,
    color: "#ff6b42",
  },
  {
    id: "job",
    label: "JOB-08421",
    type: "Active job",
    lat: 53.574,
    lng: -113.243,
    color: "#2e9c82",
  },
  {
    id: "facility",
    label: "North disposal",
    type: "Facility",
    lat: 53.595,
    lng: -113.215,
    color: "#466c97",
  },
];

type OfflineSnapshot = {
  region: string;
  savedAt: string;
  route: Array<{ lat: number; lng: number }>;
  markers: typeof mapMarkers;
};

const offlineSnapshotSeed: OfflineSnapshot = {
  region: "North Ridge operating area",
  savedAt: "",
  route: [
    { lat: 53.545, lng: -113.335 },
    { lat: 53.557, lng: -113.286 },
    { lat: 53.574, lng: -113.243 },
    { lat: 53.595, lng: -113.215 },
  ],
  markers: mapMarkers,
};

const OFFLINE_SNAPSHOT_KEY = "leaseos-north-ridge-offline-snapshot";

const evidence = [
  {
    id: "EV-2218",
    title: "Disposal ticket · JOB-08421",
    category: "Disposal ticket",
    time: "08:31",
    date: "Today",
    status: "Needs review",
    initials: "MP",
    color: "#ff6b42",
    detail: "West Ridge Disposal · Scale ticket 39104 · 18.4 m³",
  },
  {
    id: "EV-2217",
    title: "Pre-trip inspection · Hydrovac 42",
    category: "DVIR",
    time: "07:05",
    date: "Today",
    status: "Verified",
    initials: "MP",
    color: "#2e9c82",
    detail: "No defects reported · 12 inspection points complete",
  },
  {
    id: "EV-2216",
    title: "Road condition report · County 214",
    category: "Road hazard",
    time: "06:42",
    date: "Today",
    status: "Unverified",
    initials: "AL",
    color: "#d08b36",
    detail: "Soft shoulder near km 18 · passable for one truck",
  },
  {
    id: "EV-2212",
    title: "Customer signature · Horizon pad 07",
    category: "Signed record",
    time: "Yesterday",
    date: "Aug 26",
    status: "Verified",
    initials: "JS",
    color: "#466c97",
    detail: "Crestfield Resources · Field ticket 08420",
  },
];

const complianceEvents = [
  {
    time: "08:31",
    title: "Disposal ticket attached",
    detail: "West Ridge Disposal · Scale ticket 39104",
    icon: FileCheck2,
    tone: "green",
  },
  {
    time: "07:05",
    title: "DVIR completed",
    detail: "Hydrovac 42 · 12 inspection points",
    icon: ClipboardCheck,
    tone: "blue",
  },
  {
    time: "06:42",
    title: "Road condition reported",
    detail: "County 214 · soft shoulder · unverified",
    icon: AlertTriangle,
    tone: "amber",
  },
  {
    time: "06:15",
    title: "Shift started",
    detail: "Driver MP · Edmonton field office",
    icon: Activity,
    tone: "slate",
  },
];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 border-b border-[#e0e6ee] bg-[#f6f8fb] px-5 py-7 sm:px-8 lg:flex-row lg:items-end lg:justify-between lg:px-10">
      <div>
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#7990aa]">
          <span>Operations</span>
          <ChevronRight className="h-3 w-3" />
          <span>{eyebrow}</span>
        </div>
        <h1 className="text-[30px] font-semibold tracking-[-0.055em] text-[#172033] sm:text-[36px]">
          {title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#6d7d93]">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function StatusPill({
  status,
  tone = "slate",
}: {
  status: string;
  tone?: "green" | "orange" | "blue" | "amber" | "slate" | "red";
}) {
  const styles = {
    green: "bg-[#e3f6ef] text-[#147b64]",
    orange: "bg-[#fff0ea] text-[#ce5736]",
    blue: "bg-[#e8f0fb] text-[#466c97]",
    amber: "bg-[#fff5df] text-[#9a6d24]",
    slate: "bg-[#eef2f6] text-[#64748b]",
    red: "bg-[#fee9e8] text-[#bd4141]",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        styles[tone]
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function MetricCard({
  label,
  value,
  note,
  trend,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  trend?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "orange" | "blue" | "green" | "amber";
}) {
  const colors = {
    orange: "bg-[#fff0ea] text-[#e25d39]",
    blue: "bg-[#e9f0fb] text-[#52749d]",
    green: "bg-[#e3f6ef] text-[#208b72]",
    amber: "bg-[#fff4dc] text-[#ae7925]",
  };
  return (
    <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div
            className={cx(
              "flex h-10 w-10 items-center justify-center rounded-xl",
              colors[tone]
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
          </div>
          {trend && (
            <span className="flex items-center gap-1 text-[11px] font-semibold text-[#2e9c82]">
              <ArrowUpRight className="h-3.5 w-3.5" />
              {trend}
            </span>
          )}
        </div>
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8190a5]">
          {label}
        </p>
        <p className="mt-1 text-[29px] font-semibold tracking-[-0.06em] text-[#172033]">
          {value}
        </p>
        <p className="mt-1 text-xs text-[#8a98aa]">{note}</p>
      </CardContent>
    </Card>
  );
}

function MiniMap({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="relative h-full min-h-[330px] overflow-hidden rounded-[20px] bg-[#dbe7e3]">
      <div
        className="absolute inset-0 opacity-80"
        style={{
          backgroundImage:
            "linear-gradient(35deg, transparent 0 22%, rgba(255,255,255,.75) 22.5% 23%, transparent 23.5% 48%, rgba(255,255,255,.7) 48.5% 49%, transparent 49.5%), linear-gradient(120deg, transparent 0 29%, rgba(255,255,255,.65) 29.5% 30%, transparent 30.5% 70%, rgba(255,255,255,.6) 70.5% 71%, transparent 71.5%), repeating-linear-gradient(90deg, rgba(102,145,137,.11) 0 1px, transparent 1px 56px), repeating-linear-gradient(0deg, rgba(102,145,137,.11) 0 1px, transparent 1px 56px)",
        }}
      />
      <div className="absolute left-[20%] top-[42%] h-[2px] w-[65%] rotate-[-17deg] bg-[#f26b45] shadow-[0_0_0_2px_rgba(255,255,255,.7)]" />
      <div className="absolute left-[48%] top-[28%] h-[46%] w-[2px] rotate-[32deg] bg-[#f26b45]/80" />
      <div className="absolute left-[58%] top-[38%] flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-white bg-[#ff6b42] shadow-lg">
        <Truck className="h-4 w-4 text-white" />
      </div>
      <div className="absolute left-[29%] top-[59%] flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-white bg-[#2e9c82] shadow-md">
        <MapPin className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="absolute left-[73%] top-[23%] flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-white bg-[#466c97] shadow-md">
        <Warehouse className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="absolute left-4 top-4 rounded-lg bg-white/90 px-3 py-2 text-xs font-semibold text-[#172033] shadow-sm backdrop-blur">
        North Ridge operating area
      </div>
      <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2 text-[11px] font-medium text-[#5e7189] shadow-sm backdrop-blur">
        <span className="h-2 w-2 rounded-full bg-[#2e9c82]" />
        Live vehicle track <span className="mx-1 text-[#d2dae4]">•</span> 4
        markers
      </div>
      <button
        onClick={onOpen}
        className="absolute right-4 top-4 flex items-center gap-2 rounded-lg bg-[#10243f] px-3 py-2 text-[11px] font-semibold text-white shadow-lg transition hover:bg-[#1c385b]"
      >
        <Compass className="h-3.5 w-3.5" />
        Open field map
      </button>
    </div>
  );
}

function Overview() {
  const [, setLocation] = useLocation();
  const [activeMode, setActiveMode] = useState("All operations");
  const [alertOpen, setAlertOpen] = useState(true);
  return (
    <div>
      <PageHeader
        eyebrow="Today · Wed, Aug 27, 2026"
        title="Good morning, Morgan."
        description="Your operating picture is current. Four crews are moving across the North Ridge region."
        action={
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() =>
                toast.success(
                  "Date range picker is ready for your operating window."
                )
              }
              className="h-10 rounded-xl border-[#d8e0e9] bg-white text-[#52657d]"
            >
              <CalendarDays className="mr-2 h-4 w-4" />
              Today <ChevronDown className="ml-2 h-3.5 w-3.5" />
            </Button>
            <Button
              onClick={() => {
                setLocation("/jobs");
                toast.success("New job workspace opened.");
              }}
              className="h-10 rounded-xl bg-[#ff6b42] px-4 font-semibold text-white shadow-lg shadow-[#ff6b42]/15 hover:bg-[#e85d38]"
            >
              <Plus className="mr-2 h-4 w-4" />
              Create job
            </Button>
          </div>
        }
      />
      <div className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-[#2e9c82]" />
            <span className="text-sm font-semibold text-[#31435a]">
              Live operations
            </span>
            <span className="text-xs text-[#8a98aa]">
              Last synced 2 min ago
            </span>
          </div>
          <Tabs
            value={activeMode}
            onValueChange={setActiveMode}
            className="w-full sm:w-auto"
          >
            <TabsList className="grid h-9 w-full grid-cols-3 rounded-lg bg-[#e9eef4] p-1 sm:w-[370px]">
              <TabsTrigger
                value="All operations"
                className="rounded-md text-xs data-[state=active]:bg-white data-[state=active]:text-[#172033] data-[state=active]:shadow-sm"
              >
                All operations
              </TabsTrigger>
              <TabsTrigger
                value="Hydrovac"
                className="rounded-md text-xs data-[state=active]:bg-white data-[state=active]:text-[#172033] data-[state=active]:shadow-sm"
              >
                Hydrovac
              </TabsTrigger>
              <TabsTrigger
                value="Recovery"
                className="rounded-md text-xs data-[state=active]:bg-white data-[state=active]:text-[#172033] data-[state=active]:shadow-sm"
              >
                Recovery
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Active jobs"
            value="12"
            note="3 need attention"
            trend="8.4%"
            icon={BriefcaseIcon}
            tone="orange"
          />
          <MetricCard
            label="In transit"
            value="07"
            note="Across 4 operating zones"
            trend="2.1%"
            icon={Navigation}
            tone="blue"
          />
          <MetricCard
            label="On-time rate"
            value="94.2%"
            note="This week · 58 trips"
            trend="3.8%"
            icon={Gauge}
            tone="green"
          />
          <MetricCard
            label="Safety signals"
            value="03"
            note="1 unverified report"
            icon={ShieldAlert}
            tone="amber"
          />
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.22fr_.78fr]">
          <Card className="overflow-hidden border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between border-b border-[#e9edf2] px-5 py-4 sm:px-6">
              <div>
                <CardTitle className="text-[15px] font-semibold text-[#172033]">
                  Live field picture
                </CardTitle>
              <PanelSourceBadge source={demonstration("this overview reads no records; the fleet picture is the demonstration layout")} />
                <p className="mt-1 text-xs text-[#8492a5]">
                  Vehicles, active routes, and key operating locations
                </p>
              </div>
              <button
                onClick={() => setLocation("/map")}
                className="text-xs font-semibold text-[#e45e3b] hover:text-[#b7462c]"
              >
                View full map <ArrowRight className="ml-1 inline h-3.5 w-3.5" />
              </button>
            </CardHeader>
            <CardContent className="p-3">
              <MiniMap onOpen={() => setLocation("/map")} />
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-4 sm:px-6">
              <div>
                <CardTitle className="text-[15px] font-semibold text-[#172033]">
                  Signals that need you
                </CardTitle>
              <PanelSourceBadge source={demonstration("the overview signals are the demonstration layout; the safety workspace below reads the real events")} />
                <p className="mt-1 text-xs text-[#8492a5]">
                  Priority items from the field
                </p>
              </div>
              <button
                onClick={() => setAlertOpen(!alertOpen)}
                className="rounded-lg p-2 text-[#91a0b3] transition hover:bg-[#f2f5f8] hover:text-[#172033]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </CardHeader>
            <CardContent className="px-5 pb-5 sm:px-6">
              {alertOpen ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-[#f8dfc0] bg-[#fffaf0] p-4">
                    <div className="flex gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ffefd2] text-[#b47722]">
                        <AlertTriangle className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm font-semibold text-[#3b4655]">
                            Road condition report
                          </p>
                          <button
                            onClick={() => setAlertOpen(false)}
                            className="text-[#b9a27b] hover:text-[#8e6b2e]"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-[#7c7467]">
                          Soft shoulder on County 214, km 18. Passable for one
                          truck.
                        </p>
                        <div className="mt-3 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a5875a]">
                          <span>Reported by AL · 06:42</span>
                          <button
                            className="normal-case tracking-normal text-[#bb762d]"
                            onClick={() => setLocation("/map")}
                          >
                            Review on map{" "}
                            <ArrowRight className="ml-1 inline h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-xl border border-[#e8edf2] bg-[#fafcfd] p-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#e8f0fb] text-[#52749d]">
                      <CloudOff className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#3b4655]">
                        Offline pack is aging
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[#7d8a9c]">
                        North Ridge map pack last updated 3 days ago.
                      </p>
                    </div>
                    <ChevronRight className="ml-auto h-4 w-4 text-[#a6b2c2]" />
                  </div>
                  <div className="flex items-center gap-3 rounded-xl border border-[#e8edf2] bg-[#fafcfd] p-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#e3f6ef] text-[#238a72]">
                      <FileCheck2 className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#3b4655]">
                        3 documents to review
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[#7d8a9c]">
                        Evidence from the morning shift is ready.
                      </p>
                    </div>
                    <button
                      onClick={() => setLocation("/evidence")}
                      className="ml-auto text-[#a6b2c2] hover:text-[#e45e3b]"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center py-9 text-center">
                  <CheckCircle2 className="h-8 w-8 text-[#2e9c82]" />
                  <p className="mt-3 text-sm font-semibold text-[#3b4655]">
                    You are all caught up
                  </p>
                  <p className="mt-1 text-xs text-[#8593a5]">
                    No new signals in this view.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.3fr_.7fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-4 sm:px-6">
              <div>
                <CardTitle className="text-[15px] font-semibold text-[#172033]">
                  Active work
                </CardTitle>
              <PanelSourceBadge source={demonstration("JOB-08421 and its companions are demonstration jobs; no job record is read on this page")} />
                <p className="mt-1 text-xs text-[#8492a5]">
                  A glance at every crew currently in motion
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setLocation("/jobs")}
                className="h-8 rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                All jobs <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Button>
            </CardHeader>
            <CardContent className="px-5 pb-2 sm:px-6">
              <div className="hidden grid-cols-[1.25fr_1fr_.8fr_.7fr] gap-3 border-y border-[#eef1f4] py-3 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#95a1b0] sm:grid">
                <span>Job</span>
                <span>Location</span>
                <span>Status</span>
                <span>ETA</span>
              </div>
              {jobs.slice(0, 3).map(job => (
                <button
                  key={job.id}
                  onClick={() => setLocation("/jobs")}
                  className="grid w-full grid-cols-1 gap-2 border-b border-[#eef1f4] py-4 text-left transition hover:bg-[#fafcfd] sm:grid-cols-[1.25fr_1fr_.8fr_.7fr] sm:items-center sm:gap-3"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={cx(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                        job.tone === "orange"
                          ? "bg-[#fff0ea] text-[#e25d39]"
                          : job.tone === "blue"
                            ? "bg-[#e9f0fb] text-[#52749d]"
                            : "bg-[#e3f6ef] text-[#218b72]"
                      )}
                    >
                      <Truck className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[#27364b]">
                        {job.id}
                      </p>
                      <p className="mt-0.5 text-xs text-[#8795a7]">
                        {job.type} · {job.customer}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pl-12 sm:pl-0">
                    <MapPin className="h-3.5 w-3.5 text-[#97a4b4]" />
                    <span className="truncate text-xs text-[#66778d]">
                      {job.location}
                    </span>
                  </div>
                  <div className="pl-12 sm:pl-0">
                    <StatusPill
                      status={job.status}
                      tone={
                        job.tone === "orange"
                          ? "orange"
                          : job.tone === "blue"
                            ? "blue"
                            : "green"
                      }
                    />
                  </div>
                  <div className="pl-12 text-xs font-semibold text-[#52657d] sm:pl-0">
                    {job.eta}
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
            <CardHeader className="px-5 py-4 sm:px-6">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-[15px] font-semibold text-[#172033]">
                    Shift pulse
                  </CardTitle>
              <PanelSourceBadge source={demonstration("the shift figures are laid out to show the shape of the screen; no duty record is read")} />
                  <p className="mt-1 text-xs text-[#8492a5]">
                    Field performance today
                  </p>
                </div>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e3f6ef] text-[#218b72]">
                  <Activity className="h-4 w-4" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5 px-5 pb-5 sm:px-6">
              <div>
                <div className="mb-2 flex justify-between text-xs">
                  <span className="font-medium text-[#5d7088]">
                    On-time departures
                  </span>
                  <span className="font-semibold text-[#27364b]">94%</span>
                </div>
                <Progress
                  value={94}
                  className="h-2 bg-[#edf1f4] [&>div]:bg-[#2e9c82]"
                />
              </div>
              <div>
                <div className="mb-2 flex justify-between text-xs">
                  <span className="font-medium text-[#5d7088]">
                    Documents complete
                  </span>
                  <span className="font-semibold text-[#27364b]">78%</span>
                </div>
                <Progress
                  value={78}
                  className="h-2 bg-[#edf1f4] [&>div]:bg-[#52749d]"
                />
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-semibold tracking-[-0.05em] text-[#27364b]">
                    42.6
                  </p>
                  <p className="mt-1 text-[11px] text-[#8795a7]">
                    Avg. route km
                  </p>
                </div>
                <div>
                  <p className="text-2xl font-semibold tracking-[-0.05em] text-[#27364b]">
                    6.4h
                  </p>
                  <p className="mt-1 text-[11px] text-[#8795a7]">
                    Active drive time
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => toast.success("Performance detail view opened.")}
                className="h-9 w-full rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                View performance detail{" "}
                <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function BriefcaseIcon({ className }: { className?: string }) {
  return <BriefcaseBusiness className={className} />;
}

function MapWorkspace() {
  const mapRef = useRef<google.maps.Map | null>(null);
  const [query, setQuery] = useState("14-22 W5");
  const [selected, setSelected] = useState("lease");
  const [layers, setLayers] = useState({
    roads: true,
    assets: true,
    hazards: true,
  });
  const [mapStatus, setMapStatus] = useState("Loading map");
  const [mapError, setMapError] = useState(false);
  const [offlineSnapshot, setOfflineSnapshot] =
    useState<OfflineSnapshot | null>(() => {
      if (typeof window === "undefined") return null;
      try {
        const cached = localStorage.getItem(OFFLINE_SNAPSHOT_KEY);
        return cached ? (JSON.parse(cached) as OfflineSnapshot) : null;
      } catch {
        return null;
      }
    });
  const offlineReady = Boolean(offlineSnapshot);
  const { data: routeContexts } = trpc.fieldRoute.routeContext.list.useQuery();
  const saveOfflineSnapshot = () => {
    const snapshot = {
      ...offlineSnapshotSeed,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(OFFLINE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    setOfflineSnapshot(snapshot);
    toast.success(
      "North Ridge route, markers, and source context are now available offline."
    );
  };
  const locate = () => {
    toast.success(`Searching the operational index for ${query}`);
    mapRef.current?.setCenter({ lat: 53.557, lng: -113.286 });
    mapRef.current?.setZoom(13);
    setSelected("lease");
  };
  const handleMapReady = (map: google.maps.Map) => {
    mapRef.current = map;
    setMapError(false);
    setMapStatus("Live");
    mapMarkers.forEach(
      marker =>
        new google.maps.marker.AdvancedMarkerElement({
          map,
          position: { lat: marker.lat, lng: marker.lng },
          title: marker.label,
        })
    );
    new google.maps.Polyline({
      map,
      path: offlineSnapshotSeed.route,
      geodesic: true,
      strokeColor: "#f26b45",
      strokeOpacity: 0.9,
      strokeWeight: 4,
    });
  };
  return (
    <div>
      <PageHeader
        eyebrow="Field workspace"
        title="Field map"
        description="Locate leases, understand route context, and keep the operating region useful when the signal drops."
        action={
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-xl border border-[#dfe6ee] bg-white px-3 py-2 text-xs font-medium text-[#5d7189] sm:flex">
              <span className="h-2 w-2 rounded-full bg-[#2e9c82]" />
              Offline pack 92%
            </div>
            <Button
              onClick={saveOfflineSnapshot}
              variant="outline"
              className="h-10 rounded-xl border-[#d8e0e9] bg-white text-[#52657d]"
            >
              <CloudOff className="mr-2 h-4 w-4" />
              {offlineReady ? "Offline ready" : "Sync region"}
            </Button>
          </div>
        }
      />
      <div className="grid min-h-[calc(100vh-180px)] lg:grid-cols-[320px_1fr]">
        <aside className="border-b border-[#e0e6ee] bg-white p-5 lg:border-b-0 lg:border-r lg:p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
                Location index
              </p>
              <p className="mt-1 text-sm font-semibold text-[#172033]">
                Lease locator
              </p>
            </div>
            <button
              className="rounded-lg p-2 text-[#90a0b2] hover:bg-[#f1f4f7]"
              onClick={() => toast.success("Map filters reset.")}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-5 flex items-center gap-2 rounded-xl border border-[#d8e1ea] bg-[#fafcfd] px-3">
            <Search className="h-4 w-4 text-[#8b9aab]" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => event.key === "Enter" && locate()}
              className="h-11 border-0 bg-transparent px-2 text-sm shadow-none focus-visible:ring-0"
              placeholder="Lease, well, road, facility"
            />
            <button
              onClick={locate}
              className="rounded-lg p-1.5 text-[#e45e3b] hover:bg-[#fff0ea]"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-5 rounded-2xl border border-[#f3d9ca] bg-[#fff8f4] p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#ffeadf] text-[#e45e3b]">
                <MapPin className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-[#303e51]">
                    14-22 W5
                  </p>
                  <StatusPill status="Verified" tone="green" />
                </div>
                <p className="mt-1 text-xs leading-5 text-[#78879a]">
                  North Ridge lease · 3 wells · 1 active job
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[#f3ded3] pt-3 text-xs">
              <div>
                <p className="text-[#96a1ae]">Last verified</p>
                <p className="mt-1 font-semibold text-[#5d6d80]">
                  Aug 27, 06:12
                </p>
              </div>
              <div>
                <p className="text-[#96a1ae]">Access</p>
                <p className="mt-1 font-semibold text-[#5d6d80]">
                  Gate 2 · open
                </p>
              </div>
            </div>
          </div>
          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
                Layers
              </p>
              <button
                onClick={() =>
                  setLayers({ roads: true, assets: true, hazards: true })
                }
                className="text-[11px] font-semibold text-[#e45e3b]"
              >
                Reset
              </button>
            </div>
            <div className="space-y-1">
              {(
                [
                  [
                    "roads",
                    "Road context",
                    Route,
                    "County roads · restrictions",
                  ],
                  [
                    "assets",
                    "Sites & assets",
                    Warehouse,
                    "Wells · facilities · gates",
                  ],
                  [
                    "hazards",
                    "Safety signals",
                    ShieldAlert,
                    "Closures · hazards · reports",
                  ],
                ] as const
              ).map(([key, label, Icon, detail]) => (
                <button
                  key={key}
                  onClick={() => setLayers({ ...layers, [key]: !layers[key] })}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition hover:bg-[#f7f9fb]"
                >
                  <span
                    className={cx(
                      "flex h-8 w-8 items-center justify-center rounded-lg",
                      layers[key]
                        ? "bg-[#e8f0fb] text-[#52749d]"
                        : "bg-[#f0f3f6] text-[#9aa7b7]"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-[#43546a]">
                      {label}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-[#97a3b1]">
                      {detail}
                    </span>
                  </span>
                  <span
                    className={cx(
                      "h-5 w-9 rounded-full p-0.5 transition",
                      layers[key] ? "bg-[#2e9c82]" : "bg-[#dce3ea]"
                    )}
                  >
                    <span
                      className={cx(
                        "block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                        layers[key] ? "translate-x-4" : "translate-x-0"
                      )}
                    />
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-6 rounded-xl bg-[#f3f6f8] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#596d84]">
              <Signal className="h-4 w-4 text-[#2e9c82]" />
              Operational context
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#8b99aa]">
              Map sources are time-stamped and confidence-rated. Restrictions
              are advisory until verified with the controlling authority.
            </p>
            <div className="mt-3 flex items-center justify-between border-t border-[#e2e8ed] pt-3 text-[10px] font-semibold text-[#7b8c9f]">
              <span>Verified route sources</span>
              <span className="font-mono text-[#52749d]">
                {routeContexts?.length ?? 0}
              </span>
            </div>
          </div>
        </aside>
        <main className="relative min-h-[620px] bg-[#dbe7e3]">
          <MapView
            className="absolute inset-0 h-full w-full"
            initialCenter={{ lat: 53.57, lng: -113.27 }}
            initialZoom={12}
            onMapReady={handleMapReady}
            onMapError={() => {
              setMapError(true);
              setMapStatus(offlineReady ? "Offline snapshot" : "Unavailable");
            }}
          />
          {mapError && (
            <div className="pointer-events-none absolute inset-0 overflow-hidden bg-[#dce9e5]">
              <div
                className="absolute inset-0 opacity-70"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(90deg, rgba(102,145,137,.12) 0 1px, transparent 1px 56px), repeating-linear-gradient(0deg, rgba(102,145,137,.12) 0 1px, transparent 1px 56px)",
                }}
              />
              <div className="absolute left-[18%] top-[56%] h-[3px] w-[64%] rotate-[-17deg] bg-[#f26b45] shadow-[0_0_0_2px_rgba(255,255,255,.8)]" />
              <div className="absolute left-[30%] top-[64%] flex h-8 w-8 items-center justify-center rounded-full border-4 border-white bg-[#2e9c82] shadow-lg">
                <MapPin className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="absolute left-[57%] top-[40%] flex h-10 w-10 items-center justify-center rounded-full border-4 border-white bg-[#ff6b42] shadow-lg">
                <Truck className="h-4 w-4 text-white" />
              </div>
              <div className="absolute left-[75%] top-[24%] flex h-8 w-8 items-center justify-center rounded-full border-4 border-white bg-[#466c97] shadow-lg">
                <Warehouse className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/80 bg-white/90 px-5 py-4 text-center shadow-xl backdrop-blur">
                <CloudOff className="mx-auto h-6 w-6 text-[#52749d]" />
                <p className="mt-2 text-sm font-semibold text-[#34495f]">
                  {offlineSnapshot
                    ? "Offline operational snapshot"
                    : "Google Maps is unavailable"}
                </p>
                <p className="mt-1 max-w-[240px] text-[11px] leading-4 text-[#8190a3]">
                  {offlineSnapshot
                    ? `Cached route context saved ${new Date(offlineSnapshot.savedAt).toLocaleString()}.`
                    : "Connect to Google Maps or sync this region to use the cached operational view."}
                </p>
              </div>
            </div>
          )}
          <div className="absolute left-5 top-5 flex items-center gap-2 rounded-xl border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-[#43546a] shadow-lg backdrop-blur">
            <span
              className={cx(
                "h-2 w-2 rounded-full",
                mapError ? "bg-[#d08b36]" : "bg-[#2e9c82]"
              )}
            />
            Google Maps · {mapStatus}
          </div>
          <div className="absolute right-5 top-5 flex flex-col overflow-hidden rounded-xl border border-white/80 bg-white/95 shadow-lg backdrop-blur">
            <button
              className="p-3 text-[#5d7189] hover:bg-[#f3f6f8]"
              onClick={() =>
                mapRef.current?.setZoom((mapRef.current?.getZoom() || 12) + 1)
              }
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <Separator />
            <button
              className="p-3 text-[#5d7189] hover:bg-[#f3f6f8]"
              onClick={() =>
                mapRef.current?.setZoom((mapRef.current?.getZoom() || 12) - 1)
              }
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <Separator />
            <button
              className="p-3 text-[#5d7189] hover:bg-[#f3f6f8]"
              onClick={() => {
                mapRef.current?.setCenter({ lat: 53.57, lng: -113.27 });
                mapRef.current?.setZoom(12);
              }}
            >
              <Crosshair className="h-4 w-4" />
            </button>
          </div>
          <div className="absolute bottom-5 left-5 right-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-sm rounded-2xl border border-white/70 bg-white/95 p-4 shadow-lg backdrop-blur">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fff0ea] text-[#e45e3b]">
                  <Navigation className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#2c3e54]">
                    Active route · JOB-08421
                  </p>
                  <p className="mt-0.5 text-[11px] text-[#8593a5]">
                    Hydrovac 42 · 24.8 km remaining
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 text-[10px] text-[#7c8a9a]">
                <span className="h-2 w-2 rounded-full bg-[#ff6b42]" />
                Route context considers vehicle profile, restrictions, and
                reported hazards.
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/70 bg-white/95 px-3 py-2 text-[11px] font-medium text-[#60738a] shadow-lg backdrop-blur">
              <Ruler className="h-3.5 w-3.5" />
              Scale · 2 km
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

type JobRecord = (typeof jobs)[number];

function JobsWorkspace() {
  const [filter, setFilter] = useState("All jobs");
  const [selectedJob, setSelectedJob] = useState<JobRecord>(jobs[0]);
  const [isRecording, setIsRecording] = useState(false);
  const filteredJobs = useMemo(
    () =>
      filter === "All jobs" ? jobs : jobs.filter(job => job.status === filter),
    [filter]
  );
  return (
    <div>
      <PageHeader
        eyebrow="Work queue"
        title="Jobs"
        description="Every assignment, route, field procedure, and completion record in one operational thread."
        action={
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => toast.success("Job filters are ready.")}
              className="h-10 rounded-xl border-[#d8e0e9] bg-white text-[#52657d]"
            >
              <Filter className="mr-2 h-4 w-4" />
              Filter
            </Button>
            <Button
              onClick={() => toast.success("New job draft created.")}
              className="h-10 rounded-xl bg-[#ff6b42] font-semibold text-white hover:bg-[#e85d38]"
            >
              <Plus className="mr-2 h-4 w-4" />
              Create job
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[1fr_390px] lg:px-10">
        <div>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            {[
              "All jobs",
              "In transit",
              "Loading",
              "On site",
              "Awaiting docs",
            ].map(item => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={cx(
                  "rounded-lg px-3 py-2 text-xs font-semibold transition",
                  filter === item
                    ? "bg-[#10243f] text-white"
                    : "bg-white text-[#74869a] hover:bg-[#edf2f6]"
                )}
              >
                {item}
                {item === "All jobs" && (
                  <span className="ml-2 opacity-60">12</span>
                )}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {filteredJobs.map(job => (
              <button
                key={job.id}
                onClick={() => setSelectedJob(job)}
                className={cx(
                  "w-full rounded-2xl border bg-white p-5 text-left shadow-[0_8px_30px_rgba(39,63,94,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_35px_rgba(39,63,94,0.08)]",
                  selectedJob.id === job.id
                    ? "border-[#ffb59d] ring-2 ring-[#fff0ea]"
                    : "border-[#e0e6ee]"
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={cx(
                        "flex h-10 w-10 items-center justify-center rounded-xl",
                        job.tone === "orange"
                          ? "bg-[#fff0ea] text-[#e25d39]"
                          : job.tone === "blue"
                            ? "bg-[#e9f0fb] text-[#52749d]"
                            : job.tone === "green"
                              ? "bg-[#e3f6ef] text-[#218b72]"
                              : "bg-[#eef2f6] text-[#64748b]"
                      )}
                    >
                      <Truck className="h-[18px] w-[18px]" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[#27364b]">
                          {job.id}
                        </p>
                        <StatusPill
                          status={job.status}
                          tone={
                            job.tone === "orange"
                              ? "orange"
                              : job.tone === "blue"
                                ? "blue"
                                : job.tone === "green"
                                  ? "green"
                                  : "slate"
                          }
                        />
                      </div>
                      <p className="mt-1 text-xs text-[#8795a7]">
                        {job.type} · {job.customer}
                      </p>
                    </div>
                  </div>
                  <MoreHorizontal className="h-4 w-4 text-[#9aa7b7]" />
                </div>
                <div className="mt-5 grid gap-4 border-t border-[#eef1f4] pt-4 sm:grid-cols-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a0aab7]">
                      Location
                    </p>
                    <p className="mt-1 truncate text-xs font-medium text-[#5b6d82]">
                      {job.location}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a0aab7]">
                      Vehicle / driver
                    </p>
                    <p className="mt-1 text-xs font-medium text-[#5b6d82]">
                      {job.vehicle} · {job.driver}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a0aab7]">
                      ETA
                    </p>
                    <p className="mt-1 text-xs font-semibold text-[#27364b]">
                      {job.eta}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <Progress
                    value={job.progress}
                    className="h-1.5 flex-1 bg-[#edf1f4] [&>div]:bg-[#ff6b42]"
                  />
                  <span className="text-[11px] font-semibold text-[#71839a]">
                    {job.progress}%
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <JobDetail
          job={selectedJob}
          isRecording={isRecording}
          onRecording={() => setIsRecording(!isRecording)}
        />
      </div>
    </div>
  );
}

function JobDetail({
  job,
  isRecording,
  onRecording,
}: {
  job: JobRecord;
  isRecording: boolean;
  onRecording: () => void;
}) {
  return (
    <Card className="h-fit border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)] lg:sticky lg:top-5">
      <CardHeader className="border-b border-[#eef1f4] px-5 py-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
              Selected job
            </p>
            <CardTitle className="mt-1 text-xl tracking-[-0.04em] text-[#172033]">
              {job.id}
            </CardTitle>
          </div>
          <StatusPill
            status={job.status}
            tone={
              job.tone === "orange"
                ? "orange"
                : job.tone === "blue"
                  ? "blue"
                  : job.tone === "green"
                    ? "green"
                    : "slate"
            }
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <p className="text-xs text-[#8795a7]">
            {job.type} · {job.customer}
          </p>
          <span className="rounded-full bg-[#f1f4f7] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#71839a]">
            {job.mode}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <div className="rounded-xl bg-[#f6f8fb] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#4e627a]">
              Workflow progress
            </span>
            <span className="text-xs font-semibold text-[#e45e3b]">
              {job.progress}%
            </span>
          </div>
          <Progress
            value={job.progress}
            className="mt-3 h-2 bg-[#e1e8ee] [&>div]:bg-[#ff6b42]"
          />
          <div className="mt-3 flex justify-between text-[10px] font-medium text-[#96a2b0]">
            <span>Dispatched</span>
            <span>In field</span>
            <span>Complete</span>
          </div>
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <MapPin className="h-4 w-4 text-[#e45e3b]" />
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-[#9aa6b5]">
                Destination
              </p>
              <p className="mt-0.5 text-xs font-semibold text-[#53677e]">
                {job.location}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Truck className="h-4 w-4 text-[#52749d]" />
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-[#9aa6b5]">
                Assigned vehicle
              </p>
              <p className="mt-0.5 text-xs font-semibold text-[#53677e]">
                {job.vehicle} · Driver {job.driver}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Timer className="h-4 w-4 text-[#2e9c82]" />
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-[#9aa6b5]">
                Next milestone
              </p>
              <p className="mt-0.5 text-xs font-semibold text-[#53677e]">
                {job.status === "In transit"
                  ? "Arrive at lease · " + job.eta
                  : "Confirm loading · " + job.eta}
              </p>
            </div>
          </div>
        </div>
        <Separator />
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
            Field procedure
          </p>
          <div className="space-y-2">
            {procedureSteps[job.mode].map((item, index) => (
              <div key={item} className="flex items-center gap-3 text-xs">
                <span
                  className={cx(
                    "flex h-5 w-5 items-center justify-center rounded-full",
                    index < 2
                      ? "bg-[#e3f6ef] text-[#218b72]"
                      : "bg-[#eef2f6] text-[#92a0b1]"
                  )}
                >
                  {index < 2 ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Circle className="h-2.5 w-2.5 fill-current" />
                  )}
                </span>
                <span
                  className={
                    index < 2 ? "font-medium text-[#53677e]" : "text-[#8795a7]"
                  }
                >
                  {item}
                </span>
              </div>
            ))}
          </div>
        </div>
        <Button
          onClick={onRecording}
          className={cx(
            "h-11 w-full rounded-xl font-semibold",
            isRecording
              ? "bg-[#10243f] hover:bg-[#1c385b]"
              : "bg-[#ff6b42] hover:bg-[#e85d38]"
          )}
        >
          <Mic className="mr-2 h-4 w-4" />
          {isRecording ? "Listening… say confirm" : "Talk to update job"}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.success("Navigation launched with truck profile applied.")
          }
          className="h-10 w-full rounded-xl border-[#dfe6ee] bg-white text-xs font-semibold text-[#52657d]"
        >
          <Navigation className="mr-2 h-4 w-4" />
          Navigate with route context
        </Button>
      </CardContent>
    </Card>
  );
}

type EvidenceItem = (typeof evidence)[number] & { recordId?: number };

function EvidenceWorkspace() {
  const [selected, setSelected] = useState<EvidenceItem>(evidence[0]);
  const [reviewed, setReviewed] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const { data: persistedEvidence } = trpc.fieldRoute.evidence.list.useQuery();
  const utils = trpc.useUtils();
  const verifyMutation = trpc.fieldRoute.evidence.verify.useMutation({
    onSuccess: async () => {
      setReviewed(true);
      await utils.fieldRoute.evidence.list.invalidate();
      toast.success("Evidence marked as verified.");
    },
    onError: error => toast.error(error.message),
  });
  const evidenceItems = useMemo<EvidenceItem[]>(() => {
    const saved = (persistedEvidence ?? []).map(record => ({
      id: `DB-${record.id}`,
      title: record.title,
      category: record.category,
      time: new Date(record.capturedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      date: "Saved",
      status:
        record.status === "verified"
          ? "Verified"
          : record.status === "unverified"
            ? "Unverified"
            : "Needs review",
      initials: "SY",
      color: "#466c97",
      detail: record.notes || "Original field record retained in storage.",
      recordId: record.id,
    }));
    return [...saved, ...evidence];
  }, [persistedEvidence]);
  const handleVerify = () => {
    if (selected.recordId) {
      verifyMutation.mutate({ id: selected.recordId });
    } else {
      setReviewed(true);
      toast.success("Evidence marked as verified.");
    }
  };
  return (
    <div>
      <PageHeader
        eyebrow="Evidence chain"
        title="Evidence review"
        description="Keep every field record traceable, reviewable, and attached to the job it belongs to."
        action={
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => toast.success("Evidence filters are ready.")}
              className="h-10 rounded-xl border-[#d8e0e9] bg-white text-[#52657d]"
            >
              <Filter className="mr-2 h-4 w-4" />
              Filter
            </Button>
            <Button
              onClick={() => setIsCapturing(!isCapturing)}
              className="h-10 rounded-xl bg-[#ff6b42] font-semibold text-white hover:bg-[#e85d38]"
            >
              <Camera className="mr-2 h-4 w-4" />
              {isCapturing ? "Close capture" : "Capture evidence"}
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[1fr_410px] lg:px-10">
        <div>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-[#e0e6ee] bg-white p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#94a1b0]">
                Today
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-[-0.05em] text-[#27364b]">
                18
              </p>
              <p className="mt-1 text-xs text-[#8997a8]">records captured</p>
            </div>
            <div className="rounded-2xl border border-[#f3d9ca] bg-[#fff8f4] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#c18a75]">
                Needs review
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-[-0.05em] text-[#c95334]">
                03
              </p>
              <p className="mt-1 text-xs text-[#a47e72]">
                awaiting verification
              </p>
            </div>
            <div className="rounded-2xl border border-[#dceee7] bg-[#f2fbf7] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6d9d8c]">
                Verified
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-[-0.05em] text-[#238a72]">
                15
              </p>
              <p className="mt-1 text-xs text-[#74958b]">audit-ready records</p>
            </div>
          </div>
          <div className="space-y-3">
            {evidenceItems.map(item => (
              <button
                key={item.id}
                onClick={() => {
                  setSelected(item);
                  setReviewed(item.status === "Verified");
                }}
                className={cx(
                  "w-full rounded-2xl border bg-white p-4 text-left shadow-[0_8px_30px_rgba(39,63,94,0.04)] transition hover:shadow-[0_12px_35px_rgba(39,63,94,0.08)]",
                  selected.id === item.id
                    ? "border-[#ffb59d] ring-2 ring-[#fff0ea]"
                    : "border-[#e0e6ee]"
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold text-white"
                    style={{ backgroundColor: item.color }}
                  >
                    {item.initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-[#2b3b50]">
                        {item.title}
                      </p>
                      <StatusPill
                        status={item.status}
                        tone={
                          item.status === "Verified"
                            ? "green"
                            : item.status === "Needs review"
                              ? "orange"
                              : "amber"
                        }
                      />
                    </div>
                    <p className="mt-1 text-xs text-[#8795a7]">
                      {item.category} · {item.date} at {item.time}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#a6b2c1]" />
                </div>
              </button>
            ))}
          </div>
        </div>
        <Card className="h-fit border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)] lg:sticky lg:top-5">
          <CardHeader className="border-b border-[#eef1f4] px-5 py-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
                  Record detail
                </p>
                <CardTitle className="mt-1 text-lg tracking-[-0.04em] text-[#172033]">
                  {selected.title}
                </CardTitle>
              </div>
              <button
                onClick={() => toast.success("Record link copied.")}
                className="rounded-lg p-2 text-[#95a3b3] hover:bg-[#f2f5f8]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            <div className="flex h-40 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#e8eef1,#dce8e1)]">
              <div className="flex flex-col items-center gap-2 text-[#6c8295]">
                <FileText className="h-8 w-8" />
                <span className="text-xs font-semibold">
                  Original attachment preview
                </span>
                <span className="text-[10px]">
                  Image retained in field storage
                </span>
              </div>
            </div>
            <div className="rounded-xl bg-[#f6f8fb] p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#e8f0fb] text-[#52749d]">
                  <FileCheck2 className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#43556b]">
                    Extracted fields
                  </p>
                  <p className="mt-1 text-[11px] text-[#8a98aa]">
                    OCR · confidence 98%
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-y-3 text-xs">
                <div>
                  <p className="text-[#97a3b1]">Job</p>
                  <p className="mt-1 font-semibold text-[#52657d]">JOB-08421</p>
                </div>
                <div>
                  <p className="text-[#97a3b1]">Captured</p>
                  <p className="mt-1 font-semibold text-[#52657d]">
                    {selected.time}
                  </p>
                </div>
                <div>
                  <p className="text-[#97a3b1]">Location</p>
                  <p className="mt-1 font-semibold text-[#52657d]">53.557° N</p>
                </div>
                <div>
                  <p className="text-[#97a3b1]">Device</p>
                  <p className="mt-1 font-semibold text-[#52657d]">
                    Hydrovac 42
                  </p>
                </div>
              </div>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
                Field note
              </p>
              <p className="mt-2 text-sm leading-6 text-[#66778c]">
                {selected.detail}
              </p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-[#8493a5]">
              <Clock3 className="h-3.5 w-3.5" />
              Original captured {selected.date} at {selected.time} · GPS
              attached
            </div>
            <Button
              onClick={handleVerify}
              disabled={reviewed || verifyMutation.isPending}
              className={cx(
                "h-11 w-full rounded-xl font-semibold",
                reviewed
                  ? "bg-[#e3f6ef] text-[#238a72] hover:bg-[#e3f6ef]"
                  : "bg-[#10243f] text-white hover:bg-[#1c385b]"
              )}
            >
              {reviewed ? (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Verified and audit-ready
                </>
              ) : (
                <>
                  <Eye className="mr-2 h-4 w-4" />
                  Mark as verified
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
      {isCapturing && (
        <div className="fixed inset-x-4 bottom-5 z-50 mx-auto max-w-lg rounded-2xl border border-[#dfe6ee] bg-white p-4 shadow-[0_20px_60px_rgba(16,36,63,0.18)] sm:inset-x-auto sm:right-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#fff0ea] text-[#e45e3b]">
              <Camera className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[#27364b]">
                Evidence capture
              </p>
              <p className="mt-0.5 text-xs text-[#8795a7]">
                Choose a record type, then attach from the field.
              </p>
            </div>
            <button
              onClick={() => setIsCapturing(false)}
              className="ml-auto text-[#99a6b5]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Button
              variant="outline"
              onClick={() => startQuickCapture(SHOWCASE_CAPTURE.photo)}
              className="h-9 rounded-lg border-[#dfe6ee] bg-white text-xs"
            >
              <Camera className="mr-1.5 h-3.5 w-3.5" />
              Photo
            </Button>
            <Button
              variant="outline"
              onClick={() => startQuickCapture(SHOWCASE_CAPTURE.document)}
              className="h-9 rounded-lg border-[#dfe6ee] bg-white text-xs"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Document
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                toast.success(
                  "Voice note started. The note will attach to the active job after confirmation."
                )
              }
              className="h-9 rounded-lg border-[#dfe6ee] bg-white text-xs"
            >
              <Mic className="mr-1.5 h-3.5 w-3.5" />
              Voice note
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SafetyWorkspace() {
  const [checks, setChecks] = useState([true, true, false, false]);
  const [fatigue, setFatigue] = useState(false);
  const { data: persistedSafety } = trpc.fieldRoute.safety.list.useQuery();
  const utils = trpc.useUtils();
  const incidentMutation = trpc.fieldRoute.safety.create.useMutation({
    onSuccess: async () => {
      await utils.fieldRoute.safety.list.invalidate();
      toast.success("Incident signal logged and visible in the timeline.");
    },
    onError: error => toast.error(error.message),
  });
  const timelineEvents = useMemo(() => {
    const saved = (persistedSafety ?? []).map(event => ({
      time: new Date(event.occurredAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      title: event.title,
      detail: event.detail || event.eventType,
      icon: AlertTriangle,
      tone:
        event.severity === "critical"
          ? "red"
          : event.severity === "warning"
            ? "amber"
            : "blue",
    }));
    return [...saved, ...complianceEvents];
  }, [persistedSafety]);
  return (
    <div>
      <PageHeader
        eyebrow="Safety desk"
        title="Safety & compliance"
        description="See what is complete, what changed, and which signals deserve a human review before the next mile."
        action={
          <div className="flex items-center gap-3">
            <StatusPill status="No critical incidents" tone="green" />
            <Button
              onClick={() =>
                incidentMutation.mutate({
                  eventType: "incident_report",
                  severity: "warning",
                  title: "New incident report",
                  detail:
                    "Started from the safety desk for operator follow-up.",
                  occurredAt: new Date(),
                })
              }
              disabled={incidentMutation.isPending}
              className="h-10 rounded-xl bg-[#10243f] font-semibold text-white hover:bg-[#1c385b]"
            >
              <Plus className="mr-2 h-4 w-4" />
              Report incident
            </Button>
          </div>
        }
      />
      <div className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Open safety items"
            value="03"
            note="1 road report · 2 reviews"
            icon={ShieldAlert}
            tone="amber"
          />
          <MetricCard
            label="Checks complete"
            value="96%"
            note="Across active crews"
            trend="1.9%"
            icon={ClipboardCheck}
            tone="green"
          />
          <MetricCard
            label="Days incident-free"
            value="148"
            note="Current operating record"
            icon={HardHat}
            tone="blue"
          />
          <MetricCard
            label="Compliance events"
            value="24"
            note="Logged today"
            trend="6.2%"
            icon={FileCheck2}
            tone="orange"
          />
        </div>
        <div className="grid gap-6 xl:grid-cols-[.95fr_1.05fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] font-semibold text-[#172033]">
                  Pre-job checklist
                </CardTitle>
              <PanelSourceBadge source={demonstration("the checklist is the demonstration layout; the readiness engine is not run on this page")} />
                <p className="mt-1 text-xs text-[#8492a5]">
                  Hydrovac 42 · JOB-08421
                </p>
              </div>
              <StatusPill
                status={`${checks.filter(Boolean).length}/4 complete`}
                tone={checks.every(Boolean) ? "green" : "orange"}
              />
            </CardHeader>
            <CardContent className="px-5 pb-5 sm:px-6">
              <div className="space-y-2">
                {[
                  "Vehicle walkaround and DVIR",
                  "PPE and site access confirmed",
                  "Route restrictions reviewed",
                  "Disposal paperwork attached",
                ].map((item, index) => (
                  <button
                    key={item}
                    onClick={() =>
                      setChecks(
                        checks.map((value, i) => (i === index ? !value : value))
                      )
                    }
                    className="flex w-full items-center gap-3 rounded-xl border border-[#edf0f3] p-3 text-left transition hover:bg-[#fafcfd]"
                  >
                    <span
                      className={cx(
                        "flex h-6 w-6 items-center justify-center rounded-full",
                        checks[index]
                          ? "bg-[#2e9c82] text-white"
                          : "border border-[#cdd7e1] text-transparent"
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span
                      className={cx(
                        "text-sm",
                        checks[index]
                          ? "font-medium text-[#4c6379]"
                          : "text-[#8997a8]"
                      )}
                    >
                      {item}
                    </span>
                    {checks[index] && (
                      <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.12em] text-[#2e9c82]">
                        Done
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="mt-5 rounded-xl border border-[#e9edf1] bg-[#fafcfd] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-[#465a71]">
                      Fatigue signal
                    </p>
                    <p className="mt-1 text-[11px] leading-4 text-[#8897a8]">
                      Wellness indicator only · not legal HOS status
                    </p>
                  </div>
                  <button
                    onClick={() => setFatigue(!fatigue)}
                    className={cx(
                      "h-6 w-11 rounded-full p-0.5 transition",
                      fatigue ? "bg-[#d08b36]" : "bg-[#dce3ea]"
                    )}
                  >
                    <span
                      className={cx(
                        "block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
                        fatigue ? "translate-x-5" : "translate-x-0"
                      )}
                    />
                  </button>
                </div>
                {fatigue && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-[#fff5df] px-3 py-2 text-[11px] font-medium text-[#936b2a]">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Fatigue risk increasing. Consider a break before the next
                    leg.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-[15px] font-semibold text-[#172033]">
                    Compliance timeline
                  </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.safety.list", persistedSafety, { whenEmpty: "no safety event exists on this database yet" })} />
                  <p className="mt-1 text-xs text-[#8492a5]">
                    Chronological record for the selected job
                  </p>
                </div>
                <button
                  onClick={() => toast.success("Timeline export queued.")}
                  className="rounded-lg p-2 text-[#8f9eaf] hover:bg-[#f2f5f8] hover:text-[#e45e3b]"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5 sm:px-6">
              <div className="relative space-y-0 before:absolute before:bottom-5 before:left-[15px] before:top-5 before:w-px before:bg-[#e1e7ed]">
                {timelineEvents.map((event, index) => (
                  <div
                    key={`${event.time}-${event.title}-${index}`}
                    className="relative flex gap-4 py-3"
                  >
                    <div
                      className={cx(
                        "z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-4 border-white",
                        event.tone === "green"
                          ? "bg-[#dff4eb] text-[#238a72]"
                          : event.tone === "blue"
                            ? "bg-[#e5eef9] text-[#52749d]"
                            : event.tone === "amber"
                              ? "bg-[#fff0d2] text-[#a8792b]"
                              : "bg-[#eef2f6] text-[#70849a]"
                      )}
                    >
                      <event.icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-[#465a71]">
                          {event.title}
                        </p>
                        <span className="text-[11px] font-medium text-[#9aa6b4]">
                          {event.time}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-[#8997a8]">
                        {event.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                onClick={() => toast.success("Full compliance history opened.")}
                className="mt-3 h-9 w-full rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                View full history <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [location] = useLocation();
  const content =
    location === "/map" ? (
      <MapWorkspace />
    ) : location === "/jobs" ? (
      <JobsWorkspace />
    ) : location === "/evidence" ? (
      <EvidenceWorkspace />
    ) : location === "/safety" ? (
      <SafetyWorkspace />
    ) : (
      <Overview />
    );
  return <DashboardLayout>{content}</DashboardLayout>;
}
