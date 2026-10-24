import { modes } from '../data';
import type { Mode, SyncStatus } from '../types';
import { Icon } from './Icon';
import brandMark from '../assets/brand/algoflow-icon.svg';

interface TopBarProps {
  saved: boolean;
  syncState?: SyncStatus;
  onSync?: () => void;
  onOpenPhoneModal?: () => void;
  /** Display only: the selected draft's title and version. */
  draftTitle?: string;
  draftVersion?: number;
  mode?: Mode;
}

export function TopBar({ saved, syncState = 'local_only', onSync, onOpenPhoneModal, draftTitle, draftVersion, mode }: TopBarProps) {
  const modeLabel = modes.find((item) => item.id === mode)?.label;
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <img className="brand-mark" src={brandMark} alt="" />
        <span>
          <strong>AlgoFlow</strong>
          <small>思路工作台</small>
        </span>
      </div>
      {draftTitle && (
        <div className="top-crumbs">
          <span>/</span>
          <b title={draftTitle}>{draftTitle}</b>
          {modeLabel && <span className="mode-pill"><i />{modeLabel}</span>}
        </div>
      )}
      <div className="top-actions">
        <span className="sync-strip">
          <SyncChip state={syncState} />
          <span className={saved ? 'sync-meta' : 'sync-meta unsaved'}>
            {saved ? `${draftVersion !== undefined ? `v${draftVersion} · ` : ''}已保存到本机` : '有未保存更改'}
          </span>
        </span>
        <button className="phone-connect-button" type="button" onClick={onOpenPhoneModal}>
          <Icon name="source" />
          手机远程
        </button>
        <button className="sync-button" type="button" onClick={onSync}>
          <Icon name="refresh" />
          {saved ? '同步' : '保存并同步'}
        </button>
        <button className="avatar" type="button" aria-label="手机远程连接设置" onClick={onOpenPhoneModal}>
          <Icon name="user" />
        </button>
      </div>
    </header>
  );
}

const syncLabels: Record<SyncStatus, string> = { local_only: '仅本地', syncing: '同步中', synced: '已同步', conflict: '有冲突', failed: '同步失败' };

export function SyncChip({ state, small = false }: { state: SyncStatus; small?: boolean }) {
  return (
    <span className={`sync-chip sync-${state}${small ? ' small' : ''}`}>
      <i />
      {syncLabels[state]}
    </span>
  );
}
