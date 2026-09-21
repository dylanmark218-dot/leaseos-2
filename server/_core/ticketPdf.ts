/**
 * A deterministic PDF writer for ticket revisions.
 *
 * No library in the tree renders PDF, and a document that certifies a signed
 * ticket should not depend on one anyway. This writes PDF 1.4 by hand:
 * Helvetica, one column, as many pages as the lines need. The input is the
 * persisted revision snapshot — never the live ticket — and the output is
 * bytes whose SHA-256 is stored beside the revision's own hash. Same
 * snapshot, same generated time, same bytes.
 */

import { createHash } from "node:crypto";
import type { SiteSnapshot } from "./siteCloseout";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7e]/g, "?");
const LINES_PER_PAGE = 54;

export function renderPdf(title: string, lines: readonly string[]): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const monoId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pagesIdPlaceholder = objs.length + 1 + pages.length * 2; // computed after page objects
  const pageIds: number[] = [];
  pages.forEach((pg, n) => {
    const content = [`BT /F1 14 Tf 40 800 Td (${esc(title)}) Tj ET`, `BT /F2 9 Tf 40 780 Td 12 TL`, ...pg.map(l => `(${esc(l)}) '`), "ET", `BT /F2 8 Tf 40 30 Td (Page ${n + 1} of ${pages.length}) Tj ET`].join("\n");
    const cId = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${monoId} 0 R >> >> /Contents ${cId} 0 R >>`));
  });
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  if (pagesId !== pagesIdPlaceholder) throw new Error("PDF object numbering drifted");
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("") + `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export type RevisionDoc = { ticketNumber: string; revision: number; kind: string; snapshotHash: string; generatedAt: Date; signatory: { name: string; company: string; exercised: string[]; withinAuthority: string; signedAt: Date } | null; postSiteAuthorization: Record<string, unknown> | null; customerComments: string[]; supplement: { rows: { window: string; what: string; hours: number; evidence: string }[]; excluded: { what: string; reason: string }[] } | null; adjustments: { kind: string; amountCents: number; hourEquivalentMinutes: number | null; reason: string }[] };

/** Lines for a signed ticket, from the frozen snapshot only. */
export function ticketLines(snap: SiteSnapshot, doc: RevisionDoc): string[] {
  const L: string[] = [];
  const h = (s: string) => { L.push(""); L.push(s.toUpperCase()); L.push("-".repeat(s.length)); };
  L.push(`Ticket ${snap.ticketNumber}   Revision R${doc.revision} (${doc.kind})`);
  L.push(`Customer ${snap.customer}   Site ${snap.site ?? "-"}   Job ${snap.jobId ?? "-"}   Unit ${snap.unitId ?? "-"}`);
  L.push(`Source snapshot ${doc.snapshotHash}`);
  L.push(`Generated ${doc.generatedAt.toISOString()}`);
  h("Site work");
  L.push(`Arrival ${snap.arrivalAt ?? "-"}   Work start ${snap.workStartAt ?? "-"}   Site complete ${snap.siteWorkCompleteAt ?? "-"}`);
  L.push(`Loads ${snap.loads}   Site billable ${snap.siteBillableHours.toFixed(2)} h   Standby ${snap.standbyHours.toFixed(2)} h (${snap.standbyBillable})`);
  h("Lines");
  for (const l of snap.lines) L.push(`${String(l.id).padStart(4)}  ${l.lineKind.padEnd(12)} ${l.description.slice(0, 40).padEnd(40)} ${l.quantity ?? "-"} ${l.unit ?? ""} ${l.measurementMethod ? `[${l.measurementMethod}]` : ""}`);
  h("Events (clock / customer billable)");
  for (const e of snap.events) L.push(`${e.from.slice(11, 16)}-${(e.to ?? "").slice(11, 16).padEnd(5)}  ${e.eventType.padEnd(18)} ${e.hours != null ? e.hours.toFixed(2).padStart(6) : "  open"} h   billable: ${e.customerBillable}`);
  if (doc.postSiteAuthorization) { h("Post-site authorization (signed basis)"); for (const [k, v] of Object.entries(doc.postSiteAuthorization)) L.push(`${k}: ${String(v)}`); }
  if (doc.supplement) { h("Post-site supplement"); for (const r of doc.supplement.rows) L.push(`${r.window.padEnd(13)} ${r.what.padEnd(22)} ${r.hours.toFixed(2).padStart(6)} h   ${r.evidence}`); if (doc.supplement.excluded.length) { L.push("Not included:"); for (const x of doc.supplement.excluded) L.push(`  ${x.what}: ${x.reason}`); } }
  if (doc.adjustments.length) { h("Client adjustments"); for (const a of doc.adjustments) L.push(`${a.kind.padEnd(26)} $${(a.amountCents / 100).toFixed(2).padStart(10)}${a.hourEquivalentMinutes != null ? `  (${(a.hourEquivalentMinutes / 60).toFixed(2)} h-equivalent, NOT worked time)` : ""}  ${a.reason.slice(0, 40)}`); }
  h("Excluded company activity (never customer-billable)");
  const excluded = snap.events.filter(e => e.customerBillable === "no");
  if (excluded.length) for (const e of excluded) L.push(`${e.eventType}: ${e.hours != null ? `${e.hours.toFixed(2)} h` : "open"}`); else L.push("(none recorded on this revision)");
  if (doc.customerComments.length) { h("Customer comments"); for (const c of doc.customerComments) L.push(c.slice(0, 90)); }
  h("Signature");
  L.push(doc.signatory ? `${doc.signatory.name}, ${doc.signatory.company}   ${doc.signatory.signedAt.toISOString()}   authority: ${doc.signatory.exercised.join(", ") || "-"} (${doc.signatory.withinAuthority})` : "Unsigned");
  return L;
}

export function sha256Hex(b: Buffer): string { return createHash("sha256").update(b).digest("hex"); }
