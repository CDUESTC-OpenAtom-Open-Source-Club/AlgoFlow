# AlgoFlow contracts

This directory is the single source of truth for data exchanged by the phone,
web workspace, sync API, and AI gateway.

- `schemas/domain.schema.json`: entity and shared enum definitions.
- `schemas/sync.schema.json`: sync operation and result definitions.
- `schemas/ai.schema.json`: AI request and artifact definitions.
- `vectors/*.json`: implementation-neutral contract examples.

The schemas intentionally avoid provider-specific fields. Consumers may generate
types later, but must keep these JSON documents authoritative.

The AI contract separates the problem statement (`problem_context`) from stable
user-authored `idea_segments`. Faithful artifacts must map every pseudocode node
back to those segments, and code output is limited to a bounded fragment with
step-to-line mappings. `template_id` reports a server-configured template selected
by the provider; a null value means no configured template matched.

`visibility` is a presentation and workflow flag, not a security boundary. Hidden
code that is compiled without disclosure requires a separate server-side artifact
store and isolated execution service. Compilation and execution are intentionally
outside the AI gateway.

## IDE review and completion

Two optional, editor-decoupled capabilities extend the transform contract for the
CodeMirror 6 and OpenHarmony editors. Neither replaces local highlighting, bracket
matching, or base diagnostics.

- Review (`reviewRequest` / `reviewResult`): explanation, risk, or complexity
  review of the current code and user thinking. Each diagnostic records a level,
  an optional line/character `range` (a null range marks a global suggestion), a
  problem statement, the reasoning basis, and a suggestion. Suggestions are always
  a separate field — they never embed or overwrite the user's code.
- Completion (`completionRequest` / `completionResult`): a user-triggered local
  edit near the cursor. The result records the original `replaced_range`, the
  `suggestion_text`, and the `model_id` / `rule_version` provenance. Completions
  are bounded to a short fragment and must never contain a `main` entry point or
  a complete submission program.

Both capabilities reuse `mode`, `draft_id`, `draft_version`, `rule_version`, and
`visibility` semantics, and classify provider failures with the same error codes:
`AI_NOT_ENABLED` (no provider), `AI_PROVIDER_ERROR` (provider exception),
`AI_PROVIDER_TIMEOUT` (provider stalled), and `INVALID_AI_ARTIFACT` (result does
not satisfy the contract). Results are delivered as separate structures so a
client can hide, accept, or reject them without mutating the user's source.
