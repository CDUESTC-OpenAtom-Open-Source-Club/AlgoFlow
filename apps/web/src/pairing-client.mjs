// Web side of the sync-api pairing routes (packages/contracts/schemas/sync.schema.json
// #/$defs/pairing*). Pairing hands this computer's endpoints to a phone with a
// short-lived, single-use code; it is not account authentication.

export const PAIRING_INVITATION_TYPE = 'algoflow-pair-v1';

/**
 * @typedef {'lan' | 'relay'} PairingRoute
 * @typedef {'pending' | 'claimed' | 'expired' | 'revoked'} PairingState
 * @typedef {{ desktop_client_id: string, computer_name: string, route: PairingRoute, sync_api: string, ai_gateway: string }} PairingSessionRequest
 * @typedef {{ pairing_id: string, code?: string, state: PairingState, computer_name: string, route: PairingRoute,
 *   sync_api: string, ai_gateway: string, created_at: string, expires_at: string, claimed_at: string | null,
 *   phone_client_id: string | null }} PairingSession
 */

/**
 * @param {string} syncApi
 * @param {PairingSessionRequest} request
 * @returns {Promise<PairingSession & { code: string }>}
 */
export async function createPairingSession(syncApi, request) {
  const response = await fetch(`${trimSlash(syncApi)}/v1/pairing/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'created' || typeof result.session?.code !== 'string') {
    throw new Error(result.error_code ?? 'PAIRING_FAILED');
  }
  return result.session;
}

/**
 * @param {string} syncApi
 * @param {string} pairingId
 * @returns {Promise<PairingSession>}
 */
export async function getPairingSession(syncApi, pairingId) {
  const response = await fetch(`${trimSlash(syncApi)}/v1/pairing/sessions/${encodeURIComponent(pairingId)}`);
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

/** @param {string} value */
function trimSlash(value) {
  const trimmed = value.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}
