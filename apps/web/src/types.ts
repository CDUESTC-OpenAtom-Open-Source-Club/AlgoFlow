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
  ai_artifacts?: AIArtifactPayload[];
}

export interface AIArtifactPayload {
  mode: Mode;
  pseudocode: { id: string; step: string; source_refs: string[] }[];
  code_snippet: string | null;
  code_mappings: { step_id: string; start_line: number; end_line: number }[];
  assumptions: string[];
  missing_information: string[];
  risk_flags: string[];
  added_algorithm_steps: string[];
  source_draft_version: number;
  model_id: string;
  rule_version: string;
  output_kind: 'pseudocode' | 'code_snippet';
  visibility: 'visible' | 'hidden';
  template_id: string | null;
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
