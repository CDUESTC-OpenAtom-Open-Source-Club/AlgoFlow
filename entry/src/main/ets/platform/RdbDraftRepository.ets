import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DraftRepository } from '../domain/DraftRepository';
import { AIArtifact, AIMode, Draft, IdeaSegment, ReviewResult, SyncStatus } from '../domain/Models';
import { AIArtifactPayload, artifactToPayload, payloadToArtifact } from '../domain/AIArtifactCodec';
import { ConflictRecord, DraftPayload, ReviewResultPayload, SyncEntityType, SyncOperation, SyncOperationType, draftToPayload,
  payloadToDraft, payloadToReview, reviewToPayload } from '../domain/SyncModels';
import { SyncRepository } from '../domain/SyncRepository';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const DATABASE_VERSION = 4;
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const STORE_CONFIG: relationalStore.StoreConfig = {
  name: 'algoflow_workspace.db',
  securityLevel: relationalStore.SecurityLevel.S1
};

export class RdbDraftRepository implements DraftRepository, SyncRepository {
  private context: common.Context;
  private store?: relationalStore.RdbStore;
  private drafts: Draft[] = [];
  private artifacts: AIArtifact[] = [];
  private reviews: ReviewResult[] = [];
  private conflicts: ConflictRecord[] = [];
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
    await this.loadArtifacts(this.store);
    await this.loadReviews(this.store);
    await this.loadConflicts(this.store);
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

  hasPendingOperation(entityType: string, entityId: string): boolean {
    return this.operations.some((operation: SyncOperation) => operation.entity_type === entityType && operation.entity_id === entityId);
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
    this.upsertConflict(record);
    this.enqueue(async () => this.persistConflict(record));
  }

  saveConflictArtifact(artifact: AIArtifact, record: ConflictRecord): void {
    artifact.deleted = false;
    this.replaceArtifact(artifact);
    this.upsertConflict(record);
    this.enqueue(async () => this.persistConflict(record));
  }

  saveConflictReview(review: ReviewResult, record: ConflictRecord): void {
    review.deleted = false;
    this.replaceReview(review);
    this.upsertConflict(record);
    this.enqueue(async () => this.persistConflict(record));
  }

  private upsertConflict(record: ConflictRecord): void {
    const index = this.conflicts.findIndex((item: ConflictRecord) => item.id === record.id);
    if (index >= 0) this.conflicts[index] = record;
    else this.conflicts.push(record);
  }

  setDraftSyncStatus(id: string, status: SyncStatus): void {
    const draft = this.drafts.find((item: Draft) => item.id === id);
    if (draft === undefined) return;
    draft.syncStatus = status;
    this.replaceDraft(draft);
  }

  listArtifacts(): AIArtifact[] {
    return this.artifacts.filter((artifact: AIArtifact) => !artifact.deleted)
      .sort((left: AIArtifact, right: AIArtifact) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listConflicts(): ConflictRecord[] {
    return this.conflicts.filter((record: ConflictRecord) => !record.resolved);
  }

  getArtifact(id: string): AIArtifact | undefined {
    return this.artifacts.find((artifact: AIArtifact) => artifact.id === id && !artifact.deleted);
  }

  saveArtifact(artifact: AIArtifact): void {
    artifact.deleted = false;
    artifact.lastModifiedClientId = this.clientId;
    artifact.updatedAt = new Date().toISOString();
    this.replaceArtifact(artifact);
    this.queueArtifactOperation(artifact, SyncOperationType.UPSERT);
  }

  applyServerArtifact(payload: AIArtifactPayload): void {
    // Artifacts retain provenance from the source draft version that created them.
    // A later draft edit must not invalidate an otherwise valid historical result.
    const artifact = payloadToArtifact(payload);
    if (artifact === undefined) throw new Error('INVALID_AI_ARTIFACT');
    this.replaceArtifact(artifact);
  }

  listReviews(): ReviewResult[] { return this.reviews.filter((review) => !review.deleted).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); }
  getReview(id: string): ReviewResult | undefined { return this.reviews.find((review) => review.id === id && !review.deleted); }
  saveReview(review: ReviewResult): void {
    review.deleted = false; review.lastModifiedClientId = this.clientId; review.updatedAt = new Date().toISOString();
    this.replaceReview(review); this.queueReviewOperation(review, SyncOperationType.UPSERT);
  }
  applyServerReview(payload: ReviewResultPayload): void {
    const review = payloadToReview(payload); if (review === undefined) throw new Error('INVALID_REVIEW_RESULT'); this.replaceReview(review);
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
          'id TEXT PRIMARY KEY, entity_type TEXT NOT NULL DEFAULT \'draft\', entity_id TEXT NOT NULL, local_copy_id TEXT NOT NULL, ' +
          'server_entity_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS ai_artifacts (' +
          'id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
          'deleted INTEGER NOT NULL, last_modified_client_id TEXT NOT NULL, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS review_results (' +
          'id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL, ' +
          'last_modified_client_id TEXT NOT NULL, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
        store.version = DATABASE_VERSION;
        store.commit();
      } catch (error) {
        store.rollBack();
        throw new Error(error instanceof Error ? error.message : 'RDB migration failed');
      }
    }
    if (store.version === 1) {
      store.beginTransaction();
      try {
        await store.executeSql('CREATE TABLE IF NOT EXISTS ai_artifacts (' +
          'id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
          'deleted INTEGER NOT NULL, last_modified_client_id TEXT NOT NULL, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
        store.version = 2;
        store.commit();
      } catch (error) {
        store.rollBack();
        throw new Error(error instanceof Error ? error.message : 'RDB migration failed');
      }
    }
    if (store.version === 2) {
      store.beginTransaction();
      try {
        await store.executeSql('CREATE TABLE IF NOT EXISTS ai_artifacts (' +
          'id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
          'deleted INTEGER NOT NULL, last_modified_client_id TEXT NOT NULL, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
        await migrateEmbeddedArtifacts(store);
        store.version = 3;
        store.commit();
      } catch (error) {
        store.rollBack();
        throw new Error(error instanceof Error ? error.message : 'RDB migration failed');
      }
    }
    if (store.version === 3) {
      store.beginTransaction();
      try {
        const columns = await store.querySql('PRAGMA table_info(conflicts)');
        let hasEntityType = false;
        try {
          if (columns.goToFirstRow()) {
            do {
              if (readString(columns, 'name') === 'entity_type') hasEntityType = true;
            } while (columns.goToNextRow());
          }
        } finally {
          columns.close();
        }
        if (!hasEntityType) await store.executeSql('ALTER TABLE conflicts ADD COLUMN entity_type TEXT NOT NULL DEFAULT \'draft\'');
        store.version = DATABASE_VERSION;
        store.commit();
      } catch (error) {
        store.rollBack();
        throw new Error(error instanceof Error ? error.message : 'RDB migration failed');
      }
    }
    if (store.version === DATABASE_VERSION) {
      await store.executeSql('CREATE TABLE IF NOT EXISTS ai_artifacts (' +
        'id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ' +
      'deleted INTEGER NOT NULL, last_modified_client_id TEXT NOT NULL, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
      await store.executeSql('CREATE TABLE IF NOT EXISTS review_results (' +
        'id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL, ' +
        'last_modified_client_id TEXT NOT NULL, draft_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
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

  private async loadArtifacts(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT payload_json FROM ai_artifacts');
    const loaded: AIArtifact[] = [];
    try {
      if (resultSet.goToFirstRow()) {
        do {
          let payload: AIArtifactPayload;
          try {
            payload = JSON.parse(readString(resultSet, 'payload_json')) as AIArtifactPayload;
          } catch (error) {
            hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped malformed stored AI artifact JSON');
            continue;
          }
          const artifact = payloadToArtifact(payload);
          if (artifact === undefined) {
            hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped invalid stored AI artifact');
          } else {
            loaded.push(artifact);
          }
        } while (resultSet.goToNextRow());
      }
    } finally {
      resultSet.close();
    }
    this.artifacts = loaded;
  }

  private async loadReviews(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT payload_json FROM review_results');
    const loaded: ReviewResult[] = [];
    try {
      if (resultSet.goToFirstRow()) {
        do {
          try {
            const review = payloadToReview(JSON.parse(readString(resultSet, 'payload_json')) as ReviewResultPayload);
            if (review !== undefined) loaded.push(review);
          } catch (error) {
            hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped malformed stored review result');
          }
        } while (resultSet.goToNextRow());
      }
    } finally { resultSet.close(); }
    this.reviews = loaded;
  }

  private async loadConflicts(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT id, entity_type, entity_id, local_copy_id, server_entity_json, created_at, resolved FROM conflicts');
    const loaded: ConflictRecord[] = [];
    try {
      if (resultSet.goToFirstRow()) {
        do {
          const record = new ConflictRecord();
          record.id = readString(resultSet, 'id');
          record.entity_type = readString(resultSet, 'entity_type') || SyncEntityType.DRAFT;
          record.entity_id = readString(resultSet, 'entity_id');
          record.local_copy_id = readString(resultSet, 'local_copy_id');
          record.created_at = readString(resultSet, 'created_at');
          record.resolved = readNumber(resultSet, 'resolved') === 1;
          try {
            record.server_entity = JSON.parse(readString(resultSet, 'server_entity_json')) as DraftPayload | AIArtifactPayload | ReviewResultPayload;
          } catch (error) {
            hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped malformed conflict record. entity_id=%{public}s', safeLogValue(record.entity_id));
            continue;
          }
          if (!isPersistedConflictPayloadValid(record)) {
            hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped invalid conflict record. entity_id=%{public}s', safeLogValue(record.entity_id));
            continue;
          }
          loaded.push(record);
        } while (resultSet.goToNextRow());
      }
    } finally {
      resultSet.close();
    }
    this.conflicts = loaded;
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
          operation.payload = JSON.parse(readString(resultSet, 'payload_json')) as DraftPayload | AIArtifactPayload;
          if (operation.operation_id.trim().length === 0) {
            operation.operation_id = createOperationId();
            hilog.warn(DOMAIN, TAG,
              '[AlgoFlow] Repaired queued operation with missing operation_id. entity_id=%{public}s',
              safeLogValue(operation.entity_id));
            await this.persistOperation(operation);
          }
          if (operation.entity_type === SyncEntityType.DRAFT && operation.operation_type === SyncOperationType.UPSERT && isBlankPayload(operation.payload as DraftPayload) &&
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

  private replaceArtifact(artifact: AIArtifact): void {
    const snapshot = cloneArtifact(artifact);
    const index = this.artifacts.findIndex((item: AIArtifact) => item.id === snapshot.id);
    if (index >= 0) this.artifacts[index] = snapshot;
    else this.artifacts.push(snapshot);
    this.enqueue(async () => this.persistArtifact(snapshot));
  }

  private replaceReview(review: ReviewResult): void {
    const snapshot = payloadToReview(reviewToPayload(review));
    if (snapshot === undefined) throw new Error('INVALID_REVIEW_RESULT');
    const index = this.reviews.findIndex((item) => item.id === snapshot.id);
    if (index >= 0) this.reviews[index] = snapshot; else this.reviews.push(snapshot);
    this.enqueue(async () => this.persistReview(snapshot));
  }

  private queueOperation(draft: Draft, operationType: SyncOperationType): void {
    const existing = this.operations.find((operation: SyncOperation) => operation.entity_type === SyncEntityType.DRAFT && operation.entity_id === draft.id);
    const operation = new SyncOperation();
    operation.operation_id = existing !== undefined && existing.operation_id.trim().length > 0
      ? existing.operation_id : createOperationId();
    operation.entity_id = draft.id;
    operation.entity_type = SyncEntityType.DRAFT;
    operation.operation_type = operationType;
    operation.base_version = existing?.base_version ?? draft.version;
    operation.client_id = this.clientId;
    operation.occurred_at = new Date().toISOString();
    operation.payload = draftToPayload(draft);
    this.operations = this.operations.filter((item: SyncOperation) => !(item.entity_type === SyncEntityType.DRAFT && item.entity_id === draft.id));
    this.operations.push(operation);
    this.enqueue(async () => this.persistOperation(operation));
  }

  private queueArtifactOperation(artifact: AIArtifact, operationType: SyncOperationType): void {
    const existing = this.operations.find((operation: SyncOperation) => operation.entity_type === SyncEntityType.AI_ARTIFACT && operation.entity_id === artifact.id);
    const operation = new SyncOperation();
    operation.operation_id = existing !== undefined && existing.operation_id.trim().length > 0 ? existing.operation_id : createOperationId();
    operation.entity_type = SyncEntityType.AI_ARTIFACT;
    operation.entity_id = artifact.id;
    operation.operation_type = operationType;
    operation.base_version = existing?.base_version ?? artifact.version;
    operation.client_id = this.clientId;
    operation.occurred_at = new Date().toISOString();
    operation.payload = artifactToPayload(artifact);
    this.operations = this.operations.filter((item: SyncOperation) => !(item.entity_type === SyncEntityType.AI_ARTIFACT && item.entity_id === artifact.id));
    this.operations.push(operation);
    this.enqueue(async () => this.persistOperation(operation));
  }

  private queueReviewOperation(review: ReviewResult, operationType: SyncOperationType): void {
    const existing = this.operations.find((operation) => operation.entity_type === SyncEntityType.REVIEW_RESULT && operation.entity_id === review.id);
    const operation = new SyncOperation();
    operation.operation_id = existing?.operation_id ?? createOperationId(); operation.entity_type = SyncEntityType.REVIEW_RESULT;
    operation.entity_id = review.id; operation.operation_type = operationType; operation.base_version = existing?.base_version ?? review.version;
    operation.client_id = this.clientId; operation.occurred_at = new Date().toISOString(); operation.payload = reviewToPayload(review);
    this.operations = this.operations.filter((item) => !(item.entity_type === SyncEntityType.REVIEW_RESULT && item.entity_id === review.id));
    this.operations.push(operation); this.enqueue(async () => this.persistOperation(operation));
  }

  private removePendingOperationForEntity(entityId: string): void {
    const pending = this.operations.filter((item: SyncOperation) => item.entity_type === SyncEntityType.DRAFT && item.entity_id === entityId);
    if (pending.length === 0) return;
    this.operations = this.operations.filter((item: SyncOperation) => !(item.entity_type === SyncEntityType.DRAFT && item.entity_id === entityId));
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

  private async persistArtifact(artifact: AIArtifact): Promise<void> {
    const payload = artifactToPayload(artifact);
    await this.requireStore().executeSql('INSERT OR REPLACE INTO ai_artifacts (' +
      'id, version, created_at, updated_at, deleted, last_modified_client_id, draft_id, payload_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [artifact.id, artifact.version, artifact.createdAt, artifact.updatedAt,
      artifact.deleted ? 1 : 0, artifact.lastModifiedClientId, artifact.draftId, JSON.stringify(payload)]);
  }

  private async persistReview(review: ReviewResult): Promise<void> {
    const payload = reviewToPayload(review);
    await this.requireStore().executeSql('INSERT OR REPLACE INTO review_results (id, version, created_at, updated_at, deleted, last_modified_client_id, draft_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [review.id, review.version, review.createdAt, review.updatedAt, review.deleted ? 1 : 0, review.lastModifiedClientId, review.draftId, JSON.stringify(payload)]);
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
      'id, entity_type, entity_id, local_copy_id, server_entity_json, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [record.id, record.entity_type, record.entity_id, record.local_copy_id, JSON.stringify(record.server_entity), record.created_at,
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

function isPersistedConflictPayloadValid(record: ConflictRecord): boolean {
  if (record.server_entity === null || Array.isArray(record.server_entity as Object)) return false;
  if (record.entity_type === SyncEntityType.AI_ARTIFACT) {
    return payloadToArtifact(record.server_entity as AIArtifactPayload) !== undefined;
  }
  if (record.entity_type === SyncEntityType.REVIEW_RESULT) {
    return payloadToReview(record.server_entity as ReviewResultPayload) !== undefined;
  }
  if (record.entity_type !== SyncEntityType.DRAFT) return false;
  const draft = record.server_entity as DraftPayload;
  return typeof draft.id === 'string' && draft.id.length > 0 &&
    Number.isInteger(draft.version) && draft.version >= 0;
}

async function migrateEmbeddedArtifacts(store: relationalStore.RdbStore): Promise<void> {
  const columns = await store.querySql('PRAGMA table_info(drafts)');
  let hasEmbeddedColumn = false;
  try {
    if (columns.goToFirstRow()) {
      do {
        if (readString(columns, 'name') === 'ai_artifacts_json') hasEmbeddedColumn = true;
      } while (columns.goToNextRow());
    }
  } finally {
    columns.close();
  }
  if (!hasEmbeddedColumn) return;
  const resultSet = await store.querySql('SELECT id, updated_at, last_modified_client_id, ai_artifacts_json FROM drafts');
  try {
    if (!resultSet.goToFirstRow()) return;
    do {
      const draftId = readString(resultSet, 'id');
      const updatedAt = readString(resultSet, 'updated_at');
      const clientId = readString(resultSet, 'last_modified_client_id');
      const encoded = readString(resultSet, 'ai_artifacts_json');
      if (encoded.length === 0) continue;
      let values: AIArtifactPayload[] = [];
      try {
        values = JSON.parse(encoded) as AIArtifactPayload[];
      } catch (error) {
        hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped malformed legacy AI artifact JSON. draft_id=%{public}s', safeLogValue(draftId));
        continue;
      }
      if (!Array.isArray(values)) {
        hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped legacy AI artifact object. draft_id=%{public}s', safeLogValue(draftId));
        continue;
      }
      for (let index = 0; index < values.length; index++) {
        const payload = values[index];
        if (payload === undefined || payload === null || typeof payload !== 'object') {
          hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped malformed legacy AI artifact. draft_id=%{public}s index=%{public}s',
            safeLogValue(draftId), index.toString());
          continue;
        }
        payload.id = typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : `${draftId}:artifact:${index}`;
        payload.version = 0;
        payload.server_sequence = 0;
        payload.created_at = typeof payload.created_at === 'string' && payload.created_at.length > 0 ? payload.created_at : updatedAt;
        payload.updated_at = typeof payload.updated_at === 'string' && payload.updated_at.length > 0 ? payload.updated_at : updatedAt;
        payload.deleted = false;
        payload.last_modified_client_id = typeof payload.last_modified_client_id === 'string' && payload.last_modified_client_id.length > 0 ? payload.last_modified_client_id : clientId;
        payload.draft_id = draftId;
        const artifact = payloadToArtifact(payload);
        if (artifact === undefined) {
          hilog.warn(DOMAIN, TAG, '[AlgoFlow] Skipped invalid legacy AI artifact. draft_id=%{public}s index=%{public}s',
            safeLogValue(draftId), index.toString());
          continue;
        }
        await store.executeSql('INSERT OR IGNORE INTO ai_artifacts (' +
          'id, version, created_at, updated_at, deleted, last_modified_client_id, draft_id, payload_json) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [artifact.id, artifact.version, artifact.createdAt, artifact.updatedAt,
          0, artifact.lastModifiedClientId, artifact.draftId, JSON.stringify(artifactToPayload(artifact))]);
      }
    } while (resultSet.goToNextRow());
  } finally {
    resultSet.close();
  }
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
  operation.payload = JSON.parse(JSON.stringify(source.payload)) as DraftPayload | AIArtifactPayload | ReviewResultPayload;
  return operation;
}

function cloneArtifact(artifact: AIArtifact): AIArtifact {
  const payload = artifactToPayload(artifact);
  const snapshot = payloadToArtifact(payload);
  if (snapshot === undefined) throw new Error('INVALID_AI_ARTIFACT');
  return snapshot;
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
