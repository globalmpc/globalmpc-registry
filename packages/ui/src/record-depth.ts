/**
 * 3깊이 레코드 뷰 — spec 11 §11.10 / 13 AC-26.
 *
 * 같은 canonical record를 Basic / Explanation / Expert 세 깊이로 보여준다.
 * **깊이가 달라도 status·asOf·version·limitations는 동일해야 한다.** Expert만
 * receipt·schema·hash·signature·proof 상세를 추가한다.
 *
 * 이 제약이 없으면 "간단히 보기"에서 본 상태와 "자세히 보기"에서 본 상태가
 * 달라진다. 그 순간 두 화면 중 어느 쪽도 신뢰할 수 없게 된다.
 */

export type RecordDepth = "basic" | "explanation" | "expert";

/** 세 깊이가 반드시 공유하는 필드. 하나라도 다르면 AC-26 위반이다. */
export interface SharedRecordFacts {
  readonly recordId: string;
  readonly version: string;
  readonly status: string;
  readonly asOf: string;
  readonly limitations: readonly string[];
  /** authority scope와 as-of는 Basic에서 접을 수 없다(§11.10). */
  readonly authorityScope: readonly string[];
}

export interface ExplanationLayer {
  /** 이 authority가 무엇을 증명하고 무엇을 증명하지 않는가. */
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
 * 깊이별로 노출할 필드를 고른다.
 *
 * shared는 어느 깊이에서도 빠지지 않는다. 이것이 함수인 이유는, 컴포넌트마다
 * 필드를 골라 넣다 보면 어느 화면에선가 limitations가 빠지기 때문이다.
 */
export function project(view: RecordView, depth: RecordDepth) {
  const base = { ...view.shared };
  if (depth === "basic") return base;
  if (depth === "explanation") return { ...base, ...view.explanation };
  return { ...base, ...view.explanation, ...view.expert };
}

/** AC-26 검사 — 세 깊이가 같은 shared facts를 보여주는지 확인한다. */
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
