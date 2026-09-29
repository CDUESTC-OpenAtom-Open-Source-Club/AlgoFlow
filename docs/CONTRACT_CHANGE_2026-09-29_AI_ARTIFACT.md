# Contract Change: Independent AI Artifacts

## Scope

Issue #28 persists faithful AI transform results as independent `ai_artifact` entities. The artifact keeps its own version, server sequence, source draft version, source mappings, visibility, and model metadata. It is not embedded in a `Draft` and does not change the draft version when saved or synchronized.

## Sync

- `entity_type` now accepts `ai_artifact` for `upsert` and `delete` operations.
- Artifact payloads use the fields defined by `domain.schema.json` and are carried unchanged through Web, OpenHarmony, and sync-api.
- Artifact operations use the same idempotent `operation_id`, `base_version`, conflict, tombstone, and pull cursor rules as drafts.
- `server_sequence` is assigned by sync-api for artifact changes and is preserved by clients.

## Compatibility

OpenHarmony database version 3 creates `ai_artifacts` and migrates legacy `drafts.ai_artifacts_json` rows. Existing drafts and their versions remain unchanged. The sync-api remains an in-memory local development service; this change does not claim production cloud or distributed-device support.
