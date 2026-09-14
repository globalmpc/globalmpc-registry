/**
 * Three-depth record view — spec 11 §11.10 / 13 AC-26.
 *
 * Shows the same canonical record at three depths: Basic / Explanation / Expert.
 * **status, asOf, version, and limitations must be identical at every depth.** Only Expert adds
 * receipt, schema, hash, signature, and proof details.
 *
 * Without this constraint, the status in "simple view" and "detailed view" could differ. At that
 * point neither screen can be trusted.
 */

export type RecordDepth = "basic" | "explanation" | "expert";

/** Fields all three depths must share. Any difference violates AC-26. */
export interface SharedRecordFacts {
  readonly recordId: string;
  readonly version: string;
  readonly status: string;
  readonly asOf: string;
  readonly limitations: readonly string[];
  /** authority scope and as-of cannot be collapsed in Basic (§11.10). */
  readonly authorityScope: readonly string[];
}

export interface ExplanationLayer {
  /** What this authority proves and what it does not. */
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
  readonly freshnessExplanation: string;
}

export interface ExpertLayer {
  readonly authorityId: string;
  readonly queryOrDocumentReference: string;
  readonly receivedAt: string;
  readonly rawHashReference: string;
  readonly sourceSchemaVersion: string;
  readonly adapterVersion: string;
  readonly signature: string | null;
  readonly attestationVersion: string | null;
  readonly policyVersion: string | null;
  readonly merklePath: readonly string[] | null;
  readonly transactionHash: string | null;
}

export interface RecordView {
  readonly shared: SharedRecordFacts;
  readonly explanation: ExplanationLayer;
  readonly expert: ExpertLayer;
}

/**
 * Selects the fields exposed at each depth.
 *
 * shared is never dropped at any depth. This is a function because when each component picks its
 * own fields, some screen eventually drops limitations.
 */
export function project(view: RecordView, depth: RecordDepth) {
  const base = { ...view.shared };
  if (depth === "basic") return base;
  if (depth === "explanation") return { ...base, ...view.explanation };
  return { ...base, ...view.explanation, ...view.expert };
}

/** AC-26 check — verifies that all three depths show the same shared facts. */
export function sharedFactsConsistent(view: RecordView): boolean {
  const basic = project(view, "basic");
  const explanation = project(view, "explanation");
  const expert = project(view, "expert");

  const keys = Object.keys(view.shared) as (keyof SharedRecordFacts)[];
  return keys.every((key) => {
    const a = JSON.stringify(basic[key]);
    return (
      a === JSON.stringify((explanation as Record<string, unknown>)[key]) &&
      a === JSON.stringify((expert as Record<string, unknown>)[key])
    );
  });
}
