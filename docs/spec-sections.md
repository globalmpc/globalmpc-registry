# Specification section numbers and identifier notation

Code comments point to their rationale with short identifiers such as
`spec 05 §5.3` or `OD-17`. This page collects what that notation means.

**The specification text is not in this repository.** What is here is the mapping
from numbers to titles; each comment states what it needs in place — comments are
written so that you never need the specification to read them.

## `spec NN §N.N` — specification document numbers

| No. | Document |
|---|---|
| 01 | Product scope |
| 02 | Roles and permissions |
| 03 | User journeys |
| 04 | Domain and state model |
| 05 | Data and registry model |
| 06 | System architecture |
| 07 | API and events |
| 08 | Smart contracts |
| 09 | Governance |
| 10 | Security, privacy, compliance |
| 11 | UX and information architecture |
| 12 | Delivery roadmap |
| 13 | Testing and acceptance |

## Identifiers

| Notation | Meaning |
|---|---|
| `OD-nn` | **Open decision** — a decision not yet made. It is the basis for **behaviour the code refuses** because the value is not set. User-facing pages (`/legal`, `/asset-registry`) show the number as is |
| `AC-nn` | **Acceptance criterion**. Code and test mapping: [`acceptance-code-map.md`](acceptance-code-map.md) |
| `REQ-DAPP-nnn` | Requirement number |
| `ADR-Tnn` | Architecture Decision Record (technical) |
| `D-nn` | Design principle number |
| `R-04` | Prohibited-language rule. Canonical list: `packages/ui/src/prohibited-language.ts` |
| `R0`–`R7` | Release stages |

An `OD-nn` left in the code is not a sign of unfinished work but **the basis for a
deliberate refusal**. For example, because `OD-17` (data jurisdiction) and `OD-18`
(encryption key ownership) are unresolved, uploads reject the `confidential` and
`pii` classifications with 422. Not building the path until the decision is made is
how this repository works.
