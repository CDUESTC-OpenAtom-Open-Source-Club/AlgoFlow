/**
 * AlgoFlow 领域模型（客户端内部实现，语义对齐 packages/contracts/schemas）。
 *
 * 契约事实来源：packages/contracts/schemas/{domain,ai,sync}.schema.json。
 * 说明：
 *  - CodeDocument / AIArtifact 在架构上为独立实体；手机端 MVP 单端闭环中把它们作为
 *    Draft 聚合内的强类型集合保存，各自持有稳定 id 与 version，避免破坏依赖方向。
 *  - 本文件禁止使用 any，禁止运行时动态改变对象结构。
 */

// —— 同步状态（与 domain.schema.json#syncStatus 对齐，仅这 5 个值）——
export enum SyncStatus {
  LOCAL_ONLY = 'local_only',
  SYNCING = 'syncing',
  SYNCED = 'synced',
  CONFLICT = 'conflict',
  FAILED = 'failed'
}

// —— AI 模式（与 domain.schema.json#aiMode 对齐）——
export enum AIMode {
  FAITHFUL_TRANSFORM = 'faithful_transform',
  FEASIBILITY_ANALYSIS = 'feasibility_analysis',
  PROGRESSIVE_HINT = 'progressive_hint',
  FULL_SOLUTION = 'full_solution'
}

// —— 代码来源（架构文档 7.1：CodeDocument.origin）——
export enum CodeOrigin {
  USER = 'user',
  AI_FAITHFUL = 'ai_faithful',
  USER_REWRITE = 'user_rewrite',
  AI_HINT = 'ai_hint',
  AI_SOLUTION = 'ai_solution'
}

// —— 语言（首版仅 cpp，与 ai.schema.json#request.language 对齐）——
export enum CodeLanguage {
  CPP = 'cpp'
}

// —— 同步操作类型 / 实体类型 / 冲突解决（与 sync.schema.json 对齐）——
export enum OperationType {
  UPSERT = 'upsert',
  DELETE = 'delete'
}

export enum EntityType {
  DRAFT = 'draft',
  CODE_DOCUMENT = 'code_document',
  AI_ARTIFACT = 'ai_artifact'
}

export enum ConflictResolution {
  UNRESOLVED = 'unresolved',
  KEEP_SERVER = 'keep_server',
  KEEP_LOCAL = 'keep_local'
}

// —— 思路片段（可被 AI 稳定引用的单元）——
export class IdeaSegment {
  id: string;
  draftId: string;
  position: number;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  lastModifiedClientId: string;

  constructor(id: string, draftId: string, position: number, content: string, clientId: string) {
    this.id = id;
    this.draftId = draftId;
    this.position = position;
    this.content = content;
    this.version = 0;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
    this.deleted = false;
    this.lastModifiedClientId = clientId;
  }
}

// —— 代码文档（用户代码 / AI 代码 / 复写代码的独立版本）——
export class CodeDocument {
  id: string;
  draftId: string;
  origin: CodeOrigin;
  content: string;
  language: CodeLanguage;
  baseDraftVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  lastModifiedClientId: string;

  constructor(id: string, draftId: string, origin: CodeOrigin, content: string,
    language: CodeLanguage, baseDraftVersion: number, clientId: string) {
    this.id = id;
    this.draftId = draftId;
    this.origin = origin;
    this.content = content;
    this.language = language;
    this.baseDraftVersion = baseDraftVersion;
    this.version = 0;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
    this.deleted = false;
    this.lastModifiedClientId = clientId;
  }
}

// —— 伪代码步骤（step + source_refs，来源引用不可缺失）——
export class PseudocodeStep {
  step: string;
  sourceRefs: string[];

  constructor(step: string, sourceRefs: string[]) {
    this.step = step;
    this.sourceRefs = sourceRefs;
  }
}

// —— AI 产物载荷（与 ai.schema.json#artifact 对齐）——
export class AIArtifactPayload {
  pseudocode: PseudocodeStep[];
  codeSnippet: string;
  assumptions: string[];
  missingInformation: string[];
  riskFlags: string[];
  addedAlgorithmSteps: string[];

  constructor() {
    this.pseudocode = [];
    this.codeSnippet = '';
    this.assumptions = [];
    this.missingInformation = [];
    this.riskFlags = [];
    this.addedAlgorithmSteps = [];
  }
}

// —— AI 产物（不可变版本，重新生成时新建记录，不原地覆盖）——
export class AIArtifact {
  id: string;
  draftId: string;
  mode: AIMode;
  payload: AIArtifactPayload;
  modelId: string;
  ruleVersion: string;
  sourceVersion: number;
  hidden: boolean;
  version: number;
  createdAt: string;

  constructor(id: string, draftId: string, mode: AIMode, payload: AIArtifactPayload,
    modelId: string, ruleVersion: string, sourceVersion: number) {
    this.id = id;
    this.draftId = draftId;
    this.mode = mode;
    this.payload = payload;
    this.modelId = modelId;
    this.ruleVersion = ruleVersion;
    this.sourceVersion = sourceVersion;
    this.hidden = false;
    this.version = 0;
    this.createdAt = new Date().toISOString();
  }
}

// —— 草稿（聚合根，携带思路片段 / 代码文档 / AI 产物集合）——
export class Draft {
  id: string;
  workspaceId: string;
  title: string;
  language: CodeLanguage;
  /** 用户原始思路文本（编辑面），派生 ideaSegments 供 AI 引用。 */
  ideaText: string;
  ideaSegments: IdeaSegment[];
  codeDocuments: CodeDocument[];
  aiArtifacts: AIArtifact[];
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  lastModifiedClientId: string;
  syncStatus: SyncStatus;
  artifactHidden: boolean;

  constructor(id: string, title: string, workspaceId: string, clientId: string) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.title = title;
    this.language = CodeLanguage.CPP;
    this.ideaText = '';
    this.ideaSegments = [];
    this.codeDocuments = [];
    this.aiArtifacts = [];
    this.version = 0;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
    this.deleted = false;
    this.lastModifiedClientId = clientId;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.artifactHidden = false;
  }

  // 深拷贝（用于生成本地冲突副本，严禁静默覆盖）
  clone(): Draft {
    const copy = new Draft(this.id, this.title, this.workspaceId, this.lastModifiedClientId);
    copy.language = this.language;
    copy.ideaText = this.ideaText;
    copy.version = this.version;
    copy.createdAt = this.createdAt;
    copy.updatedAt = this.updatedAt;
    copy.deleted = this.deleted;
    copy.syncStatus = this.syncStatus;
    copy.artifactHidden = this.artifactHidden;
    copy.ideaSegments = this.ideaSegments.map((s: IdeaSegment): IdeaSegment => {
      const seg = new IdeaSegment(s.id, s.draftId, s.position, s.content, s.lastModifiedClientId);
      seg.version = s.version;
      seg.createdAt = s.createdAt;
      seg.updatedAt = s.updatedAt;
      seg.deleted = s.deleted;
      return seg;
    });
    copy.codeDocuments = this.codeDocuments.map((d: CodeDocument): CodeDocument => {
      const doc = new CodeDocument(d.id, d.draftId, d.origin, d.content, d.language, d.baseDraftVersion, d.lastModifiedClientId);
      doc.version = d.version;
      doc.createdAt = d.createdAt;
      doc.updatedAt = d.updatedAt;
      doc.deleted = d.deleted;
      return doc;
    });
    copy.aiArtifacts = this.aiArtifacts.map((a: AIArtifact): AIArtifact => {
      const art = new AIArtifact(a.id, a.draftId, a.mode, a.payload, a.modelId, a.ruleVersion, a.sourceVersion);
      art.hidden = a.hidden;
      art.version = a.version;
      art.createdAt = a.createdAt;
      return art;
    });
    return copy;
  }
}

// —— 同步操作载荷（强类型，避免 any；MVP 同步草稿实体）——
export class DraftPayload {
  title: string;
  language: CodeLanguage;
  ideaSegments: IdeaSegment[];
  code: string;
  deleted: boolean;

  constructor(title: string, language: CodeLanguage, ideaSegments: IdeaSegment[], code: string, deleted: boolean) {
    this.title = title;
    this.language = language;
    this.ideaSegments = ideaSegments;
    this.code = code;
    this.deleted = deleted;
  }
}

// —— 同步操作（operation_id 幂等 + base_version 乐观锁 + client_id）——
export class SyncOperation {
  operationId: string;
  entityType: EntityType;
  entityId: string;
  operationType: OperationType;
  baseVersion: number;
  clientId: string;
  occurredAt: string;
  payload: DraftPayload;

  constructor(operationId: string, entityType: EntityType, entityId: string, operationType: OperationType,
    baseVersion: number, clientId: string, occurredAt: string, payload: DraftPayload) {
    this.operationId = operationId;
    this.entityType = entityType;
    this.entityId = entityId;
    this.operationType = operationType;
    this.baseVersion = baseVersion;
    this.clientId = clientId;
    this.occurredAt = occurredAt;
    this.payload = payload;
  }
}

// —— 冲突记录（保留本地副本与服务器版本，等待用户选择）——
export class ConflictRecord {
  id: string;
  entityId: string;
  entityType: EntityType;
  serverVersion: number;
  clientVersion: number;
  resolution: ConflictResolution;
  localCopy: Draft;
  serverCopy: Draft;
  createdAt: string;

  constructor(id: string, entityId: string, entityType: EntityType, serverVersion: number,
    clientVersion: number, localCopy: Draft, serverCopy: Draft) {
    this.id = id;
    this.entityId = entityId;
    this.entityType = entityType;
    this.serverVersion = serverVersion;
    this.clientVersion = clientVersion;
    this.resolution = ConflictResolution.UNRESOLVED;
    this.localCopy = localCopy;
    this.serverCopy = serverCopy;
    this.createdAt = new Date().toISOString();
  }
}
