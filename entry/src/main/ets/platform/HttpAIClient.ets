import http from '@ohos.net.http';
import { AIGatewayArtifactPayload } from '../domain/AIArtifactCodec';
import { AIGatewayReviewPayload } from '../domain/SyncModels';
import { AIMode, AIOutputKind, AIVisibility, ReviewKind } from '../domain/Models';

const DEFAULT_AI_BASE_URL = 'http://127.0.0.1:8788';

export class AIRequestInput {
  mode: string = AIMode.FAITHFUL_TRANSFORM;
  draft_id: string = '';
  draft_version: number = 0;
  language: string = 'cpp';
  rule_version: string = '1.0.0';
  problem_context: string = '';
  idea_segments: AIRequestIdeaSegment[] = [];
  output_kind: string = AIOutputKind.PSEUDOCODE;
  visibility: string = AIVisibility.VISIBLE;
}

export class AIRequestIdeaSegment {
  id: string = '';
  content: string = '';

  constructor(id: string, content: string) {
    this.id = id;
    this.content = content;
  }
}

export class ReviewRequestInput {
  mode: string = AIMode.FAITHFUL_TRANSFORM;
  draft_id: string = '';
  draft_version: number = 0;
  language: string = 'cpp';
  rule_version: string = '1.0.0';
  code: string = '';
  idea: string = '';
  review_kind: string = ReviewKind.RISK;
  visibility: string = AIVisibility.VISIBLE;
}

class AIErrorResponse {
  code: string = '';
}

export interface AIHttpRequestHandle {
  request(url: string, options: http.HttpRequestOptions): Promise<http.HttpResponse>;
  destroy(): void;
}

export class HttpAIClient {
  private baseUrl: string;
  private cancelActiveRequest: (() => void) | undefined = undefined;
  private requestCancelled: boolean = false;
  private requestFactory: () => AIHttpRequestHandle;

  constructor(baseUrl: string = DEFAULT_AI_BASE_URL, requestFactory?: () => AIHttpRequestHandle) {
    const trimmed = baseUrl.trim();
    this.baseUrl = trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
    this.requestFactory = requestFactory ?? (() => http.createHttp());
  }

  cancel(): void {
    this.requestCancelled = true;
    if (this.cancelActiveRequest !== undefined) this.cancelActiveRequest();
  }

  wasCancelled(): boolean {
    return this.requestCancelled;
  }

  async generate(request: AIRequestInput): Promise<AIGatewayArtifactPayload> {
    if (this.baseUrl.length === 0) throw new Error('AI_BASE_URL_REQUIRED');
    const response = await this.post('/requests', request);
    const body = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
    let parsed: AIGatewayArtifactPayload;
    try {
      parsed = JSON.parse(body) as AIGatewayArtifactPayload;
    } catch (error) {
      throw new Error('AI_INVALID_RESPONSE');
    }
    if (response.responseCode < 200 || response.responseCode >= 300) {
      let errorResponse: AIErrorResponse;
      try {
        errorResponse = JSON.parse(body) as AIErrorResponse;
      } catch (error) {
        throw new Error('AI_REQUEST_FAILED');
      }
      throw new Error(errorResponse.code.length > 0 ? errorResponse.code : 'AI_REQUEST_FAILED');
    }
    return parsed;
  }

  async review(request: ReviewRequestInput): Promise<AIGatewayReviewPayload> {
    if (this.baseUrl.length === 0) throw new Error('AI_BASE_URL_REQUIRED');
    const response = await this.post('/reviews', request);
    const body = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
    let parsed: AIGatewayReviewPayload;
    try {
      parsed = JSON.parse(body) as AIGatewayReviewPayload;
    } catch (error) {
      throw new Error('AI_INVALID_RESPONSE');
    }
    if (response.responseCode < 200 || response.responseCode >= 300) {
      let errorResponse: AIErrorResponse;
      try {
        errorResponse = JSON.parse(body) as AIErrorResponse;
      } catch (error) {
        throw new Error('AI_REQUEST_FAILED');
      }
      throw new Error(errorResponse.code.length > 0 ? errorResponse.code : 'AI_REQUEST_FAILED');
    }
    return parsed;
  }

  private async post(path: string, request: AIRequestInput | ReviewRequestInput): Promise<http.HttpResponse> {
    this.requestCancelled = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.requestCancelled) throw new Error('AI_REQUEST_CANCELLED');
      const client = this.requestFactory();
      let destroyed = false;
      const destroyRequest = (): void => {
        if (!destroyed) {
          destroyed = true;
          client.destroy();
        }
      };
      const cancelRequest = (): void => {
        this.requestCancelled = true;
        destroyRequest();
      };
      this.cancelActiveRequest = cancelRequest;
      try {
        const response = await client.request(`${this.baseUrl}${path}`, {
          method: http.RequestMethod.POST,
          header: { 'Content-Type': 'application/json' },
          extraData: JSON.stringify(request),
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 5000,
          readTimeout: 30000
        });
        if ([502, 503, 504].includes(response.responseCode) && attempt === 0) continue;
        return response;
      } catch (error) {
        if (this.requestCancelled) throw new Error('AI_REQUEST_CANCELLED');
        if (attempt === 1) throw new Error('AI_NETWORK_ERROR');
      } finally {
        if (this.cancelActiveRequest === cancelRequest) this.cancelActiveRequest = undefined;
        destroyRequest();
      }
    }
    throw new Error('AI_REQUEST_FAILED');
  }
}
