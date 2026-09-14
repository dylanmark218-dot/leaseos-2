import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  FileText,
  Fingerprint,
  History,
  Layers3,
  MapPin,
  Nfc,
  PackageCheck,
  QrCode,
  Route,
  ScanLine,
  ShieldCheck,
  Truck,
  Waves,
} from "lucide-react";

const demoLocation = {
  id: 1,
  name: "North Ridge Well 102",
  surfaceLsd: "04-12-034-05W5",
  downholeLsd: "03-12-034-05W5",
  uwi: "102/04-12-034-05W5/00",
  wellLicense: "AB-991204",
  operator: "Northline Energy",
  lease: "North Ridge 42",
  field: "North Ridge",
  province: "Alberta",
  accessRoad: "County 214 · km 18",
  gate: "Gate 3 · scale before entry",
  hazards: "Soft shoulder after rain · overhead line at pad",
  emergencyInfo: "Muster at Gate 3 · call operations desk",
  source: "Provincial regulatory database",
  surfaceLatitude: 53.557,
  surfaceLongitude: -113.286,
  lastVerifiedAt: new Date("2026-08-27T16:00:00Z"),
};

export default function LocationWorkspace() {
  const { data: locations } = trpc.fieldRoute.locations.list.useQuery();
  const { data: manifests } = trpc.fieldRoute.manifests.list.useQuery();
  const scan = trpc.fieldRoute.scans.create.useMutation({
    onSuccess: () =>
      toast.success("Scan audit recorded. Authorized context loaded."),
    onError: error => toast.error(error.message),
  });
  const [layer, setLayer] = useState<"surface" | "downhole">("surface");
  const [role, setRole] = useState<
    "inspection" | "driver" | "mechanic" | "dispatcher" | "admin"
  >("dispatcher");
  const [subject, setSubject] = useState<"location" | "unit" | "manifest">(
    "location"
  );
  const location = locations?.[0] || demoLocation;
  const manifest = manifests?.[0];
  const auditScan = (scanType: "qr" | "nfc") =>
    scan.mutate({
      scanType,
      subjectType: subject,
      subjectId: location.id || 1,
      accessRole: role,
      scannedAt: new Date(),
      latitude: location.surfaceLatitude || 53.557,
      longitude: location.surfaceLongitude || -113.286,
    });
  return (
    <div>
      <div className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
              Location identity · chain of custody
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              One scan. The whole operating picture.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Separate surface and downhole identity, then connect the
              authorized well, unit, driver, manifest, route, disposal,
              evidence, and signature context.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={role}
              onChange={e => setRole(e.target.value as typeof role)}
              className="h-10 rounded-xl border border-[#dfe6ee] bg-white px-3 text-xs font-semibold text-[#52657d] outline-none"
            >
              <option value="dispatcher">Dispatcher view</option>
              <option value="driver">Driver view</option>
              <option value="mechanic">Mechanic view</option>
              <option value="inspection">Inspection view</option>
              <option value="admin">Administrator view</option>
            </select>
            <Button
              onClick={() => auditScan("qr")}
              className="h-10 rounded-xl bg-[#ff6b42] px-4 text-xs font-semibold text-white hover:bg-[#e85d38]"
            >
              <QrCode className="mr-2 h-4 w-4" />
              Scan QR
            </Button>
            <Button
              onClick={() => auditScan("nfc")}
              variant="outline"
              className="h-10 rounded-xl border-[#dfe6ee] bg-white px-4 text-xs font-semibold text-[#52657d]"
            >
              <Nfc className="mr-2 h-4 w-4" />
              Tap NFC
            </Button>
          </div>
        </div>
        <div className="mt-7 flex gap-2">
          <button
            onClick={() => setLayer("surface")}
            className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${layer === "surface" ? "bg-[#10243f] text-white" : "bg-white text-[#6f8195]"}`}
          >
            <MapPin className="h-4 w-4" />
            Show surface
          </button>
          <button
            onClick={() => setLayer("downhole")}
            className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold ${layer === "downhole" ? "bg-[#10243f] text-white" : "bg-white text-[#6f8195]"}`}
          >
            <Waves className="h-4 w-4" />
            Show downhole
          </button>
        </div>
      </div>
      <div className="grid gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[1.1fr_.9fr] lg:px-10 lg:py-8">
        <div className="space-y-6">
          <Card className="overflow-hidden border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <div className="relative h-64 bg-[#dfeae5] p-5">
              <div
                className="absolute inset-0 opacity-50"
                style={{
                  backgroundImage:
                    "linear-gradient(30deg, #c5d8d1 1px, transparent 1px), linear-gradient(120deg, #c5d8d1 1px, transparent 1px)",
                  backgroundSize: "42px 42px",
                }}
              />
              <div className="relative flex items-start justify-between">
                <div className="rounded-xl bg-white/90 px-3 py-2 shadow-sm">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                    {layer === "surface" ? "Surface layer" : "Downhole layer"}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#465a71]">
                    {layer === "surface"
                      ? location.surfaceLsd
                      : location.downholeLsd}
                  </p>
                </div>
                <Badge className="bg-[#e3f6ef] text-[#238a72] hover:bg-[#e3f6ef]">
                  Source verified
                </Badge>
              </div>
              <div className="absolute left-[35%] top-[54%] flex h-12 w-12 items-center justify-center rounded-full border-4 border-white bg-[#ff6b42] text-white shadow-lg">
                <MapPin className="h-5 w-5" />
              </div>
              <div className="absolute right-[22%] top-[30%] flex h-9 w-9 items-center justify-center rounded-full border-4 border-white bg-[#52749d] text-white shadow-lg">
                <Truck className="h-4 w-4" />
              </div>
              <div className="absolute bottom-4 left-5 rounded-lg bg-[#10243f]/90 px-3 py-2 text-[10px] text-white">
                {layer === "surface"
                  ? "Well pad / gate / access road"
                  : "Bottom-hole projection / direction"}
              </div>
            </div>
            <CardContent className="grid gap-4 px-5 py-5 sm:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#8998aa]">
                  Location identity
                </p>
                <p className="mt-2 text-lg font-semibold text-[#2f4055]">
                  {location.name}
                </p>
                <p className="mt-1 text-xs text-[#8492a4]">
                  Surface {location.surfaceLsd} · Downhole{" "}
                  {location.downholeLsd}
                </p>
              </div>
              <div className="sm:text-right">
                <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#8998aa]">
                  Status
                </p>
                <p className="mt-2 text-sm font-semibold text-[#238a72]">
                  Producing · last verified Aug 27
                </p>
                <p className="mt-1 text-xs text-[#8492a4]">{location.source}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <Layers3 className="h-5 w-5 text-[#52749d]" />
                <CardTitle className="text-[15px] text-[#172033]">
                  Location identity card
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 px-5 pb-5 sm:grid-cols-2 sm:px-6">
              <Info
                label="Well licence / UWI"
                value={`${location.wellLicense} · ${location.uwi}`}
              />
              <Info
                label="Operator / lease"
                value={`${location.operator} · ${location.lease}`}
              />
              <Info
                label="Field / province"
                value={`${location.field} · ${location.province}`}
              />
              <Info
                label="Access / gate"
                value={`${location.accessRoad} · ${location.gate}`}
              />
              <Info
                label="Hazards"
                value={location.hazards || "No hazards recorded"}
                warn
              />
              <Info
                label="Emergency info"
                value={location.emergencyInfo || "Operations desk"}
              />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-6">
          <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-5 w-5 text-[#238a72]" />
                <CardTitle className="text-[15px] text-[#254e46]">
                  Unit 247 · digital passport
                </CardTitle>
              </div>
              <p className="mt-1 text-xs text-[#729189]">
                QR-ID: 8F72-91C4-247 · sensitive documents stay behind
                authorization.
              </p>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              <div className="grid gap-2 sm:grid-cols-2">
                <PassportRow
                  label="Identity"
                  value="VIN · plate · company · GVW"
                />
                <PassportRow
                  label="Documentation"
                  value="Registration · insurance · permits"
                />
                <PassportRow
                  label="Condition"
                  value="Pre-trip · defects · repairs"
                />
                <PassportRow
                  label="History"
                  value="Trips · loads · disposals · signatures"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setSubject("unit");
                    auditScan("qr");
                  }}
                  className="h-10 flex-1 rounded-xl bg-[#2e9c82] text-xs text-white hover:bg-[#25846f]"
                >
                  <ScanLine className="mr-2 h-4 w-4" />
                  Open passport
                </Button>
                <Button
                  onClick={() =>
                    toast.success(
                      "Authorized label print prepared for Unit 247."
                    )
                  }
                  variant="outline"
                  className="h-10 rounded-xl border-[#cfe8dd] bg-white text-xs text-[#527c70]"
                >
                  <QrCode className="mr-2 h-4 w-4" />
                  Print label
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Manifest ↔ truck ↔ well
                </CardTitle>
                <p className="mt-1 text-xs text-[#8492a4]">
                  {manifest?.manifestNumber || "MANIFEST #58241"} · linked
                  operational chain
                </p>
              </div>
              <PackageCheck className="h-5 w-5 text-[#52749d]" />
            </CardHeader>
            <CardContent className="space-y-2 px-5 pb-5 sm:px-6">
              {[
                ["Generator", location.name],
                [
                  "Surface / downhole LSD",
                  `${location.surfaceLsd} / ${location.downholeLsd}`,
                ],
                ["Material / UN status", "Invert mud · needs verification"],
                ["Vehicle / driver", "Unit 247 · Dylan Hutchings"],
                ["Route / disposal", "County 214 · West Ridge Disposal"],
                ["Evidence / signatures", "8 photos · 1 device-confirmed"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-4 border-b border-[#eef1f4] py-2.5 last:border-0"
                >
                  <span className="text-xs text-[#8b99aa]">{label}</span>
                  <span className="text-right text-xs font-semibold text-[#52657d]">
                    {value}
                  </span>
                </div>
              ))}
              <Button
                onClick={() =>
                  toast.success(
                    "Manifest history opened with jobs, documents, and disposal records."
                  )
                }
                variant="outline"
                className="mt-3 h-9 w-full rounded-lg border-[#dfe6ee] bg-white text-xs text-[#536981]"
              >
                View full chain <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Button>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <History className="h-5 w-5 text-[#52749d]" />
                <CardTitle className="text-[15px] text-[#172033]">
                  Unit history
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              <Timeline
                time="18:43"
                title="Post-trip inspection"
                detail="Hydraulic hose · 2 photos · GPS attached"
                tone="amber"
              />
              <Timeline
                time="14:12"
                title="Disposal job #58241"
                detail="Completed · scale ticket attached"
                tone="green"
              />
              <Timeline
                time="08:01"
                title="Pre-trip"
                detail="Passed · driver authenticated"
                tone="green"
              />
              <Timeline
                time="Aug 26"
                title="Maintenance"
                detail="Hydraulic hose replaced · work order closed"
                tone="blue"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
function Info({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#9aa6b4]">
        {label}
      </p>
      <p
        className={`mt-1 text-xs font-semibold leading-5 ${warn ? "text-[#b3564c]" : "text-[#52657d]"}`}
      >
        {value}
      </p>
    </div>
  );
}
function PassportRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#dceee7] bg-white p-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#8aa79f]">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold text-[#527c70]">{value}</p>
    </div>
  );
}
function Timeline({
  time,
  title,
  detail,
  tone,
}: {
  time: string;
  title: string;
  detail: string;
  tone: "green" | "amber" | "blue";
}) {
  return (
    <div className="flex gap-3">
      <div
        className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${tone === "green" ? "bg-[#2e9c82]" : tone === "amber" ? "bg-[#d08b36]" : "bg-[#52749d]"}`}
      />
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-semibold text-[#52657d]">{title}</p>
          <span className="text-[10px] text-[#9aa6b4]">{time}</span>
        </div>
        <p className="mt-1 text-[11px] text-[#8b99aa]">{detail}</p>
      </div>
    </div>
  );
}
