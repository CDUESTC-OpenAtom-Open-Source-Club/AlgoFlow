export enum SyncStatus {
  LOCAL_ONLY = 'local_only',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  CONFLICT = 'conflict',
  FAILED = 'failed'
}

export enum AIMode {
  FAITHFUL_TRANSFORM = 'faithful_transform',
  FEASIBILITY_ANALYSIS = 'feasibility_analysis',
  PROGRESSIVE_HINT = 'progressive_hint',
  FULL_SOLUTION = 'full_solution'
}

export enum AIOutputKind {
  PSEUDOCODE = 'pseudocode',
  CODE_SNIPPET = 'code_snippet'
}

export enum AIVisibility {
  VISIBLE = 'visible',
  HIDDEN = 'hidden'
}

export enum AIErrorCode {
  NONE = 'NONE',
  AI_NOT_ENABLED = 'AI_NOT_ENABLED',
  AI_PROVIDER_ERROR = 'AI_PROVIDER_ERROR',
  AI_PROVIDER_TIMEOUT = 'AI_PROVIDER_TIMEOUT',
  INVALID_AI_ARTIFACT = 'INVALID_AI_ARTIFACT',
  AI_MODE_NOT_AVAILABLE = 'AI_MODE_NOT_AVAILABLE',
  INVALID_REQUEST = 'INVALID_REQUEST',
  NETWORK_ERROR = 'NETWORK_ERROR',
  CANCELLED = 'CANCELLED',
  CONTRACT_VIOLATION = 'CONTRACT_VIOLATION'
}

export enum AIResultStatus {
  SUCCESS = 'success',
  FAILURE = 'failure'
}

export class IdeaSegment {
  id: string;
  content: string;
  position: number;

  constructor(id: string, content: string, position: number) {
    this.id = id;
    this.content = content;
    this.position = position;
  }
}

export class PseudocodeStep {
  id: string;
  step: string;
  sourceRefs: string[];

  constructor(id: string, step: string, sourceRefs: string[]) {
    this.id = id;
    this.step = step;
    this.sourceRefs = sourceRefs;
  }

  clone(): PseudocodeStep {
    return new PseudocodeStep(this.id, this.step, this.sourceRefs.slice());
  }
}

export class CodeMapping {
  stepId: string;
  startLine: number;
  endLine: number;

  constructor(stepId: string, startLine: number, endLine: number) {
    this.stepId = stepId;
    this.startLine = startLine;
    this.endLine = endLine;
  }
}

export class AIArtifact {
  mode: AIMode;
  pseudocode: PseudocodeStep[];
  codeSnippet: string | null;
  codeMappings: CodeMapping[];
  assumptions: string[];
  missingInformation: string[];
  riskFlags: string[];
  addedAlgorithmSteps: string[];
  sourceDraftVersion: number;
  modelId: string;
  ruleVersion: string;
  outputKind: AIOutputKind;
  visibility: AIVisibility;
  templateId: string | null;

  constructor(mode: AIMode, outputKind: AIOutputKind, sourceDraftVersion: number, modelId: string,
    ruleVersion: string, visibility: AIVisibility) {
    this.mode = mode;
    this.outputKind = outputKind;
    this.sourceDraftVersion = sourceDraftVersion;
    this.modelId = modelId;
    this.ruleVersion = ruleVersion;
    this.visibility = visibility;
    this.pseudocode = [];
    this.codeSnippet = null;
    this.codeMappings = [];
    this.assumptions = [];
    this.missingInformation = [];
    this.riskFlags = [];
    this.addedAlgorithmSteps = [];
    this.templateId = null;
  }

  clone(): AIArtifact {
    const copy = new AIArtifact(this.mode, this.outputKind, this.sourceDraftVersion, this.modelId,
      this.ruleVersion, this.visibility);
    copy.pseudocode = this.pseudocode.map((step: PseudocodeStep) => step.clone());
    copy.codeSnippet = this.codeSnippet;
    copy.codeMappings = this.codeMappings.map((mapping: CodeMapping) =>
      new CodeMapping(mapping.stepId, mapping.startLine, mapping.endLine));
    copy.assumptions = this.assumptions.slice();
    copy.missingInformation = this.missingInformation.slice();
    copy.riskFlags = this.riskFlags.slice();
    copy.addedAlgorithmSteps = this.addedAlgorithmSteps.slice();
    copy.templateId = this.templateId;
    return copy;
  }
}

export class AIRequestSegment {
  id: string;
  content: string;

  constructor(id: string, content: string) {
    this.id = id;
    this.content = content;
  }
}

export class AIRequest {
  mode: AIMode;
  draftId: string;
  draftVersion: number;
  language: string;
  ruleVersion: string;
  problemContext: string;
  ideaSegments: AIRequestSegment[];
  outputKind: AIOutputKind;
  visibility: AIVisibility;

  constructor(mode: AIMode, draftId: string, draftVersion: number, language: string,
    ruleVersion: string, problemContext: string, ideaSegments: AIRequestSegment[],
    outputKind: AIOutputKind, visibility: AIVisibility) {
    this.mode = mode;
    this.draftId = draftId;
    this.draftVersion = draftVersion;
    this.language = language;
    this.ruleVersion = ruleVersion;
    this.problemContext = problemContext;
    this.ideaSegments = ideaSegments;
    this.outputKind = outputKind;
    this.visibility = visibility;
  }
}

export class AIResult {
  status: AIResultStatus;
  artifact: AIArtifact | null;
  errorCode: AIErrorCode;
  message: string;

  constructor(status: AIResultStatus, artifact: AIArtifact | null, errorCode: AIErrorCode,
    message: string) {
    this.status = status;
    this.artifact = artifact;
    this.errorCode = errorCode;
    this.message = message;
  }

  static success(artifact: AIArtifact): AIResult {
    return new AIResult(AIResultStatus.SUCCESS, artifact, AIErrorCode.NONE, '');
  }

  static failure(errorCode: AIErrorCode, message: string): AIResult {
    return new AIResult(AIResultStatus.FAILURE, null, errorCode, message);
  }
}

export class Draft {
  id: string;
  workspaceId: string;
  title: string;
  idea: string;
  code: string;
  shortCode: string;
  rewrite: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  lastModifiedClientId: string;
  syncStatus: SyncStatus;
  aiMode: AIMode;
  artifactHidden: boolean;
  ideaSegments: IdeaSegment[];
  aiArtifacts: AIArtifact[];

  constructor(id: string, title: string) {
    this.id = id;
    this.workspaceId = 'workspace-local';
    this.title = title;
    this.idea = '';
    this.code = '';
    this.shortCode = '';
    this.rewrite = '';
    this.version = 0;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.deleted = false;
    this.lastModifiedClientId = '';
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.aiMode = AIMode.FAITHFUL_TRANSFORM;
    this.artifactHidden = false;
    this.ideaSegments = [];
    this.aiArtifacts = [];
  }

  artifactForMode(mode: AIMode): AIArtifact | undefined {
    return this.aiArtifacts.find((artifact: AIArtifact) => artifact.mode === mode);
  }
}
