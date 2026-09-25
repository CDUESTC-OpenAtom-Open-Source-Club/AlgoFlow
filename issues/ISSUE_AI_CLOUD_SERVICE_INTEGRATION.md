# Issue: AI Gateway Cloud Service Integration

- Status: Deferred / not in the current implementation stage
- Priority: To be triaged
- Related work: AI Gateway issue #5, local test-provider integration, Web and OpenHarmony AI clients

## Problem

The current AI Gateway can be exercised locally with a test-only provider, but AlgoFlow does not yet have an approved production cloud deployment or real model provider. Local test responses validate request contracts and client workflows only; they do not establish model quality, production availability, privacy compliance, or operational readiness.

## Scope

When separately authorized, design and implement a production-capable cloud path for the AI Gateway and, where required, the existing sync API. The work should cover:

- Deployment in a team-controlled Huawei Cloud account with isolated development and release-candidate environments.
- Real provider adapter behind the existing `AIProvider` boundary; provider selection must not bind clients or domain types to a vendor.
- Authenticated and authorized API access, rate limits, request timeouts, cancellation propagation, audit identifiers, health checks, monitoring, and rollback.
- Secret management in controlled server-side configuration. No team key in clients, source control, ordinary documentation, or logs; no client-supplied key persistence without separate review.
- Explicit data-flow and privacy review for source code, ideas, review requests, retention period, deletion, and provider-side processing.
- Cost and quota controls, incident ownership, operational runbooks, and release configuration.
- Production behavior must not assemble or fall back to the test provider. Test-data headers and test fixtures must not be mistaken for real model output.

## Out of scope until separately approved

- This issue does not authorize creating cloud resources, accounts, credentials, DNS records, certificates, or production environments.
- It does not choose a provider, model, region, budget, retention period, privacy wording, or deployment owner.
- It does not authorize changing the AI contract or enabling currently unavailable AI modes.
- It does not implement code execution. Any future execution service requires a separate security design for isolation, disabled network access, resource limits, concurrency quotas, and temporary workspace cleanup.
- It does not claim OpenHarmony distributed capability; ordinary cloud synchronization and AI API calls remain separate from that platform capability.

## Preconditions

Before implementation starts, product and engineering owners must confirm:

1. Team-controlled Huawei Cloud account, resource ownership, access control, and billing responsibility.
2. Provider, model, deployment region, data-processing terms, and whether user content may be sent to that provider.
3. Development and release-candidate environment separation, domain, TLS certificate ownership, authentication, and authorization model.
4. Secret storage and rotation process, including incident response for credential exposure.
5. Request and response retention, audit fields, deletion requirements, privacy notice, and user consent where applicable.
6. Per-user and global budgets, quotas, rate limits, timeout limits, monitoring thresholds, and operational owner.
7. Local real-provider evaluation covering incomplete or incorrect ideas, requests to add an algorithm, prompt-injection attempts, malformed output, network failure, timeout, and cancellation.
8. Web and OpenHarmony integration and acceptance owners, with device and deployment environments available for verification.

Until these decisions and prerequisites are recorded, cloud integration remains `待预研` and must not be described as implemented. Continue to use the local test Provider only for explicitly configured development/testing. A normal deployment with no real provider must return `AI_NOT_ENABLED` and must never silently fall back to fixed test data.

## Acceptance criteria

- Production and test-provider startup paths are distinct and explicit; production deployment has no test-data response marker or fallback behavior.
- Provider credentials remain server-side and are absent from client bundles, repository history, and logs.
- Authentication, authorization, rate limiting, timeout/cancellation, audit IDs, health checks, monitoring, and documented rollback are exercised in the selected environments.
- Privacy/data-flow/retention decisions are reflected in user-facing notices and operational configuration.
- Real-provider results pass schema and source/range validation; evaluation results document model-behavior limitations and known failure modes.
- Web and OpenHarmony clients show accurate unavailable, provider-error, invalid-output, and test-data states without syncing AI-only results.
- Deployment and integration tests are reported with exact environment and commands. No cloud or device acceptance is inferred from local unit tests.

## Dependencies and risks

- Depends on product decisions for model/vendor, budget, privacy, retention, authentication, and cloud ownership.
- Real model output may satisfy structural contracts while still misrepresenting user intent; contract validation alone cannot prove semantic faithfulness or prompt-injection resistance.
- Cloud deployment expands the data-processing and operational security boundary and must receive its own review before release.
