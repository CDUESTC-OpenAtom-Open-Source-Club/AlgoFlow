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

export class AIGatewayArtifactPayload {
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

export function payloadToArtifact(payload: AIArtifactPayload, sourceSegmentIds?: string[]): AIArtifact | undefined {
  if (payload === undefined || payload === null || typeof payload.id !== 'string' || payload.id.length === 0 ||
    typeof payload.draft_id !== 'string' || payload.draft_id.length === 0 || typeof payload.created_at !== 'string' ||
    payload.created_at.length === 0 || !payload.created_at.endsWith('Z') || Number.isNaN(Date.parse(payload.created_at)) ||
    typeof payload.updated_at !== 'string' || payload.updated_at.length === 0 || !payload.updated_at.endsWith('Z') ||
    Number.isNaN(Date.parse(payload.updated_at)) || typeof payload.last_modified_client_id !== 'string' ||
    payload.last_modified_client_id.length === 0 || typeof payload.model_id !== 'string' || payload.model_id.length === 0 ||
    typeof payload.rule_version !== 'string' || payload.rule_version.length === 0 || typeof payload.version !== 'number' ||
    !Number.isInteger(payload.version) || typeof payload.server_sequence !== 'number' || !Number.isInteger(payload.server_sequence) ||
    typeof payload.source_draft_version !== 'number' || !Number.isInteger(payload.source_draft_version) ||
    payload.source_draft_version < 0 || payload.version < 0 || payload.server_sequence < 0 || typeof payload.deleted !== 'boolean' ||
    !Array.isArray(payload.pseudocode) || !Array.isArray(payload.code_mappings) ||
    !Array.isArray(payload.assumptions) || payload.assumptions.some((item: string) => typeof item !== 'string') ||
    !Array.isArray(payload.missing_information) || payload.missing_information.some((item: string) => typeof item !== 'string') ||
    !Array.isArray(payload.risk_flags) || payload.risk_flags.some((item: string) => typeof item !== 'string') ||
    !Array.isArray(payload.added_algorithm_steps) || payload.added_algorithm_steps.some((item: string) => typeof item !== 'string') ||
    (payload.code_snippet !== null && typeof payload.code_snippet !== 'string') ||
    (typeof payload.code_snippet === 'string' && (payload.code_snippet.length > 4000 || /\b(?:int|signed|auto|void)\s+main\s*\(/.test(payload.code_snippet))) ||
    (payload.template_id !== null && typeof payload.template_id !== 'string')) return undefined;
  const mode = parseMode(payload.mode);
  const outputKind = parseOutputKind(payload.output_kind);
  const visibility = parseVisibility(payload.visibility);
  if (mode === undefined || outputKind === undefined || visibility === undefined) return undefined;
  if (mode === AIMode.FAITHFUL_TRANSFORM && payload.added_algorithm_steps.length > 0) return undefined;
  if (outputKind === AIOutputKind.PSEUDOCODE && (payload.code_snippet !== null || payload.code_mappings.length > 0)) return undefined;
  if (outputKind === AIOutputKind.CODE_SNIPPET && (payload.code_snippet === null || payload.code_snippet.length === 0 || payload.code_mappings.length === 0)) return undefined;
  const stepIds = new Set<string>();
  const sourceIds = sourceSegmentIds === undefined ? undefined : new Set<string>(sourceSegmentIds);
  for (const step of payload.pseudocode) {
    if (step === undefined || step === null || typeof step.id !== 'string' || step.id.length === 0 || stepIds.has(step.id) ||
      typeof step.step !== 'string' || step.step.length === 0 || !Array.isArray(step.source_refs) || step.source_refs.length === 0) return undefined;
    stepIds.add(step.id);
    for (const sourceRef of step.source_refs) if (typeof sourceRef !== 'string' || sourceRef.length === 0) return undefined;
    if (sourceIds !== undefined) for (const sourceRef of step.source_refs) if (!sourceIds.has(sourceRef)) return undefined;
  }
  for (const mapping of payload.code_mappings) {
    if (mapping === undefined || mapping === null || typeof mapping.step_id !== 'string' || !stepIds.has(mapping.step_id) ||
      typeof mapping.start_line !== 'number' || !Number.isInteger(mapping.start_line) || mapping.start_line < 1 ||
      typeof mapping.end_line !== 'number' || !Number.isInteger(mapping.end_line) || mapping.end_line < mapping.start_line) return undefined;
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

export function gatewayPayloadToArtifact(payload: AIGatewayArtifactPayload, id: string, draftId: string,
  draftVersion: number, clientId: string, sourceSegmentIds: string[]): AIArtifact | undefined {
  if (payload === undefined || payload === null) return undefined;
  const entity = new AIArtifactPayload();
  entity.id = id;
  entity.version = 0;
  entity.server_sequence = 0;
  entity.created_at = new Date().toISOString();
  entity.updated_at = entity.created_at;
  entity.deleted = false;
  entity.last_modified_client_id = clientId;
  entity.draft_id = draftId;
  entity.mode = payload.mode;
  entity.pseudocode = payload.pseudocode;
  entity.code_snippet = payload.code_snippet;
  entity.code_mappings = payload.code_mappings;
  entity.assumptions = payload.assumptions;
  entity.missing_information = payload.missing_information;
  entity.risk_flags = payload.risk_flags;
  entity.added_algorithm_steps = payload.added_algorithm_steps;
  entity.source_draft_version = draftVersion;
  entity.model_id = payload.model_id;
  entity.rule_version = payload.rule_version;
  entity.output_kind = payload.output_kind;
  entity.visibility = payload.visibility;
  entity.template_id = payload.template_id;
  return payloadToArtifact(entity, sourceSegmentIds);
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
