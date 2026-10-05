# Contract Change: Independent AI Artifacts

## Scope

Issue #28 persists faithful AI transform results as independent `ai_artifact` entities. The artifact keeps its own version, server sequence, source draft version, source mappings, visibility, and model metadata. It is not embedded in a `Draft` and does not change the draft version when saved or synchronized.

## Sync

- `entity_type` now accepts `ai_artifact` for `upsert` and `delete` operations.
- Artifact payloads use the fields defined by `domain.schema.json` and are carried unchanged through Web, OpenHarmony, and sync-api.
- Artifact operations use the same idempotent `operation_id`, `base_version`, conflict, tombstone, and pull cursor rules as drafts.
- Artifact source references are checked against the stored source Draft version on sync-api; clients perform the same check when that source version is locally available. Historical artifacts remain valid after later Draft edits.
- `code_document` is not part of the active sync entity contract until a client and server implementation exists.
- Artifact conflicts are stored as `entity_type=ai_artifact` conflict records. Web exposes the same keep-local/use-server choice as Draft conflicts; OpenHarmony persists the record in the local conflict table.
- `server_sequence` is assigned by sync-api for artifact changes and is preserved by clients.

## Compatibility

OpenHarmony database version 4 creates `ai_artifacts`, migrates legacy `drafts.ai_artifacts_json` rows, and adds the `entity_type` column to legacy `conflicts` tables when needed. Version 5 creates `draft_source_snapshots`, keyed by draft ID and version, to retain immutable source code for validating historical review ranges. Existing Draft rows and versions are not rewritten by this migration. Previously persisted review results remain available; if a source version was not snapshotted before this migration, the result is retained as read-only history and cannot be hidden, re-synchronized, or used for code navigation until that source is available. A server conflict can be resolved by adopting the server copy, which remains read-only if its source snapshot is missing; re-submitting a local copy still requires the exact source snapshot. Users can request a fresh review for the current Draft version. Each migration runs in a transaction; a failure rolls back the current schema step and initialization fails rather than deleting or recreating user data. Recovery is to restore the database from the platform backup and rerun initialization; there is no destructive downgrade path. The sync-api remains an in-memory local development service; this change does not claim production cloud or distributed-device support.

## Mobile generation entry

The phone AI panel now sends an explicit `faithful_transform` request to the configured AI Gateway URL. A result is saved only after the response matches the requested mode, draft version, output kind, visibility, artifact contract, and current draft `ideaSegments` source IDs. Persisted and pulled artifacts are validated structurally without comparing their historical `source_refs` to the draft's current segments, so editing or deleting a draft thought does not erase an independent historical result. With no configured provider, the gateway continues to return `AI_NOT_ENABLED`; the client does not create a mock result.

The Web workspace has the same generation path through `VITE_AI_GATEWAY_BASE` (defaulting to the local development gateway). It sends the current editor content, persists the returned artifact locally, and queues it for sync so a phone client can pull it. Web generation rejects the response unless it passes the complete artifact contract, including source mappings, array element types, code bounds, and draft/source version checks. Idea segments are persisted on the draft and retain IDs when content is reordered or edited in place, so artifact `source_refs` do not depend on line numbers.

## Independent Review Results

Issue 29 uses a separate `review_result` sync entity rather than embedding diagnostics in `Draft` or `ai_artifact`. Each result records `review_kind` (`explanation`, `risk`, or `complexity`), diagnostic `level`, optional code `range`, `problem`, `basis`, and `suggestion`, together with the source draft version, mode, model, rule version, visibility, entity version, and server sequence. Review writes are idempotent, use optimistic versions, preserve the Draft version, reject malformed ranges and positions outside the exact source Draft version, and retain local/server conflict copies. The JSON Schema defines the range shape and runtime validators enforce ordering and source-code bounds. Web stores and hides these results independently; OpenHarmony persists them in `review_results` and routes them through the same sync queue.

Both clients submit review requests to the AI Gateway `POST /reviews` endpoint with the requested review kind, mode, source draft version, code, and idea. The gateway invokes the provider's `review({ request, templates })` port and validates the response metadata and diagnostics before returning it. A missing review provider returns `AI_NOT_ENABLED`; provider failures and timeouts are surfaced without synthesizing local review results. Clients reject a response if the source draft changed during the request. Review requests and persistence do not save or update the Draft; unsaved Web edits require an explicit Draft save first. Pull clients require the source Draft to exist locally and its current version to be at least the review's source version. The sync-api verifies the exact historical source snapshot before accepting or publishing it. Source-code range bounds are checked against the local code when the current Draft is that source version, and against the immutable server snapshot on sync-api. Pull clients keep the cursor unchanged if validation or local persistence fails; OpenHarmony flushes the complete applied batch before committing the cursor, so a failed batch is replayed on retry.

OpenHarmony's `payloadToReview`, exact source-version guard, migration-created snapshot table, invalid-pull recovery, and failed-local-persistence replay are covered by local unit tests. A failed or invalid pulled review is rejected before cursor commit; the entire pulled batch is flushed before the cursor is persisted. Version 5 adds the source snapshot table while retaining the existing review table. The AI Gateway defaults to `faithful_transform`; other modes remain unavailable unless explicitly enabled.
