import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';

export default class EntryAbility extends UIAbility {
  private launchDraftId: string = '';

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.launchDraftId = this.readDraftId(want);
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Failed to set color mode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onWindowStageCreate');

    if (this.launchDraftId.length > 0) AppStorage.setOrCreate<string>('routeDraftId', this.launchDraftId);
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, '[AlgoFlow] Failed to load content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '[AlgoFlow] Content loaded.');
    });
  }

  onNewWant(want: Want): void {
    const draftId = this.readDraftId(want);
    if (draftId.length > 0) AppStorage.setOrCreate<string>('routeDraftId', draftId);
  }

  private readDraftId(want: Want): string {
    const parameters = want.parameters;
    if (parameters === undefined) return '';
    const value = parameters['draft_id'];
    return typeof value === 'string' ? value : '';
  }

  onWindowStageDestroy(): void {
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onWindowStageDestroy');
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onForeground');
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onBackground');
  }
}
