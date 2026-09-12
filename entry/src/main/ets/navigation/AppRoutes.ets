import router from '@ohos.router';

export const HOME_ROUTE: string = 'pages/Home';
export const EDITOR_ROUTE: string = 'pages/Index';
export const PLACEHOLDER_ROUTE: string = 'pages/Placeholder';
export const ALL_DRAFTS_ROUTE: string = 'pages/AllDrafts';
export const HISTORY_ROUTE: string = 'pages/HistoryVersions';
export const NOTIFICATIONS_ROUTE: string = 'pages/Notifications';
export const SETTINGS_ROUTE: string = 'pages/Settings';

export const PLACEHOLDER_TITLE_KEY: string = 'placeholderTitle';
export const PLACEHOLDER_DETAIL_KEY: string = 'placeholderDetail';

export async function openEditor(draftId: string): Promise<void> {
  AppStorage.setOrCreate<string>('routeDraftId', draftId);
  await router.pushUrl({ url: EDITOR_ROUTE });
}

export async function openHome(): Promise<void> {
  await router.pushUrl({ url: HOME_ROUTE });
}

export async function openAllDrafts(): Promise<void> {
  await router.pushUrl({ url: ALL_DRAFTS_ROUTE });
}

export async function openHistory(): Promise<void> {
  await router.pushUrl({ url: HISTORY_ROUTE });
}

export async function openNotifications(): Promise<void> {
  await router.pushUrl({ url: NOTIFICATIONS_ROUTE });
}

export async function openSettings(): Promise<void> {
  await router.pushUrl({ url: SETTINGS_ROUTE });
}

export async function openPlaceholder(title: string, detail: string): Promise<void> {
  AppStorage.setOrCreate<string>(PLACEHOLDER_TITLE_KEY, title);
  AppStorage.setOrCreate<string>(PLACEHOLDER_DETAIL_KEY, detail);
  await router.pushUrl({ url: PLACEHOLDER_ROUTE });
}

export async function goBack(): Promise<void> {
  await router.back();
}
