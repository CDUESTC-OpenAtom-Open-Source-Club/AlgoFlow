import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPairingInvitation,
  createPairingSession,
  getPairingSession,
  isLoopbackEndpoint,
  pairingErrorText,
  type PairingSession,
} from '../pairing-client.mjs';
import { AI_ENTRY, HOSTED, PRIVACY_URL } from '../site-config.mjs';
import type { DeviceDeleteResult, DeviceList } from '../types';
import { DeviceListSection } from './DeviceListSection';
import { PairingQrCode } from './PairingQrCode';

const POLL_INTERVAL_MS = 2000;

function formatCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4, 8)}`;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export interface PhoneConnectionConfig {
  enabled: boolean;
  route: 'lan' | 'relay';
  computerName: string;
  syncBaseUrl: string;
  aiBaseUrl: string;
}

interface PhoneConnectionModalProps {
  open: boolean;
  onClose: () => void;
  clientId: string;
  cursor: string;
  pendingCount: number;
  config: PhoneConnectionConfig;
  onSaveConfig: (next: PhoneConnectionConfig) => void;
  onSyncNow: () => void;
  /** Device token of this browser for `config.syncBaseUrl`, created on demand. */
  ensureToken: () => Promise<string>;
  /** Drops a token the sync-api rejected; the next `ensureToken` replaces it. */
  onTokenRejected: (token: string) => void;
  /** The phone already had a workspace; switch this browser to `token`. */
  onTransfer: (token: string) => Promise<void>;
  listDevices: () => Promise<DeviceList>;
  removeDevice: (deviceId: string) => Promise<DeviceDeleteResult>;
  /** Retires this browser's token; local drafts stay. */
  onDisconnect: () => Promise<void>;
  /** Deletes the workspace on the server for every device; local drafts stay. */
  onDeleteCloud: () => Promise<void>;
}

export function PhoneConnectionModal({
  open,
  onClose,
  clientId,
  cursor,
  pendingCount,
  config,
  onSaveConfig,
  onSyncNow,
  ensureToken,
  onTokenRejected,
  onTransfer,
  listDevices,
  removeDevice,
  onDisconnect,
  onDeleteCloud,
}: PhoneConnectionModalProps) {
  const [route, setRoute] = useState<'lan' | 'relay'>(config.route);
  const [syncUrl, setSyncUrl] = useState(config.syncBaseUrl);
  const [aiUrl, setAiUrl] = useState(config.aiBaseUrl);
  const [computerName, setComputerName] = useState(config.computerName);
  // The code is issued, expired and consumed by sync-api (/v1/pairing). It lets
  // one phone join this browser's workspace; the phone gets its own token.
  const [session, setSession] = useState<(PairingSession & { code: string }) | null>(null);
  // Only the creating device can poll a session, so polling keeps its token.
  const sessionToken = useRef('');
  const [transferred, setTransferred] = useState(false);
  const [sessionState, setSessionState] = useState<PairingSession['state'] | null>(null);
  const [phoneClientId, setPhoneClientId] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Shown on the off card after this computer left the workspace.
  const [leftNotice, setLeftNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    setRoute(config.route);
    setSyncUrl(config.syncBaseUrl);
    setAiUrl(config.aiBaseUrl);
    setComputerName(config.computerName);
  }, [open, config]);

  // Sessions are created from the saved config, so editing the form does not
  // revoke the code a phone may be typing; 「更新配对与端点」 issues a new one.
  const startSession = useCallback(async () => {
    setLoading(true);
    setPairingError('');
    setCopyState('idle');
    try {
      const request = {
        desktop_client_id: clientId,
        computer_name: config.computerName,
        route: config.route,
        sync_api: config.syncBaseUrl,
        // Without AI entries there is no gateway to hand to the phone; the
        // hosted default `/ai-api` is not even an absolute URL.
        ...(AI_ENTRY ? { ai_gateway: config.aiBaseUrl } : {}),
      };
      let token = await ensureToken();
      let created;
      try {
        created = await createPairingSession(config.syncBaseUrl, request, token);
      } catch (error) {
        // A restarted local sync-api no longer knows the token: replace it once.
        // The hosted build turns 手机远程 off instead and asks for consent again.
        if (!(error instanceof Error) || error.message !== 'AUTH_REQUIRED') throw error;
        onTokenRejected(token);
        if (HOSTED) return;
        token = await ensureToken();
        created = await createPairingSession(config.syncBaseUrl, request, token);
      }
      sessionToken.current = token;
      setSession(created);
      setSessionState(created.state);
      setPhoneClientId(null);
      setTransferred(false);
    } catch (error) {
      setSession(null);
      setSessionState(null);
      setPairingError(pairingErrorText(error, config.syncBaseUrl, HOSTED));
    } finally {
      setLoading(false);
    }
  }, [clientId, config, ensureToken, onTokenRejected]);

  useEffect(() => {
    if (!open || !config.enabled) return;
    setLeftNotice('');
    void startSession();
  }, [open, config.enabled, startSession]);

  // A session made with a retired token can no longer be polled.
  useEffect(() => {
    if (config.enabled) return;
    setSession(null);
    setSessionState(null);
  }, [config.enabled]);

  // Polling continues after the modal closes, so a phone that claims the code
  // later still hands over its transfer_token.
  useEffect(() => {
    if (!session || sessionState !== 'pending') return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void getPairingSession(config.syncBaseUrl, session.pairing_id, sessionToken.current).then((latest) => {
        setSessionState(latest.state);
        setPhoneClientId(latest.phone_client_id);
        if (latest.transfer_token) {
          setTransferred(true);
          void onTransfer(latest.transfer_token);
        }
      }).catch(() => {});
    }, POLL_INTERVAL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(timer); window.clearInterval(tick); };
  }, [session, sessionState, config.syncBaseUrl, onTransfer]);

  const remainingSec = session ? Math.max(0, Math.ceil((Date.parse(session.expires_at) - now) / 1000)) : 0;
  const effectiveState = sessionState === 'pending' && remainingSec === 0 ? 'expired' : sessionState;
  const invitation = useMemo(
    () => (session ? buildPairingInvitation(config.syncBaseUrl, session.code) : ''),
    [session, config.syncBaseUrl],
  );

  if (!open) return null;

  const timerText = `${String(Math.floor(remainingSec / 60)).padStart(2, '0')}:${String(remainingSec % 60).padStart(2, '0')}`;
  const host = hostOf(config.syncBaseUrl);
  const loopback = !HOSTED && isLoopbackEndpoint(config.syncBaseUrl);
  const statusLabel = loading ? '正在生成配对码'
    : pairingError ? '同步服务不可用'
    : effectiveState === 'claimed' ? '手机已配对'
    : effectiveState === 'expired' ? '配对码已过期'
    : effectiveState === 'revoked' ? '配对码已作废'
    : '等待手机扫码';
  const statusClass = effectiveState === 'claimed' ? 'status-ok'
    : pairingError || effectiveState === 'expired' || effectiveState === 'revoked' ? 'status-error' : 'status-pending';

  async function handleCopyInvitation() {
    try {
      await navigator.clipboard.writeText(invitation);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('failed');
    }
  }

  async function handleDisconnect() {
    await onDisconnect();
    setLeftNotice('已断开这台电脑，本地草稿仍然保留。');
  }

  async function handleDeleteCloud() {
    await onDeleteCloud();
    setLeftNotice('云端数据已删除，所有设备已断开；这台电脑上的草稿仍然保留。');
  }

  function handleApplyEndpoints() {
    onSaveConfig({
      ...config,
      route,
      computerName: computerName.trim() || 'AlgoFlow-Desktop',
      syncBaseUrl: syncUrl.trim() || 'http://127.0.0.1:8787',
      aiBaseUrl: aiUrl.trim() || 'http://127.0.0.1:8788',
    });
  }

  return (
    <div className="pebrel-modal-backdrop" role="dialog" aria-modal="true" aria-label="手机远程连接设置">
      <div className="pebrel-modal">
        <div className="pebrel-modal-header">
          <div>
            <span className="eyebrow">SETTINGS → PHONE REMOTE</span>
            <h2>手机远程与跨端配对</h2>
            <p className="pebrel-subtitle">在手机端打开「设置 → 连接电脑」，扫描二维码或输入 8 位配对码，手机与这台电脑就会使用同一个同步工作区。</p>
          </div>
          <button type="button" className="quiet-button" aria-label="关闭手机连接窗口" onClick={onClose}>
            ✕
          </button>
        </div>

        {!config.enabled ? (
          <div className="pebrel-off-card">
            <h3>开启手机远程同步</h3>
            {leftNotice && <p role="status">{leftNotice}</p>}
            {HOSTED ? (
              <p>
                开启后，这台电脑会在 <strong>{host}</strong> 上建立同步工作区并上传草稿；服务器上的草稿不是端到端加密的。
                手机扫码加入后，两端都能读写已同步的草稿。配对码 10 分钟内有效、只能使用一次，本身不能用来读取草稿。
                {PRIVACY_URL && <> 详见<a href={PRIVACY_URL} target="_blank" rel="noreferrer">隐私政策</a>。</>}
              </p>
            ) : (
              <p>开启后由同步服务生成 10 分钟内有效、只能使用一次的配对二维码与 8 位配对码。OpenHarmony 手机端凭它加入这台电脑的同步工作区，并取得自己的设备令牌；配对码本身不能用来读取草稿。</p>
            )}
            <button
              type="button"
              className="sync-button"
              onClick={() => onSaveConfig({ ...config, enabled: true })}
            >
              {HOSTED ? '同意并开启' : '开启手机远程'}
            </button>
          </div>
        ) : (
          <>
            <div className="pebrel-pairing-hero">
              <div className="pebrel-pairing-left">
                <div className="pebrel-hero-title-row">
                  <h3>配对新手机</h3>
                  <span className={`pebrel-status-pill ${statusClass}`} aria-live="polite">
                    <i />
                    {statusLabel}
                  </span>
                </div>
                <p className="pebrel-desc">
                  {HOSTED
                    ? '在手机端扫描右侧二维码，或输入服务器地址与 8 位配对码完成配对。'
                    : '选择网络拓扑后，在手机端扫描右侧二维码，或输入电脑地址与 8 位配对码完成配对。'}
                </p>

                {HOSTED ? <HostedSteps host={host} /> : <>
                <div className="pebrel-segmented" role="tablist" aria-label="连接通道">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={route === 'lan'}
                    className={route === 'lan' ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setRoute('lan')}
                  >
                    局域网 / USB 转发
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={route === 'relay'}
                    className={route === 'relay' ? 'seg-btn active' : 'seg-btn'}
                    onClick={() => setRoute('relay')}
                  >
                    服务器中转 (Relay)
                  </button>
                </div>

                <ol className="pebrel-steps">
                  <li>
                    <span className="step-num">1</span>
                    <div>
                      <strong>{route === 'lan' ? '确保处于同一局域网或已开启 hdc rport' : '填写自建中转或公网网关地址'}</strong>
                      <p>
                        {route === 'lan'
                          ? '真机 USB 联调可执行：hdc rport tcp:8787 tcp:8787 && hdc rport tcp:8788 tcp:8788'
                          : '不在同一 Wi-Fi 时，需自行提供两端都能访问的 sync-api 与 ai-gateway 地址；当前未提供云端部署。'}
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="step-num">2</span>
                    <div>
                      <strong>在手机端打开「设置 → 连接电脑」扫码</strong>
                      <p>也可以输入电脑地址和右侧的 8 位配对码，或粘贴「复制配对信息」的内容。</p>
                    </div>
                  </li>
                  <li>
                    <span className="step-num">3</span>
                    <div>
                      <strong>同步服务校验配对码，手机完成首次 Push &amp; Pull</strong>
                      <p>配对码 10 分钟内有效、只能使用一次。每台设备凭自己的令牌同步，不同工作区的数据互相隔离。如果手机已经在别的工作区，这台电脑会改用手机的工作区，本地草稿会合并上传。</p>
                    </div>
                  </li>
                </ol>
                </>}

                {pairingError && <p className="pebrel-warning" role="alert">{pairingError}</p>}
                {!pairingError && loopback && (
                  <p className="pebrel-warning">
                    当前 Sync API 是本机回环地址，手机无法直接访问：真机或模拟器需先执行 hdc rport，或把地址改成电脑的局域网 IP。
                  </p>
                )}
                {effectiveState === 'claimed' && phoneClientId && (
                  <p className="pebrel-desc">
                    已与手机 <code>{phoneClientId}</code> 配对，手机将执行首次同步。
                    {transferred && '这台电脑已改用手机的工作区。'}
                  </p>
                )}

                <div className="pebrel-endpoint-summary">
                  <code>{config.syncBaseUrl}</code>
                  <span>·</span>
                  <code>Cursor #{cursor}</code>
                  <span>·</span>
                  <code>队列 {pendingCount} 项</code>
                </div>
              </div>

              <div className="pebrel-pairing-qr-col">
                <div className={effectiveState === 'pending' ? 'pebrel-qr-box' : 'pebrel-qr-box is-inactive'}>
                  {session ? (
                    <PairingQrCode value={invitation} label={`手机配对二维码，配对码 ${formatCode(session.code)}`} />
                  ) : (
                    <span className="pebrel-qr-placeholder">{loading ? '生成中…' : '暂无配对码'}</span>
                  )}
                </div>

                <div className="pebrel-qr-timer" aria-live="polite">
                  <span>
                    {effectiveState === 'pending' ? `${timerText} 后失效 · 仅可使用一次`
                      : effectiveState === 'claimed' ? '已被手机使用'
                      : session ? '已失效，请刷新' : ''}
                  </span>
                  <button type="button" className="quiet-link" onClick={() => void startSession()} disabled={loading}>
                    刷新配对码
                  </button>
                </div>

                <div className="pebrel-short-code-box">
                  <span>8 位配对码</span>
                  <strong>{session && effectiveState === 'pending' ? formatCode(session.code) : '---- ----'}</strong>
                </div>

                <button
                  type="button"
                  className="pebrel-copy-btn"
                  onClick={handleCopyInvitation}
                  disabled={!session || effectiveState !== 'pending'}
                >
                  {copyState === 'copied' ? '✓ 已复制配对信息' : copyState === 'failed' ? '复制失败，请手动输入配对码' : '复制配对信息'}
                </button>
              </div>
            </div>

            {session && (
              <DeviceListSection
                host={host}
                refreshKey={`${session.pairing_id}:${effectiveState ?? ''}`}
                listDevices={listDevices}
                removeDevice={removeDevice}
                onDisconnect={handleDisconnect}
                onDeleteCloud={handleDeleteCloud}
              />
            )}

            <div className="pebrel-section">
              <div className="pebrel-section-head">
                <h4>{HOSTED ? '同步' : '同步端点与主机设置'}</h4>
                <div className="pebrel-head-actions">
                  <button type="button" className="outline-button" onClick={onSyncNow}>
                    立即同步
                  </button>
                  {!HOSTED && (
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => onSaveConfig({ ...config, enabled: false })}
                    >
                      关闭远程
                    </button>
                  )}
                </div>
              </div>

              {!HOSTED && <div className="pebrel-form-grid">
                <label className="pebrel-field">
                  <span>电脑名称 (Computer Name)</span>
                  <input
                    value={computerName}
                    onChange={(e) => setComputerName(e.target.value)}
                    placeholder="AlgoFlow-Desktop"
                  />
                </label>
                <label className="pebrel-field">
                  <span>Sync API 地址</span>
                  <input
                    value={syncUrl}
                    onChange={(e) => setSyncUrl(e.target.value)}
                    placeholder="http://127.0.0.1:8787"
                  />
                </label>
                <label className="pebrel-field">
                  <span>AI Gateway 地址</span>
                  <input
                    value={aiUrl}
                    onChange={(e) => setAiUrl(e.target.value)}
                    placeholder="http://127.0.0.1:8788"
                  />
                </label>
                <div className="pebrel-field pebrel-field-action">
                  <button type="button" className="sync-button" onClick={handleApplyEndpoints}>
                    更新配对与端点
                  </button>
                </div>
              </div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// The public server has one address and no LAN or hdc setup.
function HostedSteps({ host }: { host: string }) {
  return (
    <ol className="pebrel-steps">
      <li>
        <span className="step-num">1</span>
        <div>
          <strong>在手机端打开「设置 → 连接电脑」扫码</strong>
          <p>也可以输入服务器地址 {host} 和右侧的 8 位配对码，或粘贴「复制配对信息」的内容。</p>
        </div>
      </li>
      <li>
        <span className="step-num">2</span>
        <div>
          <strong>在手机上确认服务器地址</strong>
          <p>手机会显示 {host}，确认草稿同步到这里后才完成配对。</p>
        </div>
      </li>
      <li>
        <span className="step-num">3</span>
        <div>
          <strong>手机完成首次同步</strong>
          <p>配对码 10 分钟内有效、只能使用一次。如果手机已经在别的工作区，这台电脑会改用手机的工作区，本地草稿会合并上传。</p>
        </div>
      </li>
    </ol>
  );
}
