/**
 * Records & File Manager — the container.
 *
 * The only file in the file manager that talks to the server:
 *
 *   `records.files.list`      the folders, counts and rows this caller may see,
 *                             a page at a time behind the server's cursor
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
import { mergePages, type FolderKey } from "./fileViewModels";

/** One page. The server caps it at 100; 50 keeps the first paint quick. */
const PAGE_SIZE = 50;

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

  // The folder and search are the query key: changing either starts a new
  // traversal from the first page, and the old cursor is never sent with it.
  const listQuery = trpc.records.files.list.useInfiniteQuery(
    { folder, query: debounced, limit: PAGE_SIZE },
    { getNextPageParam: last => (last.hasMore ? last.nextCursor ?? undefined : undefined) }
  );
  const detailQuery = trpc.records.files.get.useQuery(
    { evidenceId: selectedId ?? 0 },
    { enabled: selectedId != null, retry: false }
  );
  const download = trpc.records.files.download.useMutation();
  const verify = trpc.fieldRoute.evidence.verify.useMutation();

  const pages = listQuery.data?.pages;
  const list: ListState = !pages
    ? listQuery.isError
      ? { kind: "failed", message: listQuery.error.message }
      : { kind: "loading" }
    : {
        kind: "loaded",
        rows: mergePages(pages) as FileRow[],
        // Counts come with the first page only; later pages carry null.
        counts: pages[0]?.counts ?? null,
        reach: pages[0]?.reach ?? { categories: [], own: false, canVerify: false },
        hasMore: listQuery.hasNextPage,
        loadingMore: listQuery.isFetchingNextPage,
        loadMoreError: listQuery.isFetchNextPageError ? listQuery.error?.message ?? "Unknown error" : null,
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
      onLoadMore={() => { if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) void listQuery.fetchNextPage(); }}
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
