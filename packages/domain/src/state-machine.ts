/**
 * 상태기계 정의와 전이 검사.
 *
 * spec 04의 상태기계를 데이터로 표현한다. 전이표가 코드에 흩어져 있으면
 * "이 전이가 허용되는가"를 한 곳에서 검사할 수 없고, 13 §13.2의 상태 전이
 * negative test를 전수로 돌릴 수도 없다.
 */

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  /** from → 허용된 to 목록. 빈 배열은 terminal이다. */
  readonly transitions: Readonly<Record<S, readonly S[]>>;
}

export function canTransition<S extends string>(
  machine: StateMachine<S>,
  from: S,
  to: S,
): boolean {
  return (machine.transitions[from] ?? []).includes(to);
}

export function isTerminal<S extends string>(machine: StateMachine<S>, state: S): boolean {
  return (machine.transitions[state] ?? []).length === 0;
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_STATE_TRANSITION";
  constructor(
    readonly machineName: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${machineName}: ${from} → ${to} 전이는 허용되지 않는다`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition<S extends string>(
  machine: StateMachine<S>,
  from: S,
  to: S,
): void {
  if (!canTransition(machine, from, to)) {
    throw new InvalidTransitionError(machine.name, from, to);
  }
}

/** 전이표에 등장하는 모든 상태가 states에 있고, 그 반대도 성립하는지 확인한다. */
export function validateMachine<S extends string>(machine: StateMachine<S>): void {
  const declared = new Set<string>(machine.states);

  if (!declared.has(machine.initial)) {
    throw new Error(`${machine.name}: initial 상태 ${machine.initial}가 states에 없다`);
  }

  for (const state of machine.states) {
    if (!(state in machine.transitions)) {
      throw new Error(`${machine.name}: ${state}의 전이 정의가 없다`);
    }
  }

  for (const [from, targets] of Object.entries(machine.transitions) as [S, readonly S[]][]) {
    if (!declared.has(from)) {
      throw new Error(`${machine.name}: 전이표의 ${from}가 states에 없다`);
    }
    for (const to of targets) {
      if (!declared.has(to)) {
        throw new Error(`${machine.name}: ${from} → ${to}의 대상이 states에 없다`);
      }
    }
  }
}
