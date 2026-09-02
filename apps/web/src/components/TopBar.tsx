import { Icon } from './Icon';

interface TopBarProps {
  saved: boolean;
  syncState?: 'local_only' | 'syncing' | 'synced' | 'conflict' | 'failed';
  onSync?: () => void;
}

export function TopBar({ saved, syncState = 'local_only', onSync }: TopBarProps) {
  const syncLabels = { local_only: '仅本地', syncing: '同步中', synced: '已同步', conflict: '有冲突', failed: '同步失败' };
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span className="brand-mark">AF</span>
        <span>
          <strong>AlgoFlow</strong>
          <small>思路工作台</small>
        </span>
      </div>
      <div className="top-actions">
        <span className={`sync-label sync-${syncState}`}>
          <i />
          {saved ? `已保存到本机 · ${syncLabels[syncState]}` : '有未保存更改'}
        </span>
        <button className="sync-button" type="button" onClick={onSync}>
          <Icon name="refresh" />
          {saved ? '同步' : '保存并同步'}
        </button>
        <button className="avatar" type="button" aria-label="用户菜单">
          <Icon name="user" />
        </button>
      </div>
    </header>
  );
}
