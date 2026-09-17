/**
 * P7.3 — matching a disposal facility's statement line to LeaseOS disposal tickets (pure).
 *
 * The facility's ticket number is the strong key. Without it, a line can still match
 * on facility + time window + material, but only when exactly one ticket fits; two
 * fitting tickets is `ambiguous`, not a guess. A quantity or unit difference on a
 * matched line is a variance carried on the line — the ticket is never changed here.
 */
export type DisposalTicketLite = { id: number; facilityTicketNumber: string | null; scaleInAt: Date | null; material: string | null; quantity: number | null; quantityUnit: string | null; unitNumber: string | null };
export type FacilityLine = { facilityTicketNumber: string | null; receivedAt: Date; material: string | null; quantity: number; quantityUnit: string; unitHint: string | null };
export type FacilityMatch =
  | { outcome: "match"; ticketId: number; reason: string; variances: [] }
  | { outcome: "match_with_variance"; ticketId: number; reason: string; variances: string[] }
  | { outcome: "unmatched"; reason: string }
  | { outcome: "ambiguous"; reason: string; candidateTicketIds: number[] };

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

export function matchFacilityStatementLine(args: { tickets: DisposalTicketLite[]; line: FacilityLine; windowHours?: number; quantityTolerance?: number }): FacilityMatch {
  const { line } = args;
  const window = (args.windowHours ?? 48) * 3_600_000;
  const tol = args.quantityTolerance ?? 0.01;   // relative, 1% by default; a business may tighten it
  let candidates: DisposalTicketLite[];
  let how: string;
  if (line.facilityTicketNumber && norm(line.facilityTicketNumber)) {
    candidates = args.tickets.filter(t => norm(t.facilityTicketNumber) === norm(line.facilityTicketNumber));
    how = `facility ticket ${line.facilityTicketNumber}`;
    if (!candidates.length) return { outcome: "unmatched", reason: `No disposal ticket carries facility ticket ${line.facilityTicketNumber}` };
  } else {
    candidates = args.tickets.filter(t => t.scaleInAt && Math.abs(t.scaleInAt.getTime() - line.receivedAt.getTime()) <= window && (!line.material || !t.material || norm(t.material) === norm(line.material)));
    how = `time window ±${args.windowHours ?? 48}h${line.material ? ` and material ${line.material}` : ""}`;
    if (!candidates.length) return { outcome: "unmatched", reason: `No disposal ticket within the ${how}` };
  }
  if (candidates.length > 1) return { outcome: "ambiguous", reason: `${candidates.length} disposal tickets fit the ${how}; a person must choose`, candidateTicketIds: candidates.map(c => c.id) };
  const t = candidates[0]!;
  const variances: string[] = [];
  if (t.quantityUnit && norm(t.quantityUnit) !== norm(line.quantityUnit)) variances.push(`Unit differs: ticket ${t.quantityUnit}, statement ${line.quantityUnit}`);
  else if (t.quantity != null) {
    const base = Math.max(Math.abs(t.quantity), 1e-9);
    if (Math.abs(t.quantity - line.quantity) / base > tol) variances.push(`Quantity differs: ticket ${t.quantity} ${t.quantityUnit ?? ""}, statement ${line.quantity} ${line.quantityUnit} (${((Math.abs(t.quantity - line.quantity) / base) * 100).toFixed(1)}%)`);
  } else variances.push("Ticket has no quantity to compare");
  if (t.unitNumber && line.unitHint && norm(t.unitNumber) !== norm(line.unitHint)) variances.push(`Unit number differs: ticket ${t.unitNumber}, statement ${line.unitHint}`);
  return variances.length
    ? { outcome: "match_with_variance", ticketId: t.id, reason: `Matched on ${how}; details differ`, variances }
    : { outcome: "match", ticketId: t.id, reason: `Matched on ${how}`, variances: [] };
}
