import { SyncRepository } from '../domain/SyncRepository';
import { Draft, SyncStatus } from '../domain/Models';
import { ConflictRecord, DraftPayload, PullChange, SyncResultStatus, payloadToDraft } from '../domain/SyncModels';
import { HttpSyncClient } from './HttpSyncClient';
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

export class SyncRunResult {
  status: SyncRunStatus;
  message: string;

  constructor(status: SyncRunStatus, message: string) {
    this.status = status;
    this.message = message;
  }
}

export class PhoneSyncService {
  private repository: SyncRepository;

  constructor(repository: SyncRepository) {
    this.repository = repository;
  }

  async synchronize(): Promise<SyncRunResult> {
    const pending = this.repository.listPendingOperations();
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Sync run started. pending=%{public}s cursor=%{public}s',
      pending.length.toString(), safeLogValue(this.repository.getCursor()));
    for (const operation of pending) this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.SYNCING);
    const client = new HttpSyncClient(this.repository.getBaseUrl());
    let hadConflict = false;
    for (const operation of pending) {
      try {
        const result = await client.push(operation);
        hilog.info(DOMAIN, TAG,
          '[AlgoFlow] Sync operation result. entity_id=%{public}s server_version=%{public}s status=%{public}s',
          safeLogValue(operation.entity_id), result.version?.toString() ?? 'none', result.status);
        if (result.status === SyncResultStatus.CONFLICT) {
          if (result.server_entity === undefined || result.server_entity === null) {
            this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
            return new SyncRunResult(SyncRunStatus.FAILED, '服务器未返回冲突版本');
          }
          this.recordConflict(operation.entity_id, operation.payload, result.server_entity);
          this.repository.removeOperation(operation.operation_id);
          hadConflict = true;
          continue;
        }
        if (result.status !== SyncResultStatus.APPLIED && result.status !== SyncResultStatus.DUPLICATE) {
          this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
          return new SyncRunResult(SyncRunStatus.FAILED, result.error_code ?? '同步操作被拒绝');
        }
        const serverPayload = result.server_entity ?? operation.payload;
        this.repository.applyServerDraft(payloadToDraft(serverPayload));
        this.repository.removeOperation(operation.operation_id);
      } catch (error) {
        this.markPendingFailed();
        const message = error instanceof Error ? error.message : '网络请求失败';
        hilog.error(DOMAIN, TAG,
          '[AlgoFlow] Sync push phase failed. operation_id=%{public}s cause=%{public}s',
          safeLogValue(operation.operation_id), safeLogValue(message));
        return new SyncRunResult(SyncRunStatus.FAILED, message);
      }
    }

    try {
      const pull = await client.pull(this.repository.getCursor());
      this.applyPulledChanges(pull.changes);
      this.repository.setCursor(pull.next_cursor);
    } catch (error) {
      this.markPendingFailed();
      const message = error instanceof Error ? error.message : '拉取变更失败';
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Sync pull phase failed. cause=%{public}s', safeLogValue(message));
      return new SyncRunResult(SyncRunStatus.FAILED, message);
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

  private applyPulledChanges(changes: PullChange[]): void {
    let applied = 0;
    let skipped = 0;
    for (const change of changes) {
      if (change.entity_type !== 'draft') {
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
      this.repository.applyServerDraft(payloadToDraft(change.entity));
      applied += 1;
      hilog.info(DOMAIN, TAG,
        '[AlgoFlow] Sync pull applied. entity_id=%{public}s server_version=%{public}s',
        safeLogValue(change.entity.id), change.entity.version.toString());
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
      this.repository.setDraftSyncStatus(operation.entity_id, SyncStatus.FAILED);
    }
  }
}

function safeLogValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').substring(0, 96);
}
