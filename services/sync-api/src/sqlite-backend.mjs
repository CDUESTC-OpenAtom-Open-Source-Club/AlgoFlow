import { DatabaseSync } from 'node:sqlite';
import { MAX_DRAFT_HISTORY, MAX_OPERATION_RECORDS, serialize } from './sync-store.mjs';

// node:sqlite is still experimental, so it is only used in this file and only
// loaded when SYNC_DB_PATH is set. Re-run the sync-api tests before moving to
// another Node major version.
//
// Each entry upgrades PRAGMA user_version by one. Never edit a released entry;
// append a new one.
const MIGRATIONS = [
  `CREATE TABLE workspaces (
     workspace_id TEXT PRIMARY KEY,
     epoch TEXT NOT NULL,
     created_at TEXT NOT NULL,
     last_cursor INTEGER NOT NULL DEFAULT 0
   ) STRICT;
   CREATE TABLE devices (
     device_id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     name TEXT,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE
   ) STRICT;
   CREATE INDEX devices_by_workspace ON devices(workspace_id);
   CREATE TABLE entities (
     workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
     entity_type TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     cursor INTEGER NOT NULL,
     deleted INTEGER NOT NULL,
     body TEXT NOT NULL,
     size INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, entity_type, entity_id)
   ) STRICT;
   CREATE INDEX entities_by_cursor ON entities(workspace_id, cursor);
   CREATE TABLE draft_history (
     workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
     draft_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     body TEXT NOT NULL,
     size INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, draft_id, version)
   ) STRICT;
   CREATE TABLE operations (
     workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
     operation_id TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     cursor INTEGER NOT NULL,
     PRIMARY KEY (workspace_id, operation_id)
   ) STRICT;
   CREATE INDEX operations_by_cursor ON operations(workspace_id, cursor);`
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Workspaces, devices and their sync data in one SQLite file, with the same
 * methods as MemoryBackend (workspace-directory.mjs) and, per workspace,
 * MemorySyncStorage (sync-store.mjs). Pairing sessions stay in memory: they
 * live for 10 minutes and a transfer token must never reach the disk.
 */
export class SqliteBackend {
  #db;
  #sql;

  /** @param {string} path a file path, or ':memory:' for tests */
  constructor(path) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      migrate(this.#db);
      this.#sql = prepareStatements(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close() {
    this.#db.close();
  }

  transaction(run) {
    if (this.#db.isTransaction) return run();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  workspaceCount() {
    return this.#sql.countWorkspaces.get().count;
  }

  hasWorkspace(workspaceId) {
    return this.#sql.workspace.get(workspaceId) !== undefined;
  }

  createWorkspace({ workspace_id, epoch, created_at }) {
    this.#sql.insertWorkspace.run(workspace_id, epoch, created_at);
  }

  deleteWorkspace(workspaceId) {
    return this.#sql.deleteWorkspace.run(workspaceId).changes > 0;
  }

  storage(workspaceId) {
    const workspace = this.#sql.workspace.get(workspaceId);
    return workspace ? new SqliteSyncStorage(this, this.#sql, workspaceId, workspace.epoch) : undefined;
  }

  addDevice(workspaceId, { device_id, kind, name, created_at, last_seen_at, token_hash }) {
    this.#sql.insertDevice.run(device_id, workspaceId, kind, name, created_at, last_seen_at, token_hash);
  }

  deviceByTokenHash(tokenHash) {
    return plain(this.#sql.deviceByTokenHash.get(tokenHash));
  }

  touchDevice(workspaceId, deviceId, at) {
    this.#sql.touchDevice.run(at, workspaceId, deviceId);
  }

  devices(workspaceId) {
    return this.#sql.devices.all(workspaceId).map(plain);
  }

  removeDevice(workspaceId, deviceId) {
    return this.#sql.deleteDevice.run(workspaceId, deviceId).changes > 0;
  }

  purge({ inactiveBefore, idleBefore }) {
    return Number(this.#sql.purge.run(inactiveBefore, idleBefore).changes);
  }
}

class SqliteSyncStorage {
  #backend;
  #sql;
  #workspaceId;

  constructor(backend, sql, workspaceId, epoch) {
    this.#backend = backend;
    this.#sql = sql;
    this.#workspaceId = workspaceId;
    this.epoch = epoch;
  }

  transaction(run) {
    return this.#backend.transaction(run);
  }

  entity(entityType, entityId) {
    return parse(this.#sql.entity.get(this.#workspaceId, entityType, entityId));
  }

  draftSnapshot(draftId, version) {
    // Called with unvalidated payload fields, and SQLite cannot bind every value.
    if (typeof draftId !== 'string' || !Number.isSafeInteger(version)) return undefined;
    return parse(this.#sql.draftSnapshot.get(this.#workspaceId, draftId, version));
  }

  operation(operationId) {
    return plain(this.#sql.operation.get(this.#workspaceId, operationId));
  }

  lastCursor() {
    return this.#sql.workspace.get(this.#workspaceId)?.last_cursor ?? 0;
  }

  usage() {
    const { entries, bytes } = this.#sql.usage.get(this.#workspaceId);
    return { entries, bytes };
  }

  changesAfter(cursor) {
    return this.#sql.changesAfter.all(this.#workspaceId, cursor)
      .map((row) => ({ cursor: String(row.cursor), entity_type: row.entity_type, entity: JSON.parse(row.body) }));
  }

  // Same rules as MemorySyncStorage.commit; SyncStore runs it in a transaction.
  commit({ operation_id, entity_type, entity, cursor, snapshots }) {
    const sql = this.#sql;
    const workspaceId = this.#workspaceId;
    const { body, size } = serialize(entity);
    sql.upsertEntity.run(workspaceId, entity_type, entity.id, cursor, entity.deleted ? 1 : 0, body, size);
    if (entity_type === 'draft') {
      if (entity.deleted) sql.deleteDraftHistory.run(workspaceId, entity.id);
      else {
        for (const [version, snapshot] of snapshots) {
          const stored = serialize(snapshot);
          sql.insertDraftSnapshot.run(workspaceId, entity.id, version, stored.body, stored.size);
        }
        sql.pruneDraftHistory.run(workspaceId, entity.id, MAX_DRAFT_HISTORY);
      }
    }
    sql.insertOperation.run(workspaceId, operation_id, entity_type, entity.id, entity.version, cursor);
    sql.pruneOperations.run(workspaceId, cursor - MAX_OPERATION_RECORDS);
    sql.setLastCursor.run(cursor, workspaceId);
  }
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  // An older server must not write to a schema it does not know.
  if (version > MIGRATIONS.length) throw new Error(`SYNC_DB_SCHEMA_TOO_NEW: ${version}`);
  for (let next = version; next < MIGRATIONS.length; next += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[next]);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function prepareStatements(db) {
  const sql = (text) => db.prepare(text);
  return {
    countWorkspaces: sql('SELECT COUNT(*) AS count FROM workspaces'),
    workspace: sql('SELECT epoch, last_cursor FROM workspaces WHERE workspace_id = ?'),
    insertWorkspace: sql('INSERT INTO workspaces (workspace_id, epoch, created_at) VALUES (?, ?, ?)'),
    deleteWorkspace: sql('DELETE FROM workspaces WHERE workspace_id = ?'),
    setLastCursor: sql('UPDATE workspaces SET last_cursor = ? WHERE workspace_id = ?'),
    insertDevice: sql('INSERT INTO devices (device_id, workspace_id, kind, name, created_at, last_seen_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    deviceByTokenHash: sql('SELECT device_id, workspace_id, kind, name, created_at, last_seen_at, token_hash FROM devices WHERE token_hash = ?'),
    touchDevice: sql('UPDATE devices SET last_seen_at = ? WHERE workspace_id = ? AND device_id = ?'),
    devices: sql('SELECT device_id, workspace_id, kind, name, created_at, last_seen_at, token_hash FROM devices WHERE workspace_id = ? ORDER BY rowid'),
    deleteDevice: sql('DELETE FROM devices WHERE workspace_id = ? AND device_id = ?'),
    // Same rule as MemoryBackend.purge. ISO timestamps compare in time order.
    purge: sql(`DELETE FROM workspaces WHERE workspace_id IN (
      SELECT w.workspace_id FROM workspaces w LEFT JOIN devices d ON d.workspace_id = w.workspace_id
      GROUP BY w.workspace_id
      HAVING COALESCE(MAX(d.last_seen_at), w.created_at) < ?1
        OR (COALESCE(MAX(d.last_seen_at), w.created_at) < ?2 AND w.last_cursor = 0))`),
    entity: sql('SELECT body FROM entities WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?'),
    upsertEntity: sql(`INSERT INTO entities (workspace_id, entity_type, entity_id, cursor, deleted, body, size) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET cursor = excluded.cursor, deleted = excluded.deleted, body = excluded.body, size = excluded.size`),
    changesAfter: sql('SELECT cursor, entity_type, body FROM entities WHERE workspace_id = ? AND cursor > ? ORDER BY cursor'),
    usage: sql(`SELECT
      (SELECT COUNT(*) FROM entities WHERE workspace_id = ?1 AND deleted = 0) AS entries,
      (SELECT COALESCE(SUM(size), 0) FROM entities WHERE workspace_id = ?1) + (SELECT COALESCE(SUM(size), 0) FROM draft_history WHERE workspace_id = ?1) AS bytes`),
    draftSnapshot: sql('SELECT body FROM draft_history WHERE workspace_id = ? AND draft_id = ? AND version = ?'),
    insertDraftSnapshot: sql('INSERT OR IGNORE INTO draft_history (workspace_id, draft_id, version, body, size) VALUES (?, ?, ?, ?, ?)'),
    deleteDraftHistory: sql('DELETE FROM draft_history WHERE workspace_id = ? AND draft_id = ?'),
    pruneDraftHistory: sql(`DELETE FROM draft_history WHERE workspace_id = ?1 AND draft_id = ?2 AND version NOT IN (
      SELECT version FROM draft_history WHERE workspace_id = ?1 AND draft_id = ?2 ORDER BY version DESC LIMIT ?3)`),
    operation: sql('SELECT entity_type, entity_id, version, cursor FROM operations WHERE workspace_id = ? AND operation_id = ?'),
    insertOperation: sql('INSERT INTO operations (workspace_id, operation_id, entity_type, entity_id, version, cursor) VALUES (?, ?, ?, ?, ?, ?)'),
    pruneOperations: sql('DELETE FROM operations WHERE workspace_id = ? AND cursor <= ?')
  };
}

function parse(row) {
  return row ? JSON.parse(row.body) : undefined;
}

// Rows come back with a null prototype; callers get ordinary objects.
function plain(row) {
  return row ? { ...row } : undefined;
}
