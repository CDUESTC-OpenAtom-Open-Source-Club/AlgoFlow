export class SyncStore {
  #entities = new Map();
  #operations = new Map();
  #changes = [];

  apply(operation) {
    const validationError = validateOperation(operation);
    if (validationError) return { operation_id: operation?.operation_id ?? '', status: 'rejected', error_code: 'INVALID_REQUEST' };
    if (this.#operations.has(operation.operation_id)) {
      return { ...this.#operations.get(operation.operation_id), status: 'duplicate' };
    }
    const key = `${operation.entity_type}:${operation.entity_id}`;
    const current = this.#entities.get(key);
    const currentVersion = current?.version ?? 0;
    if (operation.base_version !== currentVersion) {
      const result = { operation_id: operation.operation_id, status: 'conflict', error_code: 'VERSION_CONFLICT', server_entity: current ?? null };
      this.#operations.set(operation.operation_id, result);
      return result;
    }
    const version = currentVersion + 1;
    const entity = {
      ...(current ?? {}),
      ...operation.payload,
      id: operation.entity_id,
      version,
      deleted: operation.operation_type === 'delete' || operation.payload.deleted === true,
      updated_at: operation.occurred_at,
      last_modified_client_id: operation.client_id
    };
    this.#entities.set(key, entity);
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

function validateOperation(operation) {
  if (!operation || typeof operation !== 'object') return 'operation is required';
  if (!operation.operation_id || !operation.entity_id || !operation.client_id) return 'stable identifiers are required';
  if (!Number.isInteger(operation.base_version) || operation.base_version < 0) return 'base_version is invalid';
  if (!['draft', 'code_document', 'ai_artifact'].includes(operation.entity_type)) return 'entity_type is invalid';
  if (!['upsert', 'delete'].includes(operation.operation_type)) return 'operation_type is invalid';
  if (!operation.payload || typeof operation.payload !== 'object') return 'payload is required';
  return null;
}
