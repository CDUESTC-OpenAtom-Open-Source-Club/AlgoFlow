import { AIArtifact, AIMode, CodeLanguage } from './Models';

/**
 * AI 供应商端口（领域层）。
 * UI 与领域模型不绑定任何具体供应商；未配置模型时返回 AI_NOT_ENABLED，不得伪造结果。
 */

// —— AI 请求中的思路片段（稳定 id + 内容）——
export class AIRequestSegment {
  id: string;
  content: string;

  constructor(id: string, content: string) {
    this.id = id;
    this.content = content;
  }
}

// —— AI 请求（与 ai.schema.json#request 对齐）——
export class AIRequest {
  mode: AIMode;
  draftId: string;
  draftVersion: number;
  language: CodeLanguage;
  ruleVersion: string;
  ideaSegments: AIRequestSegment[];

  constructor(mode: AIMode, draftId: string, draftVersion: number, language: CodeLanguage,
    ruleVersion: string, ideaSegments: AIRequestSegment[]) {
    this.mode = mode;
    this.draftId = draftId;
    this.draftVersion = draftVersion;
    this.language = language;
    this.ruleVersion = ruleVersion;
    this.ideaSegments = ideaSegments;
  }
}

// —— AI 供应商状态 ——
export enum AIProviderState {
  DISABLED = 'disabled',
  ENABLED = 'enabled'
}

// —— AI 结果：未启用 / 正常产物 / 可读错误 ——
export class AIResult {
  state: AIProviderState;
  artifact: AIArtifact | null;
  errorMessage: string;

  constructor(state: AIProviderState, artifact: AIArtifact | null, errorMessage: string) {
    this.state = state;
    this.artifact = artifact;
    this.errorMessage = errorMessage;
  }

  static disabled(message: string): AIResult {
    return new AIResult(AIProviderState.DISABLED, null, message);
  }

  static enabled(artifact: AIArtifact): AIResult {
    return new AIResult(AIProviderState.ENABLED, artifact, '');
  }
}

export interface AIProvider {
  generate(request: AIRequest): Promise<AIResult>;
}
