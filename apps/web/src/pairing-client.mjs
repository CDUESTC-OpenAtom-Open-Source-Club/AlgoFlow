// Web side of the sync-api pairing routes (packages/contracts/schemas/sync.schema.json
// #/$defs/pairing*). Pairing lets a phone join this browser's workspace with a
// short-lived, single-use code. Both routes need this browser's device token.

import { waitText } from './sync-client.mjs';

export const PAIRING_INVITATION_TYPE = 'algoflow-pair-v1';

/**
 * @typedef {'lan' | 'relay'} PairingRoute
 * @typedef {'pending' | 'claimed' | 'expired' | 'revoked'} PairingState
 * @typedef {{ desktop_client_id: string, computer_name: string, route: PairingRoute, sync_api: string, ai_gateway?: string }} PairingSessionRequest
 * @typedef {{ pairing_id: string, code?: string, state: PairingState, computer_name: string, route: PairingRoute,
 *   sync_api: string, ai_gateway?: string, created_at: string, expires_at: string, claimed_at: string | null,
 *   phone_client_id: string | null, transfer_token?: string }} PairingSession
 */

/**
 * @param {string} syncApi
 * @param {PairingSessionRequest} request
 * @param {string} token device token of this browser
 * @returns {Promise<PairingSession & { code: string }>}
 */
export async function createPairingSession(syncApi, request, token) {
  const response = await fetch(`${trimSlash(syncApi)}/v1/pairing/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(request)
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'created' || typeof result.session?.code !== 'string') {
    throw new Error(result.error_code ?? 'PAIRING_FAILED');
  }
  return result.session;
}

/**
 * Only the device that created the session can read it. `transfer_token` is
 * present when the phone already had another workspace: this browser then
 * switches to that token (see `onTransfer` in PhoneConnectionModal).
 * @param {string} syncApi
 * @param {string} pairingId
 * @param {string} token device token of this browser
 * @returns {Promise<PairingSession>}
 */
export async function getPairingSession(syncApi, pairingId, token) {
  const response = await fetch(`${trimSlash(syncApi)}/v1/pairing/sessions/${encodeURIComponent(pairingId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'ok') throw new Error(result.error_code ?? 'PAIRING_FAILED');
  return result.session;
}

/**
 * Text encoded in the QR code and copied by「复制配对信息」. The AI Gateway
 * endpoint is returned by the claim, so only the sync-api address travels here.
 * @param {string} syncApi
 * @param {string} code
 * @returns {string}
 */
export function buildPairingInvitation(syncApi, code) {
  return JSON.stringify({ type: PAIRING_INVITATION_TYPE, sync_api: trimSlash(syncApi), code });
}

/**
 * A loopback address only reaches this computer from this computer. A phone
 * needs the LAN address or an `hdc rport` forward.
 * @param {string} url
 * @returns {boolean}
 */
export function isLoopbackEndpoint(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  } catch { return false; }
}

const MAX_DEVICE_NAME = 64;

/**
 * Name shown for this browser in the device list, e.g. "Edge · Windows". Only
 * the browser family and system leave the user agent.
 * @param {string | undefined} userAgent
 * @returns {string}
 */
export function describeBrowser(userAgent) {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '';
  const system = /HarmonyOS|OpenHarmony/.test(ua) ? 'HarmonyOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : '';
  const name = [browser, system].filter(Boolean).join(' · ');
  return (name || '网页浏览器').slice(0, MAX_DEVICE_NAME);
}

/**
 * Text for a failed pairing session start. The hosted build has no endpoint
 * form, so its texts never point at sync-api settings.
 * @param {unknown} error
 * @param {string} syncApi
 * @param {boolean} hosted
 * @returns {string}
 */
export function pairingErrorText(error, syncApi, hosted) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'SERVER_AT_CAPACITY') return '服务器暂时无法创建新的同步工作区，请 1 小时后再试';
  if (code === 'RATE_LIMITED') {
    const seconds = /** @type {{ retryAfter?: number }} */ (error).retryAfter;
    return `请求太频繁，请${waitText(seconds)}再试`;
  }
  if (code === 'INVALID_REQUEST' && !hosted) return '端点配置无效，请检查 Sync API 与 AI Gateway 地址';
  if (hosted) return code === 'INVALID_REQUEST' ? '配对请求无效，请刷新页面后重试' : '无法连接同步服务，请检查网络后重试';
  return `无法连接同步服务 ${syncApi}，请先启动 sync-api`;
}

/** @param {string} value */
function trimSlash(value) {
  const trimmed = value.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}
