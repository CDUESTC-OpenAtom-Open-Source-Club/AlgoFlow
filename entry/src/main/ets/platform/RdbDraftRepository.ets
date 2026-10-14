import { common } from '@kit.AbilityKit';
import { relationalStore } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DraftRepository } from '../domain/DraftRepository';
import { AIArtifact, AIOutputKind, AIMode, AIRequestSegment, AIVisibility, CodeMapping, Draft, IdeaSegment, PseudocodeStep, SyncStatus } from '../domain/Models';
import { AIArtifactPayload, ConflictRecord, DraftPayload, ReviewDiagnosticPayload, ReviewResultPayload, SyncOperation, SyncOperationType, SyncEntityType,
  draftToPayload, payloadToDraft } from '../domain/SyncModels';
import { SyncRepository } from '../domain/SyncRepository';
import { AIResultRepository, IDECapability, IDEContext, IDERecord, IDEState, ReviewKind } from '../domain/IDEAIModels';
import { RdbAIResultRepository } from './RdbAIResultRepository';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const DATABASE_VERSION = 3;
interface DraftSourceSnapshot { code: string; ideaSegments: IdeaSegment[]; }
class LegacyArtifactStepBody { id: string = ''; step: string = ''; source_refs: string[] = []; }
class LegacyArtifactMappingBody { step_id: string = ''; start_line: number = 0; end_line: number = 0; }
class LegacyArtifactBody {
  mode: string = '';
  pseudocode: LegacyArtifactStepBody[] = [];
  code_snippet: string | null = null;
  code_mappings: LegacyArtifactMappingBody[] = [];
  assumptions: string[] = [];
  missing_information: string[] = [];
  risk_flags: string[] = [];
  added_algorithm_steps: string[] = [];
  source_draft_version: number = 0;
  model_id: string = '';
  rule_version: string = '';
  output_kind: string = '';
  visibility: string = '';
  template_id: string | null = null;
}
export async function migrateWorkspaceStore(store: relationalStore.RdbStore): Promise<void> {
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
        store.version = 1;
        store.commit();
      } catch (error) {
        store.rollBack();
        if (store.version === 1) store.version = 0;
        throw new Error(error instanceof Error ? error.message : 'RDB migration failed');
      }
    }
    if (store.version === 1) {
      store.beginTransaction();
      try {
        await ensureAIResultTables(store);
        await ensureDraftSourceHistory(store);
        await ensureConflictEntityType(store);
        store.version = 2;
        store.commit();
      } catch (error) {
        store.rollBack();
        if (store.version === 2) store.version = 1;
        throw new Error('AI 结果数据库升级失败，原工作区未删除');
      }
    }
    // v2 may either have the independent result tables or the older embedded
    // artifact column. Version 3 validates the tables and imports valid embedded
    // results without rewriting Draft/sync rows.
    if (store.version === 2) {
      store.beginTransaction();
      try {
        await ensureAIResultTables(store);
        await ensureDraftSourceHistory(store);
        await ensureConflictEntityType(store);
        await importLegacyArtifacts(store);
        store.version = 3;
        store.commit();
      } catch (error) {
        store.rollBack();
        if (store.version === 3) store.version = 2;
        throw new Error('AI 结果数据库兼容升级失败，原工作区未删除');
      }
    }
  }

async function ensureAIResultTables(store: relationalStore.RdbStore): Promise<void> {
  await ensureTable(store, 'ai_results', 'CREATE TABLE IF NOT EXISTS ai_results (' +
          'draft_id TEXT NOT NULL, mode TEXT NOT NULL, slot TEXT NOT NULL, is_test INTEGER NOT NULL, ' +
          'result_id TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL, ' +
          'PRIMARY KEY (draft_id, mode, slot, is_test))',
    ['draft_id', 'mode', 'slot', 'is_test', 'result_id', 'updated_at', 'record_json']);
  await ensureTable(store, 'ai_result_history', 'CREATE TABLE IF NOT EXISTS ai_result_history (' +
          'draft_id TEXT NOT NULL, mode TEXT NOT NULL, slot TEXT NOT NULL, is_test INTEGER NOT NULL, ' +
          'result_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, record_json TEXT NOT NULL)',
    ['draft_id', 'mode', 'slot', 'is_test', 'result_id', 'updated_at', 'record_json']);
}

async function ensureDraftSourceHistory(store: relationalStore.RdbStore): Promise<void> {
  await ensureTable(store, 'draft_source_history', 'CREATE TABLE IF NOT EXISTS draft_source_history (' +
          'draft_id TEXT NOT NULL, version INTEGER NOT NULL, code TEXT NOT NULL, idea_segments_json TEXT NOT NULL, ' +
          'PRIMARY KEY (draft_id, version))', ['draft_id', 'version', 'code', 'idea_segments_json']);
}

async function importLegacyArtifacts(store: relationalStore.RdbStore): Promise<void> {
  if (typeof store.querySql !== 'function') return;
  const schema = await store.querySql('PRAGMA table_info(drafts)');
  let hasLegacyColumn = false;
  try {
    if (schema.goToFirstRow()) do {
      if (schema.getString(schema.getColumnIndex('name')) === 'ai_artifacts_json') hasLegacyColumn = true;
    } while (schema.goToNextRow());
  } finally { schema.close(); }
  if (!hasLegacyColumn) return;
  let rows: relationalStore.ResultSet;
  try { rows = await store.querySql('SELECT * FROM drafts'); }
  catch (error) { throw new Error('读取旧草稿失败'); }
  try {
    if (!rows.goToFirstRow()) return;
    do {
      const draftId = readString(rows, 'id');
      if (readNumber(rows, 'deleted') === 1) continue;
      const column = rows.getColumnIndex('ai_artifacts_json');
      if (column < 0) continue;
      const raw = rows.getString(column);
      if (raw.length === 0) continue;
      const artifacts = readLegacyArtifacts(rows);
      const draft = new Draft(draftId, readString(rows, 'title'));
      draft.code = readString(rows, 'code'); draft.idea = readString(rows, 'idea');
      draft.version = readNumber(rows, 'version'); draft.updatedAt = readString(rows, 'updated_at');
      draft.ideaSegments = parseIdeaSegments(readString(rows, 'idea_segments_json'));
      for (let index = 0; index < artifacts.length; index++) {
        const artifact = artifacts[index];
        const record = new IDERecord();
        record.id = `legacy-${draftId}-${index}`; record.capability = IDECapability.TRANSFORM;
        record.state = IDEState.SUCCESS; record.createdAt = draft.updatedAt; record.updatedAt = draft.updatedAt;
        record.hidden = readNumber(rows, 'artifact_hidden') === 1 || artifact.visibility === AIVisibility.HIDDEN;
        record.restored = true; record.stale = true;
        record.context = new IDEContext(); record.context.draftId = draftId; record.context.version = artifact.sourceDraftVersion;
        record.context.code = draft.code; record.context.idea = draft.idea; record.context.problemContext = draft.title;
        const sourceIds: string[] = [];
        artifact.pseudocode.forEach((step: PseudocodeStep) => step.sourceRefs.forEach((id: string) => {
          if (!sourceIds.includes(id)) sourceIds.push(id);
        }));
        record.context.segments = sourceIds.map((id: string) => {
          const segment = draft.ideaSegments.find((item: IdeaSegment) => item.id === id);
          return new AIRequestSegment(id, segment?.content ?? '');
        });
        const body = new LegacyArtifactBody();
        body.mode = artifact.mode;
        body.pseudocode = artifact.pseudocode.map((step: PseudocodeStep) => {
          const legacyStep = new LegacyArtifactStepBody(); legacyStep.id = step.id; legacyStep.step = step.step;
          legacyStep.source_refs = step.sourceRefs.slice(); return legacyStep;
        });
        body.code_snippet = artifact.codeSnippet;
        body.code_mappings = artifact.codeMappings.map((mapping: CodeMapping) => {
          const legacyMapping = new LegacyArtifactMappingBody(); legacyMapping.step_id = mapping.stepId;
          legacyMapping.start_line = mapping.startLine; legacyMapping.end_line = mapping.endLine; return legacyMapping;
        });
        body.assumptions = artifact.assumptions.slice(); body.missing_information = artifact.missingInformation.slice();
        body.risk_flags = artifact.riskFlags.slice(); body.added_algorithm_steps = artifact.addedAlgorithmSteps.slice();
        body.source_draft_version = artifact.sourceDraftVersion; body.model_id = artifact.modelId;
        body.rule_version = artifact.ruleVersion; body.output_kind = artifact.outputKind;
        body.visibility = artifact.visibility; body.template_id = artifact.templateId;
        record.body = JSON.stringify(body);
        const json = JSON.stringify(record);
        await store.executeSql('INSERT OR IGNORE INTO ai_results (draft_id, mode, slot, is_test, result_id, updated_at, record_json) VALUES (?, ?, ?, 0, ?, ?, ?)',
          [draftId, artifact.mode, 'transform', record.id, record.updatedAt, json]);
      }
    } while (rows.goToNextRow());
  } finally { rows.close(); }
}
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_AI_BASE_URL = 'http://127.0.0.1:8788';
const STORE_CONFIG: relationalStore.StoreConfig = {
  name: 'algoflow_workspace.db',
  securityLevel: relationalStore.SecurityLevel.S1
};

export class RdbDraftRepository implements DraftRepository, SyncRepository {
  private inFlight: string[] = [];
  markInFlight(operationId: string): void {
    if (!this.inFlight.includes(operationId)) this.inFlight.push(operationId);
  }
  private context: common.Context;
  private store?: relationalStore.RdbStore;
  private drafts: Draft[] = [];
  private sourceHistory: Map<string, Map<number, DraftSourceSnapshot>> = new Map();
  private operations: SyncOperation[] = [];
  private clientId: string = '';
  private cursor: string = '0';
  private baseUrl: string = DEFAULT_BASE_URL;
  private aiBaseUrl: string = DEFAULT_AI_BASE_URL;
  private writeChain: Promise<void> = Promise.resolve();
  private writeErrors: Error[] = [];

  constructor(context: common.Context, existingStore?: relationalStore.RdbStore) {
    this.context = context;
    this.store = existingStore;
  }

  async initialize(): Promise<void> {
    if (this.store !== undefined) return;
    const store = await relationalStore.getRdbStore(this.context, STORE_CONFIG);
    await this.migrate(store);
    this.store = store;
    try {
      await this.loadState(store);
      await this.loadDrafts(store);
      await this.loadSourceHistory(store);
      await this.loadOperations(store);
    } catch (error) { this.store = undefined; throw new Error('RDB initialization failed'); }
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
    if (this.writeErrors.length > 0) {
      const messages = this.writeErrors.splice(0).map((error: Error) => error.message);
      throw new Error(messages.join('; '));
    }
  }

  aiResults(allowTestData: boolean = false): AIResultRepository {
    return new RdbAIResultRepository(this.requireStore(), allowTestData, (record: IDERecord) => this.queueAIRecord(record));
  }

  getClientId(): string { return this.clientId; }
  getDraft(id: string): Draft | undefined { return this.drafts.find((draft: Draft) => draft.id === id); }
  getCursor(): string { return this.cursor; }
  getBaseUrl(): string { return this.baseUrl; }

  getAIBaseUrl(): string { return this.aiBaseUrl; }

  setAIBaseUrl(baseUrl: string): void {
    this.aiBaseUrl = normalizeAIBaseUrl(baseUrl);
    this.enqueue(async () => this.persistState('ai_base_url', this.aiBaseUrl));
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
    this.enqueue(async () => this.persistState('cursor', cursor));
  }

  async commitCursor(cursor: string): Promise<void> {
    await this.flush();
    this.enqueue(async () => {
      await this.persistState('cursor', cursor);
      this.cursor = cursor;
    });
    await this.flush();
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

  queueAIRecord(record: IDERecord): void {
    if (record.isTestData || record.state !== IDEState.SUCCESS || record.capability === IDECapability.COMPLETION) return;
    const entityType = record.capability === IDECapability.REVIEW ? SyncEntityType.REVIEW_RESULT : SyncEntityType.AI_ARTIFACT;
    const payload = recordToSyncPayload(record, this.clientId, entityType);
    const existing = this.operations.find((operation: SyncOperation) => operation.entity_type === entityType && operation.entity_id === record.id);
    const operation = new SyncOperation();
    operation.operation_id = existing !== undefined && existing.operation_id.trim().length > 0 && !this.inFlight.includes(existing.operation_id)
      ? existing.operation_id : createOperationId();
    operation.entity_type = entityType;
    operation.entity_id = record.id;
    operation.operation_type = SyncOperationType.UPSERT;
    operation.base_version = existing?.base_version ?? record.serverVersion;
    operation.client_id = this.clientId;
    operation.occurred_at = record.updatedAt || new Date().toISOString();
    operation.payload = payload;
    this.operations = this.operations.filter((item: SyncOperation) => !(item.entity_type === entityType && item.entity_id === record.id));
    this.operations.push(operation);
    this.enqueue(async () => this.persistOperation(operation));
  }

  async getAIRecord(id: string): Promise<IDERecord | undefined> {
    const repository = new RdbAIResultRepository(this.requireStore(), false);
    for (const draft of this.drafts) {
      const records = await repository.list(draft.id, draft.aiMode);
      const found = records.find((record: IDERecord) => record.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  async applyServerAIArtifact(payload: AIArtifactPayload): Promise<void> {
    await this.applyServerAIRecord(payload, SyncEntityType.AI_ARTIFACT);
  }

  async applyServerReview(payload: ReviewResultPayload): Promise<void> {
    await this.applyServerAIRecord(payload, SyncEntityType.REVIEW_RESULT);
  }

  async saveConflictAIRecord(record: IDERecord, conflict: ConflictRecord): Promise<void> {
    await new RdbAIResultRepository(this.requireStore(), false).save(record, true);
    this.enqueue(async () => this.persistConflict(conflict));
  }

  getDraftSourceCode(draftId: string, version: number): string | undefined {
    const snapshot = this.sourceHistory.get(draftId)?.get(version);
    if (snapshot !== undefined) return snapshot.code;
    const draft = this.drafts.find((item: Draft) => item.id === draftId && !item.deleted);
    return draft !== undefined && draft.version === version ? draft.code : undefined;
  }

  getDraftSourceSegments(draftId: string, version: number): IdeaSegment[] | undefined {
    return this.sourceHistory.get(draftId)?.get(version)?.ideaSegments.map((segment: IdeaSegment) =>
      new IdeaSegment(segment.id, segment.content, segment.position));
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
    await migrateWorkspaceStore(store);
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
          if (key === 'ai_base_url') this.aiBaseUrl = value;
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
    if (this.aiBaseUrl.length === 0) this.aiBaseUrl = DEFAULT_AI_BASE_URL;
    await this.persistState('cursor', this.cursor);
    await this.persistState('base_url', this.baseUrl);
    await this.persistState('ai_base_url', this.aiBaseUrl);
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
          draft.aiArtifacts = readLegacyArtifacts(resultSet);
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

  private async loadSourceHistory(store: relationalStore.RdbStore): Promise<void> {
    const resultSet = await store.querySql('SELECT draft_id, version, code, idea_segments_json FROM draft_source_history');
    const loaded: Map<string, Map<number, DraftSourceSnapshot>> = new Map();
    try {
      if (resultSet.goToFirstRow()) do {
        const draftId = readString(resultSet, 'draft_id');
        const version = readNumber(resultSet, 'version');
        const snapshot: DraftSourceSnapshot = { code: readString(resultSet, 'code'), ideaSegments: parseIdeaSegments(readString(resultSet, 'idea_segments_json')) };
        const versions = loaded.get(draftId) ?? new Map<number, DraftSourceSnapshot>();
        versions.set(version, snapshot); loaded.set(draftId, versions);
      } while (resultSet.goToNextRow());
    } finally { resultSet.close(); }
    this.sourceHistory = loaded;
  }

  private replaceDraft(draft: Draft): void {
    const snapshot = cloneDraft(draft);
    const index = this.drafts.findIndex((item: Draft) => item.id === snapshot.id);
    if (index >= 0) this.drafts[index] = snapshot;
    else this.drafts.push(snapshot);
    if (snapshot.deleted) this.sourceHistory.delete(snapshot.id);
    if (!snapshot.deleted && snapshot.version > 0) {
      const versions = this.sourceHistory.get(snapshot.id) ?? new Map<number, DraftSourceSnapshot>();
      versions.set(snapshot.version, { code: snapshot.code, ideaSegments: snapshot.ideaSegments.map((segment: IdeaSegment) =>
        new IdeaSegment(segment.id, segment.content, segment.position)) });
      this.sourceHistory.set(snapshot.id, versions);
    }
    this.enqueue(async () => this.persistDraft(snapshot));
  }

  private async applyServerAIRecord(payload: AIArtifactPayload | ReviewResultPayload, entityType: string): Promise<void> {
    const draft = this.drafts.find((item: Draft) => item.id === payload.draft_id && !item.deleted);
    if (draft === undefined) throw new Error('AI_SOURCE_DRAFT_NOT_FOUND');
    const source = this.sourceHistory.get(payload.draft_id)?.get(payload.source_draft_version);
    const sourceDraft = source === undefined ? draft : cloneDraftWithSource(draft, source);
    const record = syncPayloadToRecord(payload, entityType, sourceDraft);
    await new RdbAIResultRepository(this.requireStore(), false).save(record, true);
  }

  private queueOperation(draft: Draft, operationType: SyncOperationType): void {
    const existing = this.operations.find((operation: SyncOperation) => operation.entity_id === draft.id);
    const operation = new SyncOperation();
    operation.operation_id = existing !== undefined && existing.operation_id.trim().length > 0 && !this.inFlight.includes(existing.operation_id)
      ? existing.operation_id : createOperationId();
    operation.entity_id = draft.id;
    operation.operation_type = operationType;
    operation.base_version = existing?.base_version ?? draft.version;
    operation.client_id = this.clientId;
    operation.occurred_at = new Date().toISOString();
    operation.payload = draftToPayload(draft);
    this.operations = this.operations.filter((item: SyncOperation) => item.entity_id !== draft.id);
    this.operations.push(operation);
    if (existing !== undefined && existing.operation_id !== operation.operation_id) {
      this.enqueue(async () => this.deleteOperation(existing.operation_id));
    }
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
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await action();
    }).catch((error: Error) => {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] RDB write failed. Cause: %{public}s', error.message);
      this.writeErrors.push(error);
    });
  }

  private async persistDraft(draft: Draft): Promise<void> {
    const store = this.requireStore();
    const transactional = typeof store.beginTransaction === 'function';
    if (transactional) store.beginTransaction();
    try {
      const legacyArtifacts = await readLegacyArtifactJson(store, draft.id);
      if (legacyArtifacts === undefined) {
      await store.executeSql('INSERT OR REPLACE INTO drafts (' +
        'id, workspace_id, title, idea, code, short_code, rewrite, version, created_at, updated_at, deleted, ' +
        'last_modified_client_id, sync_status, ai_mode, artifact_hidden, idea_segments_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          draft.id, draft.workspaceId, draft.title, draft.idea, draft.code, draft.shortCode, draft.rewrite,
          draft.version, draft.createdAt, draft.updatedAt, draft.deleted ? 1 : 0, draft.lastModifiedClientId,
          draft.syncStatus, draft.aiMode, draft.artifactHidden ? 1 : 0, JSON.stringify(draft.ideaSegments)
        ]);
      } else {
      // PR #23 v2 used this column for embedded artifacts. Preserve its raw
      // value until an explicit, reviewed conversion path is available.
      await store.executeSql('INSERT OR REPLACE INTO drafts (' +
        'id, workspace_id, title, idea, code, short_code, rewrite, version, created_at, updated_at, deleted, ' +
        'last_modified_client_id, sync_status, ai_mode, artifact_hidden, ai_artifacts_json, idea_segments_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          draft.id, draft.workspaceId, draft.title, draft.idea, draft.code, draft.shortCode, draft.rewrite,
          draft.version, draft.createdAt, draft.updatedAt, draft.deleted ? 1 : 0, draft.lastModifiedClientId,
          draft.syncStatus, draft.aiMode, draft.artifactHidden ? 1 : 0, legacyArtifacts, JSON.stringify(draft.ideaSegments)
        ]);
      }
      if (!draft.deleted && draft.version > 0) {
      await store.executeSql('INSERT OR REPLACE INTO draft_source_history (draft_id, version, code, idea_segments_json) VALUES (?, ?, ?, ?)',
        [draft.id, draft.version, draft.code, JSON.stringify(draft.ideaSegments)]);
      }
      if (draft.deleted) {
      await store.executeSql('DELETE FROM ai_results WHERE draft_id = ?', [draft.id]);
      await store.executeSql('DELETE FROM ai_result_history WHERE draft_id = ?', [draft.id]);
      await store.executeSql('DELETE FROM draft_source_history WHERE draft_id = ?', [draft.id]);
      }
      if (transactional) store.commit();
    } catch (error) {
      if (transactional) store.rollBack();
      throw new Error(error instanceof Error ? error.message : '草稿写入失败');
    }
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
      [record.id, record.entity_type || SyncEntityType.DRAFT, record.entity_id, record.local_copy_id, JSON.stringify(record.server_entity), record.created_at,
        record.resolved ? 1 : 0]);
  }

  private requireStore(): relationalStore.RdbStore {
    if (this.store === undefined) throw new Error('RDB repository is not initialized');
    if (this.store.version !== DATABASE_VERSION) throw new Error('Unsupported database version');
    return this.store;
  }
}

async function ensureConflictEntityType(store: relationalStore.RdbStore): Promise<void> {
  if (typeof store.querySql !== 'function') return;
  const columns = await store.querySql('PRAGMA table_info(conflicts)');
  let found = false;
  try {
    if (columns.goToFirstRow()) do {
      if (columns.getString(columns.getColumnIndex('name')) === 'entity_type') found = true;
    } while (columns.goToNextRow());
  } finally { columns.close(); }
  if (!found) await store.executeSql("ALTER TABLE conflicts ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'draft'");
}

async function ensureTable(store: relationalStore.RdbStore, table: string, createSql: string, requiredColumns: string[]): Promise<void> {
  if (typeof store.querySql === 'function') {
    const rows = await store.querySql(`PRAGMA table_info(${table})`);
    const columns: string[] = [];
    try {
      if (rows.goToFirstRow()) do {
        columns.push(rows.getString(rows.getColumnIndex('name')));
      } while (rows.goToNextRow());
    } finally { rows.close(); }
    if (columns.length > 0) {
      if (!requiredColumns.every((column: string) => columns.includes(column))) {
        throw new Error(`Unsupported ${table} schema`);
      }
      return;
    }
  }
  await store.executeSql(createSql);
}

async function readLegacyArtifactJson(store: relationalStore.RdbStore, draftId: string): Promise<string | undefined> {
  if (typeof store.querySql !== 'function') return undefined;
  let rows: relationalStore.ResultSet;
  try { rows = await store.querySql('SELECT ai_artifacts_json FROM drafts WHERE id = ?', [draftId]); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/no such column|unknown column|not found/i.test(message)) throw new Error(message || '读取旧 AI 结果失败');
    return undefined;
  }
  try {
    if (!rows.goToFirstRow()) return undefined;
    return rows.getString(rows.getColumnIndex('ai_artifacts_json'));
  } finally { rows.close(); }
}

function readString(resultSet: relationalStore.ResultSet, column: string): string {
  return resultSet.getString(resultSet.getColumnIndex(column));
}

function readLegacyArtifacts(resultSet: relationalStore.ResultSet): AIArtifact[] {
  let column = -1;
  try { column = resultSet.getColumnIndex('ai_artifacts_json'); } catch (error) { return []; }
  if (column < 0) return [];
  const raw = resultSet.getString(column);
  if (raw.length === 0) return [];
  const values = JSON.parse(raw) as Array<Record<string, Object>>;
  if (!Array.isArray(values)) throw new Error('旧 AI 结果格式损坏，请保留数据库并重试');
  const artifacts: AIArtifact[] = [];
  for (const value of values) {
    if (value === null || typeof value !== 'object' || typeof value['mode'] !== 'string' ||
      typeof value['source_draft_version'] !== 'number' || !Number.isInteger(value['source_draft_version']) ||
      typeof value['model_id'] !== 'string' || (value['model_id'] as string).length === 0 ||
      typeof value['rule_version'] !== 'string' || (value['rule_version'] as string).length === 0 ||
      (value['source_draft_version'] as number) < 0 ||
      !Array.isArray(value['pseudocode']) || !Array.isArray(value['code_mappings'])) {
      throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
    }
    if (![AIMode.FAITHFUL_TRANSFORM, AIMode.FEASIBILITY_ANALYSIS, AIMode.PROGRESSIVE_HINT, AIMode.FULL_SOLUTION].includes(value['mode'] as AIMode)) {
      throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
    }
    const mode = parseAIMode(String(value['mode']));
    if (value['output_kind'] !== AIOutputKind.PSEUDOCODE && value['output_kind'] !== AIOutputKind.CODE_SNIPPET ||
      value['visibility'] !== AIVisibility.VISIBLE && value['visibility'] !== AIVisibility.HIDDEN) {
      throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
    }
    const outputKind = value['output_kind'] as AIOutputKind;
    const visibility = value['visibility'] as AIVisibility;
    if ((value['template_id'] !== null && typeof value['template_id'] !== 'string') ||
      (typeof value['template_id'] === 'string' && (value['template_id'] as string).length === 0) ||
      outputKind === AIOutputKind.CODE_SNIPPET && (typeof value['code_snippet'] !== 'string' || (value['code_snippet'] as string).length > 4000 || /\b(?:int|signed|auto|void)\s+main\s*\(/.test(value['code_snippet'] as string))) {
      throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
    }
    if ((value['code_snippet'] !== null && typeof value['code_snippet'] !== 'string') ||
      (typeof value['code_snippet'] === 'string' && (value['code_snippet'] as string).length === 0 || typeof value['code_snippet'] === 'string' && (value['code_snippet'] as string).length > 4000) ||
      (value['template_id'] !== null && typeof value['template_id'] !== 'string') ||
      !isStringArray(value['assumptions']) || !isStringArray(value['missing_information']) ||
      !isStringArray(value['risk_flags']) || !isStringArray(value['added_algorithm_steps']) ||
      mode === AIMode.FAITHFUL_TRANSFORM && (value['added_algorithm_steps'] as Array<Object>).length > 0) {
      throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
    }
    const artifact = new AIArtifact(mode, outputKind, Number(value['source_draft_version']), String(value['model_id']), String(value['rule_version']), visibility);
    const steps = Array.isArray(value['pseudocode']) ? value['pseudocode'] as Array<Record<string, Object>> : [];
    const stepIds = new Set<string>();
    artifact.pseudocode = steps.map((entry: Record<string, Object>) => {
      if (typeof entry['id'] !== 'string' || (entry['id'] as string).length === 0 || typeof entry['step'] !== 'string' || (entry['step'] as string).length === 0 ||
        stepIds.has(entry['id'] as string) || !isStringArray(entry['source_refs']) || (entry['source_refs'] as Array<string>).length === 0) {
        throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
      }
      for (const sourceRef of entry['source_refs'] as Array<string>) {
        if (sourceRef.length === 0) throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
      }
      stepIds.add(entry['id'] as string);
      return new PseudocodeStep(entry['id'] as string, entry['step'] as string, entry['source_refs'] as Array<string>);
    });
    artifact.codeSnippet = value['code_snippet'] as string | null;
    const mappings = Array.isArray(value['code_mappings']) ? value['code_mappings'] as Array<Record<string, Object>> : [];
    if (outputKind === AIOutputKind.PSEUDOCODE && (artifact.codeSnippet !== null || mappings.length > 0) ||
      outputKind === AIOutputKind.CODE_SNIPPET && (artifact.codeSnippet === null || mappings.length === 0)) {
      throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
    }
    artifact.codeMappings = mappings.map((entry: Record<string, Object>) => {
      if (typeof entry['step_id'] !== 'string' || !stepIds.has(entry['step_id'] as string) ||
        typeof entry['start_line'] !== 'number' || !Number.isInteger(entry['start_line']) || (entry['start_line'] as number) < 1 ||
        typeof entry['end_line'] !== 'number' || !Number.isInteger(entry['end_line']) || (entry['end_line'] as number) < (entry['start_line'] as number)) {
        throw new Error('旧 AI 结果契约无效，请保留数据库并重试');
      }
      return new CodeMapping(entry['step_id'] as string, entry['start_line'] as number, entry['end_line'] as number);
    });
    artifact.assumptions = (value['assumptions'] as string[]) ?? [];
    artifact.missingInformation = (value['missing_information'] as string[]) ?? [];
    artifact.riskFlags = (value['risk_flags'] as string[]) ?? [];
    artifact.addedAlgorithmSteps = (value['added_algorithm_steps'] as string[]) ?? [];
    artifact.templateId = value['template_id'] as string | null;
    artifacts.push(artifact);
  }
  return artifacts;
}

function isStringArray(value: Object): boolean {
  return Array.isArray(value) && (value as Array<Object>).every((item: Object) => typeof item === 'string');
}

function recordToSyncPayload(record: IDERecord, clientId: string, entityType: string): AIArtifactPayload | ReviewResultPayload {
  const value = JSON.parse(record.body) as Record<string, Object>;
  if (entityType === SyncEntityType.REVIEW_RESULT) {
    const payload = new ReviewResultPayload();
    payload.id = record.id; payload.version = record.serverVersion; payload.server_sequence = record.serverSequence;
    payload.created_at = record.createdAt.length > 0 ? record.createdAt : record.updatedAt; payload.updated_at = record.updatedAt; payload.deleted = false;
    payload.last_modified_client_id = clientId; payload.draft_id = record.context.draftId;
    payload.mode = record.context.mode; payload.source_draft_version = record.context.version;
    payload.model_id = String(value['model_id']); payload.rule_version = String(value['rule_version']);
    payload.review_kind = record.reviewKind; payload.diagnostics = value['diagnostics'] as ReviewDiagnosticPayload[];
    payload.visibility = String(value['visibility']); payload.freshness = record.stale ? 'stale' : 'current';
    return payload;
  }
  const payload = new AIArtifactPayload();
  payload.id = record.id; payload.version = record.serverVersion; payload.server_sequence = record.serverSequence;
  payload.created_at = record.updatedAt; payload.updated_at = record.updatedAt; payload.deleted = false;
  payload.last_modified_client_id = clientId; payload.draft_id = record.context.draftId;
  payload.mode = record.context.mode; payload.pseudocode = value['pseudocode'] as Object[];
  payload.code_snippet = value['code_snippet'] as string | null; payload.code_mappings = value['code_mappings'] as Object[];
  payload.assumptions = value['assumptions'] as string[]; payload.missing_information = value['missing_information'] as string[];
  payload.risk_flags = value['risk_flags'] as string[]; payload.added_algorithm_steps = value['added_algorithm_steps'] as string[];
  payload.source_draft_version = record.context.version; payload.model_id = String(value['model_id']);
  payload.rule_version = String(value['rule_version']); payload.output_kind = String(value['output_kind']);
  payload.visibility = String(value['visibility']); payload.template_id = value['template_id'] as string | null;
  return payload;
}

function syncPayloadToRecord(payload: AIArtifactPayload | ReviewResultPayload, entityType: string, draft: Draft): IDERecord {
  const record = new IDERecord();
  record.id = payload.id; record.context.draftId = payload.draft_id; record.context.version = payload.source_draft_version;
  record.context.file = 'main.cpp'; record.context.mode = parseMode(payload.mode); record.context.code = draft.code;
  record.context.idea = draft.idea; record.context.problemContext = draft.title || '当前草稿';
  record.context.segments = draft.ideaSegments.map((segment: IdeaSegment): AIRequestSegment => new AIRequestSegment(segment.id, segment.content));
  record.context.syncStatus = draft.syncStatus; record.capability = entityType === SyncEntityType.REVIEW_RESULT ? IDECapability.REVIEW : IDECapability.TRANSFORM;
  record.reviewKind = entityType === SyncEntityType.REVIEW_RESULT ? parseReviewKind((payload as ReviewResultPayload).review_kind) : ReviewKind.EXPLANATION;
  record.state = IDEState.SUCCESS; record.serverVersion = payload.version; record.serverSequence = payload.server_sequence;
  record.syncEntityType = entityType; record.createdAt = payload.created_at; record.updatedAt = payload.updated_at; record.restored = true;
  if (entityType === SyncEntityType.REVIEW_RESULT) {
    const review = payload as ReviewResultPayload;
    record.body = JSON.stringify({ mode: review.mode, source_draft_version: review.source_draft_version, model_id: review.model_id,
      rule_version: review.rule_version, review_kind: review.review_kind, output_kind: 'review', diagnostics: review.diagnostics,
      visibility: review.visibility });
    record.stale = review.freshness === 'stale';
  } else {
    const artifact = payload as AIArtifactPayload;
    record.body = JSON.stringify({ mode: artifact.mode, pseudocode: artifact.pseudocode, code_snippet: artifact.code_snippet,
      code_mappings: artifact.code_mappings, assumptions: artifact.assumptions, missing_information: artifact.missing_information,
      risk_flags: artifact.risk_flags, added_algorithm_steps: artifact.added_algorithm_steps, source_draft_version: artifact.source_draft_version,
      model_id: artifact.model_id, rule_version: artifact.rule_version, output_kind: artifact.output_kind, visibility: artifact.visibility,
      template_id: artifact.template_id });
    record.stale = false;
  }
  return record;
}

function parseMode(value: string): AIMode {
  if (value === AIMode.FEASIBILITY_ANALYSIS) return AIMode.FEASIBILITY_ANALYSIS;
  if (value === AIMode.PROGRESSIVE_HINT) return AIMode.PROGRESSIVE_HINT;
  if (value === AIMode.FULL_SOLUTION) return AIMode.FULL_SOLUTION;
  return AIMode.FAITHFUL_TRANSFORM;
}

function parseReviewKind(value: string): ReviewKind {
  if (value === 'explanation') return ReviewKind.EXPLANATION;
  if (value === 'complexity') return ReviewKind.COMPLEXITY;
  return ReviewKind.RISK;
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
  snapshot.aiArtifacts = draft.aiArtifacts.map((artifact: AIArtifact) => artifact.clone());
  return snapshot;
}

function cloneDraftWithSource(draft: Draft, source: DraftSourceSnapshot): Draft {
  const copy = cloneDraft(draft);
  copy.code = source.code;
  copy.ideaSegments = source.ideaSegments.map((segment: IdeaSegment) => new IdeaSegment(segment.id, segment.content, segment.position));
  copy.idea = source.ideaSegments.map((segment: IdeaSegment) => segment.content).join('\n');
  return copy;
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

function normalizeAIBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_AI_BASE_URL;
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
