import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DEVICE_TOKEN_PATTERN } from '../domain/PairingContract';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';
const ALIAS = 'algoflow.sync.device-token.v1';

// The phone's device token for one sync-api. It lives in Asset Store Kit, not
// RDB: backup_config.json allows app backup, and Asset items without a sync
// type are neither backed up nor cloned, and are removed with the app. The
// token is bound to the address that issued it and is never returned for
// another one, so editing the sync address cannot send it elsewhere.
export interface DeviceTokenStore {
  load(syncApi: string): Promise<string>;
  // The address the stored token belongs to, or '' when there is none.
  server(): Promise<string>;
  save(syncApi: string, token: string): Promise<void>;
  clear(): Promise<void>;
}

class StoredDeviceToken {
  sync_api: string = '';
  device_token: string = '';
}

export class AssetDeviceTokenStore implements DeviceTokenStore {
  async load(syncApi: string): Promise<string> {
    const stored = await this.read();
    return stored !== undefined && sameEndpoint(stored.sync_api, syncApi) ? stored.device_token : '';
  }

  async server(): Promise<string> {
    return (await this.read())?.sync_api ?? '';
  }

  async save(syncApi: string, token: string): Promise<void> {
    if (!DEVICE_TOKEN_PATTERN.test(token)) throw new Error('DEVICE_TOKEN_INVALID');
    const record = new StoredDeviceToken();
    record.sync_api = trimSlash(syncApi);
    record.device_token = token;
    const attributes: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    attributes.set(asset.Tag.ALIAS, encode(ALIAS));
    attributes.set(asset.Tag.SECRET, encode(JSON.stringify(record)));
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
    try {
      await asset.add(attributes);
    } catch (error) {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Device token save failed. error_code=%{public}s', errorCode(error as BusinessError));
      throw new Error('DEVICE_TOKEN_STORAGE');
    }
  }

  async clear(): Promise<void> {
    try {
      await asset.remove(aliasQuery());
    } catch (error) {
      if (isNotFound(error as BusinessError)) return;
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Device token removal failed. error_code=%{public}s', errorCode(error as BusinessError));
      throw new Error('DEVICE_TOKEN_STORAGE');
    }
  }

  // An unreadable item counts as no token: sync stays local and the user can
  // pair again, which overwrites it.
  private async read(): Promise<StoredDeviceToken | undefined> {
    const query = aliasQuery();
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    let found: asset.AssetMap[];
    try {
      found = await asset.query(query);
    } catch (error) {
      if (!isNotFound(error as BusinessError)) {
        hilog.error(DOMAIN, TAG, '[AlgoFlow] Device token read failed. error_code=%{public}s', errorCode(error as BusinessError));
      }
      return undefined;
    }
    const secret = found.length > 0 ? found[0].get(asset.Tag.SECRET) : undefined;
    if (!(secret instanceof Uint8Array)) return undefined;
    try {
      const parsed = JSON.parse(util.TextDecoder.create('utf-8').decodeToString(secret)) as Record<string, Object>;
      const record = new StoredDeviceToken();
      record.sync_api = typeof parsed['sync_api'] === 'string' ? parsed['sync_api'] as string : '';
      record.device_token = typeof parsed['device_token'] === 'string' ? parsed['device_token'] as string : '';
      return record.sync_api.length > 0 && DEVICE_TOKEN_PATTERN.test(record.device_token) ? record : undefined;
    } catch (error) {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Device token record unreadable.');
      return undefined;
    }
  }
}

function aliasQuery(): asset.AssetMap {
  const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
  query.set(asset.Tag.ALIAS, encode(ALIAS));
  return query;
}

function encode(value: string): Uint8Array {
  return util.TextEncoder.create('utf-8').encodeInto(value);
}

function isNotFound(error: BusinessError): boolean {
  return error.code === asset.ErrorCode.NOT_FOUND;
}

function errorCode(error: BusinessError): string {
  const code = error.code;
  return typeof code === 'number' ? code.toString() : 'UNKNOWN';
}

function sameEndpoint(left: string, right: string): boolean {
  return trimSlash(left.trim()) === trimSlash(right.trim());
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.substring(0, value.length - 1) : value;
}
