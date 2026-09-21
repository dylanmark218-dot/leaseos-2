/**
 * P7.6 — profitability by dimension (pure). Revenue and cost are attributed only where
 * an evidence link exists; a dimension the links cannot support says so instead of
 * allocating by guess.
 */
export type Dimension = "client" | "job" | "load" | "unit" | "driver" | "branch" | "contractor";
export type Derivability = { derivable: true; basis: string } | { derivable: false; reason: string } | { derivable: "cost_only"; basis: string; reason: string };

export function derivability(dimension: Dimension): Derivability {
  switch (dimension) {
    case "job": return { derivable: true, basis: "invoices.jobId for revenue; vendorBills.jobId and contractor payables (chain root job) for cost" };
    case "client": return { derivable: true, basis: "revenue and cost by job, rolled up to the job's linked client organization; unlinked jobs by their captured customer name" };
    case "contractor": return { derivable: true, basis: "contractor payables by payee organization for cost; revenue of the jobs they performed for context" };
    case "unit": return { derivable: "cost_only", basis: "vendorBills.unitId for cost", reason: "invoices carry no unit; splitting a job's revenue across units would be an allocation, not evidence" };
    case "load": return { derivable: false, reason: "invoice lines reference field-ticket lines, not loads; no evidence link from revenue to a load exists yet" };
    case "driver": return { derivable: false, reason: "neither invoices nor vendor bills carry the operator; payroll cost is not linked to jobs" };
    case "branch": return { derivable: false, reason: "invoices, bills and jobs carry no branch" };
  }
}

export type Figures = { revenueCents: number; costCents: number; marginCents: number; marginPct: number | null; invoiceCount: number; billCount: number; payableCount: number };
export const empty = (): Figures => ({ revenueCents: 0, costCents: 0, marginCents: 0, marginPct: null, invoiceCount: 0, billCount: 0, payableCount: 0 });
export function finish(f: Figures): Figures {
  const marginCents = f.revenueCents - f.costCents;
  return { ...f, marginCents, marginPct: f.revenueCents > 0 ? Math.round((marginCents / f.revenueCents) * 1000) / 10 : null };
}
