import { common } from '@kit.AbilityKit';
import { formBindingData, formInfo, formProvider } from '@kit.FormKit';
import preferences from '@ohos.data.preferences';
import { Draft, SyncStatus } from '../domain/Models';

const STORE_NAME = 'algoflow_card_snapshot';
const KEY_DRAFT_ID = 'draft_id';
const KEY_TITLE = 'title';
const KEY_STATUS = 'sync_status';
const KEY_UPDATED_AT = 'updated_at';
const TITLE_LIMIT = 24;

export class CardSnapshot {
  draftId: string = '';
  title: string = '';
  syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY;
  updatedAt: string = '';
}

// Field names match the @LocalStorageProp keys in widget/pages/WidgetCard.ets.
export class CardFormData {
  title: string = '';
  draftId: string = '';
  syncLabel: string = '';
  hasDraft: boolean = false;
}

// The card shows the most recently updated live draft, never a tombstone. A
// failed or conflicting sync run is surfaced even when the draft row itself
// still carries its previous status.
export function selectCardSnapshot(drafts: Draft[], runStatus?: SyncStatus): CardSnapshot {
  const snapshot = new CardSnapshot();
  const latest = drafts.filter((draft: Draft) => !draft.deleted)
    .sort((left: Draft, right: Draft) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (latest === undefined) return snapshot;
  snapshot.draftId = latest.id;
  snapshot.title = latest.title;
  snapshot.updatedAt = latest.updatedAt;
  snapshot.syncStatus = runStatus === SyncStatus.FAILED || runStatus === SyncStatus.CONFLICT ? runStatus : latest.syncStatus;
  return snapshot;
}

export function cardFormData(snapshot: CardSnapshot): CardFormData {
  const data = new CardFormData();
  data.hasDraft = snapshot.draftId.length > 0;
  data.draftId = snapshot.draftId;
  const title = snapshot.title.trim().length > 0 ? snapshot.title.trim() : '未命名思路';
  data.title = !data.hasDraft ? '暂无草稿' : title.length > TITLE_LIMIT ? `${title.substring(0, TITLE_LIMIT)}…` : title;
  data.syncLabel = data.hasDraft ? cardStatusLabel(snapshot.syncStatus) : '点击新建思路开始记录';
  return data;
}

export function cardStatusLabel(status: SyncStatus): string {
  if (status === SyncStatus.SYNCED) return '已同步';
  if (status === SyncStatus.SYNCING) return '同步中';
  if (status === SyncStatus.CONFLICT) return '有冲突';
  if (status === SyncStatus.FAILED) return '同步失败';
  return '仅本地';
}

// Used by FormExtensionAbility.onAddForm, which must return binding data
// synchronously. The cache is dropped first because the UIAbility may have
// written the file from another process.
export function loadCardSnapshotSync(context: common.Context): CardSnapshot {
  preferences.removePreferencesFromCacheSync(context, STORE_NAME);
  const store = preferences.getPreferencesSync(context, { name: STORE_NAME });
  const snapshot = new CardSnapshot();
  snapshot.draftId = store.getSync(KEY_DRAFT_ID, '') as string;
  snapshot.title = store.getSync(KEY_TITLE, '') as string;
  snapshot.syncStatus = parseSyncStatus(store.getSync(KEY_STATUS, SyncStatus.LOCAL_ONLY) as string);
  snapshot.updatedAt = store.getSync(KEY_UPDATED_AT, '') as string;
  return snapshot;
}

let publishChain: Promise<void> = Promise.resolve();

// Persists the card snapshot and pushes it to every added card. Calls are
// serialized so a slow earlier publish cannot overwrite a newer snapshot.
export function publishCardSnapshot(context: common.Context, drafts: Draft[], runStatus?: SyncStatus): Promise<void> {
  const snapshot = selectCardSnapshot(drafts, runStatus);
  publishChain = publishChain.then(() => writeAndRefresh(context, snapshot));
  return publishChain;
}

async function writeAndRefresh(context: common.Context, snapshot: CardSnapshot): Promise<void> {
  try {
    const store = await preferences.getPreferences(context, STORE_NAME);
    await store.put(KEY_DRAFT_ID, snapshot.draftId);
    await store.put(KEY_TITLE, snapshot.title);
    await store.put(KEY_STATUS, snapshot.syncStatus);
    await store.put(KEY_UPDATED_AT, snapshot.updatedAt);
    await store.flush();
  } catch (error) {
    console.error(`[AlgoFlow] card snapshot write failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return;
  }
  await refreshAddedCards(snapshot);
}

export async function refreshAddedCards(snapshot: CardSnapshot): Promise<void> {
  let forms: string[] = [];
  try {
    forms = (await formProvider.getPublishedRunningFormInfos()).map((info: formInfo.RunningFormInfo) => info.formId);
  } catch (error) {
    console.error(`[AlgoFlow] card list failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return;
  }
  for (const formId of forms) await updateCard(formId, snapshot);
}

export async function updateCard(formId: string, snapshot: CardSnapshot): Promise<void> {
  try {
    await formProvider.updateForm(formId, formBindingData.createFormBindingData(cardFormData(snapshot)));
  } catch (error) {
    console.error(`[AlgoFlow] card update failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

export async function loadCardSnapshot(context: common.Context): Promise<CardSnapshot> {
  preferences.removePreferencesFromCacheSync(context, STORE_NAME);
  const store = await preferences.getPreferences(context, STORE_NAME);
  const snapshot = new CardSnapshot();
  snapshot.draftId = await store.get(KEY_DRAFT_ID, '') as string;
  snapshot.title = await store.get(KEY_TITLE, '') as string;
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
