/**
 * Tracking numbers — configured format, transactional sequence (project rule §18).
 *
 * Every significant artifact gets a human-readable number whose FORMAT is
 * configuration (`trackingSequences`: prefix, separator, year digits, month,
 * sequence width, reset period) and whose NUMBER comes from a row-locked
 * counter, so two offices closing tickets at the same second can never mint
 * the same one. Until this module, every number was `PREFIX-<time36>-<random>`
 * — unique enough, but not a sequence and not configurable.
 *
 * Same counter discipline as the sheet-serial allocator, for the same reason:
 * the period row is seeded OUTSIDE the transaction (an INSERT IGNORE inside it
 * takes a shared lock the UPDATE must upgrade, and two concurrent callers
 * deadlock); inside, one UPDATE takes the exclusive row lock and
 * LAST_INSERT_ID() carries the value back on the same connection.

 */
import { sql } from "drizzle-orm";

// `separator` is a MariaDB reserved word: written back-quoted inside the SQL text itself, which is what the reserved-word census scans for.
import type { MySql2Database } from "drizzle-orm/mysql2";

export type ResetPeriod = "never" | "yearly" | "monthly";
export type SequenceFormat = {
  prefix: string;
  separator: string;
  yearDigits: 2 | 4 | 0;
  includeMonth: boolean;
  sequenceDigits: number;
  resetPeriod: ResetPeriod;
};

export const DEFAULT_FORMAT: Omit<SequenceFormat, "prefix"> = { separator: "-", yearDigits: 4, includeMonth: false, sequenceDigits: 6, resetPeriod: "yearly" };

/** The counter's period: one counter per year, per month, or for all time. */
export function periodKeyFor(resetPeriod: ResetPeriod, at: Date): string {
  const y = at.getUTCFullYear(), m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return resetPeriod === "never" ? "ALL" : resetPeriod === "yearly" ? String(y) : `${y}-${m}`;
}

/** Render a number from its parts. Pure, so a format change can be previewed before it is saved. */
export function formatTrackingNumber(fmt: SequenceFormat, at: Date, sequence: number, branch?: string | null): string {
  const parts: string[] = [fmt.prefix];
  if (branch) parts.push(branch);
  const y = at.getUTCFullYear();
  const yearPart = fmt.yearDigits === 4 ? String(y) : fmt.yearDigits === 2 ? String(y).slice(-2) : "";
  const monthPart = fmt.includeMonth ? String(at.getUTCMonth() + 1).padStart(2, "0") : "";
  if (yearPart || monthPart) parts.push(`${yearPart}${monthPart}`);
  parts.push(String(sequence).padStart(fmt.sequenceDigits, "0"));
  return parts.join(fmt.separator);
}

export type Allocation = { trackingNumber: string; sequence: number; periodKey: string; format: SequenceFormat };

/**
 * Mint the next number for a sequence type, for one organization.
 *
 * 0172 — the counter and the format are per-organization. Before, one row per
 * `(sequenceType, branch, periodKey)` served every company on the deployment,
 * which meant two things that were both wrong once there was more than one:
 * Tenant A's tickets consumed numbers out of Tenant B's run, so each could read
 * the other's volume from the gaps; and "the stored row's format wins" meant
 * whichever company used a sequence type FIRST fixed the prefix, separator and
 * width for everybody else, silently ignoring what the next one configured.
 *
 * `orgRef` is now part of the counter's identity. `null` is the historical
 * single tenant — the caller with no organization membership — and it keeps its
 * own run, as every other organization does. It is passed explicitly rather
 * than defaulted so a new call site has to say which organization it is minting
 * for; a number minted into the wrong company's run cannot be taken back.
 *
 * Numbers are no longer globally unique, deliberately: A and B may both hold
 * FT-000001, and they are different records because their ownership differs.
 * The unique index is on (orgKey, number), so a duplicate WITHIN one
 * organization is still refused.
 */
export async function nextTrackingNumber(
  db: MySql2Database<Record<string, unknown>>,
  args: { sequenceType: string; orgRef: string | null; branch?: string | null; at?: Date; format?: Partial<SequenceFormat> },
): Promise<Allocation> {
  const at = args.at ?? new Date();
  const branch = args.branch ?? "";
  const seed: SequenceFormat = { prefix: args.sequenceType, ...DEFAULT_FORMAT, ...(args.format ?? {}) } as SequenceFormat;
  const periodKey = periodKeyFor(seed.resetPeriod, at);
  // The generated column the unique index is on: NULL and '~unattributed' are
  // the same counter, so the single tenant cannot mint a number twice either.
  const orgKey = args.orgRef ?? "~unattributed";
  /*
   * Normalised, because `undefined` and `null` are not the same to the query
   * builder: an undefined bind is dropped from the template entirely and the
   * statement goes out as `VALUES (?, , ?, ...)` — invalid SQL rather than an
   * error naming the missing argument. A caller that omits the organization is
   * a type error, but the runtime should not answer it with a syntax error.
   */
  const owner: string | null = args.orgRef ?? null;

  await db.execute(sql`
    INSERT IGNORE INTO trackingSequences (sequenceType, orgRef, branch, periodKey, nextNumber, prefix, \`separator\`, yearDigits, includeMonth, sequenceDigits, resetPeriod)
    VALUES (${args.sequenceType}, ${owner}, ${branch}, ${periodKey}, 1, ${seed.prefix}, ${seed.separator}, ${seed.yearDigits}, ${seed.includeMonth}, ${seed.sequenceDigits}, ${seed.resetPeriod})`);

  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE trackingSequences SET nextNumber = LAST_INSERT_ID(nextNumber) + 1
      WHERE orgKey = ${orgKey} AND sequenceType = ${args.sequenceType} AND branch = ${branch} AND periodKey = ${periodKey}`);
    const affected = (Array.isArray(updated) ? (updated[0] as { affectedRows?: number }) : (updated as { affectedRows?: number })).affectedRows ?? 0;
    if (affected !== 1) throw new Error(`trackingSequences: expected one counter row for ${orgKey}/${args.sequenceType}/${branch || "-"}/${periodKey}, matched ${affected}`);
    const [seqRows] = await tx.execute(sql`SELECT LAST_INSERT_ID() AS sequence`);
    const sequence = Number((seqRows as unknown as { sequence: unknown }[])[0]?.sequence);
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error("trackingSequences: LAST_INSERT_ID did not carry the counter back");
    const [fmtRows] = await tx.execute(sql`
      SELECT prefix, \`separator\`, yearDigits, includeMonth, sequenceDigits, resetPeriod FROM trackingSequences
      WHERE orgKey = ${orgKey} AND sequenceType = ${args.sequenceType} AND branch = ${branch} AND periodKey = ${periodKey}`);
    const row = (fmtRows as unknown as Record<string, unknown>[])[0]!;
    const format: SequenceFormat = {
      prefix: String(row.prefix), separator: String(row.separator), yearDigits: Number(row.yearDigits) as 0 | 2 | 4,
      includeMonth: Boolean(Number(row.includeMonth)), sequenceDigits: Number(row.sequenceDigits), resetPeriod: String(row.resetPeriod) as ResetPeriod,
    };
    return { trackingNumber: formatTrackingNumber(format, at, sequence, args.branch ?? null), sequence, periodKey, format };
  });
}
