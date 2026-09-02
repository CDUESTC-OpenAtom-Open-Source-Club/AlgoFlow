import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DraftRepository } from '../domain/DraftRepository';
import { AIMode, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { ConflictRecord, DraftPayload, SyncOperation, SyncOperationType, draftToPayload,
  payloadToDraft } from '../domain/SyncModels';
import { SyncRepository } from '../domain/SyncRepository';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const DATABASE_VERSION = 1;
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const STORE_CONFIG: relationalStore.StoreConfig = {
  name: 'algoflow_workspace.db',
  securityLevel: relationalStore.SecurityLevel.S1
};

export class RdbDraftRepository implements DraftRepository, SyncRepository {
  private context: common.Context;
  private store?: relationalStore.RdbStore;
  private drafts: Draft[] = [];
  private operations: SyncOperation[] = [];
  private clientId: string = '';
  private cursor: string = '0';
  private baseUrl: string = DEFAULT_BASE_URL;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(context: common.Context) {
    this.context = context;
  }

  async initialize(): Promise<void> {
    if (this.store !== undefined) return;
    this.store = await relationalStore.getRdbStore(this.context, STORE_CONFIG);
    await this.migrate(this.store);
    await this.loadState(this.store);
    await this.loadDrafts(this.store);
    await this.loadOperations(this.store);
  }

  list(): Draft[] {
    return this.drafts.filter((draft: Draft) => !draft.deleted)
      .sort((left: Draft, right: Draft) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): Draft | undefined {
    return this.drafts.find((draft: Draft) => draft.id === id && !draft.deleted);
  }

  save(draft: Draft): void {
    draft.deleted = false;
    draft.lastModifiedClientId = this.clientId;
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.replaceDraft(draft);
    // The starter draft is a local UI placeholder. Do not publish an empty
    // version-0 entity before a remote draft has had a chance to be pulled.
    if (draft.version === 0 && isBlankDraft(draft)) {
      this.removePendingOperationForEntity(draft.id);
      return;
    }
    this.queueOperation(draft, SyncOperationType.UPSERT);
  }

  delete(id: string): void {
    const draft = this.drafts.find((item: Draft) => item.id === id);
    if (draft === undefined) return;
    draft.deleted = true;
    draft.updatedAt = new Date().toISOString();
    draft.lastModifiedClientId = this.clientId;
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.replaceDraft(draft);
    this.queueOperation(draft, SyncOperationType.DELETE);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  getClientId(): string { return this.clientId; }
  getCursor(): string { return this.cursor; }
  getBaseUrl(): string { return this.baseUrl; }

  setCursor(cursor: string): void {
    this.cursor = cursor;
    this.enqueue(async () => this.persistState('cursor', cursor));
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.enqueue(async () => this.persistState('base_url', this.baseUrl));
  }

  listPendingOperations(): SyncOperation[] {
    return this.operations.map((operation: SyncOperation) => cloneOperation(operation));
  }

  hasPendingOperation(entityId: string): boolean {
    return this.operations.some((operation: SyncOperation) => operation.entity_id === entityId);
  }

  removeOperation(operationId: string): void {
    this.operations = this.operations.filter((operation: SyncOperation) => operation.operation_id !== operationId);
    this.enqueue(async () => this.deleteOperation(operationId));
  }

  applyServerDraft(draft: Draft): void {
    draft.syncStatus = SyncStatus.SYNCED;
    this.replaceDraft(draft);
  }

  saveConflictDraft(draft: Draft, record: ConflictRecord): void {
    draft.syncStatus = SyncStatus.CONFLICT;
    this.replaceDraft(draft);
    this.enqueue(async () => this.persistConflict(record));
  }

  setDraftSyncStatus(id: string, status: SyncStatus): void {
    const draft = this.drafts.find((item: Draft) => item.id === id);
    if (draft === undefined) return;
    draft.syncStatus = status;
    this.replaceDraft(draft);
  }

  private async migrate(store: relationalStore.RdbStore): Promise<void> {
    if (store.version > DATABASE_VERSION) {
      throw new Error(`Unsupported database version ${store.version}`);
    }
    if (store.version === 0) {
      store.beginTransaction();
      try {
        await store.executeSql('CREATE TABLE IF NOT EXISTS drafts (' +
          'id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, idea TEXT NOT NULL, ' +
          'code TEXT NOT NULL, short_code TEXT NOT NULL, rewrite TEXT NOT NULL, version INTEGER NOT NULL, ' +
          'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL, ' +
          'last_modified_client_id TEXT NOT NULL, sync_status TEXT NOT NULL, ai_mode TEXT NOT NULL, ' +
          'artifact_hidden INTEGER NOT NULL, idea_segments_json TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS sync_operations (' +
          'operation_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, ' +
          'operation_type TEXT NOT NULL, base_version INTEGER NOT NULL, client_id TEXT NOT NULL, ' +
          'occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL)');
        await store.executeSql('CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_operations_entity ' +
          'ON sync_operations(entity_type, entity_id)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS sync_state (' +
          'state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS conflicts (' +
          'id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, local_copy_id TEXT NOT NULL, ' +
          'server_entity_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL)');
        store.version = 1;
        store.commit();
      } catch (error) {
        store.rollBack();
        throw new Error(error instanceof Error ? error.message : 'RDB migration failed');
      }
    }
  }

  private async loadState(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT state_key, state_value FROM sync_state');
    try {
      if (resultSet.goToFirstRow()) {
        do {
          const key = resultSet.getString(resultSet.getColumnIndex('state_key'));
          const value = resultSet.getString(resultSet.getColumnIndex('state_value'));
          if (key === 'client_id') this.clientId = value;
          if (key === 'cursor') this.cursor = value;
          if (key === 'base_url') this.baseUrl = value;
        } while (resultSet.goToNextRow());
      }
    } finally {
      resultSet.close();
    }
    if (this.clientId.length === 0) {
      this.clientId = `phone-${util.generateRandomUUID()}`;
      await this.persistState('client_id', this.clientId);
    }
    if (this.cursor.length === 0) this.cursor = '0';
    if (this.baseUrl.length === 0) this.baseUrl = DEFAULT_BASE_URL;
    await this.persistState('cursor', this.cursor);
    await this.persistState('base_url', this.baseUrl);
  }

  private async loadDrafts(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT * FROM drafts');
    const loaded: Draft[] = [];
    try {
      if (resultSet.goToFirstRow()) {
        do {
          const draft = new Draft(readString(resultSet, 'id'), readString(resultSet, 'title'));
          draft.workspaceId = readString(resultSet, 'workspace_id');
          draft.idea = readString(resultSet, 'idea');
          draft.code = readString(resultSet, 'code');
          draft.shortCode = readString(resultSet, 'short_code');
          draft.rewrite = readString(resultSet, 'rewrite');
          draft.version = readNumber(resultSet, 'version');
          draft.createdAt = readString(resultSet, 'created_at');
          draft.updatedAt = readString(resultSet, 'updated_at');
          draft.deleted = readNumber(resultSet, 'deleted') === 1;
          draft.lastModifiedClientId = readString(resultSet, 'last_modified_client_id');
          draft.syncStatus = parseSyncStatus(readString(resultSet, 'sync_status'));
          draft.aiMode = parseAIMode(readString(resultSet, 'ai_mode'));
          draft.artifactHidden = readNumber(resultSet, 'artifact_hidden') === 1;
          draft.ideaSegments = parseIdeaSegments(readString(resultSet, 'idea_segments_json'));
          loaded.push(draft);
        } while (resultSet.goToNextRow());
      }
    } finally {
      resultSet.close();
    }
    this.drafts = loaded;
  }

  private async loadOperations(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT * FROM sync_operations ORDER BY occurred_at');
    const loaded: SyncOperation[] = [];
    try {
      if (resultSet.goToFirstRow()) {
        do {
          const operation = new SyncOperation();
          operation.operation_id = readString(resultSet, 'operation_id');
          operation.entity_type = readString(resultSet, 'entity_type');
          operation.entity_id = readString(resultSet, 'entity_id');
          operation.operation_type = readString(resultSet, 'operation_type');
          operation.base_version = readNumber(resultSet, 'base_version');
          operation.client_id = readString(resultSet, 'client_id');
          operation.occurred_at = readString(resultSet, 'occurred_at');
          operation.payload = JSON.parse(readString(resultSet, 'payload_json')) as DraftPayload;
          if (operation.operation_id.trim().length === 0) {
            operation.operation_id = createOperationId();
            hilog.warn(DOMAIN, TAG,
              '[AlgoFlow] Repaired queued operation with missing operation_id. entity_id=%{public}s',
              safeLogValue(operation.entity_id));
            await this.persistOperation(operation);
          }
          if (operation.operation_type === SyncOperationType.UPSERT && isBlankPayload(operation.payload) &&
            operation.base_version === 0) {
            hilog.info(DOMAIN, TAG,
              '[AlgoFlow] Dropped legacy empty placeholder operation. entity_id=%{public}s',
              safeLogValue(operation.entity_id));
            await this.deleteOperation(operation.operation_id);
            continue;
          }
          loaded.push(operation);
        } while (resultSet.goToNextRow());
      }
    } finally {
      resultSet.close();
    }
    this.operations = loaded;
  }

  private replaceDraft(draft: Draft): void {
    const snapshot = cloneDraft(draft);
    const index = this.drafts.findIndex((item: Draft) => item.id === snapshot.id);
    if (index >= 0) this.drafts[index] = snapshot;
    else this.drafts.push(snapshot);
    this.enqueue(async () => this.persistDraft(snapshot));
  }

  private queueOperation(draft: Draft, operationType: SyncOperationType): void {
    const existing = this.operations.find((operation: SyncOperation) => operation.entity_id === draft.id);
    const operation = new SyncOperation();
    operation.operation_id = existing !== undefined && existing.operation_id.trim().length > 0
      ? existing.operation_id : createOperationId();
    operation.entity_id = draft.id;
    operation.operation_type = operationType;
    operation.base_version = existing?.base_version ?? draft.version;
    operation.client_id = this.clientId;
    operation.occurred_at = new Date().toISOString();
    operation.payload = draftToPayload(draft);
    this.operations = this.operations.filter((item: SyncOperation) => item.entity_id !== draft.id);
    this.operations.push(operation);
    this.enqueue(async () => this.persistOperation(operation));
  }

  private removePendingOperationForEntity(entityId: string): void {
    const pending = this.operations.filter((item: SyncOperation) => item.entity_id === entityId);
    if (pending.length === 0) return;
    this.operations = this.operations.filter((item: SyncOperation) => item.entity_id !== entityId);
    for (const operation of pending) {
      this.enqueue(async () => this.deleteOperation(operation.operation_id));
    }
  }

  private enqueue(action: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(action).catch((error: Error) => {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] RDB write failed. Cause: %{public}s', error.message);
      throw error;
    });
  }

  private async persistDraft(draft: Draft): Promise<void> {
    const store = this.requireStore();
    await store.executeSql('INSERT OR REPLACE INTO drafts (' +
      'id, workspace_id, title, idea, code, short_code, rewrite, version, created_at, updated_at, deleted, ' +
      'last_modified_client_id, sync_status, ai_mode, artifact_hidden, idea_segments_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        draft.id, draft.workspaceId, draft.title, draft.idea, draft.code, draft.shortCode, draft.rewrite,
        draft.version, draft.createdAt, draft.updatedAt, draft.deleted ? 1 : 0, draft.lastModifiedClientId,
        draft.syncStatus, draft.aiMode, draft.artifactHidden ? 1 : 0, JSON.stringify(draft.ideaSegments)
      ]);
  }

  private async persistOperation(operation: SyncOperation): Promise<void> {
    await this.requireStore().executeSql('INSERT OR REPLACE INTO sync_operations (' +
      'operation_id, entity_type, entity_id, operation_type, base_version, client_id, occurred_at, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [operation.operation_id, operation.entity_type, operation.entity_id,
        operation.operation_type, operation.base_version, operation.client_id, operation.occurred_at,
        JSON.stringify(operation.payload)]);
  }

  private async deleteOperation(operationId: string): Promise<void> {
    await this.requireStore().executeSql('DELETE FROM sync_operations WHERE operation_id = ?', [operationId]);
  }

  private async persistState(key: string, value: string): Promise<void> {
    await this.requireStore().executeSql('INSERT OR REPLACE INTO sync_state (state_key, state_value) VALUES (?, ?)',
      [key, value]);
  }

  private async persistConflict(record: ConflictRecord): Promise<void> {
    await this.requireStore().executeSql('INSERT OR REPLACE INTO conflicts (' +
      'id, entity_id, local_copy_id, server_entity_json, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?)',
      [record.id, record.entity_id, record.local_copy_id, JSON.stringify(record.server_entity), record.created_at,
        record.resolved ? 1 : 0]);
  }

  private requireStore(): relationalStore.RdbStore {
    if (this.store === undefined) throw new Error('RDB repository is not initialized');
    return this.store;
  }
}

function readString(resultSet: relationalStore.ResultSet, column: string): string {
  return resultSet.getString(resultSet.getColumnIndex(column));
}

function readNumber(resultSet: relationalStore.ResultSet, column: string): number {
  return resultSet.getLong(resultSet.getColumnIndex(column));
}

function parseIdeaSegments(value: string): IdeaSegment[] {
  if (value.length === 0) return [];
  return JSON.parse(value) as IdeaSegment[];
}

function parseSyncStatus(value: string): SyncStatus {
  if (value === SyncStatus.SYNCING) return SyncStatus.SYNCING;
  if (value === SyncStatus.SYNCED) return SyncStatus.SYNCED;
  if (value === SyncStatus.CONFLICT) return SyncStatus.CONFLICT;
  if (value === SyncStatus.FAILED) return SyncStatus.FAILED;
  return SyncStatus.LOCAL_ONLY;
}

function parseAIMode(value: string): AIMode {
  if (value === AIMode.FEASIBILITY_ANALYSIS) return AIMode.FEASIBILITY_ANALYSIS;
  if (value === AIMode.PROGRESSIVE_HINT) return AIMode.PROGRESSIVE_HINT;
  if (value === AIMode.FULL_SOLUTION) return AIMode.FULL_SOLUTION;
  return AIMode.FAITHFUL_TRANSFORM;
}

function cloneDraft(draft: Draft): Draft {
  const snapshot = payloadToDraft(draftToPayload(draft));
  snapshot.syncStatus = draft.syncStatus;
  return snapshot;
}

function cloneOperation(source: SyncOperation): SyncOperation {
  const operation = new SyncOperation();
  operation.operation_id = source.operation_id;
  operation.entity_type = source.entity_type;
  operation.entity_id = source.entity_id;
  operation.operation_type = source.operation_type;
  operation.base_version = source.base_version;
  operation.client_id = source.client_id;
  operation.occurred_at = source.occurred_at;
  operation.payload = JSON.parse(JSON.stringify(source.payload)) as DraftPayload;
  return operation;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_BASE_URL;
  return trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
}

let operationSequence: number = 0;

function createOperationId(): string {
  const generated = util.generateRandomUUID();
  if (generated.trim().length > 0) return generated;
  operationSequence += 1;
  return `phone-operation-${Date.now()}-${operationSequence}`;
}

function safeLogValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').substring(0, 96);
}

function isBlankDraft(draft: Draft): boolean {
  return draft.title === '未命名思路' && draft.idea.length === 0 && draft.code.length === 0 &&
    draft.shortCode.length === 0 && draft.rewrite.length === 0 && draft.ideaSegments.length === 0;
}

function isBlankPayload(payload: DraftPayload): boolean {
  return payload.title === '未命名思路' && (payload.idea ?? '').length === 0 && (payload.code ?? '').length === 0 &&
    (payload.short_code ?? '').length === 0 && (payload.rewrite ?? '').length === 0 &&
    (payload.idea_segments ?? []).length === 0;
}
