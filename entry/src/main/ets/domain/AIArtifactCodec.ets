import { AIArtifact, AIOutputKind, AIMode, AIVisibility, CodeMapping, PseudocodeStep } from './Models';

export class PseudocodeStepPayload {
  id: string = '';
  step: string = '';
  source_refs: string[] = [];
}

export class CodeMappingPayload {
  step_id: string = '';
  start_line: number = 0;
  end_line: number = 0;
}

export class AIArtifactPayload {
  id: string = '';
  version: number = 0;
  server_sequence: number = 0;
  created_at: string = '';
  updated_at: string = '';
  deleted: boolean = false;
  last_modified_client_id: string = '';
  draft_id: string = '';
  mode: string = AIMode.FAITHFUL_TRANSFORM;
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
  output_kind: string = AIOutputKind.PSEUDOCODE;
  visibility: string = AIVisibility.VISIBLE;
  template_id: string | null = null;
}

export function artifactToPayload(artifact: AIArtifact): AIArtifactPayload {
  const payload = new AIArtifactPayload();
  payload.id = artifact.id;
  payload.version = artifact.version;
  payload.server_sequence = artifact.serverSequence;
  payload.created_at = artifact.createdAt;
  payload.updated_at = artifact.updatedAt;
  payload.deleted = artifact.deleted;
  payload.last_modified_client_id = artifact.lastModifiedClientId;
  payload.draft_id = artifact.draftId;
  payload.mode = artifact.mode;
  payload.pseudocode = artifact.pseudocode.map((step: PseudocodeStep) => {
    const item = new PseudocodeStepPayload();
    item.id = step.id;
    item.step = step.step;
    item.source_refs = step.sourceRefs.slice();
    return item;
  });
  payload.code_snippet = artifact.codeSnippet;
  payload.code_mappings = artifact.codeMappings.map((mapping: CodeMapping) => {
    const item = new CodeMappingPayload();
    item.step_id = mapping.stepId;
    item.start_line = mapping.startLine;
    item.end_line = mapping.endLine;
    return item;
  });
  payload.assumptions = artifact.assumptions.slice();
  payload.missing_information = artifact.missingInformation.slice();
  payload.risk_flags = artifact.riskFlags.slice();
  payload.added_algorithm_steps = artifact.addedAlgorithmSteps.slice();
  payload.source_draft_version = artifact.sourceDraftVersion;
  payload.model_id = artifact.modelId;
  payload.rule_version = artifact.ruleVersion;
  payload.output_kind = artifact.outputKind;
  payload.visibility = artifact.visibility;
  payload.template_id = artifact.templateId;
  return payload;
}

export function payloadToArtifact(payload: AIArtifactPayload): AIArtifact | undefined {
  if (payload.id.length === 0 || payload.draft_id.length === 0 || payload.created_at.length === 0 ||
    payload.updated_at.length === 0 || payload.last_modified_client_id.length === 0 || payload.model_id.length === 0 ||
    payload.rule_version.length === 0 || payload.source_draft_version < 0 || payload.version < 0 || payload.server_sequence < 0 ||
    !Array.isArray(payload.pseudocode) || !Array.isArray(payload.code_mappings) ||
    !Array.isArray(payload.assumptions) || !Array.isArray(payload.missing_information) ||
    !Array.isArray(payload.risk_flags) || !Array.isArray(payload.added_algorithm_steps)) return undefined;
  const mode = parseMode(payload.mode);
  const outputKind = parseOutputKind(payload.output_kind);
  const visibility = parseVisibility(payload.visibility);
  if (mode === undefined || outputKind === undefined || visibility === undefined) return undefined;
  if (mode === AIMode.FAITHFUL_TRANSFORM && payload.added_algorithm_steps.length > 0) return undefined;
  if (outputKind === AIOutputKind.PSEUDOCODE && (payload.code_snippet !== null || payload.code_mappings.length > 0)) return undefined;
  if (outputKind === AIOutputKind.CODE_SNIPPET && (payload.code_snippet === null || payload.code_snippet.length === 0 || payload.code_mappings.length === 0)) return undefined;
  for (const step of payload.pseudocode) {
    if (step.id.length === 0 || step.step.length === 0 || step.source_refs.length === 0) return undefined;
    for (const sourceRef of step.source_refs) if (sourceRef.length === 0) return undefined;
  }
  const artifact = new AIArtifact(payload.id, payload.draft_id, mode);
  artifact.version = payload.version;
  artifact.serverSequence = payload.server_sequence;
  artifact.createdAt = payload.created_at;
  artifact.updatedAt = payload.updated_at;
  artifact.deleted = payload.deleted;
  artifact.lastModifiedClientId = payload.last_modified_client_id;
  artifact.pseudocode = (payload.pseudocode ?? []).map((step: PseudocodeStepPayload) =>
    new PseudocodeStep(step.id, step.step, step.source_refs.slice()));
  artifact.codeSnippet = payload.code_snippet;
  artifact.codeMappings = (payload.code_mappings ?? []).map((mapping: CodeMappingPayload) =>
    new CodeMapping(mapping.step_id, mapping.start_line, mapping.end_line));
  artifact.assumptions = (payload.assumptions ?? []).slice();
  artifact.missingInformation = (payload.missing_information ?? []).slice();
  artifact.riskFlags = (payload.risk_flags ?? []).slice();
  artifact.addedAlgorithmSteps = (payload.added_algorithm_steps ?? []).slice();
  artifact.sourceDraftVersion = payload.source_draft_version;
  artifact.modelId = payload.model_id;
  artifact.ruleVersion = payload.rule_version;
  artifact.outputKind = outputKind;
  artifact.visibility = visibility;
  artifact.templateId = payload.template_id;
  return artifact;
}

function parseMode(value: string): AIMode | undefined {
  if (value === AIMode.FAITHFUL_TRANSFORM) return AIMode.FAITHFUL_TRANSFORM;
  if (value === AIMode.FEASIBILITY_ANALYSIS) return AIMode.FEASIBILITY_ANALYSIS;
  if (value === AIMode.PROGRESSIVE_HINT) return AIMode.PROGRESSIVE_HINT;
  if (value === AIMode.FULL_SOLUTION) return AIMode.FULL_SOLUTION;
  return undefined;
}

function parseOutputKind(value: string): AIOutputKind | undefined {
  if (value === AIOutputKind.PSEUDOCODE) return AIOutputKind.PSEUDOCODE;
  if (value === AIOutputKind.CODE_SNIPPET) return AIOutputKind.CODE_SNIPPET;
  return undefined;
}

function parseVisibility(value: string): AIVisibility | undefined {
  if (value === AIVisibility.VISIBLE) return AIVisibility.VISIBLE;
  if (value === AIVisibility.HIDDEN) return AIVisibility.HIDDEN;
  return undefined;
}
