import { SyncRepository } from '../domain/SyncRepository';
import { Draft, SyncStatus } from '../domain/Models';
import { AIArtifactPayload, ConflictRecord, DraftPayload, PullChange, ReviewResultPayload, SyncEntityType, SyncErrorCode,
  SyncResultStatus, payloadToDraft } from '../domain/SyncModels';
import { IDERecord } from '../domain/IDEAIModels';
import { HttpSyncClient, SYNC_AUTH_REJECTED } from './HttpSyncClient';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';

export enum SyncRunStatus {
  SYNCED = 'synced',
  LOCAL_ONLY = 'local_only',
  CONFLICT = 'conflict',
  FAILED = 'failed'
}

export const SYNC_NOT_PAIRED_MESSAGE: string = '还没有连接电脑，草稿只保存在本机。请在「设置 → 连接电脑」扫码配对后再同步';
const SYNC_AUTH_MESSAGE: string = '这台手机的连接已失效，请在「设置 → 连接电脑」重新扫码配对；本机草稿和未同步的修改都已保留';

export class SyncRunResult {
  status: SyncRunStatus;
  message: string;
  // The server rejected the device token; the caller drops it and asks the
  // user to pair again. Drafts, the queue and the cursor are untouched.
  authRequired: boolean;

  constructor(status: SyncRunStatus, message: string, authRequired: boolean = false) {
    this.status = status;
    this.message = message;
    this.authRequired = authRequired;
  }
}

export class PhoneSyncService {
  private repository: SyncRepository;
  private deviceToken: string;

  constructor(repository: SyncRepository, deviceToken: string) {
    this.repository = repository;
    this.deviceToken = deviceToken;
  }

  async synchronize(): Promise<SyncRunResult> {
    // Without a token every request would be rejected; nothing leaves the phone.
    if (this.deviceToken.length === 0) return new SyncRunResult(SyncRunStatus.LOCAL_ONLY, SYNC_NOT_PAIRED_MESSAGE);
    const pending = this.repository.listPendingOperations();
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Sync run started. pending=%{public}s cursor=%{public}s',
      pending.length.toString(), safeLogValue(this.repository.getCursor()));
    for (const operation of pending) if (entityType(operation.entity_type) === SyncEntityType.DRAFT) this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.SYNCING);
    const client = new HttpSyncClient(this.repository.getBaseUrl(), this.deviceToken);
    const epoch = this.repository.getServerEpoch?.() ?? '';
    let hadConflict = false;
    for (const queued of pending) {
      let operation = queued;
      try {
        this.repository.markInFlight(operation.operation_id);
        let result = await client.push(operation, epoch);
        // The server restarted and no longer has this draft: its base_version
        // belongs to a lost lineage, so re-create it (version 0) and retry once.
        if (result.status === SyncResultStatus.CONFLICT && result.error_code === SyncErrorCode.EPOCH_MISMATCH &&
          (result.server_entity === undefined || result.server_entity === null) &&
          entityType(operation.entity_type) === SyncEntityType.DRAFT && this.repository.rebaseDraftForNewServer !== undefined) {
          this.repository.rebaseDraftForNewServer(operation.entity_id);
          const rebased = this.repository.listPendingOperations().find(item => item.entity_id === queued.entity_id);
          if (rebased !== undefined) {
            hilog.warn(DOMAIN, TAG, '[AlgoFlow] Sync epoch changed; re-creating draft. entity_id=%{public}s',
              safeLogValue(rebased.entity_id));
            operation = rebased;
            this.repository.markInFlight(operation.operation_id);
            result = await client.push(operation, epoch);
          }
        }
        const current = operation;
        const newer = this.repository.listPendingOperations().find(item => item.entity_id === current.entity_id && item.operation_id !== current.operation_id);
        if (newer !== undefined) {
          this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.LOCAL_ONLY);
          return new SyncRunResult(SyncRunStatus.LOCAL_ONLY, '同步期间产生新编辑，已保留本地内容；再次同步时进行版本检查');
        }
        hilog.info(DOMAIN, TAG,
          '[AlgoFlow] Sync operation result. entity_id=%{public}s server_version=%{public}s status=%{public}s',
          safeLogValue(operation.entity_id), result.version?.toString() ?? 'none', result.status);
        if (result.status === SyncResultStatus.CONFLICT) {
          if (result.server_entity === undefined || result.server_entity === null) {
            this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
            return new SyncRunResult(SyncRunStatus.FAILED, '服务器未返回冲突版本');
          }
          if (entityType(operation.entity_type) === SyncEntityType.DRAFT) {
            this.recordConflict(operation.entity_id, operation.payload as DraftPayload, result.server_entity as DraftPayload);
          } else {
            await this.recordAIConflict(operation.entity_type, operation.entity_id, result.server_entity);
          }
          this.repository.removeOperation(operation.operation_id);
          hadConflict = true;
          continue;
        }
        if (result.status !== SyncResultStatus.APPLIED && result.status !== SyncResultStatus.DUPLICATE) {
          this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
          return new SyncRunResult(SyncRunStatus.FAILED, result.error_code ?? '同步操作被拒绝');
        }
        // A duplicate without the stored server entity cannot prove the edit
        // reached the server; never fall back to the local payload for it.
        if (result.status === SyncResultStatus.DUPLICATE &&
          (result.server_entity === undefined || result.server_entity === null)) {
          this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
          return new SyncRunResult(SyncRunStatus.FAILED, '服务器未返回已提交版本，本地修改已保留');
        }
        const serverPayload = result.server_entity ?? operation.payload;
        if (entityType(operation.entity_type) === SyncEntityType.AI_ARTIFACT) {
          await this.repository.applyServerAIArtifact(serverPayload as AIArtifactPayload);
        } else if (entityType(operation.entity_type) === SyncEntityType.REVIEW_RESULT) {
          await this.repository.applyServerReview(serverPayload as ReviewResultPayload);
        } else {
          this.repository.applyServerDraft(payloadToDraft(serverPayload as DraftPayload));
        }
        this.repository.removeOperation(operation.operation_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : '网络请求失败';
        // The server permanently rejects an AI result whose source Draft
        // version it no longer has (for example after a sync-api restart).
        // Retrying can never succeed and would block every later operation and
        // the rebase pull, so the upload is abandoned; the result stays local.
        if (isPermanentAIResultRejection(entityType(operation.entity_type), message)) {
          hilog.warn(DOMAIN, TAG, '[AlgoFlow] Sync dropped a rejected AI result. entity_type=%{public}s operation_id=%{public}s',
            entityType(operation.entity_type), safeLogValue(operation.operation_id));
          this.repository.removeOperation(operation.operation_id);
          continue;
        }
        this.markPendingFailed();
        hilog.error(DOMAIN, TAG,
          '[AlgoFlow] Sync push phase failed. operation_id=%{public}s cause=%{public}s',
          safeLogValue(operation.operation_id), safeLogValue(message));
        return failure(message);
      }
    }

    try {
      // A cursor without a stored epoch (installed before the epoch contract)
      // cannot be trusted across a possible restart: replay from 0 once.
      const cursor = epoch.length === 0 && this.repository.getCursor() !== '0' ? '0' : this.repository.getCursor();
      const pull = await client.pull(cursor, epoch);
      // Only a server that reports an epoch can confirm a reset; an older
      // server without one keeps the previous merge behaviour.
      const hasEpoch = pull.server_epoch !== undefined && pull.server_epoch.length > 0;
      const reset = hasEpoch && (pull.reset === true || (epoch.length === 0 && cursor !== this.repository.getCursor()));
      if (reset) {
        hilog.warn(DOMAIN, TAG, '[AlgoFlow] Sync server epoch changed; rebasing local state. changes=%{public}s',
          pull.changes.length.toString());
        await this.applyResetChanges(pull.changes);
      } else {
        await this.applyPulledChanges(pull.changes);
      }
      await this.repository.flush();
      await this.repository.commitCursor(pull.next_cursor, pull.server_epoch);
    } catch (error) {
      this.markPendingFailed();
      const message = error instanceof Error ? error.message : '拉取变更失败';
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Sync pull phase failed. cause=%{public}s', safeLogValue(message));
      return failure(message);
    }
    if (hadConflict) {
      hilog.warn(DOMAIN, TAG, '[AlgoFlow] Sync run completed with conflict.');
      return new SyncRunResult(SyncRunStatus.CONFLICT, '已保留服务器版本和本地冲突副本');
    }
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Sync run completed. remaining=%{public}s cursor=%{public}s',
      this.repository.listPendingOperations().length.toString(), safeLogValue(this.repository.getCursor()));
    return new SyncRunResult(this.repository.listPendingOperations().length === 0 ? SyncRunStatus.SYNCED : SyncRunStatus.LOCAL_ONLY,
      '同步完成');
  }

  // Versions from the old lineage are not comparable with the server's, so the
  // latest server copy of each entity wins unless a local edit is still queued.
  // Live drafts the server no longer has are re-created so their content is not
  // lost. Local-only AI results stay readable; they cannot be re-uploaded
  // because their source draft versions do not exist on the new server.
  private async applyResetChanges(changes: PullChange[]): Promise<void> {
    const latest = new Map<string, PullChange>();
    for (const change of changes) latest.set(`${entityType(change.entity_type)}:${change.entity.id}`, change);
    let applied = 0;
    for (const change of latest.values()) {
      const type = entityType(change.entity_type);
      if (this.repository.hasPendingOperation(change.entity.id)) continue;
      if (type === SyncEntityType.DRAFT) {
        this.repository.applyServerDraft(payloadToDraft(change.entity as DraftPayload));
      } else if (type === SyncEntityType.AI_ARTIFACT) {
        await this.repository.applyServerAIArtifact(change.entity as AIArtifactPayload);
      } else if (type === SyncEntityType.REVIEW_RESULT) {
        await this.repository.applyServerReview(change.entity as ReviewResultPayload);
      } else {
        continue;
      }
      applied += 1;
    }
    let recreated = 0;
    for (const id of this.repository.listDraftIds?.() ?? []) {
      if (latest.has(`${SyncEntityType.DRAFT}:${id}`) || this.repository.hasPendingOperation(id)) continue;
      const local = this.repository.getDraft(id);
      if (local === undefined || local.deleted || local.version === 0) continue;
      this.repository.rebaseDraftForNewServer?.(id);
      recreated += 1;
    }
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Sync reset merge completed. applied=%{public}s recreated=%{public}s',
      applied.toString(), recreated.toString());
  }

  private async applyPulledChanges(changes: PullChange[]): Promise<void> {
    let applied = 0;
    let skipped = 0;
    for (const change of changes) {
      if (entityType(change.entity_type) === SyncEntityType.AI_ARTIFACT || entityType(change.entity_type) === SyncEntityType.REVIEW_RESULT) {
        const remote = change.entity as AIArtifactPayload | ReviewResultPayload;
        if (remote.last_modified_client_id === this.repository.getClientId()) { skipped += 1; continue; }
        const local = await this.repository.getAIRecord(remote.id);
        if (this.repository.hasPendingOperation(remote.id) || (local !== undefined && remote.version < local.serverVersion)) { skipped += 1; continue; }
        if (entityType(change.entity_type) === SyncEntityType.AI_ARTIFACT) await this.repository.applyServerAIArtifact(remote as AIArtifactPayload);
        else await this.repository.applyServerReview(remote as ReviewResultPayload);
        applied += 1;
        continue;
      }
      const type = entityType(change.entity_type);
      if (type !== SyncEntityType.DRAFT) {
        skipped += 1;
        continue;
      }
      if (change.entity.last_modified_client_id === this.repository.getClientId()) {
        skipped += 1;
        continue;
      }
      if (this.repository.hasPendingOperation(change.entity.id)) {
        skipped += 1;
        continue;
      }
      const local = this.repository.getDraft(change.entity.id);
      if (local !== undefined && change.entity.version < local.version) {
        skipped += 1;
        continue;
      }
      const remoteDraft: DraftPayload = change.entity as DraftPayload;
      this.repository.applyServerDraft(payloadToDraft(remoteDraft));
      applied += 1;
      hilog.info(DOMAIN, TAG,
        '[AlgoFlow] Sync pull applied. entity_id=%{public}s server_version=%{public}s',
        safeLogValue(remoteDraft.id), remoteDraft.version.toString());
    }
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Sync pull merge completed. applied=%{public}s skipped=%{public}s',
      applied.toString(), skipped.toString());
  }

  private recordConflict(entityId: string, localPayload: DraftPayload, serverPayload: DraftPayload): void {
    const local = payloadToDraft(localPayload);
    const copy = payloadToDraft(localPayload);
    copy.id = `${local.id}-conflict-${util.generateRandomUUID()}`;
    copy.title = `${local.title}（冲突副本）`;
    copy.version = 0;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    copy.lastModifiedClientId = this.repository.getClientId();
    copy.syncStatus = SyncStatus.CONFLICT;
    const record = new ConflictRecord();
    record.id = util.generateRandomUUID();
    record.entity_id = entityId;
    record.local_copy_id = copy.id;
    record.server_entity = serverPayload;
    record.created_at = new Date().toISOString();
    this.repository.applyServerDraft(payloadToDraft(serverPayload));
    this.repository.saveConflictDraft(copy, record);
  }

  private markPendingFailed(): void {
    for (const operation of this.repository.listPendingOperations()) {
      if (entityType(operation.entity_type) === SyncEntityType.DRAFT) this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
    }
  }

  private async recordAIConflict(entityType: string, entityId: string, serverEntity: Object | null | undefined): Promise<void> {
    if (serverEntity === undefined || serverEntity === null) throw new Error('服务器未返回 AI 结果冲突版本');
    const local = await this.repository.getAIRecord(entityId);
    if (local === undefined) throw new Error('AI_CONFLICT_COPY_NOT_FOUND');
    const copy = JSON.parse(JSON.stringify(local)) as IDERecord;
    copy.id = `${local.id}-conflict-${util.generateRandomUUID()}`;
    copy.serverVersion = 0; copy.serverSequence = 0; copy.restored = false;
    const record = new ConflictRecord(); record.id = util.generateRandomUUID(); record.entity_type = entityType;
    record.entity_id = entityId; record.local_copy_id = copy.id; record.server_entity = serverEntity as AIArtifactPayload | ReviewResultPayload;
    record.created_at = new Date().toISOString();
    if (entityType === SyncEntityType.AI_ARTIFACT) await this.repository.applyServerAIArtifact(serverEntity as AIArtifactPayload);
    else await this.repository.applyServerReview(serverEntity as ReviewResultPayload);
    await this.repository.saveConflictAIRecord(copy, record);
  }
}

// Turns the sync client's internal codes into text the user can act on; the
// local draft and queue are untouched by a failed run. debug keeps the
// advice about running sync-api yourself and shows unknown codes as they are.
export function syncMessageText(message: string, debug: boolean): string {
  if (message.startsWith('SYNC_NETWORK_')) {
    return debug ? '连不上同步端点：需自行运行 sync-api 并在「设置 → 连接电脑」配对，草稿已保留在本机'
      : '连不上同步服务，请检查网络后重试；草稿已保留在本机';
  }
  if (message.startsWith('SYNC_HTTP_429')) return '同步请求过于频繁，请稍后再试；草稿已保留在本机';
  // Retrying does not help here; the workspace has to shrink first.
  if (message.startsWith('SYNC_HTTP_507')) return '云端空间已满，新的修改没有上传：删除不需要的草稿后再同步；草稿已保留在本机';
  if (message.startsWith('SYNC_HTTP_5')) return '同步服务器暂时出错，草稿已保留在本机，稍后重试';
  if (message.startsWith('SYNC_HTTP_') || message.startsWith('SYNC_CONTRACT_') || message === 'SYNC_INVALID_RESPONSE') {
    return debug ? '同步端点返回了无法识别的内容，请确认地址指向本应用的 sync-api 同步服务'
      : '同步服务返回了无法识别的内容，草稿已保留在本机，请稍后重试';
  }
  // Rejection codes from the server and exception text from the platform are
  // not meant for users; every message written for them is Chinese.
  if (!debug && !/[\u4e00-\u9fff]/.test(message)) return '同步没有完成，草稿已保留在本机，请稍后重试';
  return message;
}

function failure(message: string): SyncRunResult {
  if (message === SYNC_AUTH_REJECTED) return new SyncRunResult(SyncRunStatus.FAILED, SYNC_AUTH_MESSAGE, true);
  return new SyncRunResult(SyncRunStatus.FAILED, message);
}

function safeLogValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').substring(0, 96);
}

// HttpSyncClient reports a 4xx as SYNC_HTTP_<status>_<error_code>.
function isPermanentAIResultRejection(type: string, message: string): boolean {
  return (type === SyncEntityType.AI_ARTIFACT && message === 'SYNC_HTTP_422_INVALID_AI_ARTIFACT') ||
    (type === SyncEntityType.REVIEW_RESULT && message === 'SYNC_HTTP_400_INVALID_REVIEW_RESULT');
}

function entityType(value: string | undefined): string {
  return value === undefined || value.length === 0 ? SyncEntityType.DRAFT : value;
}
