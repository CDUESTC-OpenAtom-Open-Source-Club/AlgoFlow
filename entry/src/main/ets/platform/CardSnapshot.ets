import { common } from '@kit.AbilityKit';
import preferences from '@ohos.data.preferences';
import { Draft, SyncStatus } from '../domain/Models';

const STORE_NAME = 'algoflow_card_snapshot';
const KEY_DRAFT_ID = 'draft_id';
const KEY_TITLE = 'title';
const KEY_STATUS = 'sync_status';
const KEY_UPDATED_AT = 'updated_at';

export class CardSnapshot {
  draftId: string = '';
  title: string = '暂无草稿';
  syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY;
  updatedAt: string = '';
}

export async function saveCardSnapshot(context: common.Context, draft: Draft): Promise<void> {
  const store = await preferences.getPreferences(context, STORE_NAME);
  await store.put(KEY_DRAFT_ID, draft.id);
  await store.put(KEY_TITLE, draft.title);
  await store.put(KEY_STATUS, draft.syncStatus);
  await store.put(KEY_UPDATED_AT, draft.updatedAt);
  await store.flush();
}

export async function loadCardSnapshot(context: common.Context): Promise<CardSnapshot> {
  const store = await preferences.getPreferences(context, STORE_NAME);
  const snapshot = new CardSnapshot();
  snapshot.draftId = await store.get(KEY_DRAFT_ID, '') as string;
  snapshot.title = await store.get(KEY_TITLE, '暂无草稿') as string;
  snapshot.syncStatus = parseSyncStatus(await store.get(KEY_STATUS, SyncStatus.LOCAL_ONLY) as string);
  snapshot.updatedAt = await store.get(KEY_UPDATED_AT, '') as string;
  return snapshot;
}

function parseSyncStatus(value: string): SyncStatus {
  if (value === SyncStatus.SYNCING) return SyncStatus.SYNCING;
  if (value === SyncStatus.SYNCED) return SyncStatus.SYNCED;
  if (value === SyncStatus.CONFLICT) return SyncStatus.CONFLICT;
  if (value === SyncStatus.FAILED) return SyncStatus.FAILED;
  return SyncStatus.LOCAL_ONLY;
}
