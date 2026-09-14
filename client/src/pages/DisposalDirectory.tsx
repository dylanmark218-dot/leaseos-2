import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Filter,
  MapPin,
  Phone,
  Search,
  ShieldCheck,
  Truck,
  RefreshCw,
} from "lucide-react";

const seedFacilities = [
  {
    name: "Secure Energy · La Glace",
    region: "Canada · Alberta",
    address: "RR1, Site 14, Box 14, Sexsmith, AB T0H 3C0",
    phone: "1-877-518-4321",
    status: "needs_confirmation",
    capabilities: "Fluid processing · solids pad · commercial tanker offload",
    restrictions:
      "Pre-approval required for DG loads; confirm riser and bridge access",
    source: "Attachment lead · verify against provincial registry",
    sourceUrl:
      "https://open.canada.ca/data/en/dataset/1a12f1f0-d36f-4aee-8b79-135934dea63d",
    email: "Confirm with facility",
    hours: "Confirm with facility",
    emergencyPhone: "1-877-518-4321",
    facilityType: "Industrial waste processing",
    jurisdiction: "Canada · Alberta",
    registryId: "Provincial record · pending",
    verification: "Needs human confirmation",
    lat: 55.35,
    lon: -118.78,
  },
  {
    name: "Clean Harbors · Ryley Technical Services",
    region: "Canada · Alberta",
    address: "50114 Range Rd 173, Ryley, AB",
    phone: "780-663-3828",
    status: "needs_confirmation",
    capabilities: "Industrial landfill · slurry stabilization · DG handling",
    restrictions: "Confirm accepted waste class, hours, and approach route",
    source: "Attachment lead · verify facility permit",
    sourceUrl:
      "https://open.canada.ca/data/en/dataset/1a12f1f0-d36f-4aee-8b79-135934dea63d",
    email: "Confirm with facility",
    hours: "Confirm with facility",
    emergencyPhone: "780-663-3828",
    facilityType: "Industrial landfill / slurry",
    jurisdiction: "Canada · Alberta",
    registryId: "Provincial record · pending",
    verification: "Needs human confirmation",
    lat: 53.35,
    lon: -112.73,
  },
  {
    name: "Clean Harbors · Cincinnati",
    region: "United States · Ohio",
    address: "4879 Spring Grove Ave, Cincinnati, OH",
    phone: "513-681-6242",
    status: "needs_confirmation",
    capabilities: "Bulk liquid offload · industrial waste · sludges",
    restrictions: "U.S. EPA/state permit and local HM route review required",
    source: "Attachment lead · verify EPA/state record",
    sourceUrl: "https://www.epa.gov/enviro/rcrainfo-overview",
    email: "Confirm with facility",
    hours: "Confirm with facility",
    emergencyPhone: "513-681-6242",
    facilityType: "Industrial waste / bulk liquid",
    jurisdiction: "United States · Ohio",
    registryId: "EPA/state record · pending",
    verification: "Needs human confirmation",
    lat: 39.18,
    lon: -84.54,
  },
  {
    name: "Clean Harbors · Henderson",
    region: "United States · Nevada",
    address: "100 North Stockwell Road, Henderson, NV",
    phone: "1-800-645-8265",
    status: "needs_confirmation",
    capabilities: "Industrial fluid management · hazardous waste processing",
    restrictions:
      "Confirm state acceptance and route restrictions before dispatch",
    source: "Attachment lead · verify EPA/state record",
    sourceUrl: "https://www.epa.gov/enviro/rcrainfo-overview",
    email: "Confirm with facility",
    hours: "Confirm with facility",
    emergencyPhone: "1-800-645-8265",
    facilityType: "Hazardous waste processing",
    jurisdiction: "United States · Nevada",
    registryId: "EPA/state record · pending",
    verification: "Needs human confirmation",
    lat: 36.03,
    lon: -114.98,
  },
];
export default function DisposalDirectory() {
  const [, navigate] = useLocation();
  const { data: facilities } =
    trpc.fieldRoute.compliance.facilities.list.useQuery();
  const create = trpc.fieldRoute.compliance.facilities.create.useMutation({
    onSuccess: () => toast.success("Facility lead saved for verification."),
  });
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("All");
  const [selected, setSelected] = useState(0);
  const rows = facilities?.length
    ? facilities.map(f => ({
        name: f.name,
        region: "Persisted facility",
        address: f.gateInstructions || "Address on permit record",
        phone: f.phone || "Contact facility",
        status: f.status,
        capabilities:
          f.acceptedMaterials || "Acceptance capabilities require confirmation",
        restrictions: f.restrictions || "Verify vehicle/load restrictions",
        source: f.lastVerifiedAt
          ? `Last verified ${new Date(f.lastVerifiedAt).toLocaleDateString()}`
          : "Registry record · verification required",
        sourceUrl: "https://www.epa.gov/enviro/rcrainfo-overview",
        email: "Contact facility",
        hours: f.operatingHours || "Confirm with facility",
        emergencyPhone: f.emergencyPhone || f.phone || "Confirm emergency line",
        facilityType: "Industrial waste facility",
        jurisdiction: "Jurisdiction confirmation required",
        registryId: "Permit / registry ID required",
        verification: f.lastVerifiedAt
          ? "Last verified · confirm acceptance"
          : "Needs human confirmation",
        lat: f.latitude || 0,
        lon: f.longitude || 0,
      }))
    : seedFacilities;
  const filtered = useMemo(
    () =>
      rows.filter(
        f =>
          `${f.name} ${f.region ?? ""} ${f.address ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (region === "All" || f.region?.includes(region))
      ),
    [rows, query, region]
  );
  const facility = filtered[selected] || filtered[0] || rows[0];
  return (
    <div>
      <header className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
          Network intelligence · facility verification
        </p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              Disposal sites, mapped for the road.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Search permitted facility leads across Canada and the United
              States, then verify acceptance, contacts, hours, and route
              restrictions before dispatch.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() =>
                toast.info(
                  "Refresh boundary recorded. Reconcile the authoritative provincial/state registry before dispatch."
                )
              }
              variant="outline"
              className="h-9 rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
            >
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              Refresh sources
            </Button>
            <Badge className="w-fit bg-[#fff0d2] px-3 py-2 text-[#9b722c] hover:bg-[#fff0d2]">
              <AlertTriangle className="mr-2 h-3.5 w-3.5" />
              Confirmation required before use
            </Badge>
          </div>
        </div>
      </header>
      <main className="grid gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[.92fr_1.08fr] lg:px-10 lg:py-8">
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9aa6b4]" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search site, state, province, address"
                  className="h-10 w-full rounded-lg border border-[#dfe6ee] pl-9 pr-3 text-sm text-[#52657d] outline-none focus:border-[#52749d]"
                />
              </label>
              <select
                value={region}
                onChange={e => setRegion(e.target.value)}
                className="h-10 rounded-lg border border-[#dfe6ee] px-3 text-xs text-[#52657d]"
              >
                <option>All</option>
                <option>Canada</option>
                <option>United States</option>
                <option>Alberta</option>
                <option>Ohio</option>
                <option>Nevada</option>
              </select>
            </div>
            <p className="mt-3 flex items-center gap-2 text-xs text-[#8492a4]">
              <Filter className="h-3.5 w-3.5" />
              {filtered.length} facility leads · public registry and operator
              confirmation required
            </p>
          </CardHeader>
          <CardContent className="space-y-2 px-5 pb-5 sm:px-6">
            {filtered.map((item, i) => (
              <button
                key={item.name}
                onClick={() => setSelected(i)}
                className={`w-full rounded-xl border p-4 text-left transition ${facility?.name === item.name ? "border-[#ff6b42] shadow-[0_0_0_2px_rgba(255,107,66,0.12)]" : "border-[#edf0f3]"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-[#52657d]">
                      {item.name}
                    </p>
                    <p className="mt-1 text-[11px] text-[#8492a4]">
                      {item.region}
                    </p>
                  </div>
                  <Badge className="bg-[#fff0d2] text-[#9b722c] hover:bg-[#fff0d2]">
                    Verify
                  </Badge>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-[#8492a4]">
                  {item.capabilities}
                </p>
              </button>
            ))}
          </CardContent>
        </Card>
        <Card className="border-[#10243f] bg-[#10243f] text-white shadow-[0_12px_35px_rgba(16,36,63,0.16)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#aabbd0]">
                  Facility detail
                </p>
                <CardTitle className="mt-1 text-xl text-white">
                  {facility?.name}
                </CardTitle>
              </div>
              <MapPin className="h-5 w-5 text-[#ff9c7f]" />
            </div>
          </CardHeader>
          <CardContent className="space-y-5 px-5 pb-6 sm:px-6">
            <div className="rounded-2xl border border-white/10 bg-[#173454] p-4">
              <p className="text-xs text-[#d8e3ef]">{facility?.address}</p>
              <p className="mt-2 flex items-center gap-2 text-xs text-[#aabbd0]">
                <Phone className="h-3.5 w-3.5" />
                {facility?.phone}
              </p>
              <p className="mt-2 text-xs text-[#aabbd0]">
                Emergency:{" "}
                {facility?.emergencyPhone || "Confirm emergency line"} · Hours:{" "}
                {facility?.hours || "Confirm with facility"}
              </p>
              <p className="mt-2 text-xs text-[#aabbd0]">
                {facility?.facilityType} · {facility?.jurisdiction}
              </p>
              <p className="mt-2 font-mono text-[10px] text-[#7f96af]">
                Coordinates {facility?.lat?.toFixed?.(4) ?? "—"},{" "}
                {facility?.lon?.toFixed?.(4) ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#aabbd0]">
                Acceptance context
              </p>
              <p className="mt-2 text-sm leading-6 text-[#d8e3ef]">
                {facility?.capabilities}
              </p>
              <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-[#ffcf9c]">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                {facility?.restrictions}
              </p>
            </div>
            <div className="rounded-xl border border-[#3d5875] p-3">
              <p className="text-[10px] uppercase tracking-[0.14em] text-[#aabbd0]">
                Source and confidence
              </p>
              <p className="mt-1 text-xs text-[#d8e3ef]">{facility?.source}</p>
              <p className="mt-1 text-[10px] text-[#aabbd0]">
                {facility?.verification} · {facility?.registryId}
              </p>
              <a
                href={facility?.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[10px] text-[#9fc1e5]"
              >
                Source record <ExternalLink className="h-3 w-3" />
              </a>
              <p className="mt-2 text-[10px] text-[#aabbd0]">
                Never infer facility acceptance or a legal route from a
                directory record alone.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                onClick={() =>
                  navigate(
                    `/route-safety?facility=${encodeURIComponent(facility?.name || "")}&lat=${facility?.lat || 0}&lon=${facility?.lon || 0}`
                  )
                }
                className="h-10 rounded-lg bg-[#ff6b42] text-xs text-white hover:bg-[#e85d38]"
              >
                <Truck className="mr-2 h-3.5 w-3.5" />
                Plan safe route
              </Button>
              <Button
                onClick={() =>
                  create.mutate({
                    name: facility?.name || "Facility lead",
                    status: "unknown",
                    operatingHours: "Confirm with facility",
                    acceptedMaterials: facility?.capabilities,
                    restrictions: facility?.restrictions,
                    phone: facility?.phone,
                    lastVerifiedAt: new Date(),
                    latitude: facility?.lat,
                    longitude: facility?.lon,
                  })
                }
                variant="outline"
                className="h-10 rounded-lg border-[#52749d] bg-transparent text-xs text-white hover:bg-white/10"
              >
                <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                Save lead
              </Button>
            </div>
            <a
              className="flex items-center gap-1 text-[11px] text-[#9fc1e5]"
              href="https://www.epa.gov/enviro/rcrainfo-overview"
              target="_blank"
              rel="noreferrer"
            >
              Open authoritative registry guidance{" "}
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
