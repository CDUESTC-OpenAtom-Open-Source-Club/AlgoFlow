# Issue: AI Prompt-Based Code Generation

- Status: Proposed, requires product review
- Related work: AI Gateway issue #5, faithful transformation, IDE local completion
- Priority: Unset

## Problem

The current AI scope separates faithful transformation and local completion from review. A user may want to ask for code based on a review finding, but that request must not turn a review conversation into generated code or write code without an explicit action.

## Proposed user flow

1. The user invokes one review skill: `explanation`, `risk`, or `complexity`.
2. Review messages append to the current review conversation. Review results remain analysis-only and never write to a `.cpp` file.
3. The user explicitly asks to generate code from a review result or a faithful-transform/AI-hint context.
4. The app switches to a separate code-generation entry instead of continuing in the originating review conversation.
5. The generated C++ is previewed as a proposed change. The app writes it to the selected `.cpp` document only after explicit user confirmation.
6. Only the user-confirmed document edit enters the existing draft save and sync flow. AI review and generation records remain local and are not included in sync operations.

## Product decisions that need review

- Define how an explicit code-generation request differs from `faithful_transform` and the currently unavailable `progressive_hint` mode.
- Decide whether generation is limited to local snippets or may produce larger functions, and whether a full solution is always prohibited.
- Decide whether the generation entry is a separate conversation, panel, or route, and what review context may be carried into it.
- Define code-diff preview, target-file selection, stale-result checks, accept/reject behavior, undo, and conflict handling.
- Define how existing local completion relates to faithful transformation and AI hints. It is not assumed to be a standalone entry until this review is complete.
- Define provenance, source mapping, output bounds, macro/preprocessor policy, and server-side validation for generated code.
- Confirm privacy, provider, budget, retention, and deployment prerequisites before connecting a real model or cloud service.

## Safety and isolation requirements

- A review request can only return review results; review responses cannot mutate source files.
- Code generation uses a distinct request/result capability and distinct local state from review conversations.
- No generated text is written into a source document before explicit confirmation.
- Changing the draft, target file, source code, or request generation invalidates pending acceptance.
- Review and generation history is kept out of draft sync payloads. Only a confirmed code edit follows the normal draft save/sync process.
- Test-provider responses must remain visibly marked as test data and must never be represented as real model output.

## Out of scope for Web issue #5 stage 3

- Implementing a new code-generation mode or endpoint.
- Automatically converting review suggestions into code.
- Real provider integration, cloud deployment, full-solution generation, or code execution.
- Changing the shared AI Schema or OpenHarmony client before a separate product and contract review.

## Acceptance criteria to define during product review

- Review and code-generation conversations are visibly distinct and cannot overwrite each other.
- An explicit generation action opens the separate generation entry and carries only the context approved by the product decision.
- Generated changes are previewed and require explicit confirmation before editing a `.cpp` document.
- Stale or out-of-scope proposals cannot be accepted.
- Rejected, hidden, or failed proposals leave source code and existing AI results unchanged.
- Only confirmed source edits enter the existing save/sync flow; AI-only state never enters sync payloads.
