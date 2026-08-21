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

export class Draft {
  id: string;
  title: string;
  idea: string;
  code: string;
  rewrite: string;
  version: number;
  updatedAt: string;
  deleted: boolean;
  syncStatus: SyncStatus;
  aiMode: AIMode;
  artifactHidden: boolean;

  constructor(id: string, title: string) {
    this.id = id;
    this.title = title;
    this.idea = '';
    this.code = '';
    this.rewrite = '';
    this.version = 0;
    this.updatedAt = new Date().toISOString();
    this.deleted = false;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.aiMode = AIMode.FAITHFUL_TRANSFORM;
    this.artifactHidden = false;
  }
}
