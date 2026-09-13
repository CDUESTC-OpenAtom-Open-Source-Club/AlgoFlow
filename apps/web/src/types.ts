export type Panel = 'files' | 'search' | 'source' | 'ai' | 'versions';

export type Mode =
  | 'faithful_transform'
  | 'feasibility_analysis'
  | 'progressive_hint'
  | 'full_solution';

export type FileId = 'main.cpp' | 'idea.md' | 'cases.txt';

export type Documents = Record<FileId, string>;

export type SyncStatus = 'local_only' | 'syncing' | 'synced' | 'conflict' | 'failed';

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

// ---- IDE AI review and completion contracts (mirror ai.schema.json) ----

export type ReviewKind = 'explanation' | 'risk' | 'complexity';

export type DiagnosticLevel = 'error' | 'warning' | 'info' | 'hint';

export interface SourceRange {
  start_line: number;
  start_char: number;
  end_line: number;
  end_char: number;
}

export interface IdeaSegmentInput {
  id: string;
  content: string;
}

export interface ReviewRequest {
  mode: Mode;
  draft_id: string;
  draft_version: number;
  language: 'cpp';
  rule_version: string;
  review_kind: ReviewKind;
  problem_context: string;
  idea_segments: IdeaSegmentInput[];
  code: string;
  visibility: 'visible' | 'hidden';
}

export interface ReviewDiagnostic {
  id: string;
  level: DiagnosticLevel;
  range: SourceRange | null;
  problem: string;
  basis: string;
  suggestion: string;
}

export interface ReviewResult {
  mode: Mode;
  draft_id: string;
  source_draft_version: number;
  model_id: string;
  rule_version: string;
  review_kind: ReviewKind;
  diagnostics: ReviewDiagnostic[];
  visibility: 'visible' | 'hidden';
}

export interface CompletionRequest {
  mode: Mode;
  draft_id: string;
  draft_version: number;
  language: 'cpp';
  rule_version: string;
  problem_context: string;
  idea_segments: IdeaSegmentInput[];
  code: string;
  cursor: { line: number; char: number };
  visibility: 'visible' | 'hidden';
}

export interface CompletionResult {
  mode: Mode;
  draft_id: string;
  source_draft_version: number;
  model_id: string;
  rule_version: string;
  replaced_range: SourceRange;
  suggestion_text: string;
  visibility: 'visible' | 'hidden';
}

export interface AICapabilities {
  enabled: boolean;
  code: 'AI_ENABLED' | 'AI_NOT_ENABLED';
  capabilities: { transform: boolean; review: boolean; completion: boolean };
}
