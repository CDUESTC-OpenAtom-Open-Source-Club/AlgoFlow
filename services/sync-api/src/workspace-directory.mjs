import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_WORKSPACE_QUOTA, MemorySyncStorage, SyncStore } from './sync-store.mjs';

// A workspace is the unit of isolation on a shared sync-api: one SyncStore with
// its own epoch, plus the devices allowed to use it. There are no accounts; a
// device token is the only credential. Only its SHA-256 is kept, so a dump of
// the storage does not contain usable tokens.
export const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_KINDS = ['web', 'phone'];
export const MAX_DEVICE_NAME_LENGTH = 64;
export const DEFAULT_MAX_WORKSPACES = 1000;
// Retention, also stated in the privacy policy: a workspace no device has used
// for 180 days is deleted, and so is one that never received data and has not
// been used for 24 hours.
export const INACTIVE_WORKSPACE_MS = 180 * 24 * 60 * 60 * 1000;
export const IDLE_EMPTY_WORKSPACE_MS = 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
// last_seen_at only feeds retention and the device list; minute precision
// saves a storage write on most requests.
const LAST_SEEN_RESOLUTION_MS = 60 * 1000;

export class WorkspaceDirectory {
  #backend;
  #now;
  #maxWorkspaces;
  #quota;
  #purgedAt = Number.NEGATIVE_INFINITY;

  /**
   * @param {{
   *   now?: () => number,
   *   backend?: MemoryBackend | import('./sqlite-backend.mjs').SqliteBackend,
   *   maxWorkspaces?: number,
   *   quota?: { entries: number, bytes: number }
   * }} [options]
   */
  constructor({ now = () => Date.now(), backend = new MemoryBackend(), maxWorkspaces = DEFAULT_MAX_WORKSPACES, quota = DEFAULT_WORKSPACE_QUOTA } = {}) {
    this.#now = now;
    this.#backend = backend;
    this.#maxWorkspaces = maxWorkspaces;
    this.#quota = quota;
  }

  get size() {
    return this.#backend.workspaceCount();
  }

  /**
   * Returns null when the server already holds maxWorkspaces workspaces.
   * @param {{ kind: string, name: string | null }} device
   */
  create(device) {
    const now = this.#now();
    this.#purgeIfDue(now);
    if (this.#backend.workspaceCount() >= this.#maxWorkspaces) return null;
    const at = new Date(now).toISOString();
    const workspaceId = randomUUID();
    return this.#backend.transaction(() => {
      this.#backend.createWorkspace({ workspace_id: workspaceId, epoch: randomUUID(), created_at: at });
      return { workspace_id: workspaceId, ...this.#issue(workspaceId, device, at) };
    });
  }

  /** Returns null when the workspace no longer exists. */
  addDevice(workspaceId, device) {
    if (!this.#backend.hasWorkspace(workspaceId)) return null;
    return this.#issue(workspaceId, device, new Date(this.#now()).toISOString());
  }

  // Unknown, revoked and malformed tokens are indistinguishable to the caller.
  authenticate(token) {
    if (typeof token !== 'string' || !DEVICE_TOKEN_PATTERN.test(token)) return null;
    const now = this.#now();
    this.#purgeIfDue(now);
    const device = this.#backend.deviceByTokenHash(hashToken(token));
    if (!device) return null;
    if (now - Date.parse(device.last_seen_at) >= LAST_SEEN_RESOLUTION_MS) {
      this.#backend.touchDevice(device.workspace_id, device.device_id, new Date(now).toISOString());
    }
    return { workspace_id: device.workspace_id, device_id: device.device_id, store: new SyncStore(this.#backend.storage(device.workspace_id), this.#quota) };
  }

  hasDevice(workspaceId, deviceId) {
    return this.#backend.devices(workspaceId).some((device) => device.device_id === deviceId);
  }

  listDevices(workspaceId) {
    return this.#backend.devices(workspaceId).map(publicDevice);
  }

  // A workspace nobody can reach any more is deleted with its last device.
  removeDevice(workspaceId, deviceId) {
    return this.#backend.transaction(() => {
      if (!this.#backend.removeDevice(workspaceId, deviceId)) return { removed: false, workspace_deleted: false };
      if (this.#backend.devices(workspaceId).length > 0) return { removed: true, workspace_deleted: false };
      this.#backend.deleteWorkspace(workspaceId);
      return { removed: true, workspace_deleted: true };
    });
  }

  deleteWorkspace(workspaceId) {
    return this.#backend.deleteWorkspace(workspaceId);
  }

  /** Deletes expired workspaces now; returns how many were deleted. */
  purgeExpired() {
    const now = this.#now();
    this.#purgedAt = now;
    const deleted = this.#backend.purge({
      inactiveBefore: new Date(now - INACTIVE_WORKSPACE_MS).toISOString(),
      idleBefore: new Date(now - IDLE_EMPTY_WORKSPACE_MS).toISOString()
    });
    if (deleted > 0) console.log(`[AlgoFlow] Expired workspaces deleted. count=${deleted}`);
    return deleted;
  }

  #purgeIfDue(now) {
    if (now - this.#purgedAt >= PURGE_INTERVAL_MS) this.purgeExpired();
  }

  #issue(workspaceId, { kind, name }, at) {
    const token = randomBytes(32).toString('base64url');
    const device = { device_id: randomUUID(), kind, name, created_at: at, last_seen_at: at, token_hash: hashToken(token) };
    this.#backend.addDevice(workspaceId, device);
    return { device_id: device.device_id, device_token: token };
  }
}

/**
 * Workspaces and devices in process memory, lost on restart. SqliteBackend in
 * sqlite-backend.mjs implements the same methods on a database file.
 */
export class MemoryBackend {
  #workspaces = new Map();
  #tokens = new Map();

  transaction(run) {
    return run();
  }

  workspaceCount() {
    return this.#workspaces.size;
  }

  hasWorkspace(workspaceId) {
    return this.#workspaces.has(workspaceId);
  }

  createWorkspace({ workspace_id, epoch, created_at }) {
    this.#workspaces.set(workspace_id, { created_at, devices: new Map(), storage: new MemorySyncStorage(epoch) });
  }

  deleteWorkspace(workspaceId) {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return false;
    for (const device of workspace.devices.values()) this.#tokens.delete(device.token_hash);
    this.#workspaces.delete(workspaceId);
    return true;
  }

  storage(workspaceId) {
    return this.#workspaces.get(workspaceId)?.storage;
  }

  addDevice(workspaceId, device) {
    this.#workspaces.get(workspaceId).devices.set(device.device_id, { ...device });
    this.#tokens.set(device.token_hash, { workspace_id: workspaceId, device_id: device.device_id });
  }

  deviceByTokenHash(tokenHash) {
    const entry = this.#tokens.get(tokenHash);
    const device = entry && this.#workspaces.get(entry.workspace_id)?.devices.get(entry.device_id);
    return device ? { ...device, workspace_id: entry.workspace_id } : undefined;
  }

  touchDevice(workspaceId, deviceId, at) {
    const device = this.#workspaces.get(workspaceId)?.devices.get(deviceId);
    if (device) device.last_seen_at = at;
  }

  devices(workspaceId) {
    return [...(this.#workspaces.get(workspaceId)?.devices.values() ?? [])].map((device) => ({ ...device }));
  }

  removeDevice(workspaceId, deviceId) {
    const devices = this.#workspaces.get(workspaceId)?.devices;
    const device = devices?.get(deviceId);
    if (!device) return false;
    devices.delete(deviceId);
    this.#tokens.delete(device.token_hash);
    return true;
  }

  // Timestamps are ISO strings, which compare in time order.
  purge({ inactiveBefore, idleBefore }) {
    let deleted = 0;
    for (const [workspaceId, workspace] of this.#workspaces) {
      const lastSeen = [...workspace.devices.values()].reduce((latest, device) => device.last_seen_at > latest ? device.last_seen_at : latest, workspace.created_at);
      if (lastSeen < inactiveBefore || (lastSeen < idleBefore && workspace.storage.lastCursor() === 0)) {
        this.deleteWorkspace(workspaceId);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export function isDeviceName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_DEVICE_NAME_LENGTH;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicDevice(device) {
  return { device_id: device.device_id, kind: device.kind, name: device.name, created_at: device.created_at, last_seen_at: device.last_seen_at };
}
