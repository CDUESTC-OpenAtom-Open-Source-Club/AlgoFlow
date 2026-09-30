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
  id: string;
  version: number;
  serverSequence: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  lastModifiedClientId: string;
  draftId: string;
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

  constructor(id: string, draftId: string, mode: AIMode = AIMode.FAITHFUL_TRANSFORM) {
    this.id = id;
    this.version = 0;
    this.serverSequence = 0;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.deleted = false;
    this.lastModifiedClientId = '';
    this.draftId = draftId;
    this.mode = mode;
    this.pseudocode = [];
    this.codeSnippet = null;
    this.codeMappings = [];
    this.assumptions = [];
    this.missingInformation = [];
    this.riskFlags = [];
    this.addedAlgorithmSteps = [];
    this.sourceDraftVersion = 0;
    this.modelId = '';
    this.ruleVersion = '';
    this.outputKind = AIOutputKind.PSEUDOCODE;
    this.visibility = AIVisibility.VISIBLE;
    this.templateId = null;
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
  }
}
