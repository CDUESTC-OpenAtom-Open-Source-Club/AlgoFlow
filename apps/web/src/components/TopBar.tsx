import { Icon } from './Icon';

interface TopBarProps {
  saved: boolean;
}

export function TopBar({ saved }: TopBarProps) {
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
        <span className="sync-label">
          <i />
          {saved ? '已保存到本机' : '有未保存更改'}
        </span>
        <button className="sync-button" type="button">
          <Icon name="refresh" />
          同步
        </button>
        <button className="avatar" type="button" aria-label="用户菜单">
          <Icon name="user" />
        </button>
      </div>
    </header>
  );
}
