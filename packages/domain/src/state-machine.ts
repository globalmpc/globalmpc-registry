/**
 * State machine definitions and transition checks.
 *
 * Expresses the spec 04 state machines as data. With transition tables scattered through code,
 * "is this transition allowed" cannot be checked in one place, and the 13 §13.2 state-transition
 * negative tests cannot be run exhaustively.
 */

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  /** from → list of allowed to. An empty array means terminal. */
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
    super(`${machineName}: transition ${from} → ${to} is not allowed`);
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

/** Checks that every state in the transition table is in states, and vice versa. */
export function validateMachine<S extends string>(machine: StateMachine<S>): void {
  const declared = new Set<string>(machine.states);

  if (!declared.has(machine.initial)) {
    throw new Error(`${machine.name}: initial state ${machine.initial} is not in states`);
  }

  for (const state of machine.states) {
    if (!(state in machine.transitions)) {
      throw new Error(`${machine.name}: no transition definition for ${state}`);
    }
  }

  for (const [from, targets] of Object.entries(machine.transitions) as [S, readonly S[]][]) {
    if (!declared.has(from)) {
      throw new Error(`${machine.name}: transition table entry ${from} is not in states`);
    }
    for (const to of targets) {
      if (!declared.has(to)) {
        throw new Error(`${machine.name}: target of ${from} → ${to} is not in states`);
      }
    }
  }
}
