import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelSourceBadge } from "./SourcedPanel";
import { demonstration, fromQuery } from "./panelSource";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Calculator,
  Clock3,
  DollarSign,
  FileText,
  LifeBuoy,
  Phone,
  Plus,
  Save,
  ShieldCheck,
  Truck,
  Wrench,
} from "lucide-react";

const demoRates = [
  {
    name: "Hydrovac 247",
    unitType: "Hydrovac",
    hourlyRate: 285,
    dailyRate: 1950,
    jumpHourRate: 425,
    disposalRate: 185,
    specialtyEquipmentRate: 325,
    currency: "CAD",
  },
  {
    name: "Vacuum trailer 882",
    unitType: "Trailer",
    hourlyRate: 165,
    dailyRate: 1100,
    jumpHourRate: 0,
    disposalRate: 0,
    specialtyEquipmentRate: 210,
    currency: "CAD",
  },
];
const vendorsDemo = [
  {
    name: "North Ridge Mechanical",
    category: "Emergency maintenance",
    contactName: "Avery Chen",
    phone: "780-555-0188",
    emergencyPhone: "780-555-0199",
    coverageArea: "Northern Alberta",
    availability: "24 / 7",
  },
  {
    name: "Prairie Disposal",
    category: "Disposal facility",
    contactName: "Jane Smith",
    phone: "780-555-0114",
    emergencyPhone: "780-555-0115",
    coverageArea: "Grande Prairie · Fox Creek",
    availability: "06:00–22:00",
  },
];
export default function BillingSafetyWorkspace() {
  const { data: rates } = trpc.fieldRoute.billing.rateCards.list.useQuery();
  const { data: vendors } = trpc.fieldRoute.vendors.list.useQuery();
  const { data: plans } = trpc.fieldRoute.unitSafety.list.useQuery();
  const createRate = trpc.fieldRoute.billing.rateCards.create.useMutation({
    onSuccess: () => toast.success("Company rate card saved remotely."),
  });
  const createLine = trpc.fieldRoute.billing.lines.create.useMutation({
    onSuccess: () => toast.success("Auditable charge lines saved remotely."),
  });
  const createVendor = trpc.fieldRoute.vendors.create.useMutation({
    onSuccess: () => toast.success("Vendor contact saved remotely."),
  });
  const createPlan = trpc.fieldRoute.unitSafety.create.useMutation({
    onSuccess: () => toast.success("Unit safety plan version saved."),
  });
  const [hours, setHours] = useState(8);
  const [days, setDays] = useState(0);
  const [taxRate, setTaxRate] = useState(5);
  const [jumpHours, setJumpHours] = useState(1);
  const [disposalLoads, setDisposalLoads] = useState(2);
  const [specialty, setSpecialty] = useState(1);
  const [showVendorForm, setShowVendorForm] = useState(false);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const rate = rates?.[0] || demoRates[0];
  const subtotal = useMemo(
    () =>
      hours * rate.hourlyRate +
      days * rate.dailyRate +
      jumpHours * rate.jumpHourRate +
      disposalLoads * rate.disposalRate +
      specialty * rate.specialtyEquipmentRate,
    [hours, days, jumpHours, disposalLoads, specialty, rate]
  );
  const tax = Math.round((subtotal * taxRate) / 100);
  const total = subtotal + tax;
  return (
    <div>
      <header className="border-b border-[#e1e7ed] bg-[#f8fafc] px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8998aa]">
          Remote office control · commercial + safety
        </p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.055em] text-[#172033] sm:text-4xl">
              Billing that knows the work.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#75869a]">
              Set rates once, calculate transparent job charges, and keep every
              unit’s safety plan and emergency contact available to the field.
            </p>
          </div>
          <Badge className="w-fit bg-[#e3f6ef] px-3 py-2 text-[#238a72] hover:bg-[#e3f6ef]">
            <ShieldCheck className="mr-2 h-3.5 w-3.5" />
            Office-managed · field accessible
          </Badge>
        </div>
      </header>
      <main className="space-y-6 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Current estimate"
            value={`$${subtotal.toLocaleString()}`}
            note="CAD · before tax"
            icon={DollarSign}
          />
          <Metric
            label="Unit rate cards"
            value={String(rates?.length || 2)}
            note="Company specifications"
            icon={Calculator}
          />
          <Metric
            label="Vendors"
            value={String(vendors?.length || 2)}
            note="Contacts + emergency lines"
            icon={Phone}
          />
          <Metric
            label="Safety plans"
            value={String(plans?.length || 3)}
            note="Versioned unit snapshots"
            icon={LifeBuoy}
          />
        </div>
        <div className="grid gap-6 xl:grid-cols-[1.05fr_.95fr]">
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Job billing calculator · JOB-08421
                </CardTitle>
              <PanelSourceBadge source={demonstration("JOB-08421 is a demonstration job; these totals are calculated from the inputs on this page, not from a field ticket")} />
                <p className="mt-1 text-xs text-[#8492a4]">
                  Rate card: {rate.name} · {rate.currency || "CAD"}
                </p>
              </div>
              <Calculator className="h-5 w-5 text-[#52749d]" />
            </CardHeader>
            <CardContent className="space-y-4 px-5 pb-5 sm:px-6">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Unit hours", hours, setHours, rate.hourlyRate],
                  ["Unit days", days, setDays, rate.dailyRate],
                  ["Jump hours", jumpHours, setJumpHours, rate.jumpHourRate],
                  [
                    "Disposal loads",
                    disposalLoads,
                    setDisposalLoads,
                    rate.disposalRate,
                  ],
                  [
                    "Specialty equipment",
                    specialty,
                    setSpecialty,
                    rate.specialtyEquipmentRate,
                  ],
                ].map(([label, value, setter, unitRate]) => (
                  <label
                    key={String(label)}
                    className="rounded-xl border border-[#edf0f3] p-3"
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                      {label as string}
                    </span>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        value={value as number}
                        onChange={e =>
                          (setter as (value: number) => void)(
                            Number(e.target.value)
                          )
                        }
                        className="h-9 w-20 rounded-lg border border-[#dfe6ee] px-2 text-sm text-[#52657d] outline-none focus:border-[#52749d]"
                      />
                      <span className="text-xs text-[#8492a4]">
                        × ${(unitRate as number).toLocaleString()}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
              <label className="block rounded-xl border border-[#edf0f3] p-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8998aa]">
                  Tax / adjustment %
                </span>
                <input
                  type="number"
                  min="0"
                  value={taxRate}
                  onChange={e => setTaxRate(Number(e.target.value))}
                  className="mt-2 h-9 w-24 rounded-lg border border-[#dfe6ee] px-2 text-sm text-[#52657d] outline-none focus:border-[#52749d]"
                />
              </label>
              <div className="flex items-end justify-between rounded-xl bg-[#10243f] p-4 text-white">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.15em] text-[#aabbd0]">
                    Auditable subtotal
                  </p>
                  <p className="mt-1 text-2xl font-semibold">
                    ${total.toLocaleString()} CAD
                  </p>
                  <p className="mt-1 text-[10px] text-[#aabbd0]">
                    Subtotal ${subtotal.toLocaleString()} · tax/adjustment $
                    {tax.toLocaleString()}
                  </p>
                </div>
                <Button
                  onClick={() =>
                    createLine.mutate({
                      jobId: 1,
                      description:
                        "JOB-08421 · unit / jump / disposal / specialty equipment",
                      quantity: 1,
                      unitRate: total,
                      source: `rate_card:${rate.name}`,
                    })
                  }
                  className="h-9 rounded-lg bg-[#ff6b42] text-xs text-white hover:bg-[#e85d38]"
                >
                  <Save className="mr-2 h-3.5 w-3.5" />
                  Save charge lines
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Company rate cards
                </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.billing.rateCards.list", rates, { whenEmpty: "no rate card exists on this database yet" })} />
                <p className="mt-1 text-xs text-[#8492a4]">
                  Hourly, daily, jump-hour, disposal, and specialty equipment.
                </p>
              </div>
              <Button
                onClick={() =>
                  createRate.mutate({
                    name: "New company rate card",
                    unitType: "Specialty unit",
                    hourlyRate: 225,
                    dailyRate: 1500,
                    jumpHourRate: 350,
                    disposalRate: 150,
                    specialtyEquipmentRate: 275,
                    currency: "CAD",
                    active: 1,
                  })
                }
                variant="outline"
                className="h-9 rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add rate
              </Button>
            </CardHeader>
            <CardContent className="space-y-2 px-5 pb-5 sm:px-6">
              {(rates?.length ? rates : demoRates).map(item => (
                <div
                  key={item.name}
                  className="rounded-xl border border-[#edf0f3] p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#52657d]">
                      {item.name}
                    </span>
                    <Badge className="bg-[#e8f0fb] text-[#52749d] hover:bg-[#e8f0fb]">
                      {item.unitType}
                    </Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-[#8492a4]">
                    <span>
                      Hour{" "}
                      <b className="block text-xs text-[#52657d]">
                        ${item.hourlyRate}
                      </b>
                    </span>
                    <span>
                      Day{" "}
                      <b className="block text-xs text-[#52657d]">
                        ${item.dailyRate}
                      </b>
                    </span>
                    <span>
                      Jump{" "}
                      <b className="block text-xs text-[#52657d]">
                        ${item.jumpHourRate}
                      </b>
                    </span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6 xl:grid-cols-[.95fr_1.05fr]">
          <Card className="border-[#dceee7] bg-[#f3fbf7] shadow-[0_10px_35px_rgba(39,120,100,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#254e46]">
                  Unit safety + emergency plans
                </CardTitle>
              <PanelSourceBadge source={fromQuery("fieldRoute.unitSafety.list", plans, { whenEmpty: "no unit safety plan exists on this database yet" })} />
                <p className="mt-1 text-xs text-[#729189]">
                  The same safety snapshot follows the unit offline.
                </p>
              </div>
              <Button
                onClick={() => setShowPlanForm(!showPlanForm)}
                variant="outline"
                className="h-9 rounded-lg border-[#cfe8dd] bg-white text-xs text-[#527c70]"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New version
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              {showPlanForm && (
                <div className="rounded-xl border border-[#cfe8dd] bg-white p-3">
                  <p className="text-xs font-semibold text-[#527c70]">
                    Create remote safety snapshot
                  </p>
                  <p className="mt-1 text-[11px] text-[#729189]">
                    Hazards, shutdown procedure, PPE, SDS references, and
                    emergency contacts are versioned for field access.
                  </p>
                  <Button
                    onClick={() =>
                      createPlan.mutate({
                        unitId: 247,
                        unitLabel: "Unit 247 · Hydrovac",
                        hazardSummary:
                          "Pressure, traffic, chemicals, slippery ground",
                        shutdownProcedure:
                          "Stop pump, isolate pressure, secure hoses, call operations desk",
                        requiredPpe: "FR, boots, eye protection, gloves",
                        sdsReferences: "SDS-INV-2026-04",
                        emergencyContacts:
                          "Operations 1-800-555-0147 · HSE 1-800-555-0166",
                        version: 2,
                      })
                    }
                    className="mt-3 h-9 rounded-lg bg-[#2e9c82] text-xs text-white hover:bg-[#25846f]"
                  >
                    <Save className="mr-2 h-3.5 w-3.5" />
                    Save snapshot
                  </Button>
                </div>
              )}
              {(plans?.length
                ? plans
                : [
                    {
                      unitLabel: "Unit 247 · Hydrovac",
                      hazardSummary: "Pressure · chemicals · traffic",
                      requiredPpe: "FR · boots · eye protection",
                      version: 4,
                      emergencyContacts: "Operations desk · 1-800-555-0147",
                    },
                  ]
              ).map((plan, i) => (
                <div
                  key={`${plan.unitLabel}-${i}`}
                  className="rounded-xl border border-[#cfe8dd] bg-white p-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-[#527c70]">
                      {plan.unitLabel}
                    </p>
                    <Badge className="bg-[#e3f6ef] text-[#238a72] hover:bg-[#e3f6ef]">
                      v{plan.version} · cached
                    </Badge>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-[#729189]">
                    {plan.hazardSummary}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[#527c70]">
                    <span className="rounded-md bg-[#f1faf6] px-2 py-1">
                      PPE: {plan.requiredPpe}
                    </span>
                    <span className="rounded-md bg-[#f1faf6] px-2 py-1">
                      {plan.emergencyContacts}
                    </span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
            <CardHeader className="flex flex-row items-center justify-between px-5 py-5 sm:px-6">
              <div>
                <CardTitle className="text-[15px] text-[#172033]">
                  Vendor directory + emergency response
                </CardTitle>
                <p className="mt-1 text-xs text-[#8492a4]">
                  Office-managed contacts remain available to every crew.
                </p>
              </div>
              <Button
                onClick={() => setShowVendorForm(!showVendorForm)}
                variant="outline"
                className="h-9 rounded-lg border-[#dfe6ee] bg-white text-xs text-[#52657d]"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add vendor
              </Button>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 sm:px-6">
              {showVendorForm && (
                <Button
                  onClick={() =>
                    createVendor.mutate({
                      name: "Remote service partner",
                      category: "Emergency response",
                      contactName: "On-call coordinator",
                      phone: "780-555-0120",
                      emergencyPhone: "780-555-0121",
                      email: "dispatch@example.com",
                      coverageArea: "Northern Alberta",
                      availability: "24 / 7",
                      notes:
                        "Confirm access road and unit isolation before dispatch.",
                    })
                  }
                  className="h-9 w-full rounded-lg bg-[#10243f] text-xs text-white hover:bg-[#1c385b]"
                >
                  <Save className="mr-2 h-3.5 w-3.5" />
                  Save vendor contact
                </Button>
              )}
              {(vendors?.length ? vendors : vendorsDemo).map((vendor, i) => (
                <div
                  key={`${vendor.name}-${i}`}
                  className="rounded-xl border border-[#edf0f3] p-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-[#52657d]">
                      {vendor.name}
                    </p>
                    <Badge className="bg-[#fff0d2] text-[#9b722c] hover:bg-[#fff0d2]">
                      {vendor.availability}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-[#8492a4]">
                    {vendor.category} · {vendor.coverageArea}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                    <a
                      href={`tel:${vendor.phone}`}
                      className="rounded-md bg-[#f7f9fb] px-2 py-1 text-[#52749d]"
                    >
                      <Phone className="mr-1 inline h-3 w-3" />
                      {vendor.phone}
                    </a>
                    <a
                      href={`tel:${vendor.emergencyPhone}`}
                      className="rounded-md bg-[#fff7f6] px-2 py-1 text-[#c45448]"
                    >
                      <AlertTriangle className="mr-1 inline h-3 w-3" />
                      Emergency {vendor.emergencyPhone}
                    </a>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
        <Card className="border-[#e0e6ee] bg-white shadow-[0_10px_35px_rgba(39,63,94,0.05)]">
          <CardHeader className="px-5 py-5 sm:px-6">
            <CardTitle className="text-[15px] text-[#172033]">
              Remote maintenance audit
            </CardTitle>
            <p className="mt-1 text-xs text-[#8492a4]">
              Version changes, emergency plan edits, and billing updates remain
              attributable to office staff.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {[
              ["03:42", "Rate card updated", "Morgan Lee · Hydrovac 247"],
              ["Yesterday", "Emergency plan v4", "Dylan Hutchings · Unit 247"],
              [
                "Aug 27",
                "Vendor contact verified",
                "Operations desk · Prairie Disposal",
              ],
            ].map(item => (
              <div
                key={item[0]}
                className="rounded-xl border border-[#edf0f3] p-3"
              >
                <Clock3 className="h-4 w-4 text-[#52749d]" />
                <p className="mt-2 text-xs font-semibold text-[#52657d]">
                  {item[1]}
                </p>
                <p className="mt-1 text-[11px] text-[#8492a4]">{item[2]}</p>
                <p className="mt-2 font-mono text-[10px] text-[#9aa6b4]">
                  {item[0]} · audit retained
                </p>
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
  icon: typeof DollarSign;
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
