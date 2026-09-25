/**
 * The provider CI uses. Fixtures in, fixtures out, no socket opened.
 *
 * It is keyed on the transcript rather than on call order, so a test that adds
 * a case in the middle does not shift every later expectation — the failure
 * mode that makes recorded-response suites rot.
 *
 * An unknown transcript throws. A mock that invents a plausible-looking answer
 * for an unregistered input would let a test pass while proving nothing, and
 * the whole point of this layer is that nothing passes for a reason nobody
 * chose.
 */

import { TRANSCRIPT_FENCE } from "../injection/guard";
import {
  LlmTransportError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "./provider";

export class MockResponseMissing extends LlmTransportError {}

export type MockFixture = {
  /** Matched against the user message, exactly, after trimming. */
  transcript: string;
  /** What the model would have returned. Usually a JSON string. */
  response: string;
};

export class MockLlmProvider implements LlmProvider {
  readonly providerKey = "mock";
  readonly modelId: string;

  private readonly byTranscript: Map<string, string>;
  /** Every request seen, so a test can assert what the prompt actually said. */
  readonly calls: LlmRequest[] = [];

  constructor(fixtures: readonly MockFixture[], modelId = "mock-secretary-v1") {
    this.modelId = modelId;
    this.byTranscript = new Map();
    for (const f of fixtures) {
      const key = f.transcript.trim();
      if (this.byTranscript.has(key)) {
        throw new MockResponseMissing(
          `two fixtures share the transcript ${JSON.stringify(key.slice(0, 60))}; one response per transcript`
        );
      }
      this.byTranscript.set(key, f.response);
    }
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);

    // The transcript is the last user message; the system prompt and context
    // pack precede it. Keying on it rather than on the whole prompt means a
    // prompt revision does not invalidate every fixture.
    const user = [...request.messages].reverse().find(m => m.role === "user");
    const key = extractTranscript(user?.content ?? "");
    const response = this.byTranscript.get(key);

    if (response === undefined) {
      return Promise.reject(
        new MockResponseMissing(
          `no mock fixture for transcript ${JSON.stringify(key.slice(0, 80))}`
        )
      );
    }

    return Promise.resolve({ text: response, modelId: this.modelId });
  }
}

/**
 * Pull the transcript back out of a fenced user message.
 *
 * `server/ai/injection/guard.ts` wraps untrusted text in delimiters before it
 * reaches a model. The mock has to undo exactly that to find its key, so the
 * delimiter lives in one place and both sides import it.
 */
function extractTranscript(content: string): string {
  const open = content.indexOf(TRANSCRIPT_FENCE.open);
  const close = content.indexOf(TRANSCRIPT_FENCE.close);
  if (open === -1 || close === -1 || close < open) return content.trim();
  return content.slice(open + TRANSCRIPT_FENCE.open.length, close).trim();
}
