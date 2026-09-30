import { validateAIArtifactEntity } from '../../../packages/contracts/validate.mjs';

export class SyncStore {
  #entities = new Map();
  #draftHistory = new Map();
  #operations = new Map();
  #changes = [];

  apply(operation) {
    const validationError = validateOperation(operation);
    if (validationError) return { operation_id: operation?.operation_id ?? '', status: 'rejected', error_code: 'INVALID_REQUEST' };
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
    const key = `${operation.entity_type}:${operation.entity_id}`;
    const current = this.#entities.get(key);
    if (operation.entity_type === 'ai_artifact' && operation.operation_type === 'delete' && !current) {
      return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_REQUEST' };
    }
    const currentVersion = current?.version ?? 0;
    if (operation.base_version !== currentVersion) {
      const result = { operation_id: operation.operation_id, status: 'conflict', error_code: 'VERSION_CONFLICT', server_entity: current ?? null };
      this.#operations.set(operation.operation_id, result);
      return result;
    }
    const version = currentVersion + 1;
    if (operation.entity_type === 'ai_artifact' && operation.operation_type === 'upsert' &&
      !this.#draftHistory.get(operation.payload.draft_id)?.has(operation.payload.source_draft_version)) {
      return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_AI_ARTIFACT' };
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
    if (operation.entity_type === 'ai_artifact') entity.server_sequence = this.#changes.length + 1;
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

  pull(afterCursor = '0') {
    const position = Number.parseInt(afterCursor, 10);
    const safePosition = Number.isFinite(position) && position >= 0 ? position : 0;
    return { changes: this.#changes.slice(safePosition), next_cursor: String(this.#changes.length) };
  }
}

export function validateOperation(operation) {
  if (!operation || typeof operation !== 'object') return 'operation is required';
  if (!operation.operation_id || !operation.entity_id || !operation.client_id) return 'stable identifiers are required';
  if (typeof operation.occurred_at !== 'string' || !operation.occurred_at.endsWith('Z') || Number.isNaN(Date.parse(operation.occurred_at))) return 'occurred_at must be a UTC timestamp';
  if (!Number.isInteger(operation.base_version) || operation.base_version < 0) return 'base_version is invalid';
  if (!['draft', 'ai_artifact'].includes(operation.entity_type)) return 'entity_type is invalid';
  if (!['upsert', 'delete'].includes(operation.operation_type)) return 'operation_type is invalid';
  if (!operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) return 'payload is required';
  return null;
}
