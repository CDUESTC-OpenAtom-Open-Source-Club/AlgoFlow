import { AIArtifact, AIMode } from './Models';

/**
 * AI 契约守卫（纯领域规则，不依赖 ArkUI / 网络 / 模型 SDK）。
 *
 * 不可协商规则：
 *  1. 忠实转换（FAITHFUL_TRANSFORM）的 added_algorithm_steps 必须为空，否则判定越界。
 *  2. 每个伪代码步骤必须携带 source_refs，且必须引用当前请求中真实存在的片段。
 * 满足任一越界条件时，调用方必须拒绝保存，不得把结果混入用户原思路。
 */

export class AIValidationResult {
  valid: boolean;
  reason: string;

  constructor(valid: boolean, reason: string) {
    this.valid = valid;
    this.reason = reason;
  }

  static ok(): AIValidationResult {
    return new AIValidationResult(true, '');
  }

  static reject(reason: string): AIValidationResult {
    return new AIValidationResult(false, reason);
  }
}

export class AIContractGuard {
  /**
   * 校验 AI 产物是否可保存。
   * @param artifact 待保存产物
   * @param validSegmentIds 当前草稿真实存在的片段 id 集合
   */
  static validate(artifact: AIArtifact, validSegmentIds: string[]): AIValidationResult {
    if (artifact === null || artifact === undefined) {
      return AIValidationResult.reject('AI 结果为空');
    }
    // 忠实转换不允许新增算法步骤
    if (artifact.mode === AIMode.FAITHFUL_TRANSFORM) {
      if (artifact.payload.addedAlgorithmSteps.length > 0) {
        return AIValidationResult.reject('越界：忠实转换模式不得新增算法步骤');
      }
    }
    // 每个伪代码步骤必须有来源引用
    for (let i = 0; i < artifact.payload.pseudocode.length; i++) {
      const step = artifact.payload.pseudocode[i];
      if (step.sourceRefs.length === 0) {
        return AIValidationResult.reject(`越界：第 ${i + 1} 个伪代码步骤缺少来源引用`);
      }
      for (let j = 0; j < step.sourceRefs.length; j++) {
        const ref = step.sourceRefs[j];
        if (validSegmentIds.indexOf(ref) < 0) {
          return AIValidationResult.reject(`越界：伪代码步骤引用了不存在的片段 ${ref}`);
        }
      }
    }
    return AIValidationResult.ok();
  }
}
