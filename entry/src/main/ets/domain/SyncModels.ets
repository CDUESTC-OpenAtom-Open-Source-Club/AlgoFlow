import { AIArtifact, AIMode, AIVisibility, DiagnosticLevel, Draft, IdeaSegment, ReviewDiagnostic, ReviewFreshness, ReviewKind, ReviewResult, SourceRange, SyncStatus } from './Models';
import { AIArtifactPayload } from './AIArtifactCodec';

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
  id: string = ''; version: number = 0; server_sequence: number = 0; created_at: string = ''; updated_at: string = ''; deleted: boolean = false;
  last_modified_client_id: string = ''; draft_id: string = ''; mode: string = AIMode.FAITHFUL_TRANSFORM; source_draft_version: number = 0;
  model_id: string = ''; rule_version: string = ''; review_kind: string = 'risk'; diagnostics: ReviewDiagnosticPayload[] = []; visibility: string = 'visible'; freshness: string = ReviewFreshness.CURRENT;
}

export class AIGatewayReviewPayload {
  mode: string = AIMode.FAITHFUL_TRANSFORM;
  source_draft_version: number = 0;
  model_id: string = '';
  rule_version: string = '';
  review_kind: string = ReviewKind.RISK;
  diagnostics: ReviewDiagnosticPayload[] = [];
  visibility: string = AIVisibility.VISIBLE;
}

export enum SyncEntityType {
  DRAFT = 'draft',
  AI_ARTIFACT = 'ai_artifact', REVIEW_RESULT = 'review_result'
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
  INVALID_AI_ARTIFACT = 'INVALID_AI_ARTIFACT',
  INVALID_REVIEW_RESULT = 'INVALID_REVIEW_RESULT',
  VERSION_CONFLICT = 'VERSION_CONFLICT',
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
}

export class PullChange {
  cursor: string = '0';
  entity_type: string = SyncEntityType.DRAFT;
  entity: DraftPayload | AIArtifactPayload | ReviewResultPayload = new DraftPayload();
}

export class PullResult {
  changes: PullChange[] = [];
  next_cursor: string = '0';
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

export function reviewToPayload(review: ReviewResult): ReviewResultPayload {
  const payload = new ReviewResultPayload();
  payload.id = review.id; payload.version = review.version; payload.server_sequence = review.serverSequence;
  payload.created_at = review.createdAt; payload.updated_at = review.updatedAt; payload.deleted = review.deleted;
  payload.last_modified_client_id = review.lastModifiedClientId; payload.draft_id = review.draftId; payload.mode = review.mode;
  payload.source_draft_version = review.sourceDraftVersion; payload.model_id = review.modelId; payload.rule_version = review.ruleVersion;
  payload.review_kind = review.reviewKind; payload.visibility = review.visibility;
  payload.freshness = review.freshness;
  payload.diagnostics = review.diagnostics.map((item) => {
    const result = new ReviewDiagnosticPayload();
    result.id = item.id; result.level = item.level; result.range = item.range === null ? null : JSON.parse(JSON.stringify(item.range));
    result.problem = item.problem; result.basis = item.basis; result.suggestion = item.suggestion; return result;
  });
  return payload;
}

export function gatewayPayloadToReview(payload: AIGatewayReviewPayload, id: string, draftId: string,
  draftVersion: number, clientId: string): ReviewResult | undefined {
  if (payload === undefined || payload === null) return undefined;
  const entity = new ReviewResultPayload();
  entity.id = id;
  entity.version = 0;
  entity.server_sequence = 0;
  entity.created_at = new Date().toISOString();
  entity.updated_at = entity.created_at;
  entity.deleted = false;
  entity.last_modified_client_id = clientId;
  entity.draft_id = draftId;
  entity.mode = payload.mode;
  entity.source_draft_version = draftVersion;
  entity.model_id = payload.model_id;
  entity.rule_version = payload.rule_version;
  entity.review_kind = payload.review_kind;
  entity.diagnostics = payload.diagnostics;
  entity.visibility = payload.visibility;
  entity.freshness = ReviewFreshness.CURRENT;
  return payloadToReview(entity);
}

export function reviewSourceMatchesDraft(payload: ReviewResultPayload, draft: Draft | undefined, sourceCode?: string): boolean {
  if (draft === undefined || draft.deleted || draft.id !== payload.draft_id ||
    draft.version < payload.source_draft_version) return false;
  const code = payload.source_draft_version === draft.version ? draft.code : sourceCode;
  if (code === undefined) return false;
  const lines = code.split('\n');
  for (const diagnostic of payload.diagnostics) {
    if (diagnostic.range === null) continue;
    const range = diagnostic.range;
    if (range.start_line > lines.length || range.end_line > lines.length ||
      range.start_char > lines[range.start_line - 1].length || range.end_char > lines[range.end_line - 1].length) return false;
  }
  return true;
}

export function payloadToReview(payload: ReviewResultPayload): ReviewResult | undefined {
  const allowedPayloadFields = ['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id',
    'draft_id', 'mode', 'source_draft_version', 'model_id', 'rule_version', 'review_kind', 'diagnostics', 'visibility', 'freshness'];
  if (payload === undefined || payload === null) return undefined;
  if (payload.freshness === undefined || payload.freshness === '') payload.freshness = ReviewFreshness.CURRENT;
  if (typeof payload.id !== 'string' || payload.id.length === 0 ||
    Object.keys(payload).some((key: string) => !allowedPayloadFields.includes(key)) ||
    typeof payload.draft_id !== 'string' || payload.draft_id.length === 0 || !Number.isInteger(payload.version) || payload.version < 0 ||
    !Number.isInteger(payload.server_sequence) || payload.server_sequence < 0 || !isUtcTimestamp(payload.created_at) ||
    !isUtcTimestamp(payload.updated_at) || typeof payload.last_modified_client_id !== 'string' || payload.last_modified_client_id.trim().length === 0 ||
    !Number.isInteger(payload.source_draft_version) || payload.source_draft_version < 0 || typeof payload.model_id !== 'string' || payload.model_id.length === 0 ||
    typeof payload.rule_version !== 'string' || payload.rule_version.length === 0 || !['explanation', 'risk', 'complexity'].includes(payload.review_kind) ||
    !['faithful_transform', 'feasibility_analysis', 'progressive_hint', 'full_solution'].includes(payload.mode) ||
    !['visible', 'hidden'].includes(payload.visibility) || !['current', 'stale'].includes(payload.freshness) ||
    typeof payload.deleted !== 'boolean' || !Array.isArray(payload.diagnostics)) return undefined;
  const diagnosticIds = new Set<string>();
  for (const item of payload.diagnostics) {
    if (item === undefined || item === null || typeof item.id !== 'string' || item.id.trim().length === 0 || diagnosticIds.has(item.id) ||
      !['error', 'warning', 'info', 'hint'].includes(item.level) || !hasText(item.problem) || !hasText(item.basis) ||
      !hasText(item.suggestion) || !isValidSourceRange(item.range)) return undefined;
    diagnosticIds.add(item.id);
    if (Object.keys(item).some((key: string) => !['id', 'level', 'range', 'problem', 'basis', 'suggestion'].includes(key))) return undefined;
  }
  const review = new ReviewResult(payload.id, payload.draft_id);
  review.version = payload.version; review.serverSequence = payload.server_sequence; review.createdAt = payload.created_at; review.updatedAt = payload.updated_at;
  review.deleted = payload.deleted; review.lastModifiedClientId = payload.last_modified_client_id; review.mode = parseAIMode(payload.mode);
  review.sourceDraftVersion = payload.source_draft_version; review.modelId = payload.model_id; review.ruleVersion = payload.rule_version;
  review.reviewKind = payload.review_kind as ReviewKind; review.visibility = payload.visibility as AIVisibility;
  review.freshness = payload.freshness as ReviewFreshness;
  review.diagnostics = payload.diagnostics.map((item: ReviewDiagnosticPayload): ReviewDiagnostic => {
    const diagnostic = new ReviewDiagnostic(); diagnostic.id = item.id; diagnostic.level = item.level as DiagnosticLevel;
    diagnostic.range = item.range === null ? null : JSON.parse(JSON.stringify(item.range)) as SourceRange;
    diagnostic.problem = item.problem; diagnostic.basis = item.basis; diagnostic.suggestion = item.suggestion; return diagnostic;
  });
  return review;
}

function hasText(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUtcTimestamp(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.endsWith('Z') && !Number.isNaN(Date.parse(value));
}

function isValidSourceRange(range: SourceRangePayload | null): boolean {
  if (range === null) return true;
  if (range === undefined || typeof range !== 'object') return false;
  if (Object.keys(range).some((key: string) => !['start_line', 'start_char', 'end_line', 'end_char'].includes(key))) return false;
  if (typeof range.start_line !== 'number' || !Number.isInteger(range.start_line) || range.start_line < 1 ||
    typeof range.start_char !== 'number' || !Number.isInteger(range.start_char) || range.start_char < 0 ||
    typeof range.end_line !== 'number' || !Number.isInteger(range.end_line) || range.end_line < 1 ||
    typeof range.end_char !== 'number' || !Number.isInteger(range.end_char) || range.end_char < 0) return false;
  return range.end_line > range.start_line || (range.end_line === range.start_line && range.end_char >= range.start_char);
}
