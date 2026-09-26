export type Panel = 'files' | 'search' | 'source' | 'ai' | 'versions';

export type Mode =
  | 'faithful_transform'
  | 'feasibility_analysis'
  | 'progressive_hint'
  | 'full_solution';

export type FileId = 'main.cpp' | 'idea.md' | 'cases.txt';

export type Documents = Record<FileId, string>;

export type SyncStatus = 'local_only' | 'syncing' | 'synced' | 'conflict' | 'failed';

export type ReviewKind = 'explanation' | 'risk' | 'complexity';
export type AIRequestState = 'loading' | 'success' | 'unavailable' | 'error' | 'cancelled' | 'accepted' | 'rejected';

export interface IdeaSegment {
  id: string;
  content: string;
}

export interface AIRange {
  start_line: number;
  start_char: number;
  end_line: number;
  end_char: number;
}

export interface AICursor {
  line: number;
  char: number;
}

export interface AISourceRequest {
  mode: Mode;
  draft_id: string;
  draft_version: number;
  language: 'cpp';
  rule_version: string;
  problem_context: string;
  idea_segments: IdeaSegment[];
  code: string;
  visibility: 'visible' | 'hidden';
}

export interface AIReviewRequest extends AISourceRequest {
  output_kind: 'review';
  review_kind: ReviewKind;
}

export interface AICompletionRequest extends AISourceRequest {
  output_kind: 'completion';
  cursor: AICursor;
}

// Local application ports; these fields are not part of Draft or the wire Schema.
export interface AIContext {
  draftId: string;
  draftVersion: number;
  fileId: FileId;
  mode: Mode;
  code: string;
  idea: string;
  problemContext: string;
}

export interface AIResponse<T> {
  result: T;
  isTestData: boolean;
}

export interface AIClientPort {
  requestReview(request: AIReviewRequest, options: { signal: AbortSignal }): Promise<AIResponse<AIReviewResult>>;
  requestCompletion(request: AICompletionRequest, options: { signal: AbortSignal }): Promise<AIResponse<AICompletionResult>>;
}

export interface AIReviewDiagnostic {
  id: string;
  level: 'info' | 'warning' | 'error';
  range: AIRange | null;
  problem: string;
  basis: string;
  suggestion: string;
}

export interface AIReviewResult {
  mode: Mode;
  draft_id: string;
  source_draft_version: number;
  model_id: string;
  rule_version: string;
  review_kind: ReviewKind;
  output_kind: 'review';
  diagnostics: AIReviewDiagnostic[];
  visibility: 'visible' | 'hidden';
}

export interface AICompletionResult {
  mode: Mode;
  draft_id: string;
  source_draft_version: number;
  model_id: string;
  rule_version: string;
  output_kind: 'completion';
  replaced_range: AIRange;
  suggestion_text: string;
  source_refs: string[];
  visibility: 'visible' | 'hidden';
}

export interface AIResultRecord {
  id: string;
  draftId: string;
  capability: 'review' | 'completion';
  mode: Mode;
  reviewKind?: ReviewKind;
  state: AIRequestState;
  result: AIReviewResult | AICompletionResult | null;
  errorCode?: string;
  errorMessage?: string;
  isTestData: boolean;
  hidden: boolean;
  stale: boolean;
  requestGeneration: number;
  sourceDraftVersion: number;
  sourceFile: FileId;
  sourceCode: string;
  sourceIdea: string;
  sourceProblemContext: string;
  sourceSegments: IdeaSegment[];
  sourceCursor: AICursor | null;
  updatedAt: string;
}

export interface AIResultRepository {
  listForDraft(draftId: string, mode: Mode): AIResultRecord[];
  save(record: AIResultRecord): void;
  update(record: AIResultRecord): void;
  reconcileSegments(draftId: string, idea: string, fallback?: IdeaSegment[]): IdeaSegment[];
  removeDraft(draftId: string): void;
}

export interface AISessionState {
  reviews: AIResultRecord[];
  completion: AIResultRecord | null;
  segments: IdeaSegment[];
  storageError: string;
}

export interface AIEditorChange {
  id: string;
  sourceCode: string;
  range: AIRange;
  insert: string;
}

export type ApplyAIEditorChange = (change: AIEditorChange) => boolean;

export interface Draft {
  id: string;
  workspace_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  last_modified_client_id: string;
  title: string;
  language: 'cpp';
  idea: string;
  code: string;
  cases?: string;
  rewrite: string;
  ai_mode: Mode;
  artifact_hidden: boolean;
  sync_status: SyncStatus;
}

export interface SyncOperation {
  operation_id: string;
  entity_type: 'draft' | 'code_document' | 'ai_artifact';
  entity_id: string;
  operation_type: 'upsert' | 'delete';
  base_version: number;
  client_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface WorkspaceState {
  client_id: string;
  cursor: string;
  online: boolean;
  selected_id: string;
  drafts: Draft[];
  operations: SyncOperation[];
  conflicts: ConflictRecord[];
}

export interface ConflictRecord {
  id: string;
  entity_id: string;
  local_copy_id: string;
  server_entity: Draft;
  created_at: string;
  resolved: boolean;
}

export interface PushResult {
  operation_id: string;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  version?: number;
  server_entity?: Draft | null;
  error_code?: string;
}

export interface PullChange {
  cursor: string;
  entity_type: 'draft' | 'code_document' | 'ai_artifact';
  entity: Draft;
}

export interface PullResult {
  changes: PullChange[];
  next_cursor: string;
}

export interface SyncRunResult {
  state: WorkspaceState;
  status: SyncStatus;
}
