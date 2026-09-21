/**
 * 0092 — the HOS rule verification console.
 *
 * Five jobs and no more: show the profile and limit, take the figure and unit,
 * record the instrument and citation, record the four dates, and require an
 * explicit human action.
 *
 * What is deliberately absent is the point of the screen. There is no field for
 * pasted regulation text, no upload, no screenshot, no "AI verified this"
 * option, no suggested value and nothing pre-filled from a model's memory. A
 * verifier who has not opened the instrument cannot produce anything here, and
 * a model cannot produce anything here at all.
 *
 * The banner says so out loud, because a person is being asked to attest to
 * something and should be able to see what the system will and will not keep.
 */

import { useState } from "react";
import { trpc } from "../lib/trpc";

const UNITS = ["minutes", "hours", "days", "kilograms"] as const;

const METHODS = [
  { value: "OFFICIAL_WEB", label: "Official publication, on the web" },
  { value: "OFFICIAL_PDF", label: "Official publication, PDF" },
  { value: "OFFICIAL_PRINT", label: "Official publication, print" },
  { value: "REGULATOR_CONFIRMATION", label: "Written confirmation from the regulator" },
  { value: "LEGAL_COUNSEL", label: "Written advice from counsel" },
] as const;

const AUTHORITY_TYPES = [
  { value: "law", label: "Legislation or regulation" },
  { value: "official_guidance", label: "Official guidance" },
  { value: "recognized_standard", label: "Recognized standard" },
  { value: "manufacturer", label: "Manufacturer specification" },
] as const;

/** The seven states a rule can be shown in. Each says what it is in words. */
const STATE_TEXT: Record<string, string> = {
  UNVERIFIED: "Not verified — no figure has been established",
  FUTURE: "Verified, not yet in force",
  CURRENT: "Verified and in force",
  SUPERSEDED: "Replaced by a later verification",
  CORRECTED: "Withdrawn — corrected by a later verification",
  REVOKED: "Withdrawn by the issuing authority — no longer in force",
  AMBIGUOUS_AUTHORITY: "More than one schedule applies — a person decides which governs",
};

const STATE_TONE: Record<string, string> = {
  UNVERIFIED: "#5b6b82", FUTURE: "#8a6d1f", CURRENT: "#1f7a4d", SUPERSEDED: "#5b6b82",
  CORRECTED: "#b42318", REVOKED: "#b42318", AMBIGUOUS_AUTHORITY: "#8a6d1f",
};

const label: React.CSSProperties = { display: "block", fontSize: 12, color: "#3c4a5d", marginTop: 12, marginBottom: 4 };
const field: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 14,
  border: "1px solid #c3cdd9", borderRadius: 6, background: "#fff",
};

export default function HosVerificationConsole() {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

  const [profileKey, setProfileKey] = useState(params.get("profile") ?? "");
  const [limitKey, setLimitKey] = useState(params.get("limit") ?? "");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("minutes");
  const [jurisdiction, setJurisdiction] = useState("");
  const [authorityType, setAuthorityType] = useState<string>("law");
  const [instrumentTitle, setInstrumentTitle] = useState("");
  const [issuingAuthority, setIssuingAuthority] = useState("");
  const [sourceSection, setSourceSection] = useState("");
  const [citationUrl, setCitationUrl] = useState("");
  const [instrumentVersion, setInstrumentVersion] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveUntil, setEffectiveUntil] = useState("");
  const [verificationMethod, setVerificationMethod] = useState<string>("OFFICIAL_WEB");
  const [geographicScope, setGeographicScope] = useState<string>("");

  // Three separate attestations. Not one "I agree" — each is a different claim,
  // and a person should have to make each of them.
  const [hasInstrumentOpen, setHasInstrumentOpen] = useState(false);
  const [personallyVerified, setPersonallyVerified] = useState(false);
  const [confirmsBinding, setConfirmsBinding] = useState(false);

  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 0093. This was wired to `hos.limitVerify`, which accepts a section string
  // and a number and would have rejected everything else this screen collects.
  // The careful form was pointed at the weak door.
  const promote = trpc.hos.limitPromote?.useMutation?.({
    onSuccess: (data: Record<string, unknown>) => { setResult(data); setError(null); },
    onError: (e: { message: string }) => { setError(e.message); setResult(null); },
  });

  const attested = hasInstrumentOpen && personallyVerified && confirmsBinding;
  const complete = Boolean(
    profileKey && limitKey && value && jurisdiction &&
    instrumentTitle && issuingAuthority && sourceSection && citationUrl);
  const ready = attested && complete;

  return (
    <main style={{ maxWidth: 620, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", color: "#111" }}>
      <h1 style={{ fontSize: 20, marginBottom: 2 }}>HOS rule verification</h1>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "#5b6b82" }}>
        A figure recorded here becomes the limit LeaseOS measures drivers against. Only a person
        reading the instrument can establish one.
      </p>

      {/* Said out loud, because somebody is being asked to attest to something. */}
      <p
        data-testid="no-source-text"
        style={{ margin: "0 0 20px", padding: "10px 12px", fontSize: 12, fontWeight: 600,
          border: "1px solid #1f7a4d", borderRadius: 6, color: "#1f7a4d", background: "#f2fbf6" }}
      >
        NO SOURCE TEXT WILL BE STORED — LeaseOS keeps the citation, never the wording.
      </p>

      {!result && (
        <section data-testid="verification-form">
          <label style={label} htmlFor="profileKey">Rule profile</label>
          <input id="profileKey" data-testid="in-profile" style={field} value={profileKey}
            onChange={(e) => setProfileKey(e.target.value)} />

          <label style={label} htmlFor="limitKey">Limit key</label>
          <input id="limitKey" data-testid="in-limit" style={field} value={limitKey}
            onChange={(e) => setLimitKey(e.target.value)} />

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 2 }}>
              <label style={label} htmlFor="value">Value</label>
              {/* No placeholder, no default, no suggestion. A blank field is the
                  only honest starting state. */}
              <input id="value" data-testid="in-value" style={field} inputMode="numeric" value={value}
                onChange={(e) => setValue(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label} htmlFor="unit">Unit</label>
              <select id="unit" data-testid="in-unit" style={field} value={unit}
                onChange={(e) => setUnit(e.target.value as (typeof UNITS)[number])}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          <label style={label} htmlFor="jurisdiction">Jurisdiction</label>
          <input id="jurisdiction" data-testid="in-jurisdiction" style={field} value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value)} />

          <label style={label} htmlFor="scope">Geographic applicability</label>
          <select id="scope" data-testid="in-scope" style={field} value={geographicScope}
            onChange={(e) => setGeographicScope(e.target.value)}>
            <option value="">Not stated</option>
            <option value="SOUTH_OF_60_N">South of latitude 60°N</option>
            <option value="NORTH_OF_60_N">North of latitude 60°N</option>
            <option value="ALL">The whole jurisdiction</option>
          </select>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "#5b6b82" }}>
            Where a jurisdiction runs more than one regime, a schedule with no geographic
            scope is refused — a figure read in one division does not describe the other.
          </p>

          <label style={label} htmlFor="authorityType">Authority</label>
          <select id="authorityType" data-testid="in-authority" style={field} value={authorityType}
            onChange={(e) => setAuthorityType(e.target.value)}>
            {AUTHORITY_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>

          <label style={label} htmlFor="instrumentTitle">Binding instrument</label>
          <input id="instrumentTitle" data-testid="in-instrument" style={field} value={instrumentTitle}
            onChange={(e) => setInstrumentTitle(e.target.value)} />

          <label style={label} htmlFor="issuingAuthority">Issuing authority</label>
          <input id="issuingAuthority" data-testid="in-issuer" style={field} value={issuingAuthority}
            onChange={(e) => setIssuingAuthority(e.target.value)} />

          <label style={label} htmlFor="sourceSection">Section or subsection</label>
          <input id="sourceSection" data-testid="in-section" style={field} value={sourceSection}
            onChange={(e) => setSourceSection(e.target.value)} />

          <label style={label} htmlFor="citationUrl">Official citation URL</label>
          <input id="citationUrl" data-testid="in-citation" style={field} value={citationUrl}
            onChange={(e) => setCitationUrl(e.target.value)} />

          <label style={label} htmlFor="method">How it was verified</label>
          <select id="method" data-testid="in-method" style={field} value={verificationMethod}
            onChange={(e) => setVerificationMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "#5b6b82" }}>
            An official publication must be cited on the publisher's own site. A regulator's
            confirmation or counsel's advice may be cited anywhere.
          </p>

          <label style={label} htmlFor="instrumentVersion">Instrument version or consolidation date</label>
          <input id="instrumentVersion" data-testid="in-version" style={field} value={instrumentVersion}
            onChange={(e) => setInstrumentVersion(e.target.value)} />

          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={label} htmlFor="effectiveFrom">Effective from</label>
              <input id="effectiveFrom" data-testid="in-from" type="date" style={field} value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label} htmlFor="effectiveUntil">Effective until (optional)</label>
              <input id="effectiveUntil" data-testid="in-until" type="date" style={field} value={effectiveUntil}
                onChange={(e) => setEffectiveUntil(e.target.value)} />
            </div>
          </div>
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "#5b6b82" }}>
            A rule that has not started is recorded and not applied — LeaseOS keeps measuring
            against the one in force.
          </p>

          <fieldset style={{ marginTop: 20, border: "1px solid #c3cdd9", borderRadius: 6, padding: 12 }}>
            <legend style={{ fontSize: 12, color: "#3c4a5d", padding: "0 6px" }}>Attestation</legend>
            {/* Three claims, three boxes. Not one "I agree". */}
            <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <input type="checkbox" data-testid="attest-open" checked={hasInstrumentOpen}
                onChange={(e) => setHasInstrumentOpen(e.target.checked)} />{" "}
              I have the official instrument open.
            </label>
            <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <input type="checkbox" data-testid="attest-verified" checked={personallyVerified}
                onChange={(e) => setPersonallyVerified(e.target.checked)} />{" "}
              I personally verified this figure.
            </label>
            <label style={{ display: "block", fontSize: 13 }}>
              <input type="checkbox" data-testid="attest-binding" checked={confirmsBinding}
                onChange={(e) => setConfirmsBinding(e.target.checked)} />{" "}
              I confirm this is a binding authority.
            </label>
          </fieldset>

          <button
            data-testid="promote"
            disabled={!ready || promote?.isPending}
            onClick={() => promote?.mutate({
              profileKey, limitKey, value: Number(value), unit, jurisdiction, authorityType,
              instrumentTitle, issuingAuthority, sourceSection, citationUrl,
              instrumentVersion: instrumentVersion || undefined,
              verificationMethod,
              geographicScope: geographicScope || undefined,
              effectiveFrom: effectiveFrom || undefined,
              effectiveUntil: effectiveUntil || undefined,
              // Sent separately, and the server types them as literal true.
              // A combined "I agree" would not satisfy it.
              attestInstrumentOpen: hasInstrumentOpen,
              attestPersonallyVerified: personallyVerified,
              attestBindingAuthority: confirmsBinding,
            } as never)}
            style={{
              marginTop: 20, width: "100%", padding: "12px 16px", fontSize: 15, fontWeight: 600,
              borderRadius: 6, border: "none", color: "#fff",
              background: ready ? "#1f7a4d" : "#9aa7b6", cursor: ready ? "pointer" : "not-allowed",
            }}
          >
            Promote verified rule
          </button>

          {!ready && (
            <p data-testid="not-ready" style={{ margin: "8px 0 0", fontSize: 12, color: "#5b6b82" }}>
              {!complete
                ? "Every field above is required — a figure without its instrument cannot be defended later."
                : "All three attestations are required."}
            </p>
          )}

          {error && (
            <p data-testid="promotion-error" role="status"
              style={{ marginTop: 12, padding: "10px 12px", fontSize: 13, color: "#b42318",
                border: "1px solid #b42318", borderRadius: 6 }}>
              Not promoted — {error}
            </p>
          )}
        </section>
      )}

      {result && (
        <section data-testid="promotion-receipt" role="status"
          style={{ border: "1px solid #1f7a4d", borderLeftWidth: 4, borderRadius: 8, padding: 16 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>Promotion complete</h2>
          {/* The immutable record, not "saved". */}
          <Row k="Promotion ref" v={String(result.promotionRef ?? "—")} testId="r-ref" />
          <Row k="Profile" v={profileKey} testId="r-profile" />
          <Row k="Limit" v={limitKey} testId="r-limit" />
          <Row k="Value" v={`${value} ${unit}`} testId="r-value" />
          <Row k="Status" v={String(result.status ?? "—")} testId="r-status"
            note={STATE_TEXT[String(result.status ?? "")] ?? ""} />
          <Row k="Citation" v={citationUrl} testId="r-citation" />
          <Row k="Source text stored" v="NO" testId="r-no-text" />
          <Row k="Live row linked" v={result.becameCurrent ? "YES" : "NO — recorded, not yet in force"} testId="r-linked" />
          <Row k="Ledger divergence" v={String(result.divergence ?? "NONE")} testId="r-divergence" />

          <button data-testid="verify-another" onClick={() => { setResult(null); setValue("");
            setHasInstrumentOpen(false); setPersonallyVerified(false); setConfirmsBinding(false); }}
            style={{ marginTop: 16, padding: "8px 14px", fontSize: 13, borderRadius: 6,
              border: "1px solid #c3cdd9", background: "#fff", cursor: "pointer" }}>
            Verify another figure
          </button>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 13, marginBottom: 8 }}>What each state means</h2>
        {Object.entries(STATE_TEXT).map(([state, text]) => (
          <p key={state} data-testid={`state-${state}`} style={{ margin: "0 0 4px", fontSize: 12 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4,
              background: STATE_TONE[state], marginRight: 8 }} />
            <strong>{state}</strong> — {text}
          </p>
        ))}
      </section>
    </main>
  );
}

function Row({ k, v, testId, note }: { k: string; v: string; testId: string; note?: string }) {
  return (
    <p style={{ margin: "0 0 6px", fontSize: 13, display: "flex", gap: 12 }}>
      <span style={{ minWidth: 150, color: "#5b6b82" }}>{k}</span>
      <span data-testid={testId} style={{ fontWeight: 600, wordBreak: "break-all" }}>
        {v}{note ? <span style={{ fontWeight: 400, color: "#5b6b82" }}> — {note}</span> : null}
      </span>
    </p>
  );
}
