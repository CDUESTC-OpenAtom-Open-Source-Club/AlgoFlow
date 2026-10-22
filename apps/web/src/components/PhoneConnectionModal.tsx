import { useEffect, useMemo, useState } from 'react';
import type { SyncStatus } from '../types';

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
  syncState: SyncStatus;
  pendingCount: number;
  config: PhoneConnectionConfig;
  onSaveConfig: (next: PhoneConnectionConfig) => void;
  onSyncNow: () => void;
}

export function PhoneConnectionModal({
  open,
  onClose,
  clientId,
  cursor,
  syncState,
  pendingCount,
  config,
  onSaveConfig,
  onSyncNow,
}: PhoneConnectionModalProps) {
  const [route, setRoute] = useState<'lan' | 'relay'>(config.route);
  const [syncUrl, setSyncUrl] = useState(config.syncBaseUrl);
  const [aiUrl, setAiUrl] = useState(config.aiBaseUrl);
  const [computerName, setComputerName] = useState(config.computerName);
  // The short code is only compared by the user on both screens. No server
  // validates or expires it, so the UI must not present it as authentication.
  const [nonce, setNonce] = useState(() => Math.floor(10000000 + Math.random() * 90000000));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRoute(config.route);
    setSyncUrl(config.syncBaseUrl);
    setAiUrl(config.aiBaseUrl);
    setComputerName(config.computerName);
  }, [open, config]);

  const shortCode = useMemo(() => {
    const digits = String(nonce).padStart(8, '0').slice(0, 8);
    return `${digits.slice(0, 4)} ${digits.slice(4, 8)}`;
  }, [nonce]);

  const invitationPayload = useMemo(() => {
    return JSON.stringify({
      type: 'algoflow-pair-v1',
      computer: computerName || 'AlgoFlow-Desktop',
      route,
      code: shortCode.replace(/\s+/g, ''),
      sync_api: syncUrl.trim(),
      ai_gateway: aiUrl.trim(),
      desktop_client_id: clientId,
    });
  }, [computerName, route, shortCode, syncUrl, aiUrl, clientId]);

  const qrMatrix = useMemo(() => buildQrMatrix(invitationPayload, 21), [invitationPayload]);

  if (!open) return null;

  function handleRefreshCode() {
    setNonce(Math.floor(10000000 + Math.random() * 90000000));
    setCopied(false);
  }

  async function handleCopyInvitation() {
    try {
      await navigator.clipboard.writeText(invitationPayload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(true);
    }
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
            <p className="pebrel-subtitle">在手机端打开「设置 → 连接电脑」，输入电脑地址与 8 位配对码，或粘贴完整配对信息以写入同步端点。</p>
          </div>
          <button type="button" className="quiet-button" aria-label="关闭手机连接窗口" onClick={onClose}>
            ✕
          </button>
        </div>

        {!config.enabled ? (
          <div className="pebrel-off-card">
            <h3>开启手机远程同步</h3>
            <p>开启后显示 8 位核对码和完整配对信息，用于把当前电脑使用的同步与 AI 服务端点交给 OpenHarmony 手机端。这只是端点移交，不是经过认证的配对。</p>
            <button
              type="button"
              className="sync-button"
              onClick={() => onSaveConfig({ ...config, enabled: true })}
            >
              开启手机远程
            </button>
          </div>
        ) : (
          <>
            <div className="pebrel-pairing-hero">
              <div className="pebrel-pairing-left">
                <div className="pebrel-hero-title-row">
                  <h3>配对新手机</h3>
                  <span className={`pebrel-status-pill status-${syncState}`}>
                    <i />
                    {syncState === 'synced' ? '服务就绪' : syncState === 'syncing' ? '同步中' : '等待手机连接'}
                  </span>
                </div>
                <p className="pebrel-desc">选择网络拓扑后，在手机端输入电脑地址与 8 位配对码，或粘贴完整配对信息完成端点写入。</p>

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
                      <strong>在手机端打开「设置 → 连接电脑」</strong>
                      <p>输入电脑地址和右侧的 8 位配对码，或粘贴「复制完整配对信息」的内容。</p>
                    </div>
                  </li>
                  <li>
                    <span className="step-num">3</span>
                    <div>
                      <strong>核对校验码并完成首次 Push &amp; Pull</strong>
                      <p>配对后两端共享同一草稿流与忠实转换产物，AI 缓存严格按契约隔离。</p>
                    </div>
                  </li>
                </ol>

                <div className="pebrel-endpoint-summary">
                  <code>{syncUrl}</code>
                  <span>·</span>
                  <code>Cursor #{cursor}</code>
                  <span>·</span>
                  <code>队列 {pendingCount} 项</code>
                </div>
              </div>

              <div className="pebrel-pairing-qr-col">
                <div className="pebrel-qr-box">
                  <svg
                    viewBox="0 0 21 21"
                    className="pebrel-qr-svg"
                    shapeRendering="crispEdges"
                    role="img"
                    aria-label="配对示意图，非标准二维码，无法扫描"
                  >
                    {qrMatrix.map((row, rIdx) =>
                      row.map((cell, cIdx) =>
                        cell ? <rect key={`${rIdx}-${cIdx}`} x={cIdx} y={rIdx} width={1} height={1} fill="#0F172A" /> : null,
                      ),
                    )}
                  </svg>
                </div>

                <div className="pebrel-qr-timer">
                  <span>示意图，暂不支持扫码</span>
                  <button type="button" className="quiet-link" onClick={handleRefreshCode}>
                    刷新配对码
                  </button>
                </div>

                <div className="pebrel-short-code-box">
                  <span>8 位配对码</span>
                  <strong>{shortCode}</strong>
                </div>

                <button type="button" className="pebrel-copy-btn" onClick={handleCopyInvitation}>
                  {copied ? '✓ 已复制完整配对信息' : '复制完整配对信息'}
                </button>
              </div>
            </div>

            <div className="pebrel-section">
              <div className="pebrel-section-head">
                <h4>同步端点与主机设置</h4>
                <div className="pebrel-head-actions">
                  <button type="button" className="outline-button" onClick={onSyncNow}>
                    立即同步
                  </button>
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => onSaveConfig({ ...config, enabled: false })}
                  >
                    关闭远程
                  </button>
                </div>
              </div>

              <div className="pebrel-form-grid">
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
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function buildQrMatrix(seedText: string, size: number): boolean[][] {
  const matrix: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  function drawFinder(rowOffset: number, colOffset: number) {
    for (let r = 0; r < 7; r++) {
      const mRow = matrix[rowOffset + r];
      const rRow = reserved[rowOffset + r];
      if (!mRow || !rRow) continue;
      for (let c = 0; c < 7; c++) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        mRow[colOffset + c] = border || inner;
        rRow[colOffset + c] = true;
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  let hash = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    hash ^= seedText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  for (let r = 0; r < size; r++) {
    const mRow = matrix[r];
    const rRow = reserved[r];
    if (!mRow || !rRow) continue;
    for (let c = 0; c < size; c++) {
      if (rRow[c]) continue;
      if (r === 6 || c === 6) {
        mRow[c] = (r + c) % 2 === 0;
        continue;
      }
      hash ^= (r * 31 + c * 17) & 0xff;
      hash = Math.imul(hash, 16777619);
      mRow[c] = (Math.abs(hash) % 11) < 5;
    }
  }
  return matrix;
}
