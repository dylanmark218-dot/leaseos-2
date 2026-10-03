/**
 * Records & File Manager — the page cursor.
 *
 * A position in the File Manager's order (createdAt DESC, id DESC) and the
 * filter set it belongs to. Nothing else: no storage key, no path, no title,
 * no category. The client treats it as opaque; the server decodes and checks
 * every field.
 *
 * Not signed, on purpose. A cursor only says where to resume. Tenant scope,
 * category reads, ownership and signing visibility are applied to every page
 * from the session, never from the cursor — so a cursor altered by hand, or
 * lifted from another person or company, can move a caller around their own
 * records and nowhere else.
 *
 * The filter key binds a cursor to the filters it was issued under, so a
 * cursor from one folder or search cannot be replayed against another: the
 * server refuses it rather than resuming from a position that means nothing
 * in the new sequence. Changing a filter starts a new traversal.
 *
 * Server-only: it uses node:crypto, and `recordFiles.ts` is also bundled into
 * the client.
 */
import { createHash } from "node:crypto";

export type FileCursorPosition = { createdAt: Date; id: number };

export type FileFilterSet = {
  folder: string;
  query: string;
  recordType: string | null;
  lifecycle: string | null;
};

/** The largest instant a JavaScript Date can hold — beyond it a "timestamp" is not one. */
const MAX_TIME_MS = 8_640_000_000_000_000;

/** 16 hex characters of SHA-256 over the canonical filter set. Identifies, does not protect. */
export function filterKeyOf(f: FileFilterSet): string {
  const canonical = JSON.stringify([f.folder, f.query.trim().toLowerCase(), f.recordType ?? null, f.lifecycle ?? null]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function encodeFileCursor(pos: FileCursorPosition, filters: FileFilterSet): string {
  return Buffer.from(JSON.stringify({ v: 1, t: pos.createdAt.getTime(), i: pos.id, f: filterKeyOf(filters) }), "utf8").toString("base64url");
}

export type CursorDecode =
  | { ok: true; position: FileCursorPosition }
  | { ok: false; reason: string };

/**
 * Decode and check a cursor against the filters of the request it arrived
 * with. Every failure is a reason, never a throw: the caller turns it into the
 * same BAD_REQUEST, whatever was wrong.
 */
export function decodeFileCursor(raw: string, filters: FileFilterSet): CursorDecode {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) return { ok: false, reason: "not a cursor" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "not a cursor" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "not a cursor" };
  const c = parsed as Record<string, unknown>;
  const keys = Object.keys(c).sort().join(",");
  if (keys !== "f,i,t,v" || c.v !== 1) return { ok: false, reason: "not a cursor" };
  if (typeof c.t !== "number" || !Number.isSafeInteger(c.t) || c.t < 0 || c.t > MAX_TIME_MS) return { ok: false, reason: "not a cursor" };
  if (typeof c.i !== "number" || !Number.isSafeInteger(c.i) || c.i < 1 || c.i > 2_147_483_647) return { ok: false, reason: "not a cursor" };
  if (typeof c.f !== "string" || !/^[0-9a-f]{16}$/.test(c.f)) return { ok: false, reason: "not a cursor" };
  if (c.f !== filterKeyOf(filters)) return { ok: false, reason: "this cursor belongs to a different folder, type, lifecycle or search — start again" };
  return { ok: true, position: { createdAt: new Date(c.t), id: c.i } };
}
