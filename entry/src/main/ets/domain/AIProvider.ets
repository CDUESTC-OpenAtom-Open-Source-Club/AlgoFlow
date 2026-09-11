import { AIRequest, AIResult } from './Models';

export interface AIProvider {
  generate(request: AIRequest): Promise<AIResult>;
}
