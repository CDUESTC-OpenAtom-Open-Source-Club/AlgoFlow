import { describe, it, expect } from '@ohos/hypium';
import { abilityDelegatorRegistry } from '@kit.TestKit';
import { relationalStore } from '@kit.ArkData';
import { migrateWorkspaceStore } from '../../../main/ets/platform/RdbDraftRepository';
import { RdbAIResultRepository } from '../../../main/ets/platform/RdbAIResultRepository';
import { IDERecord, IDEState } from '../../../main/ets/domain/IDEAIModels';
import { AIMode } from '../../../main/ets/domain/Models';

// Only isolated test databases are touched. Run on a signed API 20 test target.
export default function aiStorageTest() {
  describe('AIStorageRealRDB', () => {
    it('fresh_upgrade_restart_slots_cleanup_and_corruption', 0, async () => {
      const context = abilityDelegatorRegistry.getAbilityDelegator().getAppContext();
      const name = `algoflow_ai_acceptance_${Date.now()}.db`;
      const config: relationalStore.StoreConfig = { name: name, securityLevel: relationalStore.SecurityLevel.S1 };
      let store = await relationalStore.getRdbStore(context, config);
      try {
        await migrateWorkspaceStore(store);
        expect(store.version).assertEqual(2);
        // Recreate the exact v1 boundary while retaining all ordinary tables.
        await store.executeSql('DROP TABLE ai_results');
        store.version = 1;
        await store.executeSql("INSERT INTO sync_state VALUES ('cursor', '42')");
        await store.executeSql("INSERT INTO drafts VALUES ('test-draft','w','t','i','c','','',1,'t','t',0,'phone','local_only','faithful_transform',0,'[]')");
        await migrateWorkspaceStore(store);
        const cursor = await store.querySql("SELECT state_value FROM sync_state WHERE state_key = 'cursor'");
        try { expect(cursor.goToFirstRow()).assertTrue(); expect(cursor.getString(0)).assertEqual('42'); } finally { cursor.close(); }
        const repository = new RdbAIResultRepository(store, false);
        const record = new IDERecord(); record.id = 'result-1'; record.context.draftId = 'test-draft';
        record.updatedAt = new Date().toISOString();
        await repository.save(record, true);
        const newer = new IDERecord(); newer.id = 'result-2'; newer.context.draftId = 'test-draft'; newer.updatedAt = record.updatedAt;
        await repository.save(newer, true);
        record.hidden = true; await repository.save(record, false);
        await store.close();
        store = await relationalStore.getRdbStore(context, config);
        const reopened = new RdbAIResultRepository(store, false);
        const results = await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM);
        expect(results.length).assertEqual(1); expect(results[0].id).assertEqual('result-2');
        expect(results[0].hidden).assertFalse(); expect(results[0].stale).assertTrue();
        expect(results[0].state).assertEqual(IDEState.CANCELLED);
        await store.executeSql("UPDATE ai_results SET record_json = '{}' ");
        let corrupt = false;
        try { await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM); } catch (error) { corrupt = true; }
        expect(corrupt).assertTrue();
        await reopened.removeDraft('test-draft');
        expect((await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM)).length).assertEqual(0);
        await store.executeSql("UPDATE drafts SET deleted = 1 WHERE id = 'test-draft'");
        await reopened.save(newer, true);
        expect((await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM)).length).assertEqual(0);
        store.version = 3;
        let high = false;
        try { await migrateWorkspaceStore(store); } catch (error) { high = true; }
        expect(high).assertTrue(); expect(store.version).assertEqual(3);
      } finally { await store.close(); await relationalStore.deleteRdbStore(context, name); }
    });
    it('failed_upgrade_rolls_back_without_advancing_version', 0, async () => {
      const context = abilityDelegatorRegistry.getAbilityDelegator().getAppContext();
      const name = `algoflow_ai_rollback_${Date.now()}.db`;
      const store = await relationalStore.getRdbStore(context, { name: name, securityLevel: relationalStore.SecurityLevel.S1 });
      try {
        await migrateWorkspaceStore(store);
        await store.executeSql('DROP TABLE ai_results');
        await store.executeSql('CREATE INDEX ai_results ON drafts(id)');
        store.version = 1;
        let failed = false;
        try { await migrateWorkspaceStore(store); } catch (error) { failed = true; }
        expect(failed).assertTrue(); expect(store.version).assertEqual(1);
        await store.executeSql('DROP INDEX ai_results');
        await migrateWorkspaceStore(store); expect(store.version).assertEqual(2);
        const repository = new RdbAIResultRepository(store, false);
        await store.close();
        let writeFailed = false;
        const record = new IDERecord(); record.id = 'closed-store';
        try { await repository.save(record, true); } catch (error) { writeFailed = true; }
        expect(writeFailed).assertTrue();
      } finally { await relationalStore.deleteRdbStore(context, name); }
    });
  });
}
