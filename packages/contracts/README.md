# AlgoFlow contracts

This directory is the single source of truth for data exchanged by the phone,
web workspace, sync API, and AI gateway.

- `schemas/domain.schema.json`: entity and shared enum definitions.
- `schemas/sync.schema.json`: sync operation and result definitions.
- `schemas/ai.schema.json`: AI request and artifact definitions.
- `vectors/*.json`: implementation-neutral contract examples.

The schemas intentionally avoid provider-specific fields. Consumers may generate
types later, but must keep these JSON documents authoritative.
