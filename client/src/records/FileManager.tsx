/**
 * Records & File Manager — the container.
 *
 * The only file in the file manager that talks to the server:
 *
 *   `records.files.list`      the folders, counts and rows this caller may see
 *   `records.files.get`       one record's inspector — logged as a view
 *   `records.files.download`  a short-lived signed URL — logged as a download
 *   `fieldRoute.evidence.verify`  the existing verification act, offered only
 *                                 when the server says this caller holds it
 *
 * The screen never decides permission. A record it is not shown does not
 * exist for it; a record it is shown is one the server already judged. The
 * download link is opened immediately and never stored: it is a capability
 * with minutes to live, not an address.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { FileManagerView, type DetailState, type FileDetail, type FileRow, type ListState } from "./FileManagerView";
import type { FolderKey } from "./fileViewModels";

export default function FileManager() {
  const utils = trpc.useUtils();
  const [folder, setFolder] = useState<FolderKey>("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState<"download" | "verify" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const listQuery = trpc.records.files.list.useQuery({ folder, query: debounced, limit: 200 });
  const detailQuery = trpc.records.files.get.useQuery(
    { evidenceId: selectedId ?? 0 },
    { enabled: selectedId != null, retry: false }
  );
  const download = trpc.records.files.download.useMutation();
  const verify = trpc.fieldRoute.evidence.verify.useMutation();

  const list: ListState = listQuery.isError
    ? { kind: "failed", message: listQuery.error.message }
    : listQuery.isPending
      ? { kind: "loading" }
      : {
          kind: "loaded",
          rows: listQuery.data.records as FileRow[],
          counts: listQuery.data.counts,
          truncated: listQuery.data.truncated,
          reach: listQuery.data.reach,
        };

  const detail: DetailState =
    selectedId == null ? { kind: "none" }
    : detailQuery.isError ? { kind: "failed", message: detailQuery.error.message }
    : detailQuery.isPending ? { kind: "loading" }
    : { kind: "loaded", detail: detailQuery.data as FileDetail };

  const onDownload = async (id: number, version?: number) => {
    setBusy("download");
    setNotice(null);
    try {
      const r = await download.mutateAsync({ evidenceId: id, version });
      window.open(r.url, "_blank", "noopener,noreferrer");
      setNotice({ tone: "ok", text: `Download of version ${r.version} opened. The link expires shortly and was not saved.` });
      // The download is now in the access history; refresh the inspector so it shows.
      void utils.records.files.get.invalidate({ evidenceId: id });
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "The download could not be prepared." });
    } finally {
      setBusy(null);
    }
  };

  const onVerify = async (id: number) => {
    setBusy("verify");
    setNotice(null);
    try {
      await verify.mutateAsync({ id });
      setNotice({ tone: "ok", text: "Record marked verified." });
      void utils.records.files.invalidate();
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "The record could not be verified." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <FileManagerView
      folder={folder}
      onFolder={f => { setFolder(f); setNotice(null); }}
      query={query}
      onQuery={setQuery}
      list={list}
      selectedId={selectedId}
      onSelect={id => { setSelectedId(id); setNotice(null); }}
      detail={detail}
      onDownload={onDownload}
      onVerify={onVerify}
      busy={busy}
      notice={notice}
    />
  );
}
