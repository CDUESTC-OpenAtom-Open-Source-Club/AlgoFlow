import { AIMode, AIRequestSegment } from './Models';

export enum IDECapability { REVIEW = 'review', COMPLETION = 'completion', TRANSFORM = 'transform' }
export enum ReviewKind { EXPLANATION = 'explanation', RISK = 'risk', COMPLEXITY = 'complexity' }
export enum IDEState { LOADING = 'loading', SUCCESS = 'success', ERROR = 'error', CANCELLED = 'cancelled', ACCEPTED = 'accepted', REJECTED = 'rejected' }
export class SourceRange {
  start_line: number = 1;
  start_char: number = 0;
  end_line: number = 1;
  end_char: number = 0;
}
export class SourceCursor { line: number = 1; char: number = 0; }
export class IDEDiagnostic {
  id: string = '';
  level: string = '';
  range: SourceRange | null = null;
  problem: string = '';
  basis: string = '';
  suggestion: string = '';
}
export class IDEContext {
  draftId: string = '';
  version: number = 0;
  file: string = 'main.cpp';
  mode: AIMode = AIMode.FAITHFUL_TRANSFORM;
  code: string = '';
  idea: string = '';
  problemContext: string = '';
  segments: AIRequestSegment[] = [];
}
export class IDERequest {
  mode: string = AIMode.FAITHFUL_TRANSFORM;
  draft_id: string = '';
  draft_version: number = 0;
  language: string = 'cpp';
  rule_version: string = '1.0.0';
  problem_context: string = '';
  idea_segments: AIRequestSegment[] = [];
  visibility: string = 'visible';
  output_kind: string = 'review';
}
export class ReviewRequest extends IDERequest {
  code: string = '';
  review_kind: string = ReviewKind.EXPLANATION;
}
export class CompletionRequest extends IDERequest {
  code: string = '';
  cursor: SourceCursor = new SourceCursor();
}
export class IDEReply {
  body: string = '';
  isTestData: boolean = false;
  errorCode: string = '';
  message: string = '';
}
export interface IDEProvider {
  request(request: IDERequest, capability: IDECapability): Promise<IDEReply>;
  cancel(): void;
}
export class IDEResult {
  modelId: string = '';
  diagnostics: IDEDiagnostic[] = [];
  range: SourceRange = new SourceRange();
  suggestion: string = '';
  sourceRefs: string[] = [];
  transformText: string = '';
}
export class IDERecord {
  id: string = '';
  context: IDEContext = new IDEContext();
  capability: IDECapability = IDECapability.REVIEW;
  reviewKind: ReviewKind = ReviewKind.EXPLANATION;
  state: IDEState = IDEState.LOADING;
  generation: number = 0;
  cursor: SourceCursor = new SourceCursor();
  body: string = '';
  isTestData: boolean = false;
  hidden: boolean = false;
  stale: boolean = false;
  errorCode: string = '';
  message: string = '';
  updatedAt: string = '';
}
export interface AIResultRepository {
  list(draftId: string, mode: AIMode): Promise<IDERecord[]>;
  save(record: IDERecord, latest: boolean): Promise<void>;
  removeDraft(draftId: string): Promise<void>;
}
export function buildIDERequest(record: IDERecord): IDERequest {
  let request: IDERequest;
  if (record.capability === IDECapability.REVIEW) {
    const review = new ReviewRequest(); review.code = record.context.code;
    review.review_kind = record.reviewKind; request = review;
  } else if (record.capability === IDECapability.COMPLETION) {
    const completion = new CompletionRequest(); completion.code = record.context.code;
    completion.cursor = record.cursor; request = completion;
  } else request = new IDERequest();
  request.mode = record.context.mode; request.draft_id = record.context.draftId;
  request.draft_version = record.context.version; request.problem_context = record.context.problemContext;
  request.idea_segments = record.context.segments;
  request.output_kind = record.capability === IDECapability.TRANSFORM ? 'pseudocode' : record.capability;
  return request;
}
