/**
 * The frame every showcase page renders inside. It raises the showcase flag
 * for the tRPC link (mutations refused) and says so on screen.
 */
import { useEffect, type ReactNode } from "react";
import { setShowcaseMode } from "../lib/showcaseGuard";

export function ShowcaseFrame({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { setShowcaseMode(true); return () => setShowcaseMode(false); }, []);
  return (
    <div>
      <div role="status" className="sticky top-0 z-50 border-b border-[#f0c36d] bg-[#fff4d6] px-4 py-2 text-sm text-[#5a3d00]">
        <strong>Showcase — {title}.</strong> Demonstration data. Nothing written here reaches production; every save on this page is refused by the client. Authoritative surfaces: <a className="underline" href="/portal">/portal</a>, <a className="underline" href="/customer">/customer</a>.
      </div>
      {children}
    </div>
  );
}
