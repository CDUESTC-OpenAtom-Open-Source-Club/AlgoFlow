import { describe, it, expect } from '@ohos/hypium';
import { abilityDelegatorRegistry } from '@kit.TestKit';
import { relationalStore } from '@kit.ArkData';
import { migrateWorkspaceStore, RdbDraftRepository } from '../../../main/ets/platform/RdbDraftRepository';
import { RdbAIResultRepository } from '../../../main/ets/platform/RdbAIResultRepository';
import { IDERecord, IDEState } from '../../../main/ets/domain/IDEAIModels';
import { AIMode, Draft } from '../../../main/ets/domain/Models';

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
        const ideaSegments = '[{"id":"segment-1","content":"保留用户思路","position":0}]';
        const payload = '{"id":"test-draft","workspace_id":"workspace-test","version":4,"created_at":"2026-09-26T00:00:00.000Z","updated_at":"2026-09-26T00:01:00.000Z","deleted":false,"last_modified_client_id":"phone-test","title":"迁移样例","language":"cpp","idea":"保留用户思路","code":"int value = 1;","short_code":"value += 1;","rewrite":"// rewrite","ai_mode":"faithful_transform","artifact_hidden":false,"sync_status":"local_only","idea_segments":[{"id":"segment-1","content":"保留用户思路","position":0}]}';
        await store.executeSql("INSERT INTO sync_state VALUES ('cursor', '42')");
        await store.executeSql("INSERT INTO drafts VALUES ('test-draft','workspace-test','迁移样例','保留用户思路','int value = 1;','value += 1;','// rewrite',4,'2026-09-26T00:00:00.000Z','2026-09-26T00:01:00.000Z',0,'phone-test','local_only','faithful_transform',0,?)", [ideaSegments]);
        await store.executeSql("INSERT INTO sync_operations VALUES ('operation-v1','draft','test-draft','upsert',3,'phone-test','2026-09-26T00:02:00.000Z',?)", [payload]);
        await store.executeSql("INSERT INTO conflicts VALUES ('conflict-v1','test-draft','test-draft-conflict',?, '2026-09-26T00:03:00.000Z', 0)", [payload]);
        await migrateWorkspaceStore(store);
        const cursor = await store.querySql("SELECT state_value FROM sync_state WHERE state_key = 'cursor'");
        try { expect(cursor.goToFirstRow()).assertTrue(); expect(cursor.getString(0)).assertEqual('42'); } finally { cursor.close(); }
        const draftRows = await store.querySql("SELECT workspace_id, title, idea, code, short_code, rewrite, version, idea_segments_json FROM drafts WHERE id = 'test-draft'");
        try {
          expect(draftRows.goToFirstRow()).assertTrue();
          expect(draftRows.getString(0)).assertEqual('workspace-test');
          expect(draftRows.getString(1)).assertEqual('迁移样例');
          expect(draftRows.getString(2)).assertEqual('保留用户思路');
          expect(draftRows.getString(3)).assertEqual('int value = 1;');
          expect(draftRows.getString(4)).assertEqual('value += 1;');
          expect(draftRows.getString(5)).assertEqual('// rewrite');
          expect(draftRows.getLong(6)).assertEqual(4);
          expect(draftRows.getString(7)).assertEqual(ideaSegments);
        } finally { draftRows.close(); }
        const operationRows = await store.querySql("SELECT operation_id, entity_id, base_version, payload_json FROM sync_operations WHERE operation_id = 'operation-v1'");
        try {
          expect(operationRows.goToFirstRow()).assertTrue();
          expect(operationRows.getString(0)).assertEqual('operation-v1');
          expect(operationRows.getString(1)).assertEqual('test-draft');
          expect(operationRows.getLong(2)).assertEqual(3);
          expect(operationRows.getString(3)).assertEqual(payload);
        } finally { operationRows.close(); }
        const conflictRows = await store.querySql("SELECT entity_id, local_copy_id, server_entity_json, resolved FROM conflicts WHERE id = 'conflict-v1'");
        try {
          expect(conflictRows.goToFirstRow()).assertTrue();
          expect(conflictRows.getString(0)).assertEqual('test-draft');
          expect(conflictRows.getString(1)).assertEqual('test-draft-conflict');
          expect(conflictRows.getString(2)).assertEqual(payload);
          expect(conflictRows.getLong(3)).assertEqual(0);
        } finally { conflictRows.close(); }
        const repository = new RdbAIResultRepository(store, false);
        const record = new IDERecord(); record.id = 'result-1'; record.context.draftId = 'test-draft';
        record.updatedAt = new Date().toISOString();
        await repository.save(record, true);
        const newer = new IDERecord(); newer.id = 'result-2'; newer.context.draftId = 'test-draft'; newer.updatedAt = record.updatedAt;
        await repository.save(newer, true);
        const testRepository = new RdbAIResultRepository(store, true);
        const testRecord = new IDERecord(); testRecord.id = 'result-test'; testRecord.context.draftId = 'test-draft';
        testRecord.hidden = true; testRecord.isTestData = true; testRecord.updatedAt = new Date(Date.now() + 1).toISOString();
        await testRepository.save(testRecord, true);
        await store.close();
        store = await relationalStore.getRdbStore(context, config);
        const reopened = new RdbAIResultRepository(store, false);
        const results = await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM);
        expect(results.length).assertEqual(1); expect(results[0].id).assertEqual('result-2');
        expect(results[0].hidden).assertFalse(); expect(results[0].stale).assertTrue();
        expect(results[0].state).assertEqual(IDEState.CANCELLED);
        const reopenedWithTests = new RdbAIResultRepository(store, true);
        const allResults = await reopenedWithTests.list('test-draft', AIMode.FAITHFUL_TRANSFORM);
        expect(allResults.length).assertEqual(2);
        const restoredTest = allResults.find((item: IDERecord) => item.isTestData);
        expect(restoredTest !== undefined).assertTrue();
        expect(restoredTest?.hidden).assertTrue();
        await store.executeSql("UPDATE ai_results SET record_json = '{}' ");
        let corrupt = false;
        try { await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM); } catch (error) { corrupt = true; }
        expect(corrupt).assertTrue();
        await reopened.removeDraft('test-draft');
        expect((await reopened.list('test-draft', AIMode.FAITHFUL_TRANSFORM)).length).assertEqual(0);
        await reopened.save(newer, true);
        const tombstone = new Draft('test-draft', '迁移样例'); tombstone.deleted = true; tombstone.version = 5;
        const draftRepository = new RdbDraftRepository(context, store);
        draftRepository.applyServerDraft(tombstone); await draftRepository.flush();
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
