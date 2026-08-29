import { AIProvider, AIRequest, AIResult } from '../domain/AIProvider';

/**
 * 未启用 AI 供应商适配器。
 *
 * 未配置模型服务时，只返回“AI 未启用”，绝不伪造本地结果。
 * 后续接入真实供应商时，通过 AIProvider 端口替换本适配器即可。
 */
export class DisabledAIProvider implements AIProvider {
  async generate(_request: AIRequest): Promise<AIResult> {
    // 未配置模型服务：不生成任何结果，避免伪造。
    return AIResult.disabled('AI 未启用：未配置模型服务');
  }
}
