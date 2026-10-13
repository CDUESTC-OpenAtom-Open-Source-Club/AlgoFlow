import { Draft, IdeaSegment, SyncStatus } from './Models';
import { AIArtifactPayload, ConflictRecord, DraftPayload, ReviewResultPayload, SyncOperation } from './SyncModels';
import { IDERecord } from './IDEAIModels';

export interface SyncRepository {
  getClientId(): string;
  getDraft(id: string): Draft | undefined;
  getCursor(): string;
  setCursor(cursor: string): void;
  commitCursor(cursor: string): Promise<void>;
  flush(): Promise<void>;
  getBaseUrl(): string;
  setBaseUrl(baseUrl: string): void;
  listPendingOperations(): SyncOperation[];
  markInFlight(operationId: string): void;
  hasPendingOperation(entityId: string): boolean;
  removeOperation(operationId: string): void;
  applyServerDraft(draft: Draft): void;
  saveConflictDraft(draft: Draft, record: ConflictRecord): void;
  setDraftSyncStatus(id: string, status: SyncStatus): void;
  queueAIRecord(record: IDERecord): void;
  getAIRecord(id: string): Promise<IDERecord | undefined>;
  applyServerAIArtifact(payload: AIArtifactPayload): Promise<void>;
  applyServerReview(payload: ReviewResultPayload): Promise<void>;
  saveConflictAIRecord(record: IDERecord, conflict: ConflictRecord): Promise<void>;
  getDraftSourceCode(draftId: string, version: number): string | undefined;
  getDraftSourceSegments(draftId: string, version: number): IdeaSegment[] | undefined;
}
