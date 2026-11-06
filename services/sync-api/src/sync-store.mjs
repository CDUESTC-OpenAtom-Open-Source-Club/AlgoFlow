import { randomUUID } from 'node:crypto';
import { validateAIArtifactEntity, validateReviewResultEntity } from '../../../packages/contracts/validate.mjs';

// What one workspace may keep. Deletes are always accepted, so a full
// workspace can still free space.
export const DEFAULT_WORKSPACE_QUOTA = Object.freeze({ entries: 2000, bytes: 20 * 1024 * 1024 });
// Older Draft versions are only needed to validate AI results made on them.
export const MAX_DRAFT_HISTORY = 50;
// A retry normally follows its lost response within one sync run.
export const MAX_OPERATION_RECORDS = 1000;

/**
 * Sync rules for one workspace. Data lives in a storage: MemorySyncStorage here,
 * or a workspace view from sqlite-backend.mjs. Both keep only the latest change
 * per entity, the last MAX_DRAFT_HISTORY versions of each Draft and the last
 * MAX_OPERATION_RECORDS applied operations.
 */
export class SyncStore {
  #storage;
  #quota;

  /**
   * @param {string | MemorySyncStorage | object} [storage] a storage, or the
   *   epoch of a new in-memory one.
   * @param {{ entries: number, bytes: number }} [quota]
   */
  constructor(storage = randomUUID(), quota = DEFAULT_WORKSPACE_QUOTA) {
    this.#storage = typeof storage === 'string' ? new MemorySyncStorage(storage) : storage;
    this.#quota = quota;
  }

  // Versions and cursors only mean something inside one storage lifetime. A
  // new random epoch lets clients detect that their base_version / cursor
  // belong to a lost lineage, for example after an in-memory restart.
  get epoch() {
    return this.#storage.epoch;
  }

  apply(operation) {
    return { ...this.#storage.transaction(() => this.#apply(operation)), server_epoch: this.epoch };
  }

  #apply(operation) {
    const storage = this.#storage;
    const validationError = validateOperation(operation);
    if (validationError) return { operation_id: typeof operation?.operation_id === 'string' ? operation.operation_id : '', status: 'rejected', error_code: 'INVALID_REQUEST' };
    // A base_version > 0 from another lineage cannot be compared with this
    // store's versions. It is a conflict even if the numbers happen to match.
    if (operation.base_version > 0 && typeof operation.base_epoch === 'string' && operation.base_epoch !== storage.epoch) {
      const current = storage.entity(operation.entity_type, operation.entity_id);
      return { operation_id: operation.operation_id, status: 'conflict', error_code: 'EPOCH_MISMATCH', server_entity: current ?? null };
    }
    // Only applied operations are remembered, so `duplicate` always means "this
    // operation_id already changed the entity". Only its version is kept: the
    // entity it produced is that Draft snapshot, or the current entity once the
    // snapshot is gone.
    const applied = storage.operation(operation.operation_id);
    if (applied) {
      const serverEntity = (applied.entity_type === 'draft' ? storage.draftSnapshot(applied.entity_id, applied.version) : undefined) ??
        storage.entity(applied.entity_type, applied.entity_id) ?? null;
      return { operation_id: operation.operation_id, status: 'duplicate', version: applied.version, server_entity: serverEntity };
    }
    if (operation.entity_type === 'ai_artifact' && operation.operation_type === 'upsert') {
      const sourceDraft = storage.draftSnapshot(operation.payload.draft_id, operation.payload.source_draft_version);
      const sourceIds = sourceDraft?.idea_segments instanceof Array
        ? new Set(sourceDraft.idea_segments.map((segment) => segment?.id).filter((id) => typeof id === 'string' && id.length > 0))
        : undefined;
      const artifactErrors = validateAIArtifactEntity(operation.payload, sourceIds);
      if (artifactErrors.length > 0) {
        return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_AI_ARTIFACT' };
      }
    }
    if (operation.entity_type === 'review_result' && operation.operation_type === 'upsert') {
      const sourceDraft = storage.draftSnapshot(operation.payload.draft_id, operation.payload.source_draft_version);
      if (!sourceDraft ||
        validateReviewResultEntity(operation.payload, sourceDraft).length > 0) {
        return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_REVIEW_RESULT' };
      }
    }
    const current = storage.entity(operation.entity_type, operation.entity_id);
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
      !storage.draftSnapshot(operation.payload.draft_id, operation.payload.source_draft_version)) {
      return { operation_id: operation.operation_id, status: 'rejected', error_code: 'INVALID_AI_ARTIFACT' };
    }
    const cursor = storage.lastCursor() + 1;
    const entity = {
      ...(current ?? {}),
      ...operation.payload,
      id: operation.entity_id,
      version,
      deleted: operation.operation_type === 'delete' || operation.payload.deleted === true,
      updated_at: operation.occurred_at,
      last_modified_client_id: operation.client_id
    };
    if (['ai_artifact', 'review_result'].includes(operation.entity_type)) entity.server_sequence = cursor;
    if (!entity.deleted && this.#exceedsQuota(entity, current)) {
      return { operation_id: operation.operation_id, status: 'rejected', error_code: 'WORKSPACE_QUOTA_EXCEEDED' };
    }
    // A source version is immutable: the snapshot used to validate historical
    // AI results is never replaced by a later write of the same version.
    const snapshots = operation.entity_type === 'draft'
      ? [[operation.base_version, { ...(current ?? {}), ...operation.payload, id: entity.id, version: operation.base_version }], [version, entity]]
      : [];
    storage.commit({ operation_id: operation.operation_id, entity_type: operation.entity_type, entity, cursor, snapshots });
    return { operation_id: operation.operation_id, status: 'applied', version, server_entity: entity };
  }

  #exceedsQuota(entity, current) {
    const { entries, bytes } = this.#storage.usage();
    const added = current === undefined || current.deleted ? 1 : 0;
    return entries + added > this.#quota.entries || bytes + byteLength(entity) > this.#quota.bytes;
  }

  // A cursor from another epoch points into a change log that no longer
  // exists; replay everything and tell the client to rebase its local state.
  pull(afterCursor = '0', clientEpoch = undefined) {
    const reset = typeof clientEpoch === 'string' && clientEpoch.length > 0 && clientEpoch !== this.epoch;
    const position = reset ? 0 : Number.parseInt(afterCursor, 10);
    const safePosition = Number.isFinite(position) && position >= 0 ? position : 0;
    return { changes: this.#storage.changesAfter(safePosition), next_cursor: String(this.#storage.lastCursor()), server_epoch: this.epoch, reset };
  }
}

/**
 * One workspace's data in process memory, lost on restart. Values are kept as
 * JSON so callers can never mutate stored entities, as with SQLite.
 */
export class MemorySyncStorage {
  // Re-inserted on every write, so iteration follows cursor order.
  #entities = new Map();
  #history = new Map();
  #operations = new Map();
  #cursor = 0;

  /** @param {string} [epoch] */
  constructor(epoch = randomUUID()) {
    this.epoch = epoch;
  }

  transaction(run) {
    return run();
  }

  entity(entityType, entityId) {
    const row = this.#entities.get(`${entityType}:${entityId}`);
    return row ? JSON.parse(row.body) : undefined;
  }

  draftSnapshot(draftId, version) {
    const row = this.#history.get(draftId)?.get(version);
    return row ? JSON.parse(row.body) : undefined;
  }

  operation(operationId) {
    return this.#operations.get(operationId);
  }

  lastCursor() {
    return this.#cursor;
  }

  usage() {
    let entries = 0;
    let bytes = 0;
    for (const row of this.#entities.values()) {
      if (!row.deleted) entries += 1;
      bytes += row.size;
    }
    for (const versions of this.#history.values()) for (const row of versions.values()) bytes += row.size;
    return { entries, bytes };
  }

  changesAfter(cursor) {
    return [...this.#entities.values()].filter((row) => row.cursor > cursor)
      .map((row) => ({ cursor: String(row.cursor), entity_type: row.entity_type, entity: JSON.parse(row.body) }));
  }

  commit({ operation_id, entity_type, entity, cursor, snapshots }) {
    const key = `${entity_type}:${entity.id}`;
    this.#entities.delete(key);
    this.#entities.set(key, { cursor, entity_type, deleted: entity.deleted, ...serialize(entity) });
    if (entity_type === 'draft') {
      // A deleted Draft takes no new AI results, so its history only uses space.
      if (entity.deleted) this.#history.delete(entity.id);
      else {
        const versions = this.#history.get(entity.id) ?? new Map();
        for (const [version, snapshot] of snapshots) if (!versions.has(version)) versions.set(version, serialize(snapshot));
        for (const version of [...versions.keys()].sort((left, right) => left - right).slice(0, -MAX_DRAFT_HISTORY)) versions.delete(version);
        this.#history.set(entity.id, versions);
      }
    }
    this.#operations.set(operation_id, { entity_type, entity_id: entity.id, version: entity.version, cursor });
    for (const [id, record] of this.#operations) {
      if (record.cursor > cursor - MAX_OPERATION_RECORDS) break;
      this.#operations.delete(id);
    }
    this.#cursor = cursor;
  }
}

export function validateOperation(operation) {
  if (!operation || typeof operation !== 'object') return 'operation is required';
  if (![operation.operation_id, operation.entity_id, operation.client_id].every(isStableId)) return 'stable identifiers are required';
  if (typeof operation.occurred_at !== 'string' || !operation.occurred_at.endsWith('Z') || Number.isNaN(Date.parse(operation.occurred_at))) return 'occurred_at must be a UTC timestamp';
  if (!Number.isInteger(operation.base_version) || operation.base_version < 0) return 'base_version is invalid';
  if (!['draft', 'ai_artifact', 'review_result'].includes(operation.entity_type)) return 'entity_type is invalid';
  if (!['upsert', 'delete'].includes(operation.operation_type)) return 'operation_type is invalid';
  if (operation.base_epoch !== undefined && !isStableId(operation.base_epoch)) return 'base_epoch is invalid';
  if (!operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload)) return 'payload is required';
  return null;
}

/** @returns {{ body: string, size: number }} */
export function serialize(value) {
  const body = JSON.stringify(value);
  return { body, size: Buffer.byteLength(body) };
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function isStableId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
