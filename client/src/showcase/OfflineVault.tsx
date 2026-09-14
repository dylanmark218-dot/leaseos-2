import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArrowRight,
  Check,
  CloudOff,
  Download,
  FileText,
  History,
  Map,
  PackageCheck,
  QrCode,
  Search,
  Send,
  ShieldAlert,
  Smartphone,
  Truck,
  WifiOff,
} from "lucide-react";

const vaultTypes = [
  "Trip passports",
  "Manifest + BOL",
  "DG + SDS",
  "Tailgate / DVIR",
  "Disposal tickets",
  "Photos + GPS",
  "Maintenance",
  "Invoices",
];
const reportRows = [
  "ELD supporting records",
  "GPS history",
  "Dispatch + BOL",
  "Manifest + scale tickets",
  "DVIR + maintenance",
  "Customer signature",
  "Disposal ticket",
];

export default function OfflineVault() {
  const { data: artifacts } =
    trpc.fieldRoute.complianceEngine.artifacts.list.useQuery();
  const { data: transfers } =
    trpc.fieldRoute.complianceEngine.transfers.list.useQuery();
  const [regionReady, setRegionReady] = useState(false);
  const [syncState, setSyncState] = useState("Offline queue · 3 events");
  const [search, setSearch] = useState("");
  const [conflictOpen, setConflictOpen] = useState(false);
  const visibleTypes = vaultTypes.filter(item =>
    item.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <header className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
              Offline-first · field OS
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              The field record stays with you.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Compliance Vault and Trip Passport keep structured records
              available without cellular service, then sync events with conflict
              review when connectivity returns.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="h-10 rounded-xl bg-[#fff0d2] px-3 py-2 text-[#9b722c] hover:bg-[#fff0d2]">
              <WifiOff className="mr-2 h-3.5 w-3.5" />
              Offline mode
            </Badge>
            <Button
              onClick={() => {
                setSyncState("Syncing · conflict review ready");
                toast.success(
                  "Local event queue is ready to sync when service returns."
                );
              }}
              className="h-10 rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
            >
              <History className="mr-2 h-4 w-4" />
              Review sync queue
            </Button>
          </div>
        </div>
      </header>
      <main className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Vault objects"
            value={String(artifacts?.length || 47)}
            note="Structured + searchable"
            icon={FileText}
          />
          <Metric
            label="Trip passport"
            value="96%"
            note="7 of 8 sections ready"
            icon={PackageCheck}
          />
          <Metric
            label="Offline region"
            value={regionReady ? "Ready" : "92%"}
            note={
              regionReady ? "Northern Alberta cached" : "Download recommended"
            }
            icon={Map}
          />
          <Metric
            label="Sync queue"
            value="03"
            note={syncState}
            icon={CloudOff}
          />
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Compliance Vault
                </CardTitle>
                <p className="mt-1 text-xs text-[#8492a4]">
                  Search structured objects by job, unit, location, trip, or
                  tracking ID.
                </p>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-[#9aa6b4]" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search the vault"
                  className="h-9 w-full rounded-lg border border-[#dfe6ee] bg-white pl-9 pr-3 text-xs text-[#52657d] outline-none focus:border-[#52749d] sm:w-52"
                />
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-6">
              {visibleTypes.map((item, index) => (
                <div
                  key={item}
                  className="flex items-center gap-3 rounded-xl border border-[#edf0f3] p-3"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e8f0fb] text-[#52749d]">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[#52657d]">
                      {item}
                    </p>
                    <p className="mt-1 text-[10px] text-[#9aa6b4]">
                      {index + 4} linked records · provenance retained
                    </p>
                  </div>
                  <span className="font-mono text-[10px] text-[#8b99aa]">
                    {["TR", "WM", "DG", "DV", "DT", "PH", "WO", "IN"][index]}
                    -2026
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="border-[#10243f] bg-[#10243f] text-white shadow-[0_12px_35px_rgba(16,36,63,0.16)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <QrCode className="h-5 w-5 text-[#ff9c7f]" />
                <CardTitle className="text-[15px] text-white">
                  Trip Passport · TR-2026-000812
                </CardTitle>
              </div>
              <p className="mt-1 text-xs text-[#aabbd0]">
                Secure identifier only · authorized viewer required
              </p>
            </CardHeader>
            <CardContent className="space-y-2 px-5 pb-5 sm:px-6">
              {[
                "Driver + Unit 247",
                "Surface / downhole LSD",
                "Load + DG + SDS",
                "Manifest + route",
                "GPS + photos",
                "Disposal + scale",
                "Signature + billing",
              ].map(item => (
                <div
                  key={item}
                  className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs text-[#d8e3ef]"
                >
                  <Check className="h-3.5 w-3.5 text-[#7fe0c6]" />
                  {item}
                </div>
              ))}
              <div className="grid gap-2 pt-3 sm:grid-cols-2">
                <Button
                  onClick={() =>
                    toast.success(
                      "Encrypted local QR transfer prepared. Large files use a local session, not QR payloads."
                    )
                  }
                  className="h-10 rounded-xl bg-[#ff6b42] text-xs text-white hover:bg-[#e85d38]"
                >
                  <Send className="mr-2 h-4 w-4" />
                  Quick share
                </Button>
                <Button
                  onClick={() =>
                    toast.error(
                      "Emergency document mode opened. Paper TDG documents remain required where configured."
                    )
                  }
                  variant="outline"
                  className="h-10 rounded-xl border-white/20 bg-white/10 text-xs text-white hover:bg-white/20"
                >
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  Emergency access
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-[.95fr_1.05fr]">
          <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#254e46]">
                  Offline operating region
                </CardTitle>
                <p className="mt-1 text-xs text-[#729189]">
                  Northern Alberta Oilfield · roads, LSDs, facilities,
                  restrictions, emergency context.
                </p>
              </div>
              <Badge className="bg-[#e3f6ef] text-[#238a72] hover:bg-[#e3f6ef]">
                {regionReady ? "Cached" : "92% synced"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  "Backroads + lease roads",
                  "Well locations + LSDs",
                  "Bridges + clearance",
                  "Weight + truck restrictions",
                  "Facilities + fuel",
                  "Emergency services",
                ].map(item => (
                  <div
                    key={item}
                    className="flex items-center gap-2 rounded-lg border border-[#cfe8dd] bg-white px-3 py-2 text-xs text-[#527c70]"
                  >
                    <Check className="h-3.5 w-3.5 text-[#2e9c82]" />
                    {item}
                  </div>
                ))}
              </div>
              <Button
                onClick={() => {
                  setRegionReady(true);
                  toast.success("Offline region package saved locally.");
                }}
                className="h-10 w-full rounded-xl bg-[#2e9c82] text-xs text-white hover:bg-[#25846f]"
              >
                <Download className="mr-2 h-4 w-4" />
                {regionReady
                  ? "Region cached locally"
                  : "Download region package"}
              </Button>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Sync + conflict review
                </CardTitle>
                <p className="mt-1 text-xs text-[#8492a4]">
                  Local events never silently overwrite authoritative records.
                </p>
              </div>
              <CloudOff className="h-5 w-5 text-[#d08b36]" />
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              <div className="flex items-center justify-between rounded-xl border border-[#f3d9ca] bg-[#fff8f4] p-4">
                <div>
                  <p className="text-xs font-semibold text-[#7b5147]">
                    Manifest quantity conflict
                  </p>
                  <p className="mt-1 text-[11px] text-[#a27d70]">
                    Driver: 300 bbl · office: 305 bbl · scale: 304.7 bbl
                  </p>
                </div>
                <Badge className="bg-[#fff0d2] text-[#9b722c] hover:bg-[#fff0d2]">
                  Needs review
                </Badge>
              </div>
              <Button
                onClick={() => {
                  setConflictOpen(!conflictOpen);
                  setSyncState(
                    conflictOpen
                      ? "Offline queue · 3 events"
                      : "Conflict opened · scale evidence selected"
                  );
                }}
                variant="outline"
                className="h-9 w-full rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                {conflictOpen
                  ? "Resolve with scale evidence"
                  : "Open conflict review"}
                <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Button>
              {conflictOpen && (
                <div className="rounded-xl border border-[#dceee7] bg-[#f3fbf7] p-3 text-[11px] text-[#527c70]">
                  Scale ticket marked as the authoritative supporting evidence.
                  Original driver and office values remain preserved in the
                  event log.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <CardTitle className="text-[15px] text-[#172033]">
                Trip evidence package · TR-2026-000812
              </CardTitle>
              <p className="mt-1 text-xs text-[#8492a4]">
                Automatic report assembled from supporting records. Certified
                ELD remains the regulated source.
              </p>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {reportRows.map(item => (
                <div
                  key={item}
                  className="flex items-center gap-2 rounded-lg bg-[#f7f9fb] px-3 py-2.5 text-xs text-[#52657d]"
                >
                  <Check className="h-3.5 w-3.5 text-[#2e9c82]" />
                  {item}
                </div>
              ))}
              <Button
                onClick={() =>
                  toast.success(
                    "Trip report generated for authorized office recipients."
                  )
                }
                className="mt-3 h-10 rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
              >
                <FileText className="mr-2 h-4 w-4" />
                Generate trip report
              </Button>
            </CardContent>
          </Card>
          <Card className="border-[#f2d5d1] bg-[#fff7f6] shadow-[0_10px_35px_rgba(196,84,72,0.06)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-[#c45448]" />
                <CardTitle className="text-[15px] text-[#773d38]">
                  First-responder safety mode
                </CardTitle>
              </div>
              <p className="mt-1 text-xs text-[#a87872]">
                Safety-critical cached context only; does not replace emergency
                services or required paper records.
              </p>
            </CardHeader>
            <CardContent className="space-y-2 px-5 pb-5 sm:px-6">
              <Field label="Vehicle" value="Unit 247 · hydrovac" />
              <Field label="Load" value="Invert mud · classification review" />
              <Field
                label="Emergency contact"
                value="Operations desk · 1-800-555-0147"
              />
              <Button
                onClick={() =>
                  toast.error("Emergency mode confirmed for the current trip.")
                }
                className="mt-2 h-10 w-full rounded-xl bg-[#c45448] text-xs text-white hover:bg-[#aa443a]"
              >
                <Smartphone className="mr-2 h-4 w-4" />
                Open emergency document mode
              </Button>
            </CardContent>
          </Card>
        </div>
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
  icon: typeof FileText;
}) {
  return (
    <Card className="border-[#e0e6ee] bg-white shadow-[0_8px_30px_rgba(39,63,94,0.05)]">
      <CardContent className="p-5">
        <Icon className="h-5 w-5 text-[#52749d]" />
        <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#8998aa]">
          {label}
        </p>
        <p className="mt-1 text-3xl font-semibold tracking-[-0.06em] text-[#172033]">
          {value}
        </p>
        <p className="mt-1 text-xs text-[#8492a4]">{note}</p>
      </CardContent>
    </Card>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[#f2d5d1] bg-white px-3 py-2.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-[#a87872]">
        {label}
      </span>
      <span className="text-right text-xs font-semibold text-[#773d38]">
        {value}
      </span>
    </div>
  );
}
