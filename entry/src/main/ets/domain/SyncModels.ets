import { AIMode, Draft, IdeaSegment, SyncStatus } from './Models';

export class SourceRangePayload {
  start_line: number = 1;
  start_char: number = 0;
  end_line: number = 1;
  end_char: number = 0;
}

export class ReviewDiagnosticPayload {
  id: string = '';
  level: string = 'info';
  range: SourceRangePayload | null = null;
  problem: string = '';
  basis: string = '';
  suggestion: string = '';
}

export class ReviewResultPayload {
  id: string = '';
  version: number = 0;
  server_sequence: number = 0;
  created_at: string = '';
  updated_at: string = '';
  deleted: boolean = false;
  last_modified_client_id: string = '';
  draft_id: string = '';
  mode: string = AIMode.FAITHFUL_TRANSFORM;
  source_draft_version: number = 0;
  model_id: string = '';
  rule_version: string = '';
  review_kind: string = 'risk';
  diagnostics: ReviewDiagnosticPayload[] = [];
  visibility: string = 'visible';
  freshness: string = 'current';
}

export class AIArtifactPayload {
  id: string = '';
  version: number = 0;
  server_sequence: number = 0;
  created_at: string = '';
  updated_at: string = '';
  deleted: boolean = false;
  last_modified_client_id: string = '';
  draft_id: string = '';
  mode: string = AIMode.FAITHFUL_TRANSFORM;
  pseudocode: Object[] = [];
  code_snippet: string | null = null;
  code_mappings: Object[] = [];
  assumptions: string[] = [];
  missing_information: string[] = [];
  risk_flags: string[] = [];
  added_algorithm_steps: string[] = [];
  source_draft_version: number = 0;
  model_id: string = '';
  rule_version: string = '';
  output_kind: string = 'pseudocode';
  visibility: string = 'visible';
  template_id: string | null = null;
}

export enum SyncEntityType {
  DRAFT = 'draft',
  CODE_DOCUMENT = 'code_document',
  AI_ARTIFACT = 'ai_artifact',
  REVIEW_RESULT = 'review_result'
}

export enum SyncOperationType {
  UPSERT = 'upsert',
  DELETE = 'delete'
}

export enum SyncResultStatus {
  APPLIED = 'applied',
  DUPLICATE = 'duplicate',
  CONFLICT = 'conflict',
  REJECTED = 'rejected'
}

export enum SyncErrorCode {
  INVALID_REQUEST = 'INVALID_REQUEST',
  VERSION_CONFLICT = 'VERSION_CONFLICT',
  EPOCH_MISMATCH = 'EPOCH_MISMATCH',
  OUT_OF_ORDER = 'OUT_OF_ORDER'
}

export class DraftPayload {
  id: string = '';
  workspace_id: string = 'workspace-local';
  version: number = 0;
  created_at: string = '';
  updated_at: string = '';
  deleted: boolean = false;
  last_modified_client_id: string = '';
  title: string = '';
  language: string = 'cpp';
  idea: string = '';
  code: string = '';
  short_code: string = '';
  rewrite: string = '';
  ai_mode: string = AIMode.FAITHFUL_TRANSFORM;
  artifact_hidden: boolean = false;
  sync_status: string = SyncStatus.SYNCED;
  idea_segments: IdeaSegment[] = [];
}

export class SyncOperation {
  operation_id: string = '';
  entity_type: string = SyncEntityType.DRAFT;
  entity_id: string = '';
  operation_type: string = SyncOperationType.UPSERT;
  base_version: number = 0;
  client_id: string = '';
  occurred_at: string = '';
  payload: DraftPayload | AIArtifactPayload | ReviewResultPayload = new DraftPayload();
}

export class PushResult {
  operation_id: string = '';
  status: string = SyncResultStatus.REJECTED;
  version?: number;
  server_entity?: DraftPayload | AIArtifactPayload | ReviewResultPayload | null;
  error_code?: string;
  server_epoch?: string;
}

export class PullChange {
  cursor: string = '0';
  entity_type: string = SyncEntityType.DRAFT;
  entity: DraftPayload | AIArtifactPayload | ReviewResultPayload = new DraftPayload();
}

export class PullResult {
  changes: PullChange[] = [];
  next_cursor: string = '0';
  // Absent from servers older than the epoch contract; treated as "no epoch".
  server_epoch?: string;
  reset?: boolean;
}

export class ConflictRecord {
  id: string = '';
  entity_type: string = SyncEntityType.DRAFT;
  entity_id: string = '';
  local_copy_id: string = '';
  server_entity: DraftPayload | AIArtifactPayload | ReviewResultPayload = new DraftPayload();
  created_at: string = '';
  resolved: boolean = false;
}

export function draftToPayload(draft: Draft): DraftPayload {
  const payload = new DraftPayload();
  payload.id = draft.id;
  payload.workspace_id = draft.workspaceId;
  payload.version = draft.version;
  payload.created_at = draft.createdAt;
  payload.updated_at = draft.updatedAt;
  payload.deleted = draft.deleted;
  payload.last_modified_client_id = draft.lastModifiedClientId;
  payload.title = draft.title;
  payload.idea = draft.idea;
  payload.code = draft.code;
  payload.short_code = draft.shortCode;
  payload.rewrite = draft.rewrite;
  payload.ai_mode = draft.aiMode;
  payload.artifact_hidden = draft.artifactHidden;
  payload.sync_status = SyncStatus.SYNCED;
  payload.idea_segments = draft.ideaSegments;
  return payload;
}

export function payloadToDraft(payload: DraftPayload): Draft {
  const draft = new Draft(payload.id, payload.title);
  draft.workspaceId = payload.workspace_id ?? 'workspace-local';
  draft.version = payload.version ?? 0;
  draft.createdAt = payload.created_at ?? payload.updated_at ?? new Date().toISOString();
  draft.updatedAt = payload.updated_at ?? draft.createdAt;
  draft.deleted = payload.deleted === true;
  draft.lastModifiedClientId = payload.last_modified_client_id ?? '';
  draft.idea = payload.idea ?? '';
  draft.code = payload.code ?? '';
  draft.shortCode = payload.short_code ?? '';
  draft.rewrite = payload.rewrite ?? '';
  draft.aiMode = parseAIMode(payload.ai_mode);
  draft.artifactHidden = payload.artifact_hidden === true;
  draft.syncStatus = SyncStatus.SYNCED;
  draft.ideaSegments = payload.idea_segments ?? [];
  return draft;
}

function parseAIMode(value: string): AIMode {
  if (value === AIMode.FEASIBILITY_ANALYSIS) return AIMode.FEASIBILITY_ANALYSIS;
  if (value === AIMode.PROGRESSIVE_HINT) return AIMode.PROGRESSIVE_HINT;
  if (value === AIMode.FULL_SOLUTION) return AIMode.FULL_SOLUTION;
  return AIMode.FAITHFUL_TRANSFORM;
}
