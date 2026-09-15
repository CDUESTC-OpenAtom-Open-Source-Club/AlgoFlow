import { AIArtifact, AIOutputKind, AIMode, AIVisibility, CodeMapping, PseudocodeStep } from './Models';

// Wire format for AI artifacts. Field names mirror packages/contracts/schemas/ai.schema.json
// ($defs.artifact) so persistence and sync stay aligned with the single source of truth.

export class PseudocodeStepPayload {
  id: string = '';
  step: string = '';
  source_refs: string[] = [];

  constructor(id: string = '', step: string = '', sourceRefs: string[] = []) {
    this.id = id;
    this.step = step;
    this.source_refs = sourceRefs;
  }
}

export class CodeMappingPayload {
  step_id: string = '';
  start_line: number = 0;
  end_line: number = 0;

  constructor(stepId: string = '', startLine: number = 0, endLine: number = 0) {
    this.step_id = stepId;
    this.start_line = startLine;
    this.end_line = endLine;
  }
}

export class AIArtifactPayload {
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
  payload.mode = artifact.mode;
  payload.pseudocode = artifact.pseudocode.map((step: PseudocodeStep) =>
    new PseudocodeStepPayload(step.id, step.step, step.sourceRefs.slice()));
  payload.code_snippet = artifact.codeSnippet;
  payload.code_mappings = artifact.codeMappings.map((mapping: CodeMapping) =>
    new CodeMappingPayload(mapping.stepId, mapping.startLine, mapping.endLine));
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

export function artifactsToPayloads(artifacts: AIArtifact[]): AIArtifactPayload[] {
  return artifacts.map((artifact: AIArtifact) => artifactToPayload(artifact));
}

export function payloadToArtifact(payload: AIArtifactPayload): AIArtifact {
  const artifact = new AIArtifact(
    parseAIMode(payload.mode),
    parseAIOutputKind(payload.output_kind),
    payload.source_draft_version,
    payload.model_id,
    payload.rule_version,
    parseAIVisibility(payload.visibility)
  );
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

export function payloadsToArtifacts(payloads: AIArtifactPayload[]): AIArtifact[] {
  return (payloads ?? []).map((payload: AIArtifactPayload) => payloadToArtifact(payload));
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
