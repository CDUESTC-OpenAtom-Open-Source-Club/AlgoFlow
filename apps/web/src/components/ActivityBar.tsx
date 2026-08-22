import type { Panel } from '../types';
import { Icon } from './Icon';

interface ActivityBarProps {
  activePanel: Panel;
  onPanelChange: (panel: Panel) => void;
}

const activities: Array<{ panel: Panel; icon: string; label: string }> = [
  { panel: 'files', icon: 'files', label: '文件' },
  { panel: 'search', icon: 'search', label: '搜索' },
  { panel: 'source', icon: 'source', label: '来源' },
  { panel: 'ai', icon: 'spark', label: 'AI' },
  { panel: 'versions', icon: 'history', label: '版本' },
];

export function ActivityBar({ activePanel, onPanelChange }: ActivityBarProps) {
  return (
    <aside className="activity-bar" aria-label="工作区工具">
      {activities.slice(0, 3).map((activity) => (
        <ActivityButton
          key={activity.panel}
          activity={activity}
          active={activePanel === activity.panel}
          onClick={() => onPanelChange(activity.panel)}
        />
      ))}
      <div className="activity-spacer" />
      {activities.slice(3).map((activity) => (
        <ActivityButton
          key={activity.panel}
          activity={activity}
          active={activePanel === activity.panel}
          onClick={() => onPanelChange(activity.panel)}
        />
      ))}
    </aside>
  );
}

interface ActivityButtonProps {
  activity: { panel: Panel; icon: string; label: string };
  active: boolean;
  onClick: () => void;
}

function ActivityButton({ activity, active, onClick }: ActivityButtonProps) {
  return (
    <button
      className={active ? 'activity active' : 'activity'}
      onClick={onClick}
      type="button"
    >
      <Icon name={activity.icon} />
      <span>{activity.label}</span>
    </button>
  );
}
