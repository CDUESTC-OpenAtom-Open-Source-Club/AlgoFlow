import { useCallback, useEffect, useState } from 'react';
import { waitText } from '../sync-client.mjs';
import type { Device, DeviceDeleteResult, DeviceList } from '../types';

type Confirming =
  | { kind: 'remove'; deviceId: string }
  | { kind: 'disconnect' }
  | { kind: 'delete'; step: 1 | 2 }
  | null;

interface DeviceListSectionProps {
  /** Host of the sync server, named in the delete confirmation. */
  host: string;
  /** Changes when the list may have changed, e.g. a new pairing session or a claim. */
  refreshKey: string;
  listDevices: () => Promise<DeviceList>;
  removeDevice: (deviceId: string) => Promise<DeviceDeleteResult>;
  onDisconnect: () => Promise<void>;
  onDeleteCloud: () => Promise<void>;
}

// Every device of this workspace, with the same actions as the phone's 设置:
// remove a lost device, disconnect this computer, delete the cloud data.
// Local drafts stay on every device in all three cases.
export function DeviceListSection({ host, refreshKey, listDevices, removeDevice, onDisconnect, onDeleteCloud }: DeviceListSectionProps) {
  const [list, setList] = useState<DeviceList | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);

  const load = useCallback(async () => {
    try {
      setList(await listDevices());
      setError('');
    } catch (failure) {
      setError(deviceErrorText(failure));
    }
  }, [listDevices]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function run(action: () => Promise<unknown>, reload: boolean) {
    setBusy(true);
    setError('');
    try {
      await action();
      setConfirming(null);
      if (reload) await load();
    } catch (failure) {
      setError(deviceErrorText(failure));
      if (failure instanceof Error && failure.message === 'DEVICE_NOT_FOUND') {
        setConfirming(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const devices = list ? sortCurrentFirst(list.devices, list.current_device_id) : [];

  return (
    <div className="pebrel-section">
      <div className="pebrel-section-head">
        <h4>已连接的设备</h4>
        <div className="pebrel-head-actions">
          <button type="button" className="outline-button" onClick={() => void load()} disabled={busy}>
            刷新
          </button>
        </div>
      </div>
      <p className="pebrel-desc">
        移除后该设备需要重新扫码才能同步，它上面的草稿会保留；手机丢失时在这里移除。
      </p>
      {error && <p className="pebrel-warning" role="alert">{error}</p>}
      {list && (
        <ul className="device-list">
          {devices.map((device) => {
            const current = device.device_id === list.current_device_id;
            const confirmingThis = current ? confirming?.kind === 'disconnect'
              : confirming?.kind === 'remove' && confirming.deviceId === device.device_id;
            return (
              <li className="device-row" key={device.device_id}>
                <div className="device-info">
                  <strong>
                    {device.name || '未命名设备'}
                    {current && <span className="device-badge">这台电脑</span>}
                  </strong>
                  <small>
                    {device.kind === 'phone' ? '手机' : '电脑网页'} · 最近同步 {formatTime(device.last_seen_at)} · 加入于 {formatTime(device.created_at)}
                  </small>
                  {confirmingThis && (
                    <small className="device-confirm-text">
                      {current
                        ? '断开后这台电脑不再同步，本地草稿会保留；需要时重新开启手机远程并扫码。'
                        : '确认移除这台设备？它需要重新扫码才能再次同步。'}
                    </small>
                  )}
                </div>
                <div className="device-actions">
                  {confirmingThis ? (
                    <>
                      <button
                        type="button"
                        className="outline-button device-danger"
                        disabled={busy}
                        onClick={() => void run(current ? onDisconnect : () => removeDevice(device.device_id), !current)}
                      >
                        {current ? '确认断开' : '确认移除'}
                      </button>
                      <button type="button" className="outline-button" disabled={busy} onClick={() => setConfirming(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="outline-button"
                      disabled={busy}
                      onClick={() => setConfirming(current ? { kind: 'disconnect' } : { kind: 'remove', deviceId: device.device_id })}
                    >
                      {current ? '断开这台电脑' : '移除'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="device-delete">
        {confirming?.kind === 'delete' ? (
          <>
            <p className="pebrel-warning" role="alert">
              {confirming.step === 1
                ? `将删除 ${host} 上这个工作区的全部草稿和历史，所有已连接的电脑和手机都会断开。这台电脑上的草稿会保留。`
                : '确定删除？删除后无法恢复。'}
            </p>
            <div className="device-actions">
              <button
                type="button"
                className="outline-button device-danger"
                disabled={busy}
                onClick={() => confirming.step === 1 ? setConfirming({ kind: 'delete', step: 2 }) : void run(onDeleteCloud, false)}
              >
                {confirming.step === 1 ? '继续' : '删除'}
              </button>
              <button type="button" className="outline-button" disabled={busy} onClick={() => setConfirming(null)}>
                取消
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="outline-button device-danger" disabled={busy} onClick={() => setConfirming({ kind: 'delete', step: 1 })}>
            删除云端数据
          </button>
        )}
      </div>
    </div>
  );
}

function sortCurrentFirst(devices: Device[], currentId: string): Device[] {
  return [...devices].sort((a, b) => Number(b.device_id === currentId) - Number(a.device_id === currentId));
}

function formatTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? '未知' : time.toLocaleString('zh-CN');
}

function deviceErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'AUTH_REQUIRED') return '这台电脑的连接已失效，本地草稿都还在；重新开启手机远程并扫码即可再次同步。';
  if (code === 'DEVICE_NOT_FOUND') return '这台设备已经被移除。';
  if (code === 'RATE_LIMITED') {
    const seconds = (error as { retryAfter?: number }).retryAfter;
    return `请求太频繁，请${waitText(seconds)}再试。`;
  }
  return '无法连接同步服务，请检查网络后重试。';
}
