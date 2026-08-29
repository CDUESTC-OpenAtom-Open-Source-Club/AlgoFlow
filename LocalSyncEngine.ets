import { SyncPort, SyncResult, SyncResultStatus } from '../domain/SyncPort';
import {
  CodeDocument,
  CodeLanguage,
  CodeOrigin,
  Draft,
  EntityType,
  OperationType,
  SyncOperation,
  SyncStatus
} from '../domain/Models';

/**
 * 本地同步协议模拟适配器（占位，非生产云服务）。
 *
 * 语义与 services/sync-api/src/sync-store.mjs 保持一致：
 *  - operation_id 幂等：重复提交返回 duplicate，不重复应用；
 *  - base_version 乐观锁：版本不匹配返回 conflict 并附服务器版本，严禁静默覆盖；
 *  - 删除以墓碑（deleted=true）参与同步。
 *
 * 本适配器仅用内存模拟服务器状态，未接入真实同步 API / 华为云；接入后替换 SyncPort 实现即可。
 */
export class LocalSyncEngine implements SyncPort {
  private serverEntities: Draft[] = [];
  private processed: string[] = [];
  private results: SyncResult[] = [];

  async apply(operation: SyncOperation): Promise<SyncResult> {
    // 幂等：重复 operation_id 直接返回上次结果
    const previous = this.findResult(operation.operationId);
    if (previous !== undefined) {
      return new SyncResult(previous.operationId, SyncResultStatus.DUPLICATE,
        previous.version, previous.serverEntity, previous.errorCode);
    }

    // 请求校验
    if (operation.operationId.length === 0 || operation.entityId.length === 0 || operation.clientId.length === 0) {
      return this.record(operation.operationId,
        new SyncResult(operation.operationId, SyncResultStatus.REJECTED, 0, null, 'INVALID_REQUEST'));
    }
    if (operation.entityType !== EntityType.DRAFT) {
      return this.record(operation.operationId,
        new SyncResult(operation.operationId, SyncResultStatus.REJECTED, 0, null, 'INVALID_REQUEST'));
    }
    if (operation.baseVersion < 0) {
      return this.record(operation.operationId,
        new SyncResult(operation.operationId, SyncResultStatus.REJECTED, 0, null, 'INVALID_REQUEST'));
    }

    const current = this.findServerEntity(operation.entityId);
    const currentVersion = current === undefined ? 0 : current.version;

    // 乐观锁冲突：返回服务器版本，绝不覆盖
    if (operation.baseVersion !== currentVersion) {
      const server = current === undefined ? null : current.clone();
      return this.record(operation.operationId,
        new SyncResult(operation.operationId, SyncResultStatus.CONFLICT, 0, server, 'VERSION_CONFLICT'));
    }

    const newVersion = currentVersion + 1;
    const applied = this.buildServerEntity(operation, current, newVersion);
    this.upsertServerEntity(applied);
    return this.record(operation.operationId,
      new SyncResult(operation.operationId, SyncResultStatus.APPLIED, newVersion, applied.clone(), ''));
  }

  private findResult(operationId: string): SyncResult | undefined {
    return this.results.find((r: SyncResult): boolean => r.operationId === operationId);
  }

  private record(operationId: string, result: SyncResult): SyncResult {
    if (this.processed.indexOf(operationId) < 0) {
      this.processed.push(operationId);
      this.results.push(result);
    }
    return result;
  }

  private findServerEntity(entityId: string): Draft | undefined {
    return this.serverEntities.find((d: Draft): boolean => d.id === entityId);
  }

  private upsertServerEntity(draft: Draft): void {
    const index = this.serverEntities.findIndex((d: Draft): boolean => d.id === draft.id);
    if (index >= 0) {
      this.serverEntities[index] = draft;
    } else {
      this.serverEntities.push(draft);
    }
  }

  private buildServerEntity(operation: SyncOperation, current: Draft | undefined, newVersion: number): Draft {
    const payload = operation.payload;
    const workspaceId = current === undefined ? '' : current.workspaceId;
    const draft = new Draft(operation.entityId, payload.title, workspaceId, operation.clientId);
    draft.language = payload.language;
    draft.version = newVersion;
    draft.updatedAt = operation.occurredAt;
    draft.deleted = operation.operationType === OperationType.DELETE || payload.deleted;
    draft.lastModifiedClientId = operation.clientId;
    draft.syncStatus = SyncStatus.SYNCED;
    draft.ideaSegments = payload.ideaSegments.slice();
    if (payload.code.length > 0) {
      const codeDoc = new CodeDocument(`code_${operation.entityId}`, operation.entityId,
        CodeOrigin.USER, payload.code, payload.language, newVersion, operation.clientId);
      draft.codeDocuments.push(codeDoc);
    }
    return draft;
  }
}
