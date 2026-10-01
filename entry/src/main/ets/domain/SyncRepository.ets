import { AIArtifact, Draft, ReviewResult, SyncStatus } from './Models';
import { AIArtifactPayload } from './AIArtifactCodec';
import { ConflictRecord, ReviewResultPayload, SyncOperation } from './SyncModels';

export interface SyncRepository {
  getClientId(): string;
  getCursor(): string;
  setCursor(cursor: string): void;
  getBaseUrl(): string;
  setBaseUrl(baseUrl: string): void;
  listPendingOperations(): SyncOperation[];
  hasPendingOperation(entityType: string, entityId: string): boolean;
  removeOperation(operationId: string): void;
  applyServerDraft(draft: Draft): void;
  saveConflictDraft(draft: Draft, record: ConflictRecord): void;
  saveConflictArtifact(artifact: AIArtifact, record: ConflictRecord): void;
  saveConflictReview(review: ReviewResult, record: ConflictRecord): void;
  listConflicts(): ConflictRecord[];
  setDraftSyncStatus(id: string, status: SyncStatus): void;
  listArtifacts(): AIArtifact[];
  getArtifact(id: string): AIArtifact | undefined;
  saveArtifact(artifact: AIArtifact): void;
  applyServerArtifact(payload: AIArtifactPayload): void;
  listReviews(): ReviewResult[];
  getReview(id: string): ReviewResult | undefined;
  saveReview(review: ReviewResult): void;
  applyServerReview(payload: ReviewResultPayload): void;
}
