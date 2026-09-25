/**
 * Where a model call is allowed to happen: the worker, behind the outbox.
 *
 * Never inside a request handler. Three reasons, and the third is the one that
 * decides it:
 *
 *   a model call is seconds, and a tRPC request that holds a connection for
 *   seconds is a tRPC request that times out under load;
 *
 *   a model call fails in ways a request cannot usefully retry — a cold model,
 *   an in-cab box that is asleep — and `domainEventOutbox` already has claim
 *   leases, attempt counts and dead-lettering for exactly that;
 *
 *   a driver narrating from a truck with no signal has no request to be inside.
 *   The capture is queued on the device, syncs when there is signal, and the
 *   extraction happens after. A design where extraction needs the driver to be
 *   connected is a design that does not work in a cab.
 *
 * This module is the job body only. It takes a claimed event and the pieces it
 * needs, and returns what should be written. The claiming, the transaction and
 * the write belong to `server/_core/productionWorker.ts`, which already does
 * them for every other event type; a second claim loop here would be a second
 * answer to who owns an event.
 */

import { createHash } from "node:crypto";
import type { LlmProvider } from "../llm/provider";
import type { FormDefinition } from "../../aiProposal";
import type { ContextPack } from "../context/contextPack";
import type { SttConfidence } from "../validate/validator";
import { runExtraction } from "../extraction/runExtraction";
import { advanceBlockedBecause, toProposal, type SecretaryProposal } from "../proposal/bridge";

/** The event type this job claims. One type, so a filter can be exact. */
export const SECRETARY_EXTRACTION_EVENT = "secretary.narration.captured";

export type SecretaryExtractionEvent = {
  eventId: string;
  /** Written by the device, stable across replays. The idempotency key. */
  clientCaptureId: string;
  transcript: string;
  targetRef: string;
};

export type SecretaryExtractionResult =
  | { kind: "refused"; eventId: string; detail: string }
  | {
      kind: "proposal";
      eventId: string;
      clientCaptureId: string;
      proposal: SecretaryProposal;
      /** Non-null when nothing may advance until a person looks. */
      heldBecause: string | null;
    };

/**
 * Run one narration.
 *
 * The provider is injected rather than resolved here, so the worker's wiring
 * decides which tier answers — phone, in-cab box or cloud — and the test suite
 * hands in the mock. A job that built its own provider would be a job that
 * could reach a network in CI.
 */
export async function runSecretaryExtractionJob(args: {
  event: SecretaryExtractionEvent;
  provider: LlmProvider;
  form: FormDefinition;
  pack: ContextPack;
  stt?: SttConfidence | null;
}): Promise<SecretaryExtractionResult> {
  const { event, provider, form, pack } = args;

  const outcome = await runExtraction({
    provider,
    form,
    transcript: event.transcript,
    pack,
    stt: args.stt ?? null,
  });

  if (outcome.kind === "refused") {
    // No proposal is created. An out-of-perimeter request that left a pending
    // row behind would be an out-of-perimeter request somebody has to dismiss.
    return { kind: "refused", eventId: event.eventId, detail: outcome.detail };
  }

  const proposal = toProposal({
    form,
    targetRef: event.targetRef,
    transcript: event.transcript,
    envelope: outcome.envelope,
    validation: outcome.validation,
    run: outcome.run,
    injection: outcome.injection,
    // The device's own id, so a replayed capture proposes once. Deriving it
    // here from the event id would break on a redelivered event, which is the
    // case the key exists for.
    proposalId: `PROP-${createHash("sha256").update(event.clientCaptureId).digest("hex").slice(0, 35)}`,
  });

  return {
    kind: "proposal",
    eventId: event.eventId,
    clientCaptureId: event.clientCaptureId,
    proposal,
    heldBecause: advanceBlockedBecause(proposal),
  };
}
