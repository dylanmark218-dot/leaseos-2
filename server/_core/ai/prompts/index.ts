/**
 * Prompts are versioned files in the repository, not strings in a function.
 *
 * `server/_core/assistantExtraction.ts` builds its system prompt inline. That
 * is readable and it makes one question unanswerable six months later: which
 * words produced this proposal? A prompt is as much a cause of an output as
 * the model is, so it gets a version, a file, and a hash, and every proposal
 * records which one it ran under.
 *
 * The version is in the filename rather than in front matter so that changing
 * a prompt is visibly a new file in a diff. Editing `v1` in place after it has
 * produced proposals makes those proposals unreproducible; the eval harness
 * compares across versions and cannot do that if a version is a moving target.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export type PromptVersion = "secretary-extract.v1";

export const CURRENT_EXTRACT_PROMPT: PromptVersion = "secretary-extract.v1";

const cache = new Map<PromptVersion, string>();

export function loadPrompt(version: PromptVersion): string {
  const cached = cache.get(version);
  if (cached !== undefined) return cached;

  const text = readFileSync(join(here, `${version}.md`), "utf8").trim();
  cache.set(version, text);
  return text;
}

/**
 * A stable fingerprint of a prompt's text.
 *
 * Stored beside the version on every proposal, because a version number only
 * proves which file was named — the hash proves which words were in it. The
 * two together are what makes "re-run this narration under exactly what it ran
 * under before" a question with an answer.
 */
export function promptHash(version: PromptVersion): string {
  return createHash("sha256").update(loadPrompt(version)).digest("hex").slice(0, 32);
}

/**
 * What a proposal records about the run that produced it.
 *
 * Everything here is about reproducing the call, not about trusting it. There
 * is no confidence score: the model's own certainty is not evidence and is not
 * stored as though it were.
 */
export type RunProvenance = {
  providerKey: string;
  modelId: string;
  promptVersion: PromptVersion;
  promptHash: string;
  /** Hash of transcript + rendered context pack, so an input is identifiable. */
  inputHash: string;
};

export function inputHash(transcript: string, renderedContext: string): string {
  return createHash("sha256")
    .update(transcript)
    .update("\u0000")
    .update(renderedContext)
    .digest("hex")
    .slice(0, 32);
}
