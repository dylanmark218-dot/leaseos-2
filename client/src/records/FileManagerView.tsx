/**
 * Records & File Manager — the screen.
 *
 * Three columns on a wide screen, stacked on a phone: folders, the record list,
 * and the inspector for one record. Presentational: every state arrives as a
 * prop from `FileManager.tsx`, which is the only file that calls the server.
 *
 * What the screen will not do: edit a file. Evidence is amended into a new
 * version, never overwritten, so there is no "Edit" button — the inspector
 * says how a correction is made instead.
 */
import type { ReactNode } from "react";
import {
  ACCESS_LABELS,
  FOLDER_LABELS,
  LIFECYCLE_LABELS,
  QUEUE_FOLDER_KEYS,
  SEAL_LABELS,
  STATUS_LABELS,
  TYPE_FOLDER_KEYS,
  entityLabel,
  entityValue,
  formatDate,
  formatDay,
  lifecycleSteps,
  reachSummary,
  readCategoryLabel,
  recordTypeLabel,
  shortHash,
  type FolderKey,
  type LifecycleStage,
} from "./fileViewModels";

type Relationship = { entityType: string; entityId: number | null; entityRef: string | null; role?: string | null };

export type FileRow = {
  id: number;
  trackingNumber: string | null;
  title: string;
  recordType: string;
  capturedAt: Date | string;
  status: "needs_review" | "verified" | "unverified";
  sealState: "draft" | "sealed" | "amended" | "superseded";
  version: number;
  legalHold: boolean;
  lifecycle: LifecycleStage;
  relationships: Relationship[];
  mine: boolean;
  matchReasons: string[];
};

export type FileDetail = {
  id: number;
  trackingNumber: string | null;
  title: string;
  recordType: string;
  category: string;
  readCategory: string | null;
  mimeType: string | null;
  hasContent: boolean;
  capturedAt: Date | string;
  receivedAt: Date | string;
  latitude: number | null;
  longitude: number | null;
  status: "needs_review" | "verified" | "unverified";
  sealState: "draft" | "sealed" | "amended" | "superseded";
  version: number;
  notes: string | null;
  lifecycle: LifecycleStage;
  integrity: {
    contentHash: string;
    manifestHash: string;
    algorithm: string;
    sealedAt: Date | string;
    verification: string;
    serverVerifiedAt: Date | string | null;
  } | null;
  relationships: Relationship[];
  versions: Array<{ version: number; current: boolean; contentHash: string; amendmentReason: string | null; createdAt: Date | string; hasContent: boolean }>;
  retention: {
    basis: string | null;
    officeRetainUntil: Date | string | null;
    deviceRetainUntil: Date | string | null;
    officeReceivedAt: Date | string | null;
    officeIntegrityVerifiedAt: Date | string | null;
    deviceCopyDeletedAt: Date | string | null;
    statutoryCompliance: "not asserted";
  } | null;
  legalHold: { active: boolean; holds: Array<{ holdNumber: string; matterRef: string | null; status: "active" | "released"; placedAt: Date | string; releasedAt: Date | string | null }> };
  accessHistory: Array<{ action: string; actorUserId: number; actorRole: string; context: string | null; occurredAt: Date | string }> | null;
  visibleBecause: "category" | "own";
  actions: { download: boolean; verify: boolean; amend: boolean };
};

export type Reach = { categories: string[]; own: boolean; canVerify: boolean };

export type ListState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; rows: FileRow[]; counts: Record<FolderKey, number>; truncated: boolean; reach: Reach };

export type DetailState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "loaded"; detail: FileDetail };

export type FileManagerViewProps = {
  folder: FolderKey;
  onFolder: (f: FolderKey) => void;
  query: string;
  onQuery: (q: string) => void;
  list: ListState;
  selectedId: number | null;
  onSelect: (id: number) => void;
  detail: DetailState;
  onDownload: (id: number, version?: number) => void;
  onVerify: (id: number) => void;
  busy: "download" | "verify" | null;
  notice: { tone: "ok" | "error"; text: string } | null;
};

const card = "rounded-2xl border border-[#dfe5ee] bg-white";
const muted = "text-[#5b6b82]";

function Badge({ tone, children }: { tone: "neutral" | "good" | "warn" | "bad"; children: ReactNode }) {
  const tones = {
    neutral: "bg-[#eef2f7] text-[#172033]",
    good: "bg-[#e6f4ea] text-[#1e5e30]",
    warn: "bg-[#fff4e5] text-[#7a3d00]",
    bad: "bg-[#fdecea] text-[#8f1d14]",
  } as const;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${tones[tone]}`}>{children}</span>;
}

function statusTone(s: FileRow["status"]) {
  return s === "verified" ? "good" : s === "needs_review" ? "warn" : "neutral";
}

function FolderNav({ folder, onFolder, counts }: { folder: FolderKey; onFolder: (f: FolderKey) => void; counts: Record<FolderKey, number> | null }) {
  const item = (key: FolderKey) => (
    <li key={key}>
      <button
        type="button"
        onClick={() => onFolder(key)}
        aria-current={folder === key ? "page" : undefined}
        className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm ${folder === key ? "bg-[#132a4a] text-white" : "hover:bg-[#eef2f7]"}`}
      >
        <span>{FOLDER_LABELS[key]}</span>
        {counts && <span className={folder === key ? "text-white" : muted}>{counts[key]}</span>}
      </button>
    </li>
  );
  return (
    <nav aria-label="Folders" className={`${card} p-3`}>
      <ul className="space-y-0.5">{item("all")}</ul>
      <h2 className={`mt-3 px-3 text-xs uppercase ${muted}`}>By type</h2>
      <ul className="mt-1 space-y-0.5">{TYPE_FOLDER_KEYS.map(item)}</ul>
      <h2 className={`mt-3 px-3 text-xs uppercase ${muted}`}>Work queues</h2>
      <ul className="mt-1 space-y-0.5">{QUEUE_FOLDER_KEYS.map(item)}</ul>
    </nav>
  );
}

function RecordList({ list, selectedId, onSelect, folder }: { list: ListState; selectedId: number | null; onSelect: (id: number) => void; folder: FolderKey }) {
  if (list.kind === "loading") return <p className={`${card} p-5 text-sm ${muted}`}>Loading records…</p>;
  if (list.kind === "failed") return <p role="alert" className={`${card} p-5 text-sm text-[#8f1d14]`}>Records could not be loaded: {list.message}</p>;
  return (
    <section aria-label="Records" className={`${card} p-3`}>
      <p className={`px-2 text-xs ${muted}`}>{reachSummary(list.reach)}</p>
      {list.truncated && (
        <p className="mt-1 px-2 text-xs text-[#7a3d00]">Only the 500 most recent records in your organization were read. Search narrows within them.</p>
      )}
      {list.rows.length === 0 ? (
        <p className={`mt-3 px-2 pb-2 text-sm ${muted}`}>No records in {FOLDER_LABELS[folder].toLowerCase()} that you can see.</p>
      ) : (
        <ul className="mt-2 divide-y divide-[#eef2f7]">
          {list.rows.map(r => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-pressed={selectedId === r.id}
                className={`w-full rounded-lg px-2 py-2 text-left ${selectedId === r.id ? "bg-[#eef2f7]" : "hover:bg-[#f6f8fb]"}`}
              >
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{r.title}</span>
                  <span className={`text-xs ${muted}`}>{r.trackingNumber ?? `Record ${r.id}`}</span>
                </span>
                <span className={`mt-0.5 block text-xs ${muted}`}>
                  {recordTypeLabel(r.recordType)} · {formatDay(r.capturedAt)} · v{r.version}
                  {r.relationships.length > 0 && ` · ${r.relationships.slice(0, 3).map(x => `${entityLabel(x.entityType)} ${entityValue(x)}`).join(", ")}`}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={statusTone(r.status)}>{STATUS_LABELS[r.status]}</Badge>
                  <Badge tone={r.lifecycle === "integrity_failed" ? "bad" : "neutral"}>{LIFECYCLE_LABELS[r.lifecycle]}</Badge>
                  {r.legalHold && <Badge tone="bad">Legal hold</Badge>}
                  {r.mine && <Badge tone="neutral">Mine</Badge>}
                </span>
                {r.matchReasons.length > 0 && <span className={`mt-1 block text-xs ${muted}`}>Matched: {r.matchReasons.join("; ")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-sm">
      <dt className={muted}>{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-[#eef2f7] pt-3">
      <h3 className="text-xs font-medium uppercase text-[#5b6b82]">{title}</h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function Inspector({ detail, onDownload, onVerify, busy }: { detail: DetailState; onDownload: FileManagerViewProps["onDownload"]; onVerify: FileManagerViewProps["onVerify"]; busy: FileManagerViewProps["busy"] }) {
  if (detail.kind === "none") return <aside aria-label="Record inspector" className={`${card} p-5 text-sm ${muted}`}>Select a record to see its identity, integrity, relationships and history.</aside>;
  if (detail.kind === "loading") return <aside aria-label="Record inspector" className={`${card} p-5 text-sm ${muted}`}>Opening record…</aside>;
  if (detail.kind === "failed") return <aside aria-label="Record inspector" className={`${card} p-5 text-sm`}><p role="alert" className="text-[#8f1d14]">{detail.message}</p></aside>;
  const d = detail.detail;
  return (
    <aside aria-label="Record inspector" className={`${card} space-y-3 p-5`}>
      <header>
        <p className={`text-xs ${muted}`}>{d.trackingNumber ?? `Record ${d.id}`} · {recordTypeLabel(d.recordType)}</p>
        <h2 className="text-lg font-semibold">{d.title}</h2>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge tone={statusTone(d.status)}>{STATUS_LABELS[d.status]}</Badge>
          <Badge tone="neutral">{SEAL_LABELS[d.sealState]} · v{d.version}</Badge>
          {d.legalHold.active && <Badge tone="bad">Legal hold</Badge>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={!d.actions.download || busy !== null} onClick={() => onDownload(d.id)}
            className="rounded-lg bg-[#132a4a] px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {busy === "download" ? "Preparing…" : "Download"}
          </button>
          {d.actions.verify && (
            <button type="button" disabled={busy !== null} onClick={() => onVerify(d.id)}
              className="rounded-lg border border-[#132a4a] px-3 py-1.5 text-sm text-[#132a4a] disabled:opacity-50">
              {busy === "verify" ? "Verifying…" : "Mark verified"}
            </button>
          )}
        </div>
        {!d.actions.download && <p className={`mt-1 text-xs ${muted}`}>No stored file — this record is metadata only.</p>}
      </header>

      <Section title="Lifecycle">
        {d.lifecycle === "integrity_failed" ? (
          <p role="alert" className="text-sm text-[#8f1d14]">The office could not reproduce this record's hash. It has not been accepted.</p>
        ) : (
          <ol className="flex flex-wrap gap-1 text-xs">
            {lifecycleSteps(d.lifecycle).map(s => (
              <li key={s.stage} aria-current={s.state === "current" ? "step" : undefined}
                className={`rounded-full px-2 py-0.5 ${s.state === "done" ? "bg-[#e6f4ea] text-[#1e5e30]" : s.state === "current" ? "bg-[#132a4a] text-white" : "bg-[#eef2f7] text-[#5b6b82]"}`}>
                {s.label}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Record">
        <dl>
          <Field label="Captured">{formatDate(d.capturedAt)}</Field>
          <Field label="Received">{formatDate(d.receivedAt)}</Field>
          <Field label="Category">{d.category}</Field>
          <Field label="Read category">{readCategoryLabel(d.readCategory)}</Field>
          <Field label="File type">{d.mimeType ?? "—"}</Field>
          {d.latitude != null && d.longitude != null && <Field label="Location">{d.latitude.toFixed(5)}, {d.longitude.toFixed(5)}</Field>}
          <Field label="You see it as">{d.visibleBecause === "own" ? "your own record" : "your role's category"}</Field>
        </dl>
        {d.notes && <p className="mt-1 text-sm">{d.notes}</p>}
      </Section>

      <Section title="Integrity">
        {d.integrity ? (
          <dl>
            <Field label="Content hash"><code title={d.integrity.contentHash}>{shortHash(d.integrity.contentHash)}</code></Field>
            <Field label="Manifest hash"><code title={d.integrity.manifestHash}>{shortHash(d.integrity.manifestHash)}</code></Field>
            <Field label="Algorithm">{d.integrity.algorithm}</Field>
            <Field label="Sealed">{formatDate(d.integrity.sealedAt)}</Field>
            <Field label="Server check">{d.integrity.verification.replace(/_/g, " ")}{d.integrity.serverVerifiedAt ? ` · ${formatDate(d.integrity.serverVerifiedAt)}` : ""}</Field>
          </dl>
        ) : (
          <p className={`text-sm ${muted}`}>Not sealed yet. A draft carries no hash until it is sealed.</p>
        )}
      </Section>

      <Section title="Related records">
        {d.relationships.length === 0 ? (
          <p className="text-sm text-[#7a3d00]">Related to nothing — this record needs filing before it can be sealed.</p>
        ) : (
          <dl>
            {d.relationships.map((r, i) => (
              <Field key={`${r.entityType}-${i}`} label={entityLabel(r.entityType)}>{entityValue(r)}{r.role ? ` (${r.role})` : ""}</Field>
            ))}
          </dl>
        )}
      </Section>

      <Section title="Versions">
        {d.versions.length === 0 ? (
          <p className={`text-sm ${muted}`}>Version {d.version} — no amendment history.</p>
        ) : (
          <ul className="space-y-2">
            {d.versions.map(v => (
              <li key={v.version} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">v{v.version}{v.current ? " · current" : " · superseded"}</span>
                  {v.hasContent && (
                    <button type="button" disabled={busy !== null} onClick={() => onDownload(d.id, v.version)} className="text-xs text-[#132a4a] underline disabled:opacity-50">
                      Download v{v.version}
                    </button>
                  )}
                </div>
                <div className={`text-xs ${muted}`}>{formatDate(v.createdAt)} · <code title={v.contentHash}>{shortHash(v.contentHash)}</code></div>
                {v.amendmentReason && <div className="text-xs">Amendment: {v.amendmentReason}</div>}
              </li>
            ))}
          </ul>
        )}
        {d.actions.amend && <p className={`mt-1 text-xs ${muted}`}>Sealed evidence is never edited. A correction is filed as an amendment, which becomes a new version; earlier versions stay.</p>}
      </Section>

      <Section title="Retention">
        {d.retention ? (
          <dl>
            <Field label="Office retain until">{formatDay(d.retention.officeRetainUntil)}</Field>
            <Field label="Basis">{d.retention.basis ?? "—"}</Field>
            <Field label="Statutory source">{d.retention.statutoryCompliance}</Field>
            <Field label="Device copy until">{d.retention.deviceCopyDeletedAt ? `deleted ${formatDay(d.retention.deviceCopyDeletedAt)}` : formatDay(d.retention.deviceRetainUntil)}</Field>
            <Field label="Office receipt">{formatDate(d.retention.officeReceivedAt)}</Field>
            <Field label="Integrity verified">{formatDate(d.retention.officeIntegrityVerifiedAt)}</Field>
          </dl>
        ) : (
          <p className={`text-sm ${muted}`}>No retention assigned — retention starts when a record is sealed.</p>
        )}
      </Section>

      <Section title="Legal hold">
        {d.legalHold.holds.length === 0 ? (
          <p className={`text-sm ${muted}`}>No legal hold.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.legalHold.holds.map(h => (
              <li key={h.holdNumber}>
                <span className="font-medium">{h.holdNumber}</span> · {h.status}
                {h.matterRef && ` · ${h.matterRef}`} · placed {formatDay(h.placedAt)}{h.releasedAt ? ` · released ${formatDay(h.releasedAt)}` : ""}
              </li>
            ))}
          </ul>
        )}
        {d.legalHold.active && <p className="mt-1 text-xs text-[#8f1d14]">Normal disposition is suspended while a hold is active.</p>}
      </Section>

      <Section title="Access history">
        {d.accessHistory === null ? (
          <p className={`text-sm ${muted}`}>Withheld — access history is shown to roles that export or hold records for legal.</p>
        ) : d.accessHistory.length === 0 ? (
          <p className={`text-sm ${muted}`}>No access recorded.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.accessHistory.map((a, i) => (
              <li key={i}>
                <span className={muted}>{formatDate(a.occurredAt)}</span> · {ACCESS_LABELS[a.action] ?? a.action} by user {a.actorUserId} ({a.actorRole})
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}

export function FileManagerView(p: FileManagerViewProps) {
  return (
    <div className="min-h-screen bg-[#f6f8fb] text-[#172033]">
      <main className="mx-auto max-w-7xl px-4 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className={`text-xs uppercase ${muted}`}>LeaseOS</p>
            <h1 className="text-xl font-semibold">Records &amp; files</h1>
            <p className={`text-sm ${muted}`}>Every file is a record: sealed, related to the work it came from, and shown only to the roles it belongs to.</p>
          </div>
          <div className="w-full sm:w-80">
            <label htmlFor="records-search" className="text-xs font-medium">Search records</label>
            <input
              id="records-search"
              type="search"
              value={p.query}
              onChange={e => p.onQuery(e.target.value)}
              placeholder="JOB-10483, TRK-27, disposal…"
              className="mt-1 w-full rounded-lg border border-[#dfe5ee] bg-white px-3 py-1.5 text-sm"
            />
          </div>
        </header>

        {p.notice && (
          <p role={p.notice.tone === "error" ? "alert" : "status"} className={`mt-4 rounded-lg px-3 py-2 text-sm ${p.notice.tone === "error" ? "bg-[#fdecea] text-[#8f1d14]" : "bg-[#e6f4ea] text-[#1e5e30]"}`}>
            {p.notice.text}
          </p>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_380px]">
          <FolderNav folder={p.folder} onFolder={p.onFolder} counts={p.list.kind === "loaded" ? p.list.counts : null} />
          <RecordList list={p.list} selectedId={p.selectedId} onSelect={p.onSelect} folder={p.folder} />
          <Inspector detail={p.detail} onDownload={p.onDownload} onVerify={p.onVerify} busy={p.busy} />
        </div>
      </main>
    </div>
  );
}
