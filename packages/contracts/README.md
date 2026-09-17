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
  `suggestion_text`, the supporting `source_refs`, and the `model_id` /
  `rule_version` provenance. Every source reference must identify an
  `idea_segments[].id` from the same request. Completions are bounded to a short
  fragment and must never contain a `main` entry point, a complete submission
  program, or an algorithm step unsupported by those referenced segments.

Both capabilities reuse `mode`, `draft_id`, `draft_version`, `rule_version`, and
`visibility` semantics, and classify provider failures with the same error codes:
`AI_NOT_ENABLED` (no provider), `AI_PROVIDER_ERROR` (provider exception),
`AI_PROVIDER_TIMEOUT` (provider stalled), and `INVALID_AI_ARTIFACT` (result does
not satisfy the contract). Results are delivered as separate structures so a
client can hide, accept, or reject them without mutating the user's source.

### Mode semantics for IDE capabilities

`mode` is both an availability gate and an output-scope constraint. It is not only
provenance for later storage. The gateway rejects modes outside its enabled set,
the provider must generate within the requested mode, and clients must archive
review and completion results under that same mode without silently promoting
them to another mode.

- `faithful_transform`: a review may identify errors, missing conditions, or a
  corrective direction in the separate `suggestion` field. That suggestion must
  not overwrite user-authored thinking, present a complete replacement solution,
  or be applied automatically. A completion must remain a local edit consistent
  with the user's existing idea and code; it must not introduce a new algorithm.
- `feasibility_analysis`: a review may analyze risks, complexity, boundaries, and
  counterexamples. It may state that the current approach is not feasible, but it
  must not turn the response into an unrequested complete solution.
- `progressive_hint`: review or completion output may reveal a corrective
  direction incrementally, but must remain bounded and must not return a complete
  submission or silently become `full_solution`.
- `full_solution`: complete corrective guidance is allowed only after the user
  explicitly selects this mode. Results remain separate from faithful artifacts
  and user-authored code until the user accepts an edit.

`review_kind` selects the review lens, not the permission level. `risk` and
`complexity` do not require `feasibility_analysis`; they are valid in any enabled
mode, but their depth and suggestions remain constrained by that mode. A
capability-mode pair that a provider cannot honor must be treated as unavailable,
not silently mapped to another mode. The shared `enabledModes` set is a coarse
gateway gate and does not by itself prove that every provider supports every
review or completion mode.

The vectors containing injection-like text verify only that untrusted user text
is parsed as data and does not break request validation. They do not demonstrate
prompt-injection resistance or safe provider behavior. Provider-level injection
handling requires separate adversarial evaluation after a real model is
configured.

`AI_PROVIDER_TIMEOUT` limits how long the gateway waits for a provider response.
It does not cancel the underlying provider promise, which may continue running
after the HTTP response has timed out. Future HTTP provider adapters should
accept an `AbortSignal` and propagate cancellation to the outbound request.
