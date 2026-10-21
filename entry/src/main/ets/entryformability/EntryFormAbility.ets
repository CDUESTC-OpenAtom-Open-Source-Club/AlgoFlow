import { formBindingData, FormExtensionAbility, formInfo } from '@kit.FormKit';
import { Want } from '@kit.AbilityKit';
import { CardSnapshot, cardFormData, loadCardSnapshot, loadCardSnapshotSync, updateCard } from '../platform/CardSnapshot';

export default class EntryFormAbility extends FormExtensionAbility {
  // onAddForm must return data synchronously, so the snapshot is read with the
  // synchronous preferences API; an unreadable snapshot falls back to the empty card.
  onAddForm(want: Want): formBindingData.FormBindingData {
    let snapshot = new CardSnapshot();
    try {
      snapshot = loadCardSnapshotSync(this.context);
    } catch (error) {
      console.error(`[AlgoFlow] card snapshot read failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    return formBindingData.createFormBindingData(cardFormData(snapshot));
  }

  onUpdateForm(formId: string, wantParams?: Record<string, Object>): void {
    this.refresh(formId);
  }

  onFormEvent(formId: string, message: string): void {}
  onRemoveForm(formId: string): void {}
  onCastToNormalForm(formId: string): void {}
  onChangeFormVisibility(newStatus: Record<string, number>): void {}
  onAcquireFormState(want: Want): formInfo.FormState { return formInfo.FormState.READY; }

  private async refresh(formId: string): Promise<void> {
    try {
      await updateCard(formId, await loadCardSnapshot(this.context));
    } catch (error) {
      console.error(`[AlgoFlow] card refresh failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}
