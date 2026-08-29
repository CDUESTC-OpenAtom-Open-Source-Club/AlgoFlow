import { hilog } from '@kit.PerformanceAnalysisKit';
import { DraftRepository } from '../domain/DraftRepository';
import {
  AIMode,
  CodeDocument,
  CodeLanguage,
  CodeOrigin,
  ConflictRecord,
  ConflictResolution,
  Draft,
  DraftPayload,
  EntityType,
  IdeaSegment,
  OperationType,
  SyncOperation,
  SyncStatus
} from '../domain/Models';
import { AIProvider, AIProviderState, AIRequest, AIRequestSegment, AIResult } from '../domain/AIProvider';
import { SyncPort, SyncResult, SyncResultStatus } from '../domain/SyncPort';
import { AIContractGuard } from '../domain/AIContractGuard';
import { IdeaSegmentSplitter } from '../domain/IdeaSegmentSplitter';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const RULE_VERSION = '1.0.0';
const DEFAULT_WORKSPACE = 'local-workspace';

/**
 * 草稿工作区用例编排（应用层）。
 *
 * 依赖方向：UI -> ViewModel -> Repository / AIProvider / SyncPort。
 * 页面不得直接调用 RDB、网络或 AI SDK；本层负责模式隔离、来源映射、同步状态机与冲突副本。
 */
export class DraftWorkspaceViewModel {
  private repository: DraftRepository;
  private aiProvider: AIProvider;
  private syncPort: SyncPort;
  private clientId: string;
  private sequence: number = 1;
  private pendingOps: SyncOperation[] = [];
  private aiToken: number = 0;
  private syncToken: number = 0;

  // 供 UI 读取的瞬时状态（非持久）
  aiLoading: boolean = false;
  syncRunning: boolean = false;
  lastInfo: string = '';
  lastError: string = '';

  constructor(repository: DraftRepository, aiProvider: AIProvider, syncPort: SyncPort, clientId: string) {
    this.repository = repository;
    this.aiProvider = aiProvider;
    this.syncPort = syncPort;
    this.clientId = clientId;
  }

  // ————— 草稿生命周期 —————

  ensureStarterDraft(): string {
    const existing = this.repository.list();
    if (existing.length > 0) {
      return existing[0].id;
    }
    return this.createDraft();
  }

  createDraft(): string {
    const id = this.nextId('phone-draft');
    const draft = new Draft(id, '未命名思路', DEFAULT_WORKSPACE, this.clientId);
    this.repository.save(draft);
    this.enqueueUpsert(draft);
    this.logInfo(`Draft created ${id}`);
    return id;
  }

  listDrafts(): Draft[] {
    return this.repository.list();
  }

  getDraft(id: string): Draft | undefined {
    return this.repository.get(id);
  }

  deleteDraft(id: string): string {
    const before = this.repository.get(id);
    const baseVersion = before === undefined ? 0 : before.version;
    // 墓碑删除：软删除并参与同步，不物理移除
    this.repository.delete(id);
    const payload = new DraftPayload('', CodeLanguage.CPP, [], '', true);
    const op = new SyncOperation(this.nextOperationId(), EntityType.DRAFT, id,
      OperationType.DELETE, baseVersion, this.clientId, new Date().toISOString(), payload);
    this.pendingOps.push(op);
    this.logInfo(`Draft tombstoned ${id}`);
    const remaining = this.repository.list();
    return remaining.length > 0 ? remaining[0].id : this.createDraft();
  }

  // ————— 编辑（title / 思路片段 / C++ 代码 / 复写） —————

  update(id: string, title: string, idea: string, code: string, rewrite: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) {
      return;
    }
    draft.title = title;
    draft.ideaText = idea;
    draft.ideaSegments = IdeaSegmentSplitter.split(idea, draft.id, this.clientId, draft.ideaSegments);
    this.setCodeDoc(draft, CodeOrigin.USER, code);
    this.setCodeDoc(draft, CodeOrigin.USER_REWRITE, rewrite);
    this.markDirty(draft);
  }

  getUserCodeText(id: string): string {
    const draft = this.repository.get(id);
    if (draft === undefined) {
      return '';
    }
    return this.getUserCode(draft);
  }

  getRewriteText(id: string): string {
    const draft = this.repository.get(id);
    if (draft === undefined) {
      return '';
    }
    const doc = draft.codeDocuments.find((d: CodeDocument): boolean => d.origin === CodeOrigin.USER_REWRITE);
    return doc === undefined ? '' : doc.content;
  }

  toggleArtifact(id: string): void {
    const draft = this.repository.get(id);
    if (draft === undefined) {
      return;
    }
    draft.artifactHidden = !draft.artifactHidden;
    this.repository.save(draft);
  }

  // ————— AI 请求与越界校验 —————

  async requestAI(id: string, mode: AIMode): Promise<void> {
    const token = ++this.aiToken;
    const draft = this.repository.get(id);
    if (draft === undefined) {
      return;
    }
    this.aiLoading = true;
    this.lastInfo = '';
    this.lastError = '';

    const segments: AIRequestSegment[] = draft.ideaSegments.map((s: IdeaSegment): AIRequestSegment =>
      new AIRequestSegment(s.id, s.content));
    const request = new AIRequest(mode, draft.id, draft.version, draft.language, RULE_VERSION, segments);

    let result: AIResult;
    try {
      result = await this.aiProvider.generate(request);
    } catch (err) {
      this.logError(`AI request failed for ${id}: ${JSON.stringify(err)}`);
      if (token === this.aiToken) {
        this.aiLoading = false;
        this.lastError = 'AI 请求失败，请检查网络后重试';
      }
      return;
    }

    if (token !== this.aiToken) {
      return; // 已被取消或更替，丢弃过期结果
    }
    this.aiLoading = false;

    if (result.state === AIProviderState.DISABLED) {
      this.lastInfo = result.errorMessage;
      return;
    }
    const artifact = result.artifact;
    if (artifact === null) {
      this.lastError = 'AI 返回结果异常，请重试';
      return;
    }
    const validIds = draft.ideaSegments.map((s: IdeaSegment): string => s.id);
    const validation = AIContractGuard.validate(artifact, validIds);
    if (!validation.valid) {
      // 越界：拒绝保存，绝不混入用户原思路
      this.lastError = validation.reason;
      this.logError(`AI artifact rejected for ${id}: ${validation.reason}`);
      return;
    }
    // 不可变版本：追加保存，不覆盖历史
    draft.aiArtifacts.push(artifact);
    this.markDirty(draft);
    this.lastInfo = 'AI 结果已保存';
    this.logInfo(`AI artifact saved for ${id} mode ${mode}`);
  }

  cancelAI(): void {
    this.aiToken++;
    this.aiLoading = false;
  }

  // ————— 同步状态机 —————

  async syncAll(): Promise<void> {
    if (this.pendingOps.length === 0) {
      this.lastInfo = '没有待同步的更改';
      return;
    }
    const token = ++this.syncToken;
    this.syncRunning = true;
    this.lastError = '';
    const ops = this.pendingOps.slice();
    for (let i = 0; i < ops.length; i++) {
      if (token !== this.syncToken) {
        this.syncRunning = false;
        return;
      }
      const op = ops[i];
      const draft = this.repository.get(op.entityId);
      if (draft !== undefined && !draft.deleted) {
        draft.syncStatus = SyncStatus.SYNCING;
        this.repository.save(draft);
      }
      let result: SyncResult;
      try {
        result = await this.syncPort.apply(op);
      } catch (err) {
        this.logError(`Sync failed for ${op.entityId}: ${JSON.stringify(err)}`);
        this.markFailed(op.entityId);
        this.lastError = '同步失败，更改已保留在本地';
        continue;
      }
      this.handleSyncResult(op, result);
    }
    this.syncRunning = false;
    if (this.pendingOps.length === 0) {
      this.lastInfo = '同步完成';
    }
  }

  cancelSync(): void {
    this.syncToken++;
    this.syncRunning = false;
  }

  resolveConflict(draftId: string, keepServer: boolean): void {
    const records = this.repository.listConflictRecords(draftId);
    if (records.length === 0) {
      return;
    }
    const record = records[0];
    const draft = this.repository.get(draftId);
    if (draft === undefined) {
      return;
    }
    if (keepServer) {
      const server = record.serverCopy.clone();
      this.repository.save(server);
      this.removePending(draftId);
      this.logInfo(`Conflict ${draftId} resolved keep-server`);
    } else {
      // 保留本地，以服务器版本为基准重新入队（再次同步即覆盖，但经过显式用户选择）
      draft.version = record.serverVersion;
      draft.syncStatus = SyncStatus.LOCAL_ONLY;
      this.repository.save(draft);
      this.enqueueUpsert(draft);
      this.logInfo(`Conflict ${draftId} resolved keep-local`);
    }
    record.resolution = keepServer ? ConflictResolution.KEEP_SERVER : ConflictResolution.KEEP_LOCAL;
    this.lastInfo = keepServer ? '已采用服务器版本' : '已保留本地版本';
  }

  hasConflict(draftId: string): boolean {
    return this.repository.listConflictRecords(draftId).length > 0;
  }

  // ————— 内部工具 —————

  private markDirty(draft: Draft): void {
    draft.updatedAt = new Date().toISOString();
    draft.lastModifiedClientId = this.clientId;
    draft.syncStatus = SyncStatus.LOCAL_ONLY;
    this.repository.save(draft);
    this.enqueueUpsert(draft);
  }

  private enqueueUpsert(draft: Draft): void {
    this.removePending(draft.id);
    const payload = new DraftPayload(draft.title, draft.language, draft.ideaSegments.slice(),
      this.getUserCode(draft), false);
    const op = new SyncOperation(this.nextOperationId(), EntityType.DRAFT, draft.id,
      OperationType.UPSERT, draft.version, this.clientId, new Date().toISOString(), payload);
    this.pendingOps.push(op);
  }

  private handleSyncResult(op: SyncOperation, result: SyncResult): void {
    if (result.status === SyncResultStatus.APPLIED || result.status === SyncResultStatus.DUPLICATE) {
      this.removePending(op.operationId);
      const draft = this.repository.get(op.entityId);
      if (draft !== undefined) {
        draft.version = result.version;
        draft.syncStatus = SyncStatus.SYNCED;
        this.repository.save(draft);
      }
      return;
    }
    if (result.status === SyncResultStatus.CONFLICT) {
      const draft = this.repository.get(op.entityId);
      if (draft === undefined) {
        return;
      }
      const serverCopy = result.serverEntity === null ? new Draft(op.entityId, '', DEFAULT_WORKSPACE, this.clientId) : result.serverEntity;
      const record = new ConflictRecord(this.nextId('conflict'), op.entityId, op.entityType,
        serverCopy.version, draft.version, draft.clone(), serverCopy.clone());
      this.repository.saveConflictRecord(record);
      draft.syncStatus = SyncStatus.CONFLICT;
      this.repository.save(draft);
      this.lastInfo = '检测到版本冲突，已生成本地冲突副本';
      this.logInfo(`Conflict detected on ${op.entityId}, local copy created`);
      return;
    }
    // REJECTED
    this.markFailed(op.entityId);
    this.lastError = '同步请求被拒绝，请检查数据后重试';
  }

  private markFailed(draftId: string): void {
    const draft = this.repository.get(draftId);
    if (draft !== undefined) {
      draft.syncStatus = SyncStatus.FAILED;
      this.repository.save(draft);
    }
  }

  private removePending(key: string): void {
    this.pendingOps = this.pendingOps.filter((op: SyncOperation): boolean =>
      op.operationId !== key && op.entityId !== key);
  }

  private setCodeDoc(draft: Draft, origin: CodeOrigin, content: string): void {
    const index = draft.codeDocuments.findIndex((d: CodeDocument): boolean => d.origin === origin);
    if (index >= 0) {
      draft.codeDocuments[index].content = content;
      draft.codeDocuments[index].updatedAt = new Date().toISOString();
    } else {
      const doc = new CodeDocument(this.nextId('code'), draft.id, origin, content,
        draft.language, draft.version, this.clientId);
      draft.codeDocuments.push(doc);
    }
  }

  private getUserCode(draft: Draft): string {
    const doc = draft.codeDocuments.find((d: CodeDocument): boolean => d.origin === CodeOrigin.USER);
    return doc === undefined ? '' : doc.content;
  }

  private nextId(prefix: string): string {
    const id = `${prefix}-${Date.now()}-${this.sequence}`;
    this.sequence++;
    return id;
  }

  private nextOperationId(): string {
    return this.nextId('op');
  }

  private logInfo(message: string): void {
    hilog.info(DOMAIN, TAG, '[AlgoFlow] %{public}s', message);
  }

  private logError(message: string): void {
    hilog.error(DOMAIN, TAG, '[AlgoFlow] %{public}s', message);
  }
}
