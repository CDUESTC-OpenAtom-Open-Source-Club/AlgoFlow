import { Draft, SyncOperation } from './Models';

/**
 * 同步端口（领域层）。
 * 适配器负责幂等、乐观锁与冲突返回；ViewModel 负责状态机与冲突副本。
 * MVP 为本地协议模拟，接入真实同步 API 后替换适配器即可，不改变领域规则。
 */

export enum SyncResultStatus {
  APPLIED = 'applied',
  DUPLICATE = 'duplicate',
  CONFLICT = 'conflict',
  REJECTED = 'rejected'
}

export class SyncResult {
  operationId: string;
  status: SyncResultStatus;
  version: number;
  serverEntity: Draft | null;
  errorCode: string;

  constructor(operationId: string, status: SyncResultStatus, version: number,
    serverEntity: Draft | null, errorCode: string) {
    this.operationId = operationId;
    this.status = status;
    this.version = version;
    this.serverEntity = serverEntity;
    this.errorCode = errorCode;
  }
}

export interface SyncPort {
  apply(operation: SyncOperation): Promise<SyncResult>;
}
