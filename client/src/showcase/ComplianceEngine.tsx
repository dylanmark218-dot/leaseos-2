import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelSourceBadge } from "./SourcedPanel";
import { demonstration, fromQuery } from "./panelSource";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArrowRight,
  Check,
  ClipboardCheck,
  FileCheck2,
  FileText,
  Flag,
  History,
  Mail,
  QrCode,
  Send,
  ShieldAlert,
  Truck,
  Volume2,
} from "lucide-react";

const artifactTypes = [
  "TB Tailgate/JSA",
  "FT Field ticket",
  "BL Bill of lading",
  "DG Shipping document",
  "WM Waste manifest",
  "DT Disposal ticket",
  "DVIR Inspection",
  "WO Work order",
  "PH Photo package",
  "TR Trip passport",
];
const checklist = [
  "Operator authorization",
  "Vehicle registration / insurance",
  "Pre-trip and DVIR",
  "BOL and manifest",
  "SDS and verified classification",
  "Route permits / restrictions",
  "Disposal acceptance",
  "Customer signature",
];

export default function ComplianceEngine() {
  const { data: artifacts } =
    trpc.fieldRoute.complianceEngine.artifacts.list.useQuery();
  const { data: tailgates } =
    trpc.fieldRoute.complianceEngine.tailgates.list.useQuery();
  const { data: transfers } =
    trpc.fieldRoute.complianceEngine.transfers.list.useQuery();
  const createArtifact =
    trpc.fieldRoute.complianceEngine.artifacts.create.useMutation({
      onSuccess: () => toast.success("Tracked artifact created."),
    });
  const createTailgate =
    trpc.fieldRoute.complianceEngine.tailgates.create.useMutation({
      onSuccess: () => toast.success("Tailgate/JSA saved for review."),
    });
  const createTransfer =
    trpc.fieldRoute.complianceEngine.transfers.create.useMutation({
      onSuccess: () => toast.success("Disposal package transfer queued."),
    });
  const acknowledge =
    trpc.fieldRoute.complianceEngine.transfers.acknowledge.useMutation({
      onSuccess: () => toast.success("Recipient acknowledgement recorded."),
    });
  const [checks, setChecks] = useState(checklist.map(() => true));
  const [paperRequired, setPaperRequired] = useState(true);
  const [tailgateText, setTailgateText] = useState(
    "Discussed traffic, pressure hazards, slippery ground, chemicals, weather, equipment, and emergency shutdown procedure."
  );
  const ready = checks.every(Boolean) && !paperRequired;
  const newNumber = (prefix: string) =>
    `${prefix}-2026-${String(Date.now()).slice(-6)}`;
  return (
    <div>
      <header className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
          Compliance engine · chain of custody
        </p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              Every record, accountable.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Universal IDs connect tailgate → loading → transport → disposal →
              billing → maintenance. Electronic workflows remain subject to
              applicable authorization.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                createArtifact.mutate({
                  trackingNumber: newNumber("TR"),
                  artifactType: "TR Trip passport",
                  status: "active",
                  jurisdiction: "Canada · Alberta · Road",
                  regulatoryProfile: "TDG",
                  regulatoryVersion: "Profile pending review",
                  retentionUntil: new Date("2028-08-27T00:00:00Z"),
                  metadata: JSON.stringify({
                    job: "JOB-08421",
                    location: "04-12-034-05W5",
                    unit: "247",
                  }),
                })
              }
              className="h-10 rounded-xl bg-[#ff6b42] text-xs font-semibold text-white hover:bg-[#e85d38]"
            >
              <QrCode className="mr-2 h-4 w-4" />
              Create trip passport
            </Button>
            <Button
              onClick={() =>
                createTailgate.mutate({
                  trackingNumber: newNumber("TB"),
                  jobId: 1,
                  locationId: 1,
                  supervisor: "Dylan Hutchings",
                  operators: "Dylan Hutchings",
                  units: "247, 312, 118",
                  hazards:
                    "Traffic · pressure · ground conditions · chemicals · weather",
                  ppe: "FR, boots, eye protection, gloves",
                  controls: "Spotter, exclusion zone, emergency shutdown",
                  voiceTranscript: tailgateText,
                  reviewStatus: "needs_review",
                  startedAt: new Date(),
                })
              }
              variant="outline"
              className="h-10 rounded-xl border-[#dfe6ee] bg-white text-xs text-[#52657d]"
            >
              <ClipboardCheck className="mr-2 h-4 w-4" />
              Log tailgate
            </Button>
          </div>
        </div>
      </header>
      <main className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Tracked artifacts"
            value={String(artifacts?.length || 24)}
            note="Permanent IDs"
            icon={FileText}
          />
          <Metric
            label="Trip readiness"
            value={ready ? "100%" : "82%"}
            note={ready ? "Ready for dispatch" : "Review required"}
            icon={FileCheck2}
          />
          <Metric
            label="Tailgates"
            value={String(tailgates?.length || 3)}
            note="Voice + signatures"
            icon={ClipboardCheck}
          />
          <Metric
            label="Transfers"
            value={String(transfers?.length || 6)}
            note="Recipient delivery trail"
            icon={Send}
          />
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Job readiness · JOB-08421
                </CardTitle>
              <PanelSourceBadge source={demonstration("JOB-08421 is a demonstration job; the readiness engine is not run on this page")} />
                <p className="mt-1 text-xs text-[#8492a4]">
                  Jurisdiction: Canada · Alberta · Road · TDG profile
                </p>
              </div>
              <Badge
                className={
                  ready
                    ? "bg-[#e3f6ef] text-[#238a72]"
                    : "bg-[#fff0d2] text-[#9b722c]"
                }
              >
                {ready ? "Ready for dispatch" : "82% · review"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2 px-5 pb-5 sm:px-6">
              {checklist.map((item, i) => (
                <button
                  key={item}
                  onClick={() =>
                    setChecks(values =>
                      values.map((value, index) =>
                        index === i ? !value : value
                      )
                    )
                  }
                  className="flex w-full items-center gap-3 rounded-xl border border-[#edf0f3] p-3 text-left"
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full ${checks[i] ? "bg-[#2e9c82] text-white" : "border border-[#d6dee6] text-transparent"}`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span
                    className={`flex-1 text-xs ${checks[i] ? "font-medium text-[#52657d]" : "text-[#9aa6b4]"}`}
                  >
                    {item}
                  </span>
                  {checks[i] && (
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#2e9c82]">
                      Verified
                    </span>
                  )}
                </button>
              ))}
              <div className="mt-4 rounded-xl border border-[#f2d5d1] bg-[#fff7f6] p-4">
                <div className="flex items-start gap-3">
                  <Flag className="mt-0.5 h-4 w-4 text-[#c45448]" />
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-[#773d38]">
                      Paper document required
                    </p>
                    <p className="mt-1 text-[11px] leading-5 text-[#a87872]">
                      Electronic shipping documents do not automatically replace
                      the accompanying paper document. Clear this only when the
                      configured authorization permits the electronic workflow.
                    </p>
                  </div>
                  <button
                    onClick={() => setPaperRequired(value => !value)}
                    className="rounded-lg border border-[#edc5bf] bg-white px-2 py-1 text-[10px] font-semibold text-[#9f5147]"
                  >
                    {paperRequired ? "Required" : "Cleared"}
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
          <div className="space-y-6">
            <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
              <CardHeader className="px-5 py-5 sm:px-6">
                <div className="flex items-center gap-2">
                  <Volume2 className="h-5 w-5 text-[#238a72]" />
                  <CardTitle className="text-[15px] text-[#254e46]">
                    Tailgate / JSA voice entry
                  </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.complianceEngine.tailgates.list", tailgates, { whenEmpty: "no tailgate meeting exists on this database yet" })} />
                </div>
                <p className="mt-1 text-xs text-[#729189]">
                  Voice becomes structured fields for human review; it does not
                  self-certify compliance.
                </p>
              </CardHeader>
              <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
                <textarea
                  value={tailgateText}
                  onChange={e => setTailgateText(e.target.value)}
                  className="min-h-24 w-full rounded-xl border border-[#cfe8dd] bg-white p-3 text-xs leading-5 text-[#527c70] outline-none focus:border-[#2e9c82]"
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    label="Hazards"
                    value="Traffic · pressure · chemicals"
                  />
                  <Field label="Controls" value="Spotter · exclusion zone" />
                  <Field label="PPE" value="FR · boots · eye protection" />
                  <Field label="Review" value="Human approval required" />
                </div>
              </CardContent>
            </Card>
            <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
              <CardHeader className="px-5 py-5 sm:px-6">
                <CardTitle className="text-[15px] text-[#172033]">
                  Tracked artifact types
                </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.complianceEngine.artifacts.list", artifacts, { whenEmpty: "no compliance artifact exists on this database yet" })} />
              </CardHeader>
              <CardContent className="grid gap-2 px-5 pb-5 sm:grid-cols-2">
                {artifactTypes.map((item, i) => (
                  <div
                    key={item}
                    className="flex items-center justify-between rounded-xl border border-[#edf0f3] px-3 py-2.5 text-xs text-[#52657d]"
                  >
                    <span>{item}</span>
                    <span className="font-mono text-[10px] text-[#9aa6b4]">
                      {item.slice(0, 2).toUpperCase()}-2026-
                      {String(184 + i).padStart(6, "0")}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
        <div className="grid gap-6 xl:grid-cols-[.95fr_1.05fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Disposal package transfer
                </CardTitle>
                <p className="mt-1 text-xs text-[#8492a4]">
                  Email, portal, API, and download channels with
                  acknowledgement.
                </p>
              </div>
              <Mail className="h-5 w-5 text-[#52749d]" />
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              <div className="rounded-xl border border-[#e5ebf0] bg-[#fbfcfd] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-[#52657d]">
                      DT-2026-000114
                    </p>
                    <p className="mt-1 text-[11px] text-[#8b99aa]">
                      9 attachments · manifest · DG document · SDS · photos ·
                      scale ticket
                    </p>
                  </div>
                  <Badge className="bg-[#e8f0fb] text-[#52749d]">Pending</Badge>
                </div>
              </div>
              <Button
                onClick={() =>
                  createTransfer.mutate({
                    trackingNumber: "DT-2026-000114",
                    channel: "email",
                    recipient: "disposal@example.com",
                    deliveryStatus: "pending",
                    messageId: `msg-${Date.now()}`,
                    attachmentCount: 9,
                  })
                }
                className="h-10 w-full rounded-xl bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
              >
                <Send className="mr-2 h-4 w-4" />
                Transfer record
              </Button>
              <div className="space-y-2">
                {(transfers?.length
                  ? transfers
                  : [
                      {
                        id: undefined,
                        recipient: "disposal@example.com",
                        deliveryStatus: "confirmed",
                        channel: "email",
                      },
                      {
                        id: undefined,
                        recipient: "customer portal",
                        deliveryStatus: "opened",
                        channel: "portal",
                      },
                    ]
                ).map((item, i) => (
                  <div
                    key={`${item.recipient}-${i}`}
                    className="flex items-center justify-between border-t border-[#edf0f3] pt-2 text-[11px]"
                  >
                    <span className="text-[#8492a4]">
                      {item.recipient} · {item.channel}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#238a72]">
                        {item.deliveryStatus}
                      </span>
                      {item.id && item.deliveryStatus !== "confirmed" && (
                        <button
                          onClick={() =>
                            acknowledge.mutate({
                              id: item.id!,
                              acknowledgedBy: "Authorized recipient",
                            })
                          }
                          className="rounded-md bg-[#e3f6ef] px-2 py-1 text-[10px] font-semibold text-[#238a72]"
                        >
                          Acknowledge
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#10243f] bg-[#10243f] text-white shadow-[0_12px_35px_rgba(16,36,63,0.16)]">
            <CardHeader className="px-5 py-5 sm:px-6">
              <div className="flex items-center gap-2">
                <Truck className="h-5 w-5 text-[#ff9c7f]" />
                <CardTitle className="text-[15px] text-white">
                  Master trip compliance passport
                </CardTitle>
              </div>
              <p className="mt-1 text-xs text-[#aabbd0]">
                TR-2026-000812 · authorized record view
              </p>
            </CardHeader>
            <CardContent className="grid gap-2 px-5 pb-5 sm:grid-cols-2">
              {[
                "Driver + units",
                "Surface / downhole LSD",
                "Load + DG document",
                "Manifest + route",
                "GPS + evidence",
                "Disposal + scale",
                "Customer signature",
                "Invoice + maintenance",
              ].map(item => (
                <div
                  key={item}
                  className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs text-[#d8e3ef]"
                >
                  <ShieldAlert className="h-3.5 w-3.5 text-[#7fe0c6]" />
                  {item}
                </div>
              ))}
              <Button
                onClick={() =>
                  toast.success("Authorized trip passport view opened.")
                }
                variant="outline"
                className="mt-3 h-10 rounded-xl border-white/20 bg-white/10 text-xs text-white hover:bg-white/20"
              >
                <QrCode className="mr-2 h-4 w-4" />
                Scan / view passport{" "}
                <ArrowRight className="ml-auto h-3.5 w-3.5" />
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
    <div className="rounded-xl border border-[#dceee7] bg-white p-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-[#8aa79f]">
        {label}
      </p>
      <p className="mt-1 text-xs font-semibold text-[#527c70]">{value}</p>
    </div>
  );
}
