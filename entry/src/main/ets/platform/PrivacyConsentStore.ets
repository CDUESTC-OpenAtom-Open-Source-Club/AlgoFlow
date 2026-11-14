import { common } from '@kit.AbilityKit';
import preferences from '@ohos.data.preferences';

// Raise this when the privacy policy changes what it collects, why, or how long
// it keeps it (section 8 of deploy/privacy.template.html); everyone who agreed
// to an older version sees the consent page again.
export const PRIVACY_POLICY_VERSION: number = 1;

const STORE_NAME = 'algoflow_privacy_consent';
const KEY_AGREED_VERSION = 'privacy_agreed_version';

// Read synchronously because EntryAbility picks the first page before any UI
// exists. A store that cannot be read counts as no consent.
export function hasPrivacyConsent(context: common.Context): boolean {
  try {
    const store = preferences.getPreferencesSync(context, { name: STORE_NAME });
    return (store.getSync(KEY_AGREED_VERSION, 0) as number) >= PRIVACY_POLICY_VERSION;
  } catch (error) {
    console.error(`[AlgoFlow] privacy consent read failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return false;
  }
}

export async function savePrivacyConsent(context: common.Context): Promise<void> {
  const store = await preferences.getPreferences(context, STORE_NAME);
  await store.put(KEY_AGREED_VERSION, PRIVACY_POLICY_VERSION);
  await store.flush();
}
