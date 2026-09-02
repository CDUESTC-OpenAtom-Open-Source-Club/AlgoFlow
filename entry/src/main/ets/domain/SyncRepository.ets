import { Draft, SyncStatus } from './Models';
import { ConflictRecord, SyncOperation } from './SyncModels';

export interface SyncRepository {
  getClientId(): string;
  getCursor(): string;
  setCursor(cursor: string): void;
  getBaseUrl(): string;
  setBaseUrl(baseUrl: string): void;
  listPendingOperations(): SyncOperation[];
  hasPendingOperation(entityId: string): boolean;
  removeOperation(operationId: string): void;
  applyServerDraft(draft: Draft): void;
  saveConflictDraft(draft: Draft, record: ConflictRecord): void;
  setDraftSyncStatus(id: string, status: SyncStatus): void;
}
