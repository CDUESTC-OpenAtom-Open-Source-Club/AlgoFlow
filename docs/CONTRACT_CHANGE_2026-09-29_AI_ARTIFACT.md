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

OpenHarmony database version 4 creates `ai_artifacts`, migrates legacy `drafts.ai_artifacts_json` rows, and adds the `entity_type` column to legacy `conflicts` tables when needed. Existing drafts and their versions remain unchanged. Each migration runs in a transaction; a failure rolls back the current schema step and initialization fails rather than deleting or recreating user data. Recovery is to restore the database from the platform backup and rerun the migration; there is no destructive downgrade path. The sync-api remains an in-memory local development service; this change does not claim production cloud or distributed-device support.

## Mobile generation entry

The phone AI panel now sends an explicit `faithful_transform` request to the configured AI Gateway URL. A result is saved only after the response matches the requested mode, draft version, output kind, visibility, artifact contract, and current draft `ideaSegments` source IDs. Persisted and pulled artifacts are validated structurally without comparing their historical `source_refs` to the draft's current segments, so editing or deleting a draft thought does not erase an independent historical result. With no configured provider, the gateway continues to return `AI_NOT_ENABLED`; the client does not create a mock result.

The Web workspace has the same generation path through `VITE_AI_GATEWAY_BASE` (defaulting to the local development gateway). It sends the current editor content, persists the returned artifact locally, and queues it for sync so a phone client can pull it. Web generation rejects the response unless it passes the complete artifact contract, including source mappings, array element types, code bounds, and draft/source version checks. Idea segments are persisted on the draft and retain IDs when content is reordered or edited in place, so artifact `source_refs` do not depend on line numbers.
