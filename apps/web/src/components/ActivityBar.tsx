import { AI_ENTRY } from '../site-config.mjs';
import type { Panel } from '../types';
import { Icon } from './Icon';

interface ActivityBarProps {
  activePanel: Panel;
  onPanelChange: (panel: Panel) => void;
}

const activities: Array<{ panel: Panel; icon: string; label: string }> = [
  { panel: 'files', icon: 'files', label: '文件' },
  { panel: 'source', icon: 'source', label: '来源' },
];
const bottomActivities: Array<{ panel: Panel; icon: string; label: string }> = AI_ENTRY
  ? [{ panel: 'ai', icon: 'spark', label: 'AI' }]
  : [];

export function ActivityBar({ activePanel, onPanelChange }: ActivityBarProps) {
  return (
    <aside className="activity-bar" aria-label="工作区工具">
      {activities.map((activity) => (
        <ActivityButton
          key={activity.panel}
          activity={activity}
          active={activePanel === activity.panel}
          onClick={() => onPanelChange(activity.panel)}
        />
      ))}
      <div className="activity-spacer" />
      {bottomActivities.map((activity) => (
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
      aria-label={activity.label}
      aria-pressed={active}
      title={activity.label}
    >
      <Icon name={activity.icon} />
    </button>
  );
}
