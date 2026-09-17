/**
 * B28 — the widget board, fed from `widgets.*`.
 *
 * The board component is presentational (the engine was built branchless); this
 * page is the one place that talks to the server: resolve the board for this
 * role and device, save an order, add a widget from what the role may put on
 * its board. Nothing here decides what a tile shows — the server does, per tile,
 * through that tile's own procedure. An unpromoted tile says `unknown` on its face.
 */
import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc";
import { WidgetBoard, type BoardTileView, type SaveState } from "../widgets/WidgetBoard";
import { AddWidgetPicker } from "../widgets/AddWidgetPicker";
import type { DeviceClass } from "../../../server/_core/widgetLayoutWrite";
import type { WidgetVariant } from "../../../server/_core/widgetRegistry";

function deviceClassNow(): DeviceClass {
  const w = typeof window === "undefined" ? 1200 : window.innerWidth;
  return w < 640 ? "phone" : w < 1100 ? "tablet" : "desktop";
}

export default function WidgetBoardPage() {
  const deviceClass = useMemo(deviceClassNow, []);
  const utils = trpc.useUtils();
  const board = trpc.widgets.boardResolve.useQuery({ deviceClass, connected: typeof navigator === "undefined" ? true : navigator.onLine, subjects: {} });
  const offerable = trpc.widgets.offerable.useQuery(undefined, { enabled: false });
  const save = trpc.widgets.layoutSave.useMutation();
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [picking, setPicking] = useState(false);
  const [localTiles, setLocalTiles] = useState<readonly BoardTileView[] | null>(null);

  const tiles: readonly BoardTileView[] = localTiles ?? (board.data?.tiles ?? []).map((t, i) => ({
    instanceRef: t.instanceRef, widgetKey: t.widgetKey, title: t.title, variant: t.variant as WidgetVariant,
    payload: t.payload, position: i,
  }));

  const persist = async (next: readonly BoardTileView[]) => {
    if (!board.data) return;
    setSaveState({ kind: "saving" });
    const out = await save.mutateAsync({
      layoutRef: board.data.layoutRef ?? null, deviceClass, name: board.data.name, isDefault: true,
      items: next.map((t, position) => ({ instanceRef: t.instanceRef, widgetKey: t.widgetKey, variant: t.variant, position })),
    });
    if ("ok" in out && out.ok) { setSaveState({ kind: "saved", at: new Date() }); setLocalTiles(null); await utils.widgets.boardResolve.invalidate(); }
    else if ("rejections" in out) setSaveState({ kind: "rejected", rejections: out.rejections.map(r => ({ code: r.code, detail: r.detail, ...("instanceRef" in r && r.instanceRef ? { instanceRef: r.instanceRef } : {}) })) });
    else setSaveState({ kind: "failed", detail: "The board changed elsewhere; reload and try again" });
  };

  if (board.isLoading) return <main style={{ padding: 24 }}>Opening your board…</main>;
  if (board.error) return <main style={{ padding: 24 }}>This board could not be opened: {board.error.message}</main>;
  if (!board.data) return null;

  return (
    <main style={{ padding: 16 }}>
      <WidgetBoard
        name={board.data.name} seeded={board.data.seeded} deviceClass={deviceClass} tiles={tiles} saveState={saveState}
        offline={typeof navigator !== "undefined" && !navigator.onLine}
        onSave={(order) => void persist(order.map((ref, i) => ({ ...tiles.find(t => t.instanceRef === ref)!, position: i })))}
        onAddWidget={() => { void offerable.refetch(); setPicking(true); }}
        onRemove={(ref) => setLocalTiles(tiles.filter(t => t.instanceRef !== ref))}
        onVariantChange={(ref, variant) => setLocalTiles(tiles.map(t => t.instanceRef === ref ? { ...t, variant } : t))}
        onRefresh={() => void utils.widgets.boardResolve.invalidate()}
        onTileAction={(_ref, kind) => { if (kind === "retry") void utils.widgets.boardResolve.invalidate(); }}
      />
      {picking && offerable.data && (
        <AddWidgetPicker
          offers={offerable.data as never}
          alreadyAdded={tiles.map(t => t.widgetKey)}
          onAdd={(widgetKey: string, variant: string) => {
            const ref = `w-${Date.now().toString(36)}`;
            setLocalTiles([...tiles, { instanceRef: ref, widgetKey, title: widgetKey, variant: variant as WidgetVariant, position: tiles.length,
              payload: { state: "unknown", reason: "added; save the board to read it" } }]);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </main>
  );
}
