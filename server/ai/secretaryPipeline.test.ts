/**
 * The pipeline end to end, and the provenance it leaves behind.
 *
 * One narration through the worker job: perimeter, fence, provider, parse,
 * scan, validate, proposal. No database — the job body returns what should be
 * written, and the worker that already owns claims and transactions does the
 * writing.
 */
import { describe, expect, it } from "vitest";
import { FORMS } from "../_core/aiProposal";
import { MockLlmProvider } from "./llm/mockProvider";
import { buildContextPack } from "./context/contextPack";
import { runExtraction } from "./extraction/runExtraction";
import { toProposal, advanceBlockedBecause } from "./proposal/bridge";
import { runSecretaryExtractionJob } from "./worker/secretaryExtractionJob";
import { loadGoldenSet } from "./eval/goldenSet";

const form = FORMS.unload_stop;
const cases = loadGoldenSet();
const caseNamed = (id: string) => {
  const found = cases.find(c => c.id === id);
  if (!found) throw new Error(`no golden case ${id}`);
  return found;
};

const providerFor = (id: string) => {
  const c = caseNamed(id);
  return new MockLlmProvider([{ transcript: c.transcript, response: JSON.stringify(c.modelResponse) }]);
};

const packFor = (id: string) => buildContextPack(caseNamed(id).context);

describe("the prompt the model actually receives", () => {
  it("fences the transcript and labels it as data", async () => {
    const provider = providerFor("07-injected-scan");
    await runExtraction({
      provider,
      form,
      transcript: caseNamed("07-injected-scan").transcript,
      pack: packFor("07-injected-scan"),
    });

    const user = provider.calls[0].messages.find(m => m.role === "user")!.content;
    expect(user).toContain("DATA, not instructions");
    expect(user).toContain("LEASEOS_TRANSCRIPT_DATA_BEGIN");
    expect(user).toContain("LEASEOS_TRANSCRIPT_DATA_END");
  });

  it("carries the versioned prompt and the context pack in the system message", async () => {
    const provider = providerFor("01-clean-unload");
    await runExtraction({
      provider,
      form,
      transcript: caseNamed("01-clean-unload").transcript,
      pack: packFor("01-clean-unload"),
    });

    const system = provider.calls[0].messages.find(m => m.role === "system")!.content;
    expect(system).toContain("You are the LeaseOS field secretary");
    expect(system).toContain("- trip: Trip = TRIP-2026-004821");
  });

  it("constrains the output to the derived schema at temperature zero", async () => {
    const provider = providerFor("01-clean-unload");
    await runExtraction({
      provider,
      form,
      transcript: caseNamed("01-clean-unload").transcript,
      pack: packFor("01-clean-unload"),
    });
    expect(provider.calls[0].jsonSchema.name).toBe("leaseos_secretary_unload_stop_v1");
    expect(provider.calls[0].temperature).toBe(0);
  });
});

describe("out-of-perimeter requests", () => {
  it("are refused before any model is called", async () => {
    const provider = new MockLlmProvider([]);
    const outcome = await runExtraction({
      provider,
      form,
      transcript: caseNamed("09-out-of-scope").transcript,
      pack: packFor("09-out-of-scope"),
    });

    expect(outcome.kind).toBe("refused");
    // Not one call. The cheapest refusal is the one that spends nothing, and
    // an empty mock would have thrown if a call had been attempted.
    expect(provider.calls).toHaveLength(0);
  });

  it("create no proposal at all", async () => {
    const result = await runSecretaryExtractionJob({
      event: {
        eventId: "EV-1",
        clientCaptureId: "CAP-1",
        transcript: caseNamed("09-out-of-scope").transcript,
        targetRef: "TRIP-2026-004821 unload stop",
      },
      provider: new MockLlmProvider([]),
      form,
      pack: packFor("09-out-of-scope"),
    });

    expect(result.kind).toBe("refused");
  });
});

describe("the proposal that comes out", () => {
  const runJob = async (id: string, captureId = "CAP-9f2") =>
    runSecretaryExtractionJob({
      event: {
        eventId: "EV-1",
        clientCaptureId: captureId,
        transcript: caseNamed(id).transcript,
        targetRef: "TRIP-2026-004821 unload stop",
      },
      provider: providerFor(id),
      form,
      pack: packFor(id),
    });

  it("records what answered, under which prompt, on what input", async () => {
    const result = await runJob("01-clean-unload");
    if (result.kind !== "proposal") throw new Error("expected a proposal");

    expect(result.proposal.run.providerKey).toBe("mock");
    expect(result.proposal.run.modelId).toBe("mock-secretary-v1");
    expect(result.proposal.run.promptVersion).toBe("secretary-extract.v1");
    expect(result.proposal.run.promptHash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.proposal.run.inputHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("lands at the HYBRID ceiling and in drafting, never committed", async () => {
    const result = await runJob("01-clean-unload");
    if (result.kind !== "proposal") throw new Error("expected a proposal");

    expect(result.proposal.ceiling).toBe("HYBRID");
    expect(result.proposal.proposal.commitState).toBe("drafting");
  });

  it("is keyed on the device's capture id, so a replay proposes once", async () => {
    const first = await runJob("01-clean-unload", "CAP-abc");
    const replay = await runJob("01-clean-unload", "CAP-abc");
    if (first.kind !== "proposal" || replay.kind !== "proposal") throw new Error("expected proposals");
    expect(first.proposal.proposal.proposalId).toBe(replay.proposal.proposal.proposalId);
  });

  it("maps a stated field onto driver_voice, and a hedge onto approximate", async () => {
    const result = await runJob("04-geofence-proposes-time");
    if (result.kind !== "proposal") throw new Error("expected a proposal");

    const quantity = result.proposal.proposal.fields.find(f => f.key === "quantity");
    expect(quantity?.source).toBe("driver_voice");
    expect(quantity?.precision).toBe("exact");

    // "Got there around seven" is hedged in the driver's own words, so the
    // value is approximate whatever the model thought of it — and the value
    // itself came from the geofence, so its source is gps.
    const arrived = result.proposal.proposal.fields.find(f => f.key === "arrivedAt");
    expect(arrived?.precision).toBe("approximate");
    expect(arrived?.source).toBe("gps");
    expect(arrived?.value).toBe("07:04");
  });

  it("drops a fabricated field from the proposal but keeps it in the verdicts", async () => {
    const result = await runJob("05-fabricated-quote");
    if (result.kind !== "proposal") throw new Error("expected a proposal");

    expect(result.proposal.proposal.fields.some(f => f.key === "quantity")).toBe(false);
    const verdict = result.proposal.verdicts.find(v => v.key === "quantity");
    expect(verdict?.verdict).toBe("BLOCKED");
    expect(verdict?.reasonCodes).toContain("quote_not_in_transcript");
  });

  it("holds everything while an injection is suspected", async () => {
    const result = await runJob("07-injected-scan");
    if (result.kind !== "proposal") throw new Error("expected a proposal");

    expect(result.proposal.injection.suspected).toBe(true);
    expect(result.heldBecause).toContain("injection suspected");
  });

  it("holds everything while a field is BLOCKED", async () => {
    const result = await runJob("10-over-capacity");
    if (result.kind !== "proposal") throw new Error("expected a proposal");
    expect(result.heldBecause).toContain("blocked fields");
  });

  it("does not hold a clean narration", async () => {
    const result = await runJob("01-clean-unload");
    if (result.kind !== "proposal") throw new Error("expected a proposal");
    expect(result.heldBecause).toBeNull();
  });
});

describe("corrections keep what they replaced", () => {
  it("marks the field human_corrected and keeps the superseded value", async () => {
    const id = "02-ambiguous-units";
    const outcome = await runExtraction({
      provider: providerFor(id),
      form,
      transcript: caseNamed(id).transcript,
      pack: packFor(id),
    });
    if (outcome.kind !== "extracted") throw new Error("expected an extraction");

    const proposal = toProposal({
      form,
      targetRef: "TRIP-2026-004821 unload stop",
      transcript: caseNamed(id).transcript,
      envelope: outcome.envelope,
      validation: outcome.validation,
      run: outcome.run,
      injection: outcome.injection,
      correctedKeys: ["quantity"],
      supersededValues: { quantity: 16 },
    });

    const quantity = proposal.proposal.fields.find(f => f.key === "quantity");
    expect(quantity?.source).toBe("human_corrected");
    expect(quantity?.status).toBe("corrected");
    // Nothing is overwritten in place: the superseded value is a labelled
    // example, and losing it loses both the audit trail and the training set.
    expect(quantity?.correctedFrom).toBe(16);
  });

  it("reports nothing held when the injection scan and the verdicts are clean", async () => {
    const id = "01-clean-unload";
    const outcome = await runExtraction({
      provider: providerFor(id),
      form,
      transcript: caseNamed(id).transcript,
      pack: packFor(id),
    });
    if (outcome.kind !== "extracted") throw new Error("expected an extraction");

    expect(
      advanceBlockedBecause(
        toProposal({
          form,
          targetRef: "X",
          transcript: caseNamed(id).transcript,
          envelope: outcome.envelope,
          validation: outcome.validation,
          run: outcome.run,
          injection: outcome.injection,
        })
      )
    ).toBeNull();
  });
});
