/**
 * Persistence boundary for Assistant proposals.
 *
 * Database rows are not a Proposal. A proposal's gaps/questions are derived
 * state and must be recomputed from the fields that were actually persisted.
 * Reusing buildProposal(form, targetRef, []) and then swapping the fields in
 * leaves the gap list for an EMPTY proposal attached to the real fields.
 */

import {
  FORMS,
  buildProposal,
  detectGaps,
  minimumQuestions,
  type Proposal,
  type ProposedField,
} from "./aiProposal";

export type PersistedAssistantProposal = {
  proposalId: string;
  formKey: string;
  targetRef: string;
  readBack: string | null;
  readBackAcknowledged: boolean;
  commitState: Proposal["commitState"];
};

export type PersistedProposalField = {
  fieldKey: string;
  label: string;
  fieldValue: string | null;
  precision: ProposedField["precision"];
  source: ProposedField["source"];
  confidence: ProposedField["confidence"];
  status: ProposedField["status"];
  sourceUtterance: string | null;
  correctedFrom: string | null;
};

export const parseStoredProposalValue = (
  value: string
): string | number | boolean | null => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * Rebuild the runtime Proposal from persisted rows and recompute every derived
 * field from the persisted field set. Unknown form versions fail closed: a
 * proposal whose schema no longer exists must not be committed by guesswork.
 */
export function rehydrateProposal(
  row: PersistedAssistantProposal,
  fieldRows: readonly PersistedProposalField[]
): Proposal {
  const form = FORMS[row.formKey];
  if (!form) {
    throw new Error(
      `Unknown persisted assistant form: ${row.formKey} — proposal ${row.proposalId} cannot be safely rehydrated`
    );
  }

  const fields: ProposedField[] = fieldRows.map(f => ({
    key: f.fieldKey,
    label: f.label,
    value:
      f.fieldValue === null ? null : parseStoredProposalValue(f.fieldValue),
    precision: f.precision,
    source: f.source,
    confidence: f.confidence,
    status: f.status,
    sourceUtterance: f.sourceUtterance,
    correctedFrom:
      f.correctedFrom === null
        ? null
        : parseStoredProposalValue(f.correctedFrom),
  }));

  const base = buildProposal(form, row.targetRef, []);
  const gaps = detectGaps(form, fields);

  return {
    ...base,
    proposalId: row.proposalId,
    fields,
    gaps,
    questions: minimumQuestions(gaps),
    readBack: row.readBack,
    readBackAcknowledged: row.readBackAcknowledged,
    commitState: row.commitState,
  };
}
