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
