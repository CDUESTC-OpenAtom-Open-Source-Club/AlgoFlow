import http from '@ohos.net.http';
import { AIGatewayArtifactPayload } from '../domain/AIArtifactCodec';
import { AIMode, AIOutputKind, AIVisibility } from '../domain/Models';

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

class AIErrorResponse {
  code: string = '';
}

export class HttpAIClient {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_AI_BASE_URL) {
    const trimmed = baseUrl.trim();
    this.baseUrl = trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
  }

  async generate(request: AIRequestInput): Promise<AIGatewayArtifactPayload> {
    if (this.baseUrl.length === 0) throw new Error('AI_BASE_URL_REQUIRED');
    const client = http.createHttp();
    try {
      let response: http.HttpResponse;
      try {
        response = await client.request(`${this.baseUrl}/requests`, {
          method: http.RequestMethod.POST,
          header: { 'Content-Type': 'application/json' },
          extraData: JSON.stringify(request),
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 5000,
          readTimeout: 30000
        });
      } catch (error) {
        throw new Error('AI_NETWORK_ERROR');
      }
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
    } finally {
      client.destroy();
    }
  }
}
