import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelSourceBadge } from "./SourcedPanel";
import { demonstration, fromQuery } from "./panelSource";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BatteryCharging,
  BrainCircuit,
  CalendarClock,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FileText,
  Fingerprint,
  Flame,
  Gauge,
  HardHat,
  IdCard,
  KeyRound,
  MapPin,
  PackageCheck,
  Phone,
  QrCode,
  Radio,
  ScanLine,
  Send,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Truck,
  Wrench,
} from "lucide-react";

const tabs = [
  { id: "identity", label: "Identity & wallet", icon: IdCard },
  { id: "units", label: "Units & job crew", icon: Truck },
  { id: "load", label: "Load & placards", icon: PackageCheck },
  { id: "facilities", label: "Facilities", icon: MapPin },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "emergency", label: "Emergency", icon: Siren },
] as const;

type FleetTab = (typeof tabs)[number]["id"];

const demoDocuments = [
  {
    title: "Driver's licence",
    meta: "Class 1 · expires Sep 18, 2026",
    state: "Verified",
    tone: "green",
  },
  {
    title: "TDG / HazMat certificate",
    meta: "Renewal due in 41 days",
    state: "Expiring soon",
    tone: "amber",
  },
  {
    title: "Company authorization",
    meta: "Northline Energy · verified Aug 12",
    state: "Verified",
    tone: "green",
  },
  {
    title: "Medical fitness record",
    meta: "Source scan awaiting confirmation",
    state: "Needs review",
    tone: "orange",
  },
];

const demoUnits = [
  {
    unitNumber: "247",
    vehicleType: "Hydrovac",
    plate: "NR-247",
    vin: "1HVG247NR26…",
    equipment: "Tank 04 · trailer 882",
    status: "Ready for dispatch",
    detail: "Inspection current · 1,240 km to service",
    tone: "green",
  },
  {
    unitNumber: "312",
    vehicleType: "Vacuum trailer",
    plate: "VT-312",
    vin: "1VAC312VT26…",
    equipment: "Vacuum pod · hose kit",
    status: "Joined JOB-08421",
    detail: "Joined at 10:42 · support unit",
    tone: "blue",
  },
  {
    unitNumber: "118",
    vehicleType: "Water truck",
    plate: "WT-118",
    vin: "1WTR118WT26…",
    equipment: "Baffled tank · pump",
    status: "Inspection due",
    detail: "Pre-trip required before dispatch",
    tone: "amber",
  },
];

function Status({
  label,
  tone = "slate",
}: {
  label: string;
  tone?: "green" | "amber" | "orange" | "blue" | "slate" | "red";
}) {
  const styles = {
    green: "bg-[#e3f6ef] text-[#238a72]",
    amber: "bg-[#fff1d3] text-[#9b722c]",
    orange: "bg-[#fff0ea] text-[#d65c38]",
    blue: "bg-[#e7effa] text-[#52749d]",
    red: "bg-[#ffe6e3] text-[#c45448]",
    slate: "bg-[#eef2f6] text-[#687c92]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${styles[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function PageHeader({
  tab,
  setTab,
}: {
  tab: FleetTab;
  setTab: (value: FleetTab) => void;
}) {
  return (
    <>
      <div className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
              Fleet control · controlled compliance
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              Identity, readiness, and load confidence.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Keep verified operator, vehicle, load, facility, and audit context
              together without turning the assistant into the authority.
            </p>
          </div>
          <Button
            onClick={() =>
              toast.success(
                "Scan mode is ready. Use a unit QR/NFC tag to load its profile."
              )
            }
            className="h-11 rounded-xl bg-[#ff6b42] px-5 font-semibold text-white hover:bg-[#e85d38]"
          >
            <ScanLine className="mr-2 h-4 w-4" />
            Scan unit
          </Button>
        </div>
        <div className="mt-7 flex gap-2 overflow-x-auto pb-1">
          {tabs.map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition ${tab === item.id ? "bg-[#10243f] text-white shadow-sm" : "bg-white text-[#6f8195] hover:bg-[#edf2f5]"}`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function IdentityTab() {
  const { data: operators } =
    trpc.fieldRoute.identity.operators.list.useQuery();
  const { data: documents } =
    trpc.fieldRoute.identity.documents.list.useQuery();
  const createDocument = trpc.fieldRoute.identity.documents.create.useMutation({
    onSuccess: () => toast.success("Document captured as needs review."),
    onError: error => toast.error(error.message),
  });
  const reviewDocument = trpc.fieldRoute.identity.documents.review.useMutation({
    onSuccess: () => toast.success("Document review saved."),
    onError: error => toast.error(error.message),
  });
  const operator = operators?.[0];
  const docs = documents?.length
    ? documents.map(item => ({
        id: item.id,
        title: item.title,
        meta: item.expiresAt
          ? `Expires ${new Date(item.expiresAt).toLocaleDateString()}`
          : "No expiry recorded",
        state:
          item.verificationStatus === "verified"
            ? "Verified"
            : item.verificationStatus === "rejected"
              ? "Rejected"
              : "Needs review",
        tone: item.verificationStatus === "verified" ? "green" : "orange",
      }))
    : demoDocuments.map(item => ({ ...item, id: undefined }));
  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="flex flex-row items-start justify-between px-5 py-5 sm:px-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
                Authenticated operator
              </p>
              <CardTitle className="mt-2 text-2xl tracking-[-0.05em] text-[#172033]">
                {operator?.name || "Dylan Hutchings"}
              </CardTitle>
              <p className="mt-1 text-sm text-[#8492a4]">
                {operator?.company || "Northline Energy"} · Driver profile
              </p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#e3f6ef] text-[#238a72]">
              <Fingerprint className="h-6 w-6" />
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 border-t border-[#eef1f4] px-5 py-5 sm:grid-cols-2 sm:px-6">
            <Info
              label="Licence"
              value={operator?.licenseClass || "Class 1 · unrestricted"}
              icon={IdCard}
            />
            <Info
              label="Licence expiry"
              value={
                operator?.licenseExpiresAt
                  ? new Date(operator.licenseExpiresAt).toLocaleDateString()
                  : "Sep 18, 2026"
              }
              icon={CalendarClock}
              tone="amber"
            />
            <Info
              label="Training"
              value={operator?.trainingStatus || "TDG · Hydrovac · current"}
              icon={HardHat}
            />
            <Info
              label="Emergency contact"
              value={
                operator?.emergencyContact || "Operations desk · 1-800-555-0147"
              }
              icon={Phone}
            />
            <Info
              label="Certifications"
              value={
                operator?.certifications ||
                "TDG · confined space · site orientation"
              }
              icon={BadgeCheck}
            />
            <Info
              label="Insurance"
              value={operator?.insurance || "Northline fleet policy · current"}
              icon={ShieldCheck}
            />
          </CardContent>
          <div className="flex flex-wrap items-center gap-3 border-t border-[#eef1f4] px-5 py-4 sm:px-6">
            <Button
              onClick={() =>
                toast.success(
                  "Device biometric challenge opened. Raw biometric data is never stored."
                )
              }
              className="h-10 rounded-xl bg-[#10243f] text-xs font-semibold text-white hover:bg-[#1c385b]"
            >
              <Fingerprint className="mr-2 h-4 w-4" />
              Authenticate device
            </Button>
            <Button
              onClick={() =>
                toast.success("Operator profile edit mode opened.")
              }
              variant="outline"
              className="h-10 rounded-xl border-[#dce4eb] bg-white text-xs text-[#566b82]"
            >
              Edit profile
            </Button>
          </div>
        </Card>
        <Card className="border-[#f3d9ca] bg-[#fff8f4] shadow-[0_10px_35px_rgba(210,100,60,0.06)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#ffeadf] text-[#e45d3b]">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-[15px] text-[#3a4655]">
                  Document readiness
                </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.identity.documents.list", documents, { whenEmpty: "no compliance document exists on this database yet" })} />
                <p className="mt-1 text-xs text-[#a27d70]">
                  OCR proposes fields; a human confirms before authority.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5 sm:px-6">
            <div className="flex items-end justify-between">
              <span className="text-4xl font-semibold tracking-[-0.06em] text-[#c55637]">
                3 / 4
              </span>
              <span className="text-xs font-semibold text-[#a27d70]">
                ready to dispatch
              </span>
            </div>
            <div className="mt-4 h-2 rounded-full bg-[#f5dfd3]">
              <div className="h-2 w-3/4 rounded-full bg-[#ff6b42]" />
            </div>
            <p className="mt-4 text-xs leading-5 text-[#906e63]">
              One document needs review and the TDG certificate is approaching
              expiry. The system will flag both before dispatch.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
        <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
          <div>
            <CardTitle className="text-[15px] text-[#172033]">
              Secure document wallet
            </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.identity.documents.list", documents, { whenEmpty: "no compliance document exists on this database yet" })} />
            <p className="mt-1 text-xs text-[#8492a4]">
              Driver licence, insurance, permits, certificates, and
              authorizations.
            </p>
          </div>
          <Status label="OCR review required" tone="orange" />
          <Button
            onClick={() =>
              createDocument.mutate({
                ownerType: "operator",
                ownerId: operator?.id || 1,
                docType: "field_capture",
                title: "New field document",
                capturedAt: new Date(),
                source: "Operator capture",
                confidence: "low",
              })
            }
            variant="outline"
            className="h-9 rounded-lg border-[#dce4eb] bg-white text-xs text-[#536981]"
          >
            <Camera className="mr-2 h-3.5 w-3.5" />
            Capture document
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-6">
          {docs.map((doc, index) => (
            <div
              key={`${doc.title}-${index}`}
              className="flex items-center gap-3 rounded-2xl border border-[#edf0f3] p-4"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#edf2f7] text-[#547294]">
                <FileText className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#43556b]">
                  {doc.title}
                </p>
                <p className="mt-1 truncate text-xs text-[#8b99aa]">
                  {doc.meta}
                </p>
                <p className="mt-1 text-[10px] text-[#9aa7b4]">
                  OCR fields: name · expiry · document class
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Status
                  label={doc.state}
                  tone={doc.tone as "green" | "amber" | "orange"}
                />
                {doc.id && doc.state === "Needs review" && (
                  <>
                    <button
                      onClick={() =>
                        reviewDocument.mutate({
                          id: doc.id!,
                          status: "verified",
                        })
                      }
                      className="rounded-md p-1 text-[#238a72] hover:bg-[#e3f6ef]"
                      title="Approve OCR fields"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        reviewDocument.mutate({
                          id: doc.id!,
                          status: "rejected",
                        })
                      }
                      className="rounded-md p-1 text-[#c45448] hover:bg-[#ffe6e3]"
                      title="Reject OCR fields"
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function UnitsTab() {
  const { data: units } = trpc.fieldRoute.identity.units.list.useQuery();
  const { data: documents } =
    trpc.fieldRoute.identity.documents.list.useQuery();
  const { data: jobUnits } = trpc.fieldRoute.identity.jobUnits.list.useQuery();
  const createUnit = trpc.fieldRoute.identity.units.create.useMutation({
    onSuccess: () => toast.success("Unit identity created."),
    onError: error => toast.error(error.message),
  });
  const rows = units?.length
    ? units.map(unit => ({
        unitNumber: unit.unitNumber,
        vehicleType: unit.vehicleType,
        plate: unit.plate || "Plate pending",
        vin: unit.vin || "VIN pending",
        equipment: unit.equipment || "Equipment profile pending",
        status:
          unit.maintenanceStatus === "clear"
            ? "Ready for dispatch"
            : "Maintenance review",
        detail: `${unit.inspectionStatus} inspection · ${unit.qrTag || "QR tag not assigned"}`,
        tone: unit.maintenanceStatus === "clear" ? "green" : "amber",
      }))
    : demoUnits;
  return (
    <div className="space-y-6">
      <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
            <div>
              <CardTitle className="text-[15px] text-[#172033]">
                Unit identity wallet
              </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.identity.units.list", units, { whenEmpty: "no unit exists on this database yet" })} />
              <p className="mt-1 text-xs text-[#8492a4]">
                Scan a physical unit to load its verified configuration.
              </p>
            </div>
            <Button
              onClick={() =>
                createUnit.mutate({
                  unitNumber: `NEW-${Date.now().toString().slice(-4)}`,
                  vehicleType: "Field unit",
                  qrTag: "pending-scan",
                })
              }
              className="h-9 rounded-lg bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
            >
              <QrCode className="mr-2 h-3.5 w-3.5" />
              Add unit
            </Button>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
            {rows.map((unit, index) => (
              <div
                key={`${unit.unitNumber}-${index}`}
                className="flex items-center gap-3 rounded-2xl border border-[#edf0f3] p-4"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#e8f0fb] text-[#52749d]">
                  <Truck className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-[#2f4055]">
                      Unit {unit.unitNumber} · {unit.vehicleType}
                    </p>
                    <Status
                      label={unit.status}
                      tone={unit.tone as "green" | "amber" | "blue"}
                    />
                  </div>
                  <p className="mt-1 text-xs text-[#8492a4]">
                    {unit.plate} · VIN {unit.vin}
                  </p>
                  <p className="mt-1 text-[11px] text-[#9aa7b4]">
                    {unit.equipment} · {unit.detail} · documents linked
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 text-[#a0adbb]" />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-2">
              <PackageCheck className="h-5 w-5 text-[#238a72]" />
              <CardTitle className="text-[15px] text-[#254e46]">
                JOB-08421 · multi-unit crew
              </CardTitle>
            </div>
            <p className="mt-2 text-xs text-[#729189]">
              Every associated unit is timestamped for work and billing context.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
            {jobUnits?.length ? (
              jobUnits.map(item => (
                <CrewRow
                  key={item.id}
                  unit={`Unit ${item.unitId}`}
                  role={item.role}
                  time={`Joined ${new Date(item.joinedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${item.hours || 0} hr · ${item.mileage || 0} km`}
                />
              ))
            ) : (
              <>
                <CrewRow
                  unit="Hydrovac 247"
                  role="Primary unit"
                  time="Started 07:12"
                />
                <CrewRow
                  unit="Vacuum 312"
                  role="Support unit"
                  time="Joined 10:42"
                />
                <CrewRow
                  unit="Water truck 118"
                  role="Standby"
                  time="Available to add"
                  muted
                />
              </>
            )}
            <div className="mt-4 overflow-x-auto rounded-xl border border-[#cfe8dd] bg-white">
              <div className="grid min-w-[620px] grid-cols-[1.2fr_.9fr_.7fr_.7fr_1.2fr] gap-3 border-b border-[#e2f0ea] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-[#8aa79f]">
                <span>Unit / role</span>
                <span>Arrival / departure</span>
                <span>Hours</span>
                <span>Mileage</span>
                <span>Work / billing</span>
              </div>
              <div className="grid min-w-[620px] grid-cols-[1.2fr_.9fr_.7fr_.7fr_1.2fr] gap-3 px-3 py-3 text-[11px] text-[#587d73]">
                <span>247 · primary</span>
                <span>07:12 → active</span>
                <span>8.4 hr</span>
                <span>—</span>
                <span>$1,428 · disposal haul</span>
              </div>
              <div className="grid min-w-[620px] grid-cols-[1.2fr_.9fr_.7fr_.7fr_1.2fr] gap-3 border-t border-[#eef5f2] px-3 py-3 text-[11px] text-[#587d73]">
                <span>312 · support</span>
                <span>10:42 → active</span>
                <span>5.2 hr</span>
                <span>42 km</span>
                <span>$624 · hose transfer</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
        <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
          <div>
            <CardTitle className="text-[15px] text-[#172033]">
              Unit document wallet
            </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.identity.documents.list", documents, { whenEmpty: "no compliance document exists on this database yet" })} />
            <p className="mt-1 text-xs text-[#8492a4]">
              VIN, inspection, insurance, and equipment records linked to a
              physical unit.
            </p>
          </div>
          <Status
            label={`${documents?.filter(item => item.ownerType === "unit").length || 2} linked`}
            tone="blue"
          />
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-3">
          <Field label="Unit 247 · VIN" value="1HVG247NR26…" />
          <Field label="Inspection record" value="Pre-trip · current" />
          <Field label="Equipment pack" value="Tank 04 · trailer 882" />
        </CardContent>
      </Card>
      <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
        <CardHeader className="px-5 py-5 sm:px-6">
          <CardTitle className="text-[15px] text-[#172033]">
            Travel readiness engine
          </CardTitle>
              <PanelSourceBadge source={demonstration("the readiness engine is not run on this page; these states are the demonstration layout")} />
          <p className="mt-1 text-xs text-[#8492a4]">
            Documented conditions only; not a mechanic, legal determination, or
            guarantee.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-4">
          <Readiness
            label="Critical defects"
            value="None recorded"
            tone="green"
          />
          <Readiness label="Brake inspection" value="Current" tone="green" />
          <Readiness
            label="Right rear tire"
            value="Review required"
            tone="amber"
          />
          <Readiness label="Route restrictions" value="Verified" tone="blue" />
        </CardContent>
      </Card>
    </div>
  );
}

function LoadTab() {
  const [material, setMaterial] = useState("Used drilling fluid · invert mud");
  const [classified, setClassified] = useState(false);
  const createLoad = trpc.fieldRoute.compliance.loads.create.useMutation({
    onSuccess: () => toast.success("Load profile saved as needs verification."),
    onError: error => toast.error(error.message),
  });
  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[1fr_390px]">
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#e7effa] text-[#52749d]">
                <BrainCircuit className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Tell the app what you’re hauling
                </CardTitle>
              <PanelSourceBadge source={demonstration("this is the form on this page, not a classified load record")} />
                <p className="mt-1 text-xs text-[#8492a4]">
                  Voice or text becomes a structured load profile for review.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 px-5 pb-5 sm:px-6">
            <div className="rounded-2xl border border-[#dfe7ee] bg-[#fbfcfd] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#96a2b0]">
                Operator statement
              </p>
              <p className="mt-2 text-sm leading-6 text-[#52657d]">
                “I’m hauling used drilling fluid, mostly invert mud, from the
                lease to the disposal facility.”
              </p>
            </div>
            <label className="block">
              <span className="text-xs font-semibold text-[#576b82]">
                Material profile
              </span>
              <textarea
                value={material}
                onChange={event => setMaterial(event.target.value)}
                className="mt-2 min-h-24 w-full rounded-xl border border-[#dfe6ee] bg-white p-3 text-sm text-[#4b6077] outline-none focus:border-[#ff9c7f] focus:ring-2 focus:ring-[#fff0ea]"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Waste?" value="Yes · requires classification" />
              <Field label="SDS" value="Scan required" />
              <Field label="UN number" value="Unknown" />
              <Field label="Jurisdiction" value="Alberta · road transport" />
            </div>
            <div className="rounded-xl border border-[#f3d9ca] bg-[#fff8f4] p-4">
              <div className="flex gap-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#d15b3a]" />
                <div>
                  <p className="text-xs font-semibold text-[#8f4936]">
                    Verification boundary
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[#9f7365]">
                    The assistant will not invent a UN number, placard, or
                    classification. Attach an SDS or authoritative source before
                    this profile can become transport-ready.
                  </p>
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Source" value="Operator statement · SDS pending" />
              <Field label="Confidence" value="Low · review required" />
              <Field
                label="Classification"
                value={classified ? "Review requested" : "Needs verification"}
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() =>
                  createLoad.mutate({
                    jobId: 1,
                    material,
                    isWaste: true,
                    jurisdiction: "Alberta",
                    confidence: "low",
                    source: "Operator statement; SDS pending",
                  })
                }
                className="h-10 rounded-xl bg-[#10243f] text-xs font-semibold text-white hover:bg-[#1c385b]"
              >
                <FileCheck2 className="mr-2 h-4 w-4" />
                Save as needs verification
              </Button>
              <Button
                onClick={() =>
                  toast.success(
                    "SDS capture started. Confirm extracted fields before saving."
                  )
                }
                variant="outline"
                className="h-10 rounded-xl border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                <Camera className="mr-2 h-4 w-4" />
                Scan SDS
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <CardTitle className="text-[15px] text-[#172033]">
              Placard assistant
            </CardTitle>
              <PanelSourceBadge source={demonstration("a placard suggestion is a candidate for a person to verify, never a certification; nothing here is read from a TDG record")} />
            <p className="mt-1 text-xs text-[#8492a4]">
              Populates only after classification is verified.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 px-5 pb-5 sm:px-6">
            <div className="rounded-2xl bg-[#f5f7fa] p-5 text-center">
              <Truck className="mx-auto h-9 w-9 text-[#8b9aae]" />
              <p className="mt-3 text-sm font-semibold text-[#53677d]">
                Unit 247
              </p>
              <p className="mt-1 text-xs text-[#93a0ae]">
                Front · left · right · rear
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <Placard side="Front" />
                <Placard side="Rear" />
                <Placard side="Left" />
                <Placard side="Right" />
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-[#f3d9ca] bg-[#fff8f4] p-3">
              <AlertTriangle className="h-4 w-4 text-[#d15b3a]" />
              <span className="text-xs font-medium text-[#8f4936]">
                No placard recommendation until verified.
              </span>
            </div>
            <Button
              onClick={() => {
                setClassified(true);
                toast.success(
                  "Classification remains needs verification until an SDS/source is confirmed."
                );
              }}
              variant="outline"
              className="h-10 w-full rounded-xl border-[#dfe6ee] bg-white text-xs text-[#536981]"
            >
              {classified ? "Verification requested" : "Request source review"}
              <ArrowRight className="ml-2 h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FacilitiesTab() {
  const { data: facilities } =
    trpc.fieldRoute.compliance.facilities.list.useQuery();
  const createFacility =
    trpc.fieldRoute.compliance.facilities.create.useMutation({
      onSuccess: () =>
        toast.success("Facility added to the intelligence index."),
      onError: error => toast.error(error.message),
    });
  const facility = facilities?.[0];
  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="flex flex-row items-start justify-between px-5 py-5 sm:px-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
                Disposal facility
              </p>
              <CardTitle className="mt-2 text-2xl tracking-[-0.05em] text-[#172033]">
                {facility?.name || "West Ridge Disposal"}
              </CardTitle>
              <p className="mt-1 text-sm text-[#8492a4]">
                {facility?.operatingHours || "Open · 06:00–18:00"} · last
                verified today
              </p>
            </div>
            <Status
              label={facility?.status === "closed" ? "Closed" : "Open"}
              tone={facility?.status === "closed" ? "red" : "green"}
            />
          </CardHeader>
          <CardContent className="grid gap-4 border-t border-[#eef1f4] px-5 py-5 sm:grid-cols-2 sm:px-6">
            <Info
              label="Accepted materials"
              value={
                facility?.acceptedMaterials ||
                "Produced water · drilling waste · invert mud"
              }
              icon={PackageCheck}
            />
            <Info
              label="Restrictions"
              value={facility?.restrictions || "Appointment after 16:00"}
              icon={ShieldAlert}
              tone="amber"
            />
            <Info
              label="Gate instructions"
              value={
                facility?.gateInstructions ||
                "Scale first · bay 3 · show manifest"
              }
              icon={MapPin}
            />
            <Info
              label="Emergency contact"
              value={facility?.emergencyPhone || "1-800-555-0199"}
              icon={Phone}
            />
          </CardContent>
          <div className="flex flex-wrap gap-3 border-t border-[#eef1f4] px-5 py-4 sm:px-6">
            <Button
              onClick={() =>
                toast.success("Calling the authorized facility contact.")
              }
              className="h-10 rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
            >
              <Phone className="mr-2 h-4 w-4" />
              Call facility
            </Button>
            <Button
              onClick={() =>
                toast.success("Facility route context opened on the field map.")
              }
              variant="outline"
              className="h-10 rounded-xl border-[#dfe6ee] bg-white text-xs text-[#536981]"
            >
              <MapPin className="mr-2 h-4 w-4" />
              Open route context
            </Button>
          </div>
        </Card>
        <Card className="border-[#f3d9ca] bg-[#fff8f4] shadow-[0_10px_35px_rgba(210,100,60,0.06)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-2">
              <Clock3 className="h-5 w-5 text-[#d15b3a]" />
              <CardTitle className="text-[15px] text-[#6f4135]">
                Dangerous-hours alert
              </CardTitle>
              <PanelSourceBadge source={demonstration("the alert is laid out to show the shape of the screen; no duty record or HOS rule is read here")} />
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5 sm:px-6">
            <p className="text-4xl font-semibold tracking-[-0.06em] text-[#c55637]">
              19:12
            </p>
            <p className="mt-1 text-sm font-semibold text-[#8f4936]">
              ETA exceeds normal close
            </p>
            <p className="mt-3 text-xs leading-5 text-[#a27366]">
              Route context says the facility normally closes at 18:00. Confirm
              appointment or reroute before departure.
            </p>
            <Button
              onClick={() =>
                toast.success("Appointment confirmation task created.")
              }
              className="mt-5 h-10 w-full rounded-xl bg-[#ff6b42] text-xs font-semibold text-white hover:bg-[#e85d38]"
            >
              Create confirmation task{" "}
              <ArrowRight className="ml-2 h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>
      </div>
      <Button
        onClick={() =>
          createFacility.mutate({
            name: "New disposal facility",
            status: "unknown",
            operatingHours: "Confirm hours",
            acceptedMaterials: "Needs verification",
            lastVerifiedAt: new Date(),
          })
        }
        variant="outline"
        className="h-10 rounded-xl border-[#dfe6ee] bg-white text-xs text-[#536981]"
      >
        <MapPin className="mr-2 h-4 w-4" />
        Add facility record
      </Button>
    </div>
  );
}

function MaintenanceTab() {
  const { data: defects } =
    trpc.fieldRoute.compliance.maintenance.list.useQuery();
  const createDefect =
    trpc.fieldRoute.compliance.maintenance.create.useMutation({
      onSuccess: () =>
        toast.success("Maintenance defect logged as an open work order."),
      onError: error => toast.error(error.message),
    });
  const createInspection =
    trpc.fieldRoute.identity.inspections.create.useMutation({
      onSuccess: () => toast.success("Actual pre-trip inspection saved."),
      onError: error => toast.error(error.message),
    });
  const [trainingStep, setTrainingStep] = useState(0);
  const [defectNote, setDefectNote] = useState(
    "Hydraulic hose leak near fitting; photograph before work order."
  );
  const [checklist, setChecklist] = useState(
    ["Tires", "Brakes", "Lights", "Hydraulics"].map(label => ({
      label,
      done: false,
    }))
  );
  const training = ["Tires", "Brakes", "Hydraulics", "Load securement"];
  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="flex flex-row items-start justify-between px-5 py-5 sm:px-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8998aa]">
                Mechanic mode
              </p>
              <CardTitle className="mt-2 text-2xl tracking-[-0.05em] text-[#172033]">
                Unit 247 health
              </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.compliance.maintenance.list", defects, { whenEmpty: "no maintenance defect exists on this database yet" })} />
              <p className="mt-1 text-sm text-[#8492a4]">
                Photograph defects, parts, odometers, and completed repairs.
              </p>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#fff0ea] text-[#e45d3b]">
              <Wrench className="h-5 w-5" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
            <HealthRow label="Engine" value="Clear" tone="green" />
            <HealthRow
              label="Brakes"
              value="Inspection required"
              tone="amber"
            />
            <HealthRow
              label="Right rear tire"
              value="Slow leak recorded"
              tone="amber"
            />
            <HealthRow
              label="Hydraulics"
              value="Hose leak · work order open"
              tone="red"
            />
            <HealthRow label="Next service" value="1,240 km" tone="blue" />
            <Separator className="my-4" />
            <textarea
              value={defectNote}
              onChange={event => setDefectNote(event.target.value)}
              className="min-h-16 w-full rounded-xl border border-[#dfe6ee] bg-[#fbfcfd] p-3 text-xs text-[#52657d] outline-none focus:border-[#ff9c7f]"
              placeholder="Describe the observed defect and follow-up needed"
            />
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() =>
                  createDefect.mutate({
                    unitId: 1,
                    title: "Hydraulic hose leak",
                    severity: "inspection_required",
                    detail: defectNote,
                    reportedAt: new Date(),
                  })
                }
                className="h-10 rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
              >
                <Camera className="mr-2 h-4 w-4" />
                Report defect
              </Button>
              <Button
                onClick={() =>
                  toast.success("Work order photo capture started.")
                }
                variant="outline"
                className="h-10 rounded-xl border-[#dfe6ee] bg-white text-xs text-[#536981]"
              >
                <FileText className="mr-2 h-4 w-4" />
                Photograph work order
              </Button>
            </div>
            {defects?.length ? (
              <p className="pt-2 text-xs text-[#7890a0]">
                {defects.length} persisted maintenance record
                {defects.length === 1 ? "" : "s"} linked to units.
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-[#238a72]" />
              <CardTitle className="text-[15px] text-[#254e46]">
                Interactive pre-trip training
              </CardTitle>
            </div>
            <p className="mt-2 text-xs text-[#729189]">
              Training and actual inspection use the same field procedure
              vocabulary.
            </p>
          </CardHeader>
          <CardContent className="px-5 pb-5 sm:px-6">
            <div className="rounded-2xl border border-[#cfe8dd] bg-white p-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#78a193]">
                Prompt {trainingStep + 1} of {training.length}
              </p>
              <p className="mt-3 text-lg font-semibold text-[#315c53]">
                What are you checking next?
              </p>
              <p className="mt-2 text-sm text-[#6f8f87]">
                {training[trainingStep]}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setTrainingStep((trainingStep + 1) % training.length);
                    toast.success("Training response recorded.");
                  }}
                  className="h-9 rounded-lg bg-[#2e9c82] text-xs text-white hover:bg-[#25846f]"
                >
                  <Check className="mr-2 h-3.5 w-3.5" />
                  Pass
                </Button>
                <Button
                  onClick={() =>
                    toast.warning(
                      "Training response recorded as needs maintenance."
                    )
                  }
                  variant="outline"
                  className="h-9 rounded-lg border-[#f3d9ca] bg-white text-xs text-[#9b722c]"
                >
                  <AlertTriangle className="mr-2 h-3.5 w-3.5" />
                  Needs maintenance
                </Button>
              </div>
            </div>
            <p className="mt-4 text-[11px] leading-5 text-[#729189]">
              Real inspection outcomes remain governed by applicable law,
              company procedure, qualified inspection, and actual observations.
            </p>
          </CardContent>
        </Card>
      </div>
      <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
        <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
          <div>
            <CardTitle className="text-[15px] text-[#172033]">
              Actual pre-trip inspection
            </CardTitle>
            <p className="mt-1 text-xs text-[#8492a4]">
              Record observed conditions separately from training prompts.
            </p>
          </div>
          <Status
            label={`${checklist.filter(item => item.done).length}/${checklist.length} complete`}
            tone={checklist.every(item => item.done) ? "green" : "amber"}
          />
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
          <div className="grid gap-2 sm:grid-cols-2">
            {checklist.map((item, index) => (
              <button
                key={item.label}
                onClick={() =>
                  setChecklist(items =>
                    items.map((entry, itemIndex) =>
                      itemIndex === index
                        ? { ...entry, done: !entry.done }
                        : entry
                    )
                  )
                }
                className="flex items-center gap-3 rounded-xl border border-[#edf0f3] p-3 text-left"
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-lg ${item.done ? "bg-[#e3f6ef] text-[#238a72]" : "bg-[#f1f4f7] text-[#9ba8b5]"}`}
                >
                  {item.done ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-current" />
                  )}
                </span>
                <span className="text-xs font-semibold text-[#52657d]">
                  {item.label}
                </span>
              </button>
            ))}
          </div>
          <Button
            disabled={!checklist.every(item => item.done)}
            onClick={() =>
              createInspection.mutate({
                unitId: 1,
                type: "pre_trip",
                status: "pass",
                checklist: JSON.stringify(checklist),
                resultSummary: "Operator-confirmed actual pre-trip inspection.",
                observedAt: new Date(),
                authenticatedOperatorId: 1,
              })
            }
            className="h-10 w-full rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ClipboardCheck className="mr-2 h-4 w-4" />
            Save actual pre-trip
          </Button>
        </CardContent>
      </Card>
      <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
        <CardHeader className="px-5 py-5 sm:px-6">
          <CardTitle className="text-[15px] text-[#172033]">
            Post-trip handoff
          </CardTitle>
          <p className="mt-1 text-xs text-[#8492a4]">
            Voice notes can become maintenance work orders after operator
            confirmation.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3 px-5 pb-5 sm:px-6">
          <HealthRow label="Damage" value="No new report" tone="green" />
          <HealthRow label="Leaks" value="Hydraulic hose · open" tone="amber" />
          <HealthRow
            label="Missing equipment"
            value="None reported"
            tone="green"
          />
        </CardContent>
      </Card>{" "}
    </div>
  );
}

function EmergencyTab() {
  const { data: deliveries } =
    trpc.fieldRoute.compliance.deliveries.list.useQuery();
  const [deviceConfirmed, setDeviceConfirmed] = useState(false);
  const sign = trpc.fieldRoute.compliance.sign.useMutation({
    onSuccess: () =>
      toast.success("Device-authenticated signature audit recorded."),
    onError: error => toast.error(error.message),
  });
  const delivery = trpc.fieldRoute.compliance.deliveries.create.useMutation({
    onSuccess: () =>
      toast.success("Completion package queued for authorized recipients."),
    onError: error => toast.error(error.message),
  });
  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
        <Card className="border-[#f2d5d1] bg-[#fff7f6] shadow-[0_10px_35px_rgba(196,84,72,0.06)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#c45448] text-white">
                <Siren className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-[15px] text-[#773d38]">
                  Emergency quick view
                </CardTitle>
                <p className="mt-1 text-xs text-[#a87872]">
                  One press presents context; it does not replace emergency
                  services.
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
            <EmergencyRow
              label="Current location"
              value="North Ridge · County 214 km 18"
            />
            <EmergencyRow
              label="Vehicle / load"
              value="Hydrovac 247 · invert mud"
            />
            <EmergencyRow
              label="Placards / SDS"
              value="Classification needs verification"
              warn
            />
            <EmergencyRow
              label="Nearest response"
              value="Hospital · fire · police · road authority"
            />
            <Button
              onClick={() =>
                toast.error(
                  "Emergency call handoff prepared. Confirm before placing a call."
                )
              }
              className="mt-3 h-11 w-full rounded-xl bg-[#c45448] text-xs font-semibold text-white hover:bg-[#aa443a]"
            >
              <Phone className="mr-2 h-4 w-4" />
              Call emergency services
            </Button>
          </CardContent>
        </Card>
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <div className="flex items-center gap-2">
              <Send className="h-5 w-5 text-[#52749d]" />
              <CardTitle className="text-[15px] text-[#172033]">
                Completion package & audit
              </CardTitle>
            </div>
            <p className="mt-2 text-xs text-[#8492a4]">
              BOL, tickets, photos, unit records, signature, work summary, and
              invoice.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 px-5 pb-5 sm:px-6">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                "BOL",
                "Field ticket",
                "Waste manifest",
                "Disposal ticket",
                "Photos",
                "Unit records",
                "Customer signature",
                "Invoice",
              ].map(item => (
                <div
                  key={item}
                  className="flex items-center gap-2 rounded-lg bg-[#f5f8fa] px-3 py-2 text-xs font-medium text-[#5e7187]"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-[#2e9c82]" />
                  {item}
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-[#dfe7ee] bg-[#fbfcfd] p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-[#52657d]">
                    Biometric-assisted sign
                  </p>
                  <p className="mt-1 text-[11px] text-[#8b99aa]">
                    Device auth result only · raw biometrics never retained
                  </p>
                </div>
                <Fingerprint className="h-5 w-5 text-[#52749d]" />
              </div>
              <Button
                onClick={() => {
                  if (!deviceConfirmed) {
                    setDeviceConfirmed(true);
                    toast.success(
                      "Device confirmation captured. Review the package, then confirm the signature."
                    );
                    return;
                  }
                  sign.mutate({
                    jobId: 1,
                    signerName: "Dylan Hutchings",
                    signedAt: new Date(),
                  });
                }}
                className="mt-3 h-10 w-full rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {deviceConfirmed
                  ? "Confirm signature handoff"
                  : "Confirm device identity"}
              </Button>
            </div>
            <Button
              onClick={() =>
                delivery.mutate({
                  jobId: 1,
                  recipientRole: "customer",
                  recipient: "Configured authorized recipients",
                  status: "queued",
                })
              }
              variant="outline"
              className="h-10 w-full rounded-xl border-[#dfe6ee] bg-white text-xs text-[#536981]"
            >
              <Send className="mr-2 h-4 w-4" />
              Send to authorized recipients
            </Button>
            <div className="rounded-xl border border-[#edf0f3] bg-[#fbfcfd] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold text-[#52657d]">
                  Delivery audit trail
                </p>
                <span className="text-[10px] text-[#91a0ae]">
                  {deliveries?.length || 0} persisted
                </span>
              </div>
              {(deliveries?.length
                ? deliveries.map(item => ({
                    role: item.recipientRole,
                    recipient: item.recipient,
                    status: item.status,
                  }))
                : [
                    {
                      role: "customer",
                      recipient: "Configured customer",
                      status: "queued",
                    },
                    {
                      role: "dispatcher",
                      recipient: "Operations desk",
                      status: "queued",
                    },
                    {
                      role: "accounting",
                      recipient: "Accounting queue",
                      status: "queued",
                    },
                  ]
              ).map((item, index) => (
                <div
                  key={`${item.role}-${index}`}
                  className="flex items-center justify-between border-t border-[#edf0f3] py-2 text-[11px]"
                >
                  <span className="text-[#7b8c9c]">
                    {item.role} · {item.recipient}
                  </span>
                  <Status
                    label={item.status === "delivered" ? "Delivered" : "Queued"}
                    tone={item.status === "delivered" ? "green" : "blue"}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Info({
  label,
  value,
  icon: Icon,
  tone = "blue",
}: {
  label: string;
  value: string;
  icon: typeof IdCard;
  tone?: "blue" | "amber";
}) {
  return (
    <div className="flex gap-3">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone === "amber" ? "bg-[#fff1d3] text-[#9b722c]" : "bg-[#e7effa] text-[#52749d]"}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa6b4]">
          {label}
        </p>
        <p className="mt-1 text-xs font-semibold leading-5 text-[#52657d]">
          {value}
        </p>
      </div>
    </div>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#edf0f3] p-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[#9aa6b4]">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold text-[#52657d]">{value}</p>
    </div>
  );
}
function Placard({ side }: { side: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[#cfd8e0] bg-white py-2 text-[10px] font-semibold text-[#9ba7b4]">
      <span className="block">{side}</span>
      <span className="mt-1 block text-[#c5ccd4]">VERIFY</span>
    </div>
  );
}
function CrewRow({
  unit,
  role,
  time,
  muted = false,
}: {
  unit: string;
  role: string;
  time: string;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 ${muted ? "border-dashed border-[#cfe8dd] bg-white/60" : "border-[#e2f0ea] bg-white"}`}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#e3f6ef] text-[#238a72]">
        <Truck className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-[#41675f]">{unit}</p>
        <p className="mt-0.5 text-[10px] text-[#82a097]">
          {role} · {time}
        </p>
      </div>
      {!muted && <CheckCircle2 className="h-4 w-4 text-[#2e9c82]" />}
    </div>
  );
}
function Readiness({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "amber" | "blue";
}) {
  return (
    <div className="rounded-xl border border-[#edf0f3] p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9aa6b4]">
          {label}
        </p>
        <span
          className={`h-2 w-2 rounded-full ${tone === "green" ? "bg-[#2e9c82]" : tone === "amber" ? "bg-[#d08b36]" : "bg-[#52749d]"}`}
        />
      </div>
      <p className="mt-3 text-sm font-semibold text-[#52657d]">{value}</p>
    </div>
  );
}
function HealthRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "amber" | "red" | "blue";
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[#edf0f3] px-4 py-3">
      <span className="text-xs font-semibold text-[#65788d]">{label}</span>
      <Status
        label={value}
        tone={
          tone === "red"
            ? "red"
            : tone === "amber"
              ? "amber"
              : tone === "green"
                ? "green"
                : "blue"
        }
      />
    </div>
  );
}
function EmergencyRow({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#f0dedd] py-3 last:border-0">
      <span className="text-xs text-[#9f746f]">{label}</span>
      <span
        className={`text-right text-xs font-semibold ${warn ? "text-[#b3564c]" : "text-[#754a45]"}`}
      >
        {value}
      </span>
    </div>
  );
}

export default function FleetWorkspace() {
  const [tab, setTab] = useState<FleetTab>("identity");
  const Active = useMemo(
    () => tabs.find(item => item.id === tab)?.icon || IdCard,
    [tab]
  );
  return (
    <div>
      <PageHeader tab={tab} setTab={setTab} />
      <div className="px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="mb-5 flex items-center gap-2 text-xs text-[#8998aa]">
          <Active className="h-4 w-4 text-[#52749d]" />
          <span>{tabs.find(item => item.id === tab)?.label}</span>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="font-semibold text-[#52657d]">
            North Ridge operating area
          </span>
        </div>
        {tab === "identity" && <IdentityTab />}
        {tab === "units" && <UnitsTab />}
        {tab === "load" && <LoadTab />}
        {tab === "facilities" && <FacilitiesTab />}
        {tab === "maintenance" && <MaintenanceTab />}
        {tab === "emergency" && <EmergencyTab />}
      </div>
    </div>
  );
}
