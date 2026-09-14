import http from '@ohos.net.http';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AIProvider } from '../domain/AIProvider';
import { AIArtifact, AIErrorCode, AIOutputKind, AIMode, AIRequest, AIRequestSegment, AIResult,
  AIVisibility, CodeMapping, PseudocodeStep } from '../domain/Models';
import { AIContractGuard } from '../domain/AIContractGuard';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8788';
const RULE_VERSION = '1.0.0';

export class HttpAIProvider implements AIProvider {
  private baseUrl: string;
  private maxRetries: number;
  private readTimeoutMs: number;
  private activeRequest: http.HttpRequest | null = null;
  private generation: number = 0;
  private cancelledGeneration: number = -1;

  constructor(baseUrl: string = DEFAULT_BASE_URL, maxRetries: number = 2, readTimeoutMs: number = 10000) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.maxRetries = Math.max(0, maxRetries);
    this.readTimeoutMs = readTimeoutMs;
  }

  cancel(): void {
    this.cancelledGeneration = this.generation;
    const request = this.activeRequest;
    this.activeRequest = null;
    if (request !== null) request.destroy();
  }

  async generate(request: AIRequest): Promise<AIResult> {
    const generation = ++this.generation;
    const modeUnavailable = validateModeAvailability(request.mode);
    if (modeUnavailable.length > 0) {
      return AIResult.failure(AIErrorCode.AI_MODE_NOT_AVAILABLE, modeUnavailable);
    }
    hilog.info(DOMAIN, TAG,
      '[AlgoFlow] AI request started. draft_id=%{public}s mode=%{public}s version=%{public}s',
      safeLogValue(request.draftId), request.mode, request.draftVersion.toString());
    const body = JSON.stringify(new AIRequestBody(request));
    let lastError: AIErrorCode = AIErrorCode.NETWORK_ERROR;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.isCancelled(generation)) {
        return AIResult.failure(AIErrorCode.CANCELLED, 'AI 请求已取消');
      }
      try {
        const result = await this.post(body);
        if (this.isCancelled(generation)) {
          return AIResult.failure(AIErrorCode.CANCELLED, 'AI 请求已取消');
        }
        if (result.statusCode >= 200 && result.statusCode < 300) {
          return this.parseSuccess(result.body, request);
        }
        const mapped = mapHttpError(result.statusCode, result.body);
        if (result.statusCode >= 500 && attempt < this.maxRetries) {
          lastError = mapped.code;
          hilog.warn(DOMAIN, TAG,
            '[AlgoFlow] AI provider transient failure. status=%{public}s attempt=%{public}s',
            result.statusCode.toString(), attempt.toString());
          await sleep(500 * (attempt + 1));
          if (this.isCancelled(generation)) {
            return AIResult.failure(AIErrorCode.CANCELLED, 'AI 请求已取消');
          }
          continue;
        }
        hilog.warn(DOMAIN, TAG,
          '[AlgoFlow] AI request rejected. status=%{public}s code=%{public}s',
          result.statusCode.toString(), mapped.code);
        return AIResult.failure(mapped.code, mapped.message);
      } catch (error) {
        if (this.isCancelled(generation)) {
          return AIResult.failure(AIErrorCode.CANCELLED, 'AI 请求已取消');
        }
        lastError = AIErrorCode.NETWORK_ERROR;
        hilog.warn(DOMAIN, TAG,
          '[AlgoFlow] AI transport failed. attempt=%{public}s', attempt.toString());
        if (attempt < this.maxRetries) {
          await sleep(500 * (attempt + 1));
          if (this.isCancelled(generation)) {
            return AIResult.failure(AIErrorCode.CANCELLED, 'AI 请求已取消');
          }
          continue;
        }
        return AIResult.failure(AIErrorCode.NETWORK_ERROR, 'AI 服务不可达，请检查网络或稍后重试');
      }
    }
    return AIResult.failure(lastError, 'AI 请求失败');
  }

  private async post(body: string): Promise<HttpResult> {
    const request = http.createHttp();
    this.activeRequest = request;
    try {
      const response = await request.request(`${this.baseUrl}/requests`, {
        method: http.RequestMethod.POST,
        header: { 'Content-Type': 'application/json' },
        extraData: body,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 5000,
        readTimeout: this.readTimeoutMs
      });
      const responseBody = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      return new HttpResult(response.responseCode, responseBody);
    } finally {
      if (this.activeRequest === request) this.activeRequest = null;
      request.destroy();
    }
  }

  private isCancelled(generation: number): boolean {
    return this.cancelledGeneration === generation;
  }

  private parseSuccess(body: string, request: AIRequest): AIResult {
    let artifact: AIArtifact;
    try {
      const payload = JSON.parse(body) as AIArtifactPayload;
      artifact = payloadToArtifact(payload);
    } catch (error) {
      return AIResult.failure(AIErrorCode.INVALID_AI_ARTIFACT, 'AI 产物格式无效');
    }
    const violations = AIContractGuard.validateArtifactAgainstRequest(artifact, request);
    if (violations.length > 0) {
      hilog.warn(DOMAIN, TAG,
        '[AlgoFlow] AI artifact violated local contract. reason=%{public}s', safeLogValue(violations.join(';')));
      return AIResult.failure(AIErrorCode.INVALID_AI_ARTIFACT, 'AI 产物越界，已拒绝保存');
    }
    return AIResult.success(artifact);
  }
}

class AIRequestBody {
  mode: string;
  draft_id: string;
  draft_version: number;
  language: string;
  rule_version: string;
  problem_context: string;
  idea_segments: AIRequestSegmentPayload[];
  output_kind: string;
  visibility: string;

  constructor(request: AIRequest) {
    this.mode = request.mode;
    this.draft_id = request.draftId;
    this.draft_version = request.draftVersion;
    this.language = request.language;
    this.rule_version = request.ruleVersion;
    this.problem_context = request.problemContext;
    this.idea_segments = request.ideaSegments.map((segment: AIRequestSegment) =>
      new AIRequestSegmentPayload(segment.id, segment.content));
    this.output_kind = request.outputKind;
    this.visibility = request.visibility;
  }
}

class AIRequestSegmentPayload {
  id: string;
  content: string;

  constructor(id: string, content: string) {
    this.id = id;
    this.content = content;
  }
}

class AIArtifactPayload {
  mode: string = '';
  pseudocode: PseudocodeStepPayload[] = [];
  code_snippet: string | null = null;
  code_mappings: CodeMappingPayload[] = [];
  assumptions: string[] = [];
  missing_information: string[] = [];
  risk_flags: string[] = [];
  added_algorithm_steps: string[] = [];
  source_draft_version: number = 0;
  model_id: string = '';
  rule_version: string = '';
  output_kind: string = '';
  visibility: string = '';
  template_id: string | null = null;
}

class PseudocodeStepPayload {
  id: string = '';
  step: string = '';
  source_refs: string[] = [];
}

class CodeMappingPayload {
  step_id: string = '';
  start_line: number = 0;
  end_line: number = 0;
}

class AIErrorPayload {
  code: string = '';
  message: string = '';
  errors: string[] = [];
}

class HttpResult {
  statusCode: number;
  body: string;

  constructor(statusCode: number, body: string) {
    this.statusCode = statusCode;
    this.body = body;
  }
}

class MappedError {
  code: AIErrorCode;
  message: string;

  constructor(code: AIErrorCode, message: string) {
    this.code = code;
    this.message = message;
  }
}

function payloadToArtifact(payload: AIArtifactPayload): AIArtifact {
  const mode = parseAIMode(payload.mode);
  const outputKind = parseAIOutputKind(payload.output_kind);
  const visibility = parseAIVisibility(payload.visibility);
  const artifact = new AIArtifact(mode, outputKind, payload.source_draft_version, payload.model_id,
    payload.rule_version, visibility);
  artifact.pseudocode = (payload.pseudocode ?? []).map((step: PseudocodeStepPayload) =>
    new PseudocodeStep(step.id, step.step, step.source_refs ?? []));
  artifact.codeSnippet = payload.code_snippet ?? null;
  artifact.codeMappings = (payload.code_mappings ?? []).map((mapping: CodeMappingPayload) =>
    new CodeMapping(mapping.step_id, mapping.start_line, mapping.end_line));
  artifact.assumptions = payload.assumptions ?? [];
  artifact.missingInformation = payload.missing_information ?? [];
  artifact.riskFlags = payload.risk_flags ?? [];
  artifact.addedAlgorithmSteps = payload.added_algorithm_steps ?? [];
  artifact.templateId = payload.template_id ?? null;
  return artifact;
}

function mapHttpError(statusCode: number, body: string): MappedError {
  const code = readErrorCode(body);
  if (statusCode === 400) return new MappedError(AIErrorCode.INVALID_REQUEST, '请求参数无效');
  if (statusCode === 409) return new MappedError(AIErrorCode.AI_MODE_NOT_AVAILABLE, '该 AI 模式尚未接入');
  if (statusCode === 422) return new MappedError(AIErrorCode.INVALID_AI_ARTIFACT, 'AI 产物越界，已拒绝');
  if (statusCode === 502) return new MappedError(AIErrorCode.AI_PROVIDER_ERROR, 'AI 服务异常，请稍后重试');
  if (statusCode === 503) return new MappedError(AIErrorCode.AI_NOT_ENABLED, 'AI 服务未配置模型');
  if (statusCode === 504) return new MappedError(AIErrorCode.AI_PROVIDER_TIMEOUT, 'AI 请求超时');
  return new MappedError(code.length > 0 ? parseErrorCode(code) : AIErrorCode.AI_PROVIDER_ERROR,
    code.length > 0 ? 'AI 服务错误' : 'AI 请求失败');
}

function readErrorCode(body: string): string {
  try {
    const payload = JSON.parse(body) as AIErrorPayload;
    if (payload.code !== undefined && payload.code.length > 0) return safeErrorCode(payload.code);
  } catch (error) {
    return '';
  }
  return '';
}

function parseErrorCode(code: string): AIErrorCode {
  if (code === AIErrorCode.AI_NOT_ENABLED) return AIErrorCode.AI_NOT_ENABLED;
  if (code === AIErrorCode.AI_PROVIDER_ERROR) return AIErrorCode.AI_PROVIDER_ERROR;
  if (code === AIErrorCode.AI_PROVIDER_TIMEOUT) return AIErrorCode.AI_PROVIDER_TIMEOUT;
  if (code === AIErrorCode.INVALID_AI_ARTIFACT) return AIErrorCode.INVALID_AI_ARTIFACT;
  if (code === AIErrorCode.AI_MODE_NOT_AVAILABLE) return AIErrorCode.AI_MODE_NOT_AVAILABLE;
  if (code === AIErrorCode.INVALID_REQUEST) return AIErrorCode.INVALID_REQUEST;
  return AIErrorCode.AI_PROVIDER_ERROR;
}

function parseAIMode(value: string): AIMode {
  if (value === AIMode.FEASIBILITY_ANALYSIS) return AIMode.FEASIBILITY_ANALYSIS;
  if (value === AIMode.PROGRESSIVE_HINT) return AIMode.PROGRESSIVE_HINT;
  if (value === AIMode.FULL_SOLUTION) return AIMode.FULL_SOLUTION;
  return AIMode.FAITHFUL_TRANSFORM;
}

function parseAIOutputKind(value: string): AIOutputKind {
  return value === AIOutputKind.CODE_SNIPPET ? AIOutputKind.CODE_SNIPPET : AIOutputKind.PSEUDOCODE;
}

function parseAIVisibility(value: string): AIVisibility {
  return value === AIVisibility.HIDDEN ? AIVisibility.HIDDEN : AIVisibility.VISIBLE;
}

function validateModeAvailability(mode: AIMode): string {
  if (mode === AIMode.FAITHFUL_TRANSFORM) return '';
  return '该 AI 模式尚未接入，保持不可用';
}

function trimBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_BASE_URL;
  return trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(resolve, ms);
  });
}

function safeLogValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').substring(0, 96);
}

function safeErrorCode(value: string): string {
  const sanitized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 64);
  return sanitized.length > 0 ? sanitized : 'UNKNOWN';
}
