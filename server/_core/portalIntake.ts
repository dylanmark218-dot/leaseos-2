/**
 * Portal intake.
 *
 * An external identity is bound to exactly one account, and everything it
 * submits or reads is scoped by that binding on the server. A submission is
 * checked here — is it complete, is it a duplicate, does it claim a PO the
 * vendor must have — and enters as SUBMITTED. It becomes a vendor bill, a
 * disposal ticket or a dispute case only when a person inside accepts it.
 * A facility's ticket that arrives with the facility's own hash of its scale
 * record is stronger evidence than one without; it is still a person's call.
 */

export type ExternalIdentity = { id: number; kind: "customer" | "vendor" | "facility"; customerAccountId: number | null; vendorId: number | null; facilityId: number | null; status: "invited" | "active" | "suspended" | "revoked" };

export type IntakeDecision = { accepted: boolean; refusals: string[]; findings: string[] };

export type VendorBillPayload = { vendorInvoiceNumber: string; invoiceDate: Date; subtotal: number; taxAmount: number; total: number; lines: { description: string; quantity: number; unitPrice: number }[]; purchaseAuthorizationRef: string | null };

export function intakeVendorBill(args: { identity: ExternalIdentity; payload: VendorBillPayload; vendorRequiresPurchaseAuthorization: boolean; existingInvoiceNumbers: readonly string[] }): IntakeDecision {
  const refusals: string[] = [], findings: string[] = [];
  if (args.identity.kind !== "vendor" || args.identity.vendorId == null) refusals.push("Only a vendor identity submits a vendor bill");
  if (args.identity.status !== "active") refusals.push(`Identity is ${args.identity.status}`);
  const p = args.payload;
  if (Math.abs(p.subtotal + p.taxAmount - p.total) > 0.005) refusals.push(`Subtotal ${p.subtotal.toFixed(2)} plus tax ${p.taxAmount.toFixed(2)} is not total ${p.total.toFixed(2)}`);
  const linesSum = p.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  if (Math.abs(linesSum - p.subtotal) > 0.01) refusals.push(`Lines sum to ${linesSum.toFixed(2)}, not the subtotal ${p.subtotal.toFixed(2)}`);
  if (args.existingInvoiceNumbers.includes(p.vendorInvoiceNumber)) refusals.push(`Invoice ${p.vendorInvoiceNumber} was already submitted by this vendor`);
  if (args.vendorRequiresPurchaseAuthorization && !p.purchaseAuthorizationRef) findings.push("This vendor's bills require a LeaseOS purchase authorization; none was cited — the four-way match will hold it");
  if (p.total <= 0) refusals.push("Total must be positive");
  return { accepted: refusals.length === 0, refusals, findings };
}

export type DisposalTicketPayload = { facilityTicketNumber: string; scaleInAt: Date; grossKg: number | null; tareKg: number | null; netKg: number | null; quantity: number | null; quantityUnit: string | null; carrierUnitNumber: string | null; loadReference: string | null; scaleRecordHash: string | null };

export function intakeDisposalTicket(args: { identity: ExternalIdentity; payload: DisposalTicketPayload; existingTicketNumbers: readonly string[] }): IntakeDecision & { confidence: "low" | "medium" | "high" } {
  const refusals: string[] = [], findings: string[] = [];
  if (args.identity.kind !== "facility" || args.identity.facilityId == null) refusals.push("Only a facility identity submits a disposal ticket");
  if (args.identity.status !== "active") refusals.push(`Identity is ${args.identity.status}`);
  const p = args.payload;
  if (!p.facilityTicketNumber.trim()) refusals.push("Facility ticket number is required");
  if (args.existingTicketNumbers.includes(p.facilityTicketNumber)) refusals.push(`Ticket ${p.facilityTicketNumber} was already submitted by this facility`);
  const weights = p.grossKg != null && p.tareKg != null && p.netKg != null;
  if (weights) {
    if (Math.abs(p.grossKg! - p.tareKg! - p.netKg!) > 20) refusals.push(`Gross ${p.grossKg} − tare ${p.tareKg} ≠ net ${p.netKg} (beyond 20 kg)`);
    if (p.tareKg! > p.grossKg!) refusals.push("Tare exceeds gross");
  } else if (p.quantity == null) refusals.push("A ticket needs scale weights or a measured quantity");
  if (!p.carrierUnitNumber && !p.loadReference) findings.push("No carrier unit or load reference — the office will have to match this ticket to a load by time and facility");
  const hashOk = !!p.scaleRecordHash && /^[a-f0-9]{64}$/.test(p.scaleRecordHash);
  if (p.scaleRecordHash && !hashOk) refusals.push("scaleRecordHash must be a lowercase SHA-256 hex digest");
  const confidence: "low" | "medium" | "high" = refusals.length ? "low" : hashOk && weights ? "high" : weights ? "medium" : "low";
  return { accepted: refusals.length === 0, refusals, findings, confidence };
}

/** The scope rule, stated once: what an identity may read is what it is bound to. Never an id from the request. */
export function scopeOf(identity: ExternalIdentity): { kind: ExternalIdentity["kind"]; accountId: number } | null {
  if (identity.status !== "active") return null;
  if (identity.kind === "customer" && identity.customerAccountId != null) return { kind: "customer", accountId: identity.customerAccountId };
  if (identity.kind === "vendor" && identity.vendorId != null) return { kind: "vendor", accountId: identity.vendorId };
  if (identity.kind === "facility" && identity.facilityId != null) return { kind: "facility", accountId: identity.facilityId };
  return null;
}
