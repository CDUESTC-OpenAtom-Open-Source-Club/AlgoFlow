import { Draft, IdeaSegment, SyncStatus } from './Models';
import { AIArtifactPayload, ConflictRecord, DraftPayload, ReviewResultPayload, SyncOperation } from './SyncModels';
import { IDERecord } from './IDEAIModels';

export interface SyncRepository {
  getClientId(): string;
  getDraft(id: string): Draft | undefined;
  getCursor(): string;
  setCursor(cursor: string): void;
  // serverEpoch is stored with the cursor so both always describe one lineage.
  commitCursor(cursor: string, serverEpoch?: string): Promise<void>;
  getServerEpoch?(): string;
  // After a server reset: the draft no longer exists on the server, so it is
  // re-queued as a creation (version 0) and its old-lineage snapshots dropped.
  rebaseDraftForNewServer?(id: string): void;
  listDraftIds?(): string[];
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
  getDraftSourceVersions?(draftId: string): number[];
}
