import { randomInt, randomUUID } from 'node:crypto';

// Pairing hands the desktop's sync-api / AI Gateway endpoints to a phone after
// the user scans the QR code or types the 8-digit code. It is an endpoint
// handoff with a short-lived, single-use code, not account authentication: the
// sync API itself remains unauthenticated and LAN-only until cloud auth exists.
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_INVITATION_TYPE = 'algoflow-pair-v1';
const MAX_FAILED_CLAIMS = 10;
const FAILED_CLAIM_WINDOW_MS = 60 * 1000;
const RETAIN_AFTER_EXPIRY_MS = 10 * 60 * 1000;
const CODE_PATTERN = /^\d{8}$/;

export class PairingStore {
  #sessions = new Map();
  #failedClaims = [];
  #now;

  /** @param {() => number} [now] */
  constructor(now = () => Date.now()) {
    this.#now = now;
  }

  create(request) {
    const error = validatePairingSessionRequest(request);
    if (error) return { status: 'rejected', error_code: 'INVALID_REQUEST', reason: error };
    const now = this.#now();
    this.#prune(now);
    // One pending code per desktop client: refreshing the QR code revokes the
    // previous one so a photographed old code cannot be claimed later.
    for (const session of this.#sessions.values()) {
      if (session.desktop_client_id === request.desktop_client_id && session.state === 'pending') session.state = 'revoked';
    }
    let code;
    do code = String(randomInt(0, 100000000)).padStart(8, '0');
    while ([...this.#sessions.values()].some((session) => session.state === 'pending' && session.code === code));
    const session = {
      pairing_id: randomUUID(),
      code,
      state: 'pending',
      desktop_client_id: request.desktop_client_id,
      computer_name: request.computer_name,
      route: request.route,
      sync_api: trimSlash(request.sync_api),
      ai_gateway: trimSlash(request.ai_gateway),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PAIRING_TTL_MS).toISOString(),
      claimed_at: null,
      phone_client_id: null
    };
    this.#sessions.set(session.pairing_id, session);
    return { status: 'created', session: { ...this.#publicView(session, now), code } };
  }

  get(pairingId) {
    const now = this.#now();
    const session = this.#sessions.get(pairingId);
    if (!session) return { status: 'rejected', error_code: 'PAIRING_NOT_FOUND' };
    return { status: 'ok', session: this.#publicView(session, now) };
  }

  claim(request) {
    const now = this.#now();
    this.#prune(now);
    if (!request || typeof request !== 'object' || typeof request.code !== 'string' || !CODE_PATTERN.test(request.code) ||
      typeof request.phone_client_id !== 'string' || request.phone_client_id.trim().length === 0) {
      return { status: 'rejected', error_code: 'INVALID_REQUEST' };
    }
    this.#failedClaims = this.#failedClaims.filter((time) => now - time < FAILED_CLAIM_WINDOW_MS);
    if (this.#failedClaims.length >= MAX_FAILED_CLAIMS) return { status: 'rejected', error_code: 'PAIRING_RATE_LIMITED' };
    const candidates = [...this.#sessions.values()].filter((session) => session.code === request.code);
    const pending = candidates.find((session) => session.state === 'pending' && this.#stateAt(session, now) === 'pending');
    if (!pending) {
      this.#failedClaims.push(now);
      if (candidates.some((session) => session.state === 'claimed')) return { status: 'rejected', error_code: 'PAIRING_CODE_USED' };
      if (candidates.some((session) => this.#stateAt(session, now) === 'expired')) return { status: 'rejected', error_code: 'PAIRING_CODE_EXPIRED' };
      return { status: 'rejected', error_code: 'PAIRING_CODE_INVALID' };
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
      ai_gateway: pending.ai_gateway
    };
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
      ai_gateway: session.ai_gateway,
      created_at: session.created_at,
      expires_at: session.expires_at,
      claimed_at: session.claimed_at,
      phone_client_id: session.phone_client_id
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
  if (typeof request.desktop_client_id !== 'string' || request.desktop_client_id.trim().length === 0) return 'desktop_client_id is required';
  if (typeof request.computer_name !== 'string' || request.computer_name.trim().length === 0 || request.computer_name.length > 64) return 'computer_name is invalid';
  if (!['lan', 'relay'].includes(request.route)) return 'route is invalid';
  if (!isHttpUrl(request.sync_api)) return 'sync_api must be an http(s) URL';
  if (!isHttpUrl(request.ai_gateway)) return 'ai_gateway must be an http(s) URL';
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
