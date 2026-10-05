import http from '@ohos.net.http';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AIProvider } from '../domain/AIProvider';
import { AIArtifact, AIErrorCode, AIOutputKind, AIMode, AIRequest, AIRequestSegment, AIResult,
  AIVisibility, CodeMapping, PseudocodeStep } from '../domain/Models';
import { AIContractGuard } from '../domain/AIContractGuard';
import { IDECapability, IDEProvider, IDEReply, IDERequest, IDERecord, buildIDERequest } from '../domain/IDEAIModels';
import { parseIDEResult } from '../domain/IDEAIContract';
import { DEBUG } from 'BuildProfile';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8788';
const RULE_VERSION = '1.0.0';

export class HttpAIProvider implements AIProvider, IDEProvider {
  private allowTestData: boolean = false;
  private baseUrl: string;
  private readTimeoutMs: number;
  private activeRequest: http.HttpRequest | null = null;
  private generation: number = 0;
  private cancelledGeneration: number = -1;

  constructor(baseUrl: string = DEFAULT_BASE_URL, maxRetries: number = 0, readTimeoutMs: number = 10000, allowTestData: boolean = false) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.readTimeoutMs = readTimeoutMs;
    this.allowTestData = DEBUG && allowTestData;
  }

  async request(body: IDERequest, capability: IDECapability): Promise<IDEReply> {
    this.cancel();
    const generation = ++this.generation;
    const reply = new IDEReply();
    if (body.mode !== AIMode.FAITHFUL_TRANSFORM) {
      reply.errorCode = 'AI_MODE_NOT_AVAILABLE'; reply.message = '当前模式尚未接入'; return reply;
    }
    const transport = http.createHttp(); this.activeRequest = transport;
    try {
      const path = capability === IDECapability.TRANSFORM ? '/requests' : capability === IDECapability.REVIEW ? '/reviews' : '/completions';
      const response = await transport.request(`${this.baseUrl}${path}`, {
        method: http.RequestMethod.POST, header: { 'Content-Type': 'application/json' }, extraData: JSON.stringify(body),
        expectDataType: http.HttpDataType.STRING, connectTimeout: 5000, readTimeout: this.readTimeoutMs
      });
      if (generation !== this.generation || this.isCancelled(generation)) {
        reply.errorCode = 'CANCELLED'; reply.message = '请求已取消'; return reply;
      }
      const headers = response.header as Record<string, string>;
      const marker = Object.keys(headers).find(key => key.toLowerCase() === 'x-algoflow-test-data');
      const testData = marker !== undefined && String(headers[marker]).trim().toLowerCase() === 'true';
      if (testData && !this.allowTestData) {
        reply.errorCode = 'AI_NOT_ENABLED'; reply.message = 'AI 不可用：当前配置不允许测试数据'; return reply;
      }
      reply.isTestData = testData;
      if (response.responseCode !== 200) {
        const error = mapHttpError(response.responseCode, ''); reply.errorCode = error.code; reply.message = error.message; return reply;
      }
      reply.body = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      return reply;
    } catch (error) {
      reply.errorCode = generation !== this.generation || this.isCancelled(generation) ? 'CANCELLED' : 'NETWORK_ERROR';
      reply.message = reply.errorCode === 'CANCELLED' ? '请求已取消' : 'AI 服务不可达，请检查地址或网络后重试'; return reply;
    } finally {
      if (this.activeRequest === transport) this.activeRequest = null;
      transport.destroy();
    }
  }

  cancel(): void {
    this.cancelledGeneration = this.generation;
    const request = this.activeRequest;
    this.activeRequest = null;
    if (request !== null) request.destroy();
  }

  async generate(request: AIRequest): Promise<AIResult> {
    const record = new IDERecord(); record.capability = IDECapability.TRANSFORM;
    record.context.draftId = request.draftId; record.context.version = request.draftVersion;
    record.context.mode = request.mode; record.context.segments = request.ideaSegments;
    record.context.problemContext = request.problemContext;
    const reply = await this.request(buildIDERequest(record), IDECapability.TRANSFORM);
    if (reply.errorCode.length > 0) {
      const code = reply.errorCode === 'CANCELLED' ? AIErrorCode.CANCELLED : reply.errorCode === 'NETWORK_ERROR' ? AIErrorCode.NETWORK_ERROR : parseErrorCode(reply.errorCode);
      return AIResult.failure(code, reply.message);
    }
    try { parseIDEResult(reply.body, record); }
    catch (error) { return AIResult.failure(AIErrorCode.INVALID_AI_ARTIFACT, 'AI 产物不符合契约'); }
    return this.parseSuccess(reply.body, request);
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


function trimBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_BASE_URL;
  return trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
}


function safeLogValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').substring(0, 96);
}

function safeErrorCode(value: string): string {
  const sanitized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_').substring(0, 64);
  return sanitized.length > 0 ? sanitized : 'UNKNOWN';
}
