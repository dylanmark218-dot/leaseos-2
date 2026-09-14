/**
 * v22.12 — The first-run setup wizard's model. Pure: the steps, what each
 * step needs from the server's readiness projection, and the order a new
 * company walks them in. The wizard never claims a step is done; the
 * readiness projection says so.
 */
export type ReadinessCheck = { key: string; ok: boolean; detail: string };
export type Readiness = { percent: number; ready: boolean; missing: string[]; checks: ReadinessCheck[] };

export type StepKey = "company" | "services" | "rates" | "customers" | "vendors" | "units" | "guardrails" | "terms" | "readiness";
export type Step = { key: StepKey; title: string; ask: string; checkKeys: string[]; status: "done" | "missing" | "pending" | "unknown"; detail: string };

const STEPS: readonly Omit<Step, "status" | "detail">[] = [
  { key: "company", title: "Company", ask: "Which financial entity is being set up?", checkKeys: [] },
  { key: "services", title: "What do you do?", ask: "Hydrovac, vac hauling, water, dirt, septic, transport — activate the services you bill for.", checkKeys: ["services"] },
  { key: "rates", title: "Rates", ask: "What do you charge for each service, and who approves it?", checkKeys: ["sell_rates", "proposals_pending"] },
  { key: "customers", title: "Customers", ask: "Does every customer have an approved rate?", checkKeys: ["customer_rates"] },
  { key: "vendors", title: "Vendors and subcontractors", ask: "What do you owe each vendor, per customer where it differs?", checkKeys: ["vendor_rates"] },
  { key: "units", title: "Equipment", ask: "What does each unit cost you to run?", checkKeys: ["unit_cost"] },
  { key: "guardrails", title: "Margin guardrails", ask: "Target, warning and minimum-authority margins, and who may discount below them.", checkKeys: ["guardrails"] },
  { key: "terms", title: "Billing terms", ask: "Minimum hours, standby, travel, disposal, rounding — approved by a second person.", checkKeys: ["terms"] },
  { key: "readiness", title: "Go-live readiness", ask: "Exactly what remains before dispatching, billing and paying with confidence.", checkKeys: [] },
];

/** Steps with their status from the readiness projection: done when every check passes, pending when a proposal awaits approval, missing otherwise, unknown without a projection. */
export function stepStates(readiness: Readiness | null, entitySelected: boolean): Step[] {
  return STEPS.map(s => {
    if (s.key === "company") return { ...s, status: entitySelected ? "done" : "missing", detail: entitySelected ? "Entity selected" : "Select or create the financial entity" };
    if (s.key === "readiness") return { ...s, status: readiness ? (readiness.ready ? "done" : "missing") : "unknown", detail: readiness ? `${readiness.percent}% — ${readiness.missing.length} item(s) missing` : "Not yet projected" };
    if (!readiness) return { ...s, status: "unknown", detail: "Not yet projected" };
    const checks = readiness.checks.filter(c => s.checkKeys.includes(c.key));
    const pending = checks.find(c => !c.ok && c.key === "proposals_pending");
    const failing = checks.filter(c => !c.ok);
    return { ...s, status: failing.length === 0 ? "done" : pending && failing.length === 1 ? "pending" : "missing", detail: failing.length ? failing.map(c => c.detail).join("; ") : checks.map(c => c.detail).join("; ") };
  });
}

/** The first step that is not done — where the wizard opens. */
export function nextStep(steps: readonly Step[]): StepKey {
  return steps.find(s => s.status !== "done")?.key ?? "readiness";
}

export const SERVICE_CATALOGUE: readonly { code: string; label: string }[] = [
  { code: "hydrovac", label: "Hydrovac" }, { code: "vac_hauling", label: "Vac hauling" }, { code: "water_hauling", label: "Water hauling" }, { code: "dirt_hauling", label: "Dirt hauling" },
  { code: "septic", label: "Septic" }, { code: "excavation", label: "Excavation" }, { code: "heavy_equipment", label: "Heavy equipment" }, { code: "transportation", label: "Transportation" },
  { code: "environmental", label: "Environmental" }, { code: "crane_lifting", label: "Crane / lifting" }, { code: "other", label: "Other" },
];

/** Dollars typed by a person become the integers the server stores; never a double past this line. */
export function dollarsToMillis(text: string): number | null { const n = Number(text); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null; }
export function percentToBps(text: string): number | null { const n = Number(text); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null; }
