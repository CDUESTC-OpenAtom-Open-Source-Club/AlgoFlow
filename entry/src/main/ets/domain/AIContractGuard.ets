import { AIArtifact, AIRequest, AIRequestSegment, AIMode } from './Models';

export class AIContractGuard {
  static validateArtifactAgainstRequest(artifact: AIArtifact, request: AIRequest): string[] {
    const errors: string[] = [];
    if (artifact.mode !== request.mode) {
      errors.push('artifact mode must match request mode');
    }
    if (artifact.sourceDraftVersion !== request.draftVersion) {
      errors.push('artifact source_draft_version must match request draft_version');
    }
    if (artifact.ruleVersion !== request.ruleVersion) {
      errors.push('artifact rule_version must match request rule_version');
    }
    if (artifact.outputKind !== request.outputKind) {
      errors.push('artifact output_kind must match request output_kind');
    }
    if (artifact.visibility !== request.visibility) {
      errors.push('artifact visibility must match request visibility');
    }
    if (artifact.mode === AIMode.FAITHFUL_TRANSFORM && artifact.addedAlgorithmSteps.length > 0) {
      errors.push('faithful transform cannot add algorithm steps');
    }
    const sourceIds: string[] = request.ideaSegments.map((segment: AIRequestSegment) => segment.id);
    artifact.pseudocode.forEach((step, index: number) => {
      if (step.sourceRefs.length === 0) {
        errors.push(`pseudocode[${index}].source_refs must not be empty`);
        return;
      }
      step.sourceRefs.forEach((reference: string) => {
        if (!sourceIds.includes(reference)) {
          errors.push(`pseudocode[${index}] unknown source_ref: ${reference}`);
        }
      });
    });
    return errors;
  }

  static isValid(artifact: AIArtifact, request: AIRequest): boolean {
    return AIContractGuard.validateArtifactAgainstRequest(artifact, request).length === 0;
  }
}
