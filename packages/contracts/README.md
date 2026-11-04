# AlgoFlow contracts

This directory is the single source of truth for data exchanged by the phone,
web workspace, sync API, and AI gateway.

- `schemas/domain.schema.json`: entity and shared enum definitions.
- `schemas/sync.schema.json`: sync operation and result definitions.
- `schemas/ai.schema.json`: AI request and artifact definitions.
- `cpp-fragment.mjs`: dependency-free lexical gate for IDE C++ completion text.
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

## Phone pairing

`sync.schema.json#/$defs/pairing*` describes how a phone and the Web workspace
end up in the same cloud workspace, and how the phone learns its endpoints.

- `POST /v1/pairing/sessions` (`pairingSessionRequest`) returns a `pairingSession`
  with an 8-digit `code`. The code is returned only in this response; status
  polling (`GET /v1/pairing/sessions/{pairing_id}`) never echoes it. Creating a
  new session revokes the same device's pending one for that desktop client.
  Both routes need the creator's device token, and another device's session
  answers `404 PAIRING_NOT_FOUND`, even within the same workspace.
- The QR code and the copied text carry only `pairingInvitation`
  (`type`, `sync_api`, `code`); unknown fields are rejected so a credential
  cannot be smuggled in. The AI Gateway endpoint, when the deployment has one,
  comes back from the claim.
- `POST /v1/pairing/claims` (`pairingClaimRequest`) consumes the code once.
  Errors: `400 INVALID_REQUEST`, `404 PAIRING_CODE_INVALID`,
  `409 PAIRING_CODE_USED`, `410 PAIRING_CODE_EXPIRED`, `429 PAIRING_RATE_LIMITED`.
  Codes expire after 10 minutes.
- Desktop-loopback endpoints in a claim are rewritten by the phone to the host
  it actually reached.

A claim needs no token, but the phone sends its own `Authorization: Bearer`
token if it has one for this sync-api; an invalid token counts as none.

| Phone | Result | Web afterwards |
|---|---|---|
| No valid token | The phone joins the session's workspace; the claim returns `device_token`. | Nothing changes. |
| Already in the session's workspace | Nothing changes. | Nothing changes. |
| In another workspace | The phone keeps its workspace and its token. | The session gains `transfer_token`, a new web device in the phone's workspace, visible only to the creator. The Web saves it and deletes its old device. |

After a transfer the Web sees a new `server_epoch`, so the reset described under
[Server epoch](#server-epoch) merges its local drafts into the phone's workspace.
Failed claims are limited per client address, not globally, so one client guessing
codes cannot lock out other users. `vectors/pairing-invitations.json` is shared by
the sync-api, Web, and phone tests.

## Workspaces and device tokens

A workspace is the unit of isolation on a shared sync-api: one change stream with
its own `server_epoch`, and the devices allowed to use it. There are no accounts.

- `POST /v1/workspaces` (`workspaceCreateRequest`, `workspaceCreateResult`) needs no
  token and makes the caller the first web device.
- `deviceToken` is 32 random bytes in base64url, sent as `Authorization: Bearer`.
  sync-api stores only its SHA-256. It never appears in a `pairingInvitation`.
- Every `/v1` route except workspace creation and pairing claims answers
  `401 AUTH_REQUIRED` without a valid token. A revoked, unknown or malformed token
  looks the same. Clients then keep their drafts and queue, and ask the user to pair
  again. There is no mode that turns authentication off.
- The token alone selects the workspace; no request field can. The same
  `operation_id` or `entity_id` in two workspaces does not collide.
- `GET /v1/devices` (`deviceList`) lists the caller's workspace.
- `DELETE /v1/devices/{device_id}` or `/v1/devices/current` (`deviceDeleteResult`)
  revokes one token, or answers `404 DEVICE_NOT_FOUND`. Deleting the last device
  deletes the workspace and its data.
- `DELETE /v1/workspaces/current` (`workspaceDeleteResult`) deletes the workspace,
  its data and every token.

Other errors use `errorResult`: `400 INVALID_REQUEST`, `404 NOT_FOUND` and
`413 PAYLOAD_TOO_LARGE` (`SYNC_MAX_BODY_BYTES`, 1 MiB by default). `GET /healthz`
needs no token. Workspaces, devices and sessions live in process memory for now.

## Sync write results

`sync.schema.json#/$defs/result.status` has strict meanings:

- `applied`: this operation changed the entity; `server_entity` is the new version.
- `duplicate`: this `operation_id` was already **applied** earlier. sync-api only
  remembers applied operations, so a duplicate always carries the
  `server_entity` that operation produced. Clients must treat a duplicate
  without `server_entity` as a failure and keep the operation queued; never
  substitute the local payload, because nothing proves the server has it.
- `conflict`: `base_version` does not match. A conflict changes nothing and is
  not remembered, so a retry of the same `operation_id` is checked again against
  the current version. `server_entity` is the current entity, or `null` when
  the entity does not exist on the server.

### Server epoch

Versions and cursors only mean something inside one store lifetime, and the
in-memory sync-api starts empty after every restart. Each workspace's store
therefore has a random `server_epoch`, returned on every push result and pull
result. Switching to another workspace looks the same to a client as a restart.

- Clients store `server_epoch` together with their cursor, committed only after a
  whole pull batch is applied. Before the first pull there is no epoch.
- Pushes carry it as `base_epoch`. A `base_version > 0` from another epoch is a
  `conflict` with `error_code: EPOCH_MISMATCH`, even when the numbers happen to
  match. `base_version: 0` (a creation) is not checked.
- Pulls send it as `?epoch=`. A different epoch returns every change from 0 with
  `reset: true`. Requests without an epoch keep the plain cursor behaviour.
- On a reset the latest server copy of each entity wins unless a local operation
  is still queued, because old-lineage versions are not comparable. Live drafts
  the server no longer has are re-created (`version` 0, re-queued) and their
  old snapshots dropped. On `EPOCH_MISMATCH` with `server_entity: null`, a draft
  is re-created and pushed again once; with a server entity the usual conflict
  copy is kept.
- A client upgraded from before this contract has a cursor but no epoch; it
  replays from 0 once and treats that as a reset when the server reports an
  epoch.

Not covered: local-only AI artifacts and review results from the old lineage
stay readable but are not re-uploaded, because their source draft versions no
longer exist on the server.

## IDE review and completion

Two optional, editor-decoupled capabilities extend the transform contract for the
CodeMirror 6 and OpenHarmony editors. Neither replaces local highlighting, bracket
matching, or base diagnostics.

- Review (`reviewRequest` / `reviewResult`): explanation, risk, or complexity
  review of the current code and user thinking. Both shapes require
  `output_kind: "review"`. Each diagnostic records a level,
  a required line/character `range` (explicit `null` marks a global suggestion), a
  problem statement, the reasoning basis, and a suggestion. Suggestions are always
  a separate field — they never embed or overwrite the user's code.
- Completion (`completionRequest` / `completionResult`): a user-triggered local
  edit near the cursor. Both shapes require `output_kind: "completion"`.
  The result records the original `replaced_range`, the
  `suggestion_text`, the supporting `source_refs`, and the `model_id` /
  `rule_version` provenance. Every source reference must identify an
  `idea_segments[].id` from the same request. The replacement range must contain
  the cursor (including either endpoint and zero-width insertion), stay within
  three lines above and below its line (at most seven original code lines), and
  never cover the entire file, even for short files. The gateway checks these
  request-relative constraints; `suggestion_text` is limited to 500 characters by
  the shared schema. Completions must be ordinary C++ fragments, without macros,
  other preprocessor directives, a `main` entry point, a complete submission
  program, or an algorithm step unsupported by those referenced segments.

Both capabilities reuse `mode`, `draft_id`, `draft_version`, `rule_version`, and
`visibility` semantics, and classify provider failures with the same error codes:
`AI_NOT_ENABLED` (no provider), `502 AI_PROVIDER_ERROR` (provider call exception,
timeout, or network failure), and `422 INVALID_AI_ARTIFACT` (returned result does
not satisfy the contract). Structural validation precedes request-relative range
and source checks so malformed fields cannot become provider-call errors. This
classification also applies to `/requests`. Results are delivered separately so a
client can hide, accept, or reject them without mutating the user's source.

### C++ completion validation boundary

Schema validation is only the structural and length gate. After it succeeds,
`validateCompletionResult` also calls `validateCompletionFragment` from
`cpp-fragment.mjs`; a JSON Schema validator alone does **not** implement the
completion policy. The gateway then checks metadata, source references, and the
replacement range against the request. Reuse the helper and the `fragments`
section of `vectors/ide-completion-vectors.json` when implementing another client.

The lexical gate handles backslash continuations (LF, CRLF, and CR), line/block
comments, escaped and prefixed quoted literals, raw strings with custom
delimiters, and numeric digit separators. Raw-string contents retain their
original spelling so splicing cannot invent a closing delimiter. Outside comments
and literals, preprocessing tokens (`#`, `%:`, and the legacy `??=` spelling) and
the standalone `main` identifier are rejected. This is deliberately conservative:
even a variable/member/call named exactly `main` is outside the supported subset.
Unresolved code-token escapes (including universal-character and legacy trigraph
escapes), unterminated comments/literals, and invalid raw delimiters are rejected.
Mentions of `main` or `#include` inside ordinary comments/literals remain valid;
identifiers such as `main_count` are not entry points.

This gate examines generated text, not the user's original file: existing
preprocessor code and `main` in the request are not deleted or banned. It is not
a compiler, macro expander, or arbitrary C++ syntax validator. Valid source IDs
and accepted tokens do not establish algorithmic faithfulness, rule out every
submission-shaped algorithm, or prove prompt-injection resistance. Provider
behavior needs separate evaluation; no real Provider is connected in Stage 1.

### IDE compatibility and rollback

Stage 1 intentionally tightens the IDE shapes. Old IDE requests without
`output_kind` now return `400 INVALID_REQUEST` before calling a Provider. Old
Provider results without the matching kind or an explicit diagnostic `range`
return `422 INVALID_AI_ARTIFACT`. Do not infer missing values or turn every omitted
range into a global diagnostic: the producer must make that choice explicitly.
Request/result mode, draft, version, rule, visibility, output kind, and review
kind (where applicable) must match.

Update the IDE caller, Provider/fixture, gateway, and shared contract together.
The existing `/requests` transform shapes and `aiOutputKind` enum remain limited
to `pseudocode` / `code_snippet`; IDE kinds do not widen them. `rule_version`
remains provenance, not a schema-negotiation mechanism. If rolling back an IDE
integration, disable those capabilities and restore its matching contract,
gateway, and callers together rather than silently weakening validation. Stage 1
does not change databases, saved drafts, or client storage, and requires no data
migration or deletion. Web and phone IDE integration belongs to later stages.

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

The provider timeout limits how long the gateway waits for a response, aborts the
same `AbortSignal` passed to the provider, and returns `502 AI_PROVIDER_ERROR`.
Provider adapters must accept that signal and propagate cancellation to their
outbound request so a timed-out call does not continue running after the HTTP
response has ended.
