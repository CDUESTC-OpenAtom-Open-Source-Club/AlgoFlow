import { randomUUID } from 'node:crypto';
import { validateAIArtifactEntity, validateReviewResultEntity } from '../../../packages/contracts/validate.mjs';

export class SyncStore {
  #entities = new Map();
  #draftHistory = new Map();
  #operations = new Map();
  #changes = [];

  // Versions and cursors only mean something inside one store lifetime. The
  // in-memory store starts empty after a restart, so a new random epoch lets
  // clients detect that their base_version / cursor belong to a lost lineage.
  /** @param {string} [epoch] */
  constructor(epoch = randomUUID()) {
    this.epoch = epoch;
  }

  apply(operation) {
    return { ...this.#apply(operation), server_epoch: this.epoch };
  }

  #apply(operation) {
    const validationError = validateOperation(operation);
    if (validationError) return { operation_id: operation?.operation_id ?? '', status: 'rejected', error_code: 'INVALID_REQUEST' };
    // A base_version > 0 from another lineage cannot be compared with this
    // store's versions. It is a conflict even if the numbers happen to match.
    if (operation.base_version > 0 && typeof operation.base_epoch === 'string' && operation.base_epoch !== this.epoch) {
      const current = this.#entities.get(`${operation.entity_type}:${operation.entity_id}`);
      return { operation_id: operation.operation_id, status: 'conflict', error_code: 'EPOCH_MISMATCH', server_entity: current ?? null };
    }
    // Only applied operations are remembered, so `duplicate` always means "this
    // operation_id already changed the entity" and carries that server_entity.
    if (this.#operations.has(operation.operation_id)) {
      return { ...this.#operations.get(operation.operation_id), status: 'duplicate' };
    }
    if (operation.entity_type === 'ai_artifact' && operation.operation_type === 'upsert') {
      const sourceDraft = this.#draftHistory.get(operation.payload.draft_id)?.get(operation.payload.source_draft_version);
      const sourceIds = sourceDraft?.idea_segments instanceof Array
        ? new Set(sourceDraft.idea_segments.map((segment) => segment?.id).filter((id) => typeof id === 'string' && id.length > 0))
        : undefined;
      const artifactErrors = validateAIArtifactEntity(operation.payload, sourceIds);
      if (artifactErrors.length > 0) {
        return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_AI_ARTIFACT' };
      }
    }
    if (operation.entity_type === 'review_result' && operation.operation_type === 'upsert') {
      const sourceDraft = this.#draftHistory.get(operation.payload.draft_id)?.get(operation.payload.source_draft_version);
      if (!sourceDraft ||
        validateReviewResultEntity(operation.payload, sourceDraft).length > 0) {
        return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_REVIEW_RESULT' };
      }
    }
    const key = `${operation.entity_type}:${operation.entity_id}`;
    const current = this.#entities.get(key);
    if (['ai_artifact', 'review_result'].includes(operation.entity_type) && operation.operation_type === 'delete' && !current) {
      return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_REQUEST' };
    }
    const currentVersion = current?.version ?? 0;
    if (operation.base_version !== currentVersion) {
      // A conflict did not change anything. It is not recorded: a retry of the
      // same operation_id is checked again against the current version instead
      // of being reported as an already-applied duplicate.
      return { operation_id: operation.operation_id, status: 'conflict', error_code: 'VERSION_CONFLICT', server_entity: current ?? null };
    }
    const version = currentVersion + 1;
    if (operation.entity_type === 'ai_artifact' && operation.operation_type === 'upsert' &&
      !this.#draftHistory.get(operation.payload.draft_id)?.has(operation.payload.source_draft_version)) {
      return { operation_id: operation.operation_id, status: 'rejected', error_code: operation.entity_type === 'review_result' ? 'INVALID_REVIEW_RESULT' : 'INVALID_AI_ARTIFACT' };
    }
    const entity = {
      ...(current ?? {}),
      ...operation.payload,
      id: operation.entity_id,
      version,
      deleted: operation.operation_type === 'delete' || operation.payload.deleted === true,
      updated_at: operation.occurred_at,
      last_modified_client_id: operation.client_id
    };
    if (['ai_artifact', 'review_result'].includes(operation.entity_type)) entity.server_sequence = this.#changes.length + 1;
    this.#entities.set(key, entity);
    if (operation.entity_type === 'draft') {
      const history = this.#draftHistory.get(entity.id) ?? new Map();
      const snapshot = operation.payload && typeof operation.payload === 'object'
        ? { ...(current ?? {}), ...operation.payload, id: entity.id, version: operation.base_version }
        : { ...entity, version: operation.base_version };
      // A source version is immutable. Later Draft writes must never replace
      // the snapshot used to validate historical AI artifacts.
      if (!history.has(operation.base_version)) history.set(operation.base_version, structuredClone(snapshot));
      if (!history.has(entity.version)) history.set(entity.version, structuredClone(entity));
      this.#draftHistory.set(entity.id, history);
    }
    this.#changes.push({ cursor: String(this.#changes.length + 1), entity_type: operation.entity_type, entity });
    const result = { operation_id: operation.operation_id, status: 'applied', version, server_entity: entity };
    this.#operations.set(operation.operation_id, result);
    return result;
  }

  // A cursor from another epoch points into a change log that no longer
  // exists; replay everything and tell the client to rebase its local state.
  pull(afterCursor = '0', clientEpoch = undefined) {
    const reset = typeof clientEpoch === 'string' && clientEpoch.length > 0 && clientEpoch !== this.epoch;
    const position = reset ? 0 : Number.parseInt(afterCursor, 10);
    const safePosition = Number.isFinite(position) && position >= 0 ? position : 0;
    return { changes: this.#changes.slice(safePosition), next_cursor: String(this.#changes.length), server_epoch: this.epoch, reset };
  }
}

export function validateOperation(operation) {
  if (!operation || typeof operation !== 'object') return 'operation is required';
  if (!operation.operation_id || !operation.entity_id || !operation.client_id) return 'stable identifiers are required';
  if (typeof operation.occurred_at !== 'string' || !operation.occurred_at.endsWith('Z') || Number.isNaN(Date.parse(operation.occurred_at))) return 'occurred_at must be a UTC timestamp';
  if (!Number.isInteger(operation.base_version) || operation.base_version < 0) return 'base_version is invalid';
  if (!['draft', 'ai_artifact', 'review_result'].includes(operation.entity_type)) return 'entity_type is invalid';
  if (!['upsert', 'delete'].includes(operation.operation_type)) return 'operation_type is invalid';
  if (operation.base_epoch !== undefined && (typeof operation.base_epoch !== 'string' || operation.base_epoch.length === 0)) return 'base_epoch is invalid';
  if (!operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) return 'payload is required';
  return null;
}
