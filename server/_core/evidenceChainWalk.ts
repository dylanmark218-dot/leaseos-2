/**
 * P3.6 — resolve a tracking number, then walk the chain it sits in.
 *
 * The master search already resolves: hand it `DSP-2026-000412` and it finds the disposal ticket.
 * That is half of what the rule asks for, and the half that matters less. Somebody holding a
 * number is almost never asking "does this exist" — they are asking what it belongs to. A
 * dispatcher with a disposal ticket wants the load, the trip, the job and the customer. An
 * accounts clerk with an invoice number wants the field ticket lines under it and the tickets
 * behind those. A driver on the phone has one number written on his hand and needs everything
 * else.
 *
 * Two rules:
 *
 *   **A missing hop is named, not skipped.** A load with no disposal ticket is the most
 *   interesting thing on the chain — it is a load nobody can bill. A walk that silently omitted it
 *   would present an incomplete chain as a complete one, which is worse than not walking at all.
 *
 *   **The walk reports position, not judgement.** It says what is attached and what is not. It
 *   does not decide whether the gap is a problem: a trip still in progress legitimately has no
 *   field ticket, and the Exception Centre — not a search result — is where something being wrong
 *   gets decided.
 */

export type ChainNodeKind =
  | "customer" | "job" | "trip" | "load" | "manifest" | "disposal_ticket"
  | "field_ticket" | "billing_book" | "invoice" | "work_order" | "defect";

/** The chain in the order the work happens; a walk presents hops in this order, not FK order. */
export const CHAIN_ORDER: readonly ChainNodeKind[] = [
  "customer", "job", "trip", "load", "manifest", "disposal_ticket",
  "field_ticket", "billing_book", "invoice",
];

export type ChainNode = {
  kind: ChainNodeKind;
  /** The human-readable number, which is what the person on the phone actually has. */
  ref: string;
  id: number | null;
  status: string | null;
  /** How this node connects to the one before it, in words. */
  via: string | null;
};

export type ChainGap = {
  after: ChainNodeKind;
  missing: ChainNodeKind;
  /** Why the hop is absent, if that is knowable, or what it would mean if it is not. */
  note: string;
};

export type ChainWalk = {
  anchor: ChainNode;
  nodes: readonly ChainNode[];
  gaps: readonly ChainGap[];
  explanation: string;
};

const LABEL: Record<ChainNodeKind, string> = {
  customer: "customer", job: "job", trip: "trip", load: "load", manifest: "manifest",
  disposal_ticket: "disposal ticket", field_ticket: "field ticket", billing_book: "billing book",
  invoice: "invoice", work_order: "work order", defect: "defect",
};

/**
 * What a gap means, where that is knowable from the chain itself.
 *
 * Nothing here says "this is wrong". A trip that has not closed has no field ticket yet and that is
 * correct; a closed trip without one is a revenue hole. The walk states the position and leaves the
 * verdict to the engine whose job it is.
 */
function noteFor(missing: ChainNodeKind, anchorStatusOf: (k: ChainNodeKind) => string | null): string {
  const tripStatus = anchorStatusOf("trip");
  const loadStatus = anchorStatusOf("load");
  switch (missing) {
    case "disposal_ticket":
      return loadStatus && /deliver|dispos|complete|closed/i.test(loadStatus)
        ? `the load reads ${loadStatus} but no disposal ticket is attached — the load cannot be billed as disposed`
        : "no disposal ticket attached yet";
    case "field_ticket":
      return tripStatus && /closed|complete/i.test(tripStatus)
        ? `the trip reads ${tripStatus} with no field ticket — nothing has been presented to the customer`
        : "no field ticket raised yet";
    case "invoice":
      return "not invoiced";
    case "manifest":
      return "no manifest attached";
    default:
      return `no ${LABEL[missing]} attached`;
  }
}

/**
 * Walk the chain around a resolved record.
 *
 * `found` carries whatever the caller could resolve; absent kinds are the gaps. The caller does the
 * queries because the joins differ per anchor, and pushing them in here would put a dozen table
 * reads behind a pure function nobody could test without a database.
 */
export function walkEvidenceChain(args: {
  anchorKind: ChainNodeKind;
  found: Partial<Record<ChainNodeKind, { ref: string; id: number | null; status?: string | null }>>;
  /** Kinds this anchor's chain cannot contain, so their absence is not reported as a gap. */
  notApplicable?: readonly ChainNodeKind[];
}): ChainWalk {
  const na = new Set(args.notApplicable ?? []);
  const statusOf = (k: ChainNodeKind) => args.found[k]?.status ?? null;

  const nodes: ChainNode[] = [];
  const gaps: ChainGap[] = [];
  let previous: ChainNodeKind | null = null;

  for (const kind of CHAIN_ORDER) {
    if (na.has(kind)) continue;
    const hit = args.found[kind];
    if (hit) {
      nodes.push({
        kind, ref: hit.ref, id: hit.id ?? null, status: hit.status ?? null,
        via: previous ? `${LABEL[kind]} of ${LABEL[previous]} ${args.found[previous]?.ref ?? ""}`.trim() : null,
      });
      previous = kind;
    } else if (previous) {
      // Named, never skipped: an omitted hop presents an incomplete chain as a complete one.
      gaps.push({ after: previous, missing: kind, note: noteFor(kind, statusOf) });
    }
  }

  const anchor = nodes.find(n => n.kind === args.anchorKind)
    ?? { kind: args.anchorKind, ref: args.found[args.anchorKind]?.ref ?? "(unresolved)", id: null, status: null, via: null };

  return {
    anchor, nodes, gaps,
    explanation: gaps.length === 0
      ? `${LABEL[args.anchorKind]} ${anchor.ref}: chain complete — ${nodes.map(n => `${LABEL[n.kind]} ${n.ref}`).join(" → ")}.`
      : `${LABEL[args.anchorKind]} ${anchor.ref}: ${nodes.map(n => `${LABEL[n.kind]} ${n.ref}`).join(" → ")}. Not attached: ${gaps.map(g => `${LABEL[g.missing]} (${g.note})`).join("; ")}.`,
  };
}
