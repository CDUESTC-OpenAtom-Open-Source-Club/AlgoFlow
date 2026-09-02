import { formBindingData, FormExtensionAbility, formInfo, formProvider } from '@kit.FormKit';
import { Want } from '@kit.AbilityKit';
import { loadCardSnapshot } from '../platform/CardSnapshot';
import { SyncStatus } from '../domain/Models';

class CardFormData {
  title: string = '';
  draftId: string = '';
  syncStatus: string = '';
  stage: string = '';
}

export default class EntryFormAbility extends FormExtensionAbility {
  onAddForm(want: Want): formBindingData.FormBindingData {
    this.updateFormSnapshot(want, '添加中');
    const data = new CardFormData();
    data.title = 'AlgoFlow';
    data.syncStatus = '待预研';
    data.stage = '开发中';
    return formBindingData.createFormBindingData(data);
  }

  onUpdateForm(formId: string, wantParams?: Record<string, Object>): void {
    this.updateFormSnapshot(undefined, formId);
  }

  onFormEvent(formId: string, message: string): void {
    this.updateFormSnapshot(undefined, formId);
  }

  onRemoveForm(formId: string): void {}
  onCastToNormalForm(formId: string): void {}
  onChangeFormVisibility(newStatus: Record<string, number>): void {}
  onAcquireFormState(want: Want): formInfo.FormState { return formInfo.FormState.READY; }

  private async updateFormSnapshot(want: Want | undefined, formId: string): Promise<void> {
    try {
      const snapshot = await loadCardSnapshot(this.context);
      const data = new CardFormData();
      data.title = snapshot.title;
      data.draftId = snapshot.draftId;
      data.syncStatus = statusLabel(snapshot.syncStatus);
      data.stage = '开发中';
      if (formId !== '添加中') {
        await formProvider.updateForm(formId, formBindingData.createFormBindingData(data));
      }
    } catch (error) {
      console.error(`[AlgoFlow] card snapshot failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

function statusLabel(status: SyncStatus): string {
  if (status === SyncStatus.SYNCED) return '已同步';
  if (status === SyncStatus.SYNCING) return '同步中';
  if (status === SyncStatus.CONFLICT) return '有冲突';
  if (status === SyncStatus.FAILED) return '同步失败';
  return '仅本地';
}
