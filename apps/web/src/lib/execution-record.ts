/**
 * Execution record form — 09 §9.7.
 *
 * One form serves every proposal waiting for an execution record. Evidence typed for one
 * proposal must not be recorded against another, and a record cannot be deleted once written
 * (0054), so the form names its target and only that proposal's buttons act on it.
 */
export interface ExecutionRecordFields {
  readonly targetProposalId: string;
  readonly executor: string;
  readonly authority: string;
  readonly executedAction: string;
  readonly evidenceReference: string;
  readonly evidenceHash: string;
  readonly limitation: string;
}

export const EMPTY_EXECUTION_RECORD: ExecutionRecordFields = {
  targetProposalId: "",
  executor: "",
  authority: "",
  executedAction: "",
  evidenceReference: "",
  evidenceHash: "",
  limitation: "",
};

/** Whether the form may record against `proposalId`: it is the chosen target and complete. */
export function canRecordExecutionFor(fields: ExecutionRecordFields, proposalId: string): boolean {
  return (
    fields.targetProposalId === proposalId &&
    fields.executor.trim().length > 0 &&
    fields.authority.trim().length > 0 &&
    fields.executedAction.trim().length > 0 &&
    fields.evidenceReference.trim().length > 0 &&
    /^0x[0-9a-f]{64}$/.test(fields.evidenceHash) &&
    fields.limitation.trim().length > 0
  );
}
