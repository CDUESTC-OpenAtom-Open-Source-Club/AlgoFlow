import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SyncStore } from './sync-store.mjs';

// A workspace is the unit of isolation on a shared sync-api: one SyncStore with
// its own epoch, plus the devices allowed to use it. There are no accounts; a
// device token is the only credential. Only its SHA-256 is kept, so a dump of
// this directory does not contain usable tokens.
export const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_KINDS = ['web', 'phone'];
export const MAX_DEVICE_NAME_LENGTH = 64;

export class WorkspaceDirectory {
  #workspaces = new Map();
  #tokens = new Map();
  #now;
  #createStore;

  /** @param {{ now?: () => number, createStore?: () => SyncStore }} [options] */
  constructor({ now = () => Date.now(), createStore = () => new SyncStore() } = {}) {
    this.#now = now;
    this.#createStore = createStore;
  }

  get size() {
    return this.#workspaces.size;
  }

  /** @param {{ kind: string, name: string }} device */
  create(device) {
    const at = new Date(this.#now()).toISOString();
    const workspace = { workspace_id: randomUUID(), created_at: at, store: this.#createStore(), devices: new Map() };
    this.#workspaces.set(workspace.workspace_id, workspace);
    const issued = this.#issue(workspace, device, at);
    return { workspace_id: workspace.workspace_id, ...issued };
  }

  /** Returns null when the workspace no longer exists. */
  addDevice(workspaceId, device) {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return null;
    return this.#issue(workspace, device, new Date(this.#now()).toISOString());
  }

  // Unknown, revoked and malformed tokens are indistinguishable to the caller.
  authenticate(token) {
    if (typeof token !== 'string' || !DEVICE_TOKEN_PATTERN.test(token)) return null;
    const entry = this.#tokens.get(hashToken(token));
    const workspace = entry && this.#workspaces.get(entry.workspace_id);
    const device = workspace?.devices.get(entry.device_id);
    if (!device) return null;
    device.last_seen_at = new Date(this.#now()).toISOString();
    return { workspace_id: workspace.workspace_id, device_id: device.device_id, store: workspace.store };
  }

  hasDevice(workspaceId, deviceId) {
    return this.#workspaces.get(workspaceId)?.devices.has(deviceId) ?? false;
  }

  listDevices(workspaceId) {
    const workspace = this.#workspaces.get(workspaceId);
    return workspace ? [...workspace.devices.values()].map(publicDevice) : [];
  }

  // A workspace nobody can reach any more is deleted with its last device.
  removeDevice(workspaceId, deviceId) {
    const workspace = this.#workspaces.get(workspaceId);
    const device = workspace?.devices.get(deviceId);
    if (!device) return { removed: false, workspace_deleted: false };
    workspace.devices.delete(deviceId);
    this.#tokens.delete(device.token_hash);
    if (workspace.devices.size > 0) return { removed: true, workspace_deleted: false };
    this.#workspaces.delete(workspaceId);
    return { removed: true, workspace_deleted: true };
  }

  deleteWorkspace(workspaceId) {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) return false;
    for (const device of workspace.devices.values()) this.#tokens.delete(device.token_hash);
    this.#workspaces.delete(workspaceId);
    return true;
  }

  #issue(workspace, { kind, name }, at) {
    const token = randomBytes(32).toString('base64url');
    const device = { device_id: randomUUID(), kind, name, created_at: at, last_seen_at: at, token_hash: hashToken(token) };
    workspace.devices.set(device.device_id, device);
    this.#tokens.set(device.token_hash, { workspace_id: workspace.workspace_id, device_id: device.device_id });
    return { device_id: device.device_id, device_token: token };
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
