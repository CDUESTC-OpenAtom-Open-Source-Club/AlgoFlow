import { randomInt, randomUUID } from 'node:crypto';
import { WorkspaceDirectory, isDeviceName } from './workspace-directory.mjs';

// Pairing lets a phone join the workspace of the device that created the
// session, after the user scans the QR code or types the 8-digit code. The code
// is short-lived and single-use; the credential the phone keeps is the device
// token returned by the claim, never the code itself.
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_INVITATION_TYPE = 'algoflow-pair-v1';
export const MAX_FAILED_CLAIMS = 10;
export const FAILED_CLAIM_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_CLAIM_ADDRESSES = 10000;
const RETAIN_AFTER_EXPIRY_MS = 10 * 60 * 1000;
const CODE_PATTERN = /^\d{8}$/;
const MAX_ID_LENGTH = 128;

export class PairingStore {
  #sessions = new Map();
  #failedClaims = new Map();
  #now;
  #directory;
  #maxFailedClaims;

  /** @param {{ now?: () => number, directory?: WorkspaceDirectory, maxFailedClaims?: number }} [options] */
  constructor({ now = () => Date.now(), directory = new WorkspaceDirectory({ now }), maxFailedClaims = MAX_FAILED_CLAIMS } = {}) {
    this.#now = now;
    this.#directory = directory;
    this.#maxFailedClaims = maxFailedClaims;
  }

  /** @param {{ workspace_id: string, device_id: string }} creator authenticated caller */
  create(request, creator) {
    const error = validatePairingSessionRequest(request);
    if (error) return { status: 'rejected', error_code: 'INVALID_REQUEST', reason: error };
    const now = this.#now();
    this.#prune(now);
    // One pending code per desktop client: refreshing the QR code revokes the
    // previous one so a photographed old code cannot be claimed later.
    for (const session of this.#sessions.values()) {
      if (session.creator_device_id === creator.device_id && session.desktop_client_id === request.desktop_client_id &&
        session.state === 'pending') session.state = 'revoked';
    }
    let code;
    do code = String(randomInt(0, 100000000)).padStart(8, '0');
    while ([...this.#sessions.values()].some((session) => session.state === 'pending' && session.code === code));
    const session = {
      pairing_id: randomUUID(),
      code,
      state: 'pending',
      workspace_id: creator.workspace_id,
      creator_device_id: creator.device_id,
      desktop_client_id: request.desktop_client_id,
      computer_name: request.computer_name,
      route: request.route,
      sync_api: trimSlash(request.sync_api),
      ai_gateway: typeof request.ai_gateway === 'string' ? trimSlash(request.ai_gateway) : undefined,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PAIRING_TTL_MS).toISOString(),
      claimed_at: null,
      phone_client_id: null,
      transfer_token: undefined
    };
    this.#sessions.set(session.pairing_id, session);
    return { status: 'created', session: { ...this.#publicView(session, now), code } };
  }

  // Another device's session looks exactly like a missing one.
  /** @param {{ device_id: string }} viewer authenticated caller */
  get(pairingId, viewer) {
    const now = this.#now();
    const session = this.#sessions.get(pairingId);
    if (!session || session.creator_device_id !== viewer.device_id) return { status: 'rejected', error_code: 'PAIRING_NOT_FOUND' };
    return { status: 'ok', session: this.#publicView(session, now) };
  }

  /**
   * @param {{ ip?: string, phone?: { workspace_id: string } | null }} [context]
   *   `phone` is the claiming phone's authenticated token, if it sent a valid one.
   */
  claim(request, { ip = 'unknown', phone = null } = {}) {
    const now = this.#now();
    this.#prune(now);
    if (!request || typeof request !== 'object' || typeof request.code !== 'string' || !CODE_PATTERN.test(request.code) ||
      typeof request.phone_client_id !== 'string' || request.phone_client_id.trim().length === 0 ||
      request.phone_client_id.length > MAX_ID_LENGTH || (request.device_name !== undefined && !isDeviceName(request.device_name))) {
      return { status: 'rejected', error_code: 'INVALID_REQUEST' };
    }
    // Failures are counted per address, so one client guessing codes cannot
    // lock everybody else out of pairing.
    if (this.#recentFailures(ip, now).length >= this.#maxFailedClaims) return { status: 'rejected', error_code: 'PAIRING_RATE_LIMITED' };
    const candidates = [...this.#sessions.values()].filter((session) => session.code === request.code);
    // A session whose creator has since been removed has nobody to pair with.
    const pending = candidates.find((session) => session.state === 'pending' && this.#stateAt(session, now) === 'pending' &&
      this.#directory.hasDevice(session.workspace_id, session.creator_device_id));
    if (!pending) {
      this.#recordFailure(ip, now);
      if (candidates.some((session) => session.state === 'claimed')) return { status: 'rejected', error_code: 'PAIRING_CODE_USED' };
      if (candidates.some((session) => this.#stateAt(session, now) === 'expired')) return { status: 'rejected', error_code: 'PAIRING_CODE_EXPIRED' };
      return { status: 'rejected', error_code: 'PAIRING_CODE_INVALID' };
    }
    let deviceToken;
    if (!phone) {
      // A new phone joins the creator's workspace.
      deviceToken = this.#directory.addDevice(pending.workspace_id, { kind: 'phone', name: request.device_name?.trim() ?? null })?.device_token;
    } else if (phone.workspace_id !== pending.workspace_id) {
      // A phone that already has a workspace keeps it, so a second computer can
      // join the same drafts. The creator picks up its new token by polling.
      pending.transfer_token = this.#directory.addDevice(phone.workspace_id, { kind: 'web', name: pending.computer_name })?.device_token;
    }
    pending.state = 'claimed';
    pending.claimed_at = new Date(now).toISOString();
    pending.phone_client_id = request.phone_client_id.trim();
    return {
      status: 'claimed',
      pairing_id: pending.pairing_id,
      computer_name: pending.computer_name,
      route: pending.route,
      sync_api: pending.sync_api,
      ...(pending.ai_gateway === undefined ? {} : { ai_gateway: pending.ai_gateway }),
      ...(deviceToken === undefined ? {} : { device_token: deviceToken })
    };
  }

  #recentFailures(ip, now) {
    const recent = (this.#failedClaims.get(ip) ?? []).filter((time) => now - time < FAILED_CLAIM_WINDOW_MS);
    if (recent.length > 0) this.#failedClaims.set(ip, recent);
    else this.#failedClaims.delete(ip);
    return recent;
  }

  #recordFailure(ip, now) {
    const failures = this.#failedClaims.get(ip) ?? [];
    failures.push(now);
    // Re-insert so Map order is least recently failed first, then cap memory.
    this.#failedClaims.delete(ip);
    this.#failedClaims.set(ip, failures);
    if (this.#failedClaims.size > MAX_TRACKED_CLAIM_ADDRESSES) this.#failedClaims.delete(this.#failedClaims.keys().next().value);
  }

  #stateAt(session, now) {
    if (session.state === 'pending' && now >= Date.parse(session.expires_at)) return 'expired';
    return session.state;
  }

  // The code is returned only once, to the desktop that created the session.
  #publicView(session, now) {
    return {
      pairing_id: session.pairing_id,
      state: this.#stateAt(session, now),
      computer_name: session.computer_name,
      route: session.route,
      sync_api: session.sync_api,
      ...(session.ai_gateway === undefined ? {} : { ai_gateway: session.ai_gateway }),
      created_at: session.created_at,
      expires_at: session.expires_at,
      claimed_at: session.claimed_at,
      phone_client_id: session.phone_client_id,
      ...(session.transfer_token === undefined ? {} : { transfer_token: session.transfer_token })
    };
  }

  #prune(now) {
    for (const [id, session] of this.#sessions) {
      if (now - Date.parse(session.expires_at) > RETAIN_AFTER_EXPIRY_MS) this.#sessions.delete(id);
    }
  }
}

export function validatePairingSessionRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'request is required';
  if (typeof request.desktop_client_id !== 'string' || request.desktop_client_id.trim().length === 0 ||
    request.desktop_client_id.length > MAX_ID_LENGTH) return 'desktop_client_id is invalid';
  if (typeof request.computer_name !== 'string' || request.computer_name.trim().length === 0 || request.computer_name.length > 64) return 'computer_name is invalid';
  if (!['lan', 'relay'].includes(request.route)) return 'route is invalid';
  if (!isHttpUrl(request.sync_api)) return 'sync_api must be an http(s) URL';
  if (request.ai_gateway !== undefined && !isHttpUrl(request.ai_gateway)) return 'ai_gateway must be an http(s) URL';
  return null;
}

export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0 && !url.username && !url.password;
  } catch { return false; }
}

function trimSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
