import { describe, it, expect } from '@ohos/hypium';
import { abilityDelegatorRegistry } from '@kit.TestKit';
import { relationalStore } from '@kit.ArkData';
import { migrateWorkspaceStore, RdbDraftRepository } from '../../../main/ets/platform/RdbDraftRepository';
import { RdbAIResultRepository } from '../../../main/ets/platform/RdbAIResultRepository';
import { IDERecord, IDEState } from '../../../main/ets/domain/IDEAIModels';
import { parseIDEResult } from '../../../main/ets/domain/IDEAIContract';
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
        // Start from the real v1 schema so this test exercises v1->v2->v3,
        // rather than changing the version number after a v3 migration.
        await store.executeSql('CREATE TABLE IF NOT EXISTS drafts (' +
          'id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, idea TEXT NOT NULL, ' +
          'code TEXT NOT NULL, short_code TEXT NOT NULL, rewrite TEXT NOT NULL, version INTEGER NOT NULL, ' +
          'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL, ' +
          'last_modified_client_id TEXT NOT NULL, sync_status TEXT NOT NULL, ai_mode TEXT NOT NULL, ' +
          'artifact_hidden INTEGER NOT NULL, idea_segments_json TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS sync_operations (' +
          'operation_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, ' +
          'operation_type TEXT NOT NULL, base_version INTEGER NOT NULL, client_id TEXT NOT NULL, ' +
          'occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL)');
        await store.executeSql('CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_operations_entity ' +
          'ON sync_operations(entity_type, entity_id)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS sync_state (' +
          'state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS conflicts (' +
          'id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, local_copy_id TEXT NOT NULL, ' +
          'server_entity_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL)');
        store.version = 1;
        const ideaSegments = '[{"id":"segment-1","content":"保留用户思路","position":0}]';
        const payload = '{"id":"test-draft","workspace_id":"workspace-test","version":4,"created_at":"2026-09-26T00:00:00.000Z","updated_at":"2026-09-26T00:01:00.000Z","deleted":false,"last_modified_client_id":"phone-test","title":"迁移样例","language":"cpp","idea":"保留用户思路","code":"int value = 1;","short_code":"value += 1;","rewrite":"// rewrite","ai_mode":"faithful_transform","artifact_hidden":false,"sync_status":"local_only","idea_segments":[{"id":"segment-1","content":"保留用户思路","position":0}]}';
        await store.executeSql("INSERT INTO sync_state VALUES ('cursor', '42')");
        await store.executeSql("INSERT INTO drafts VALUES ('test-draft','workspace-test','迁移样例','保留用户思路','int value = 1;','value += 1;','// rewrite',4,'2026-09-26T00:00:00.000Z','2026-09-26T00:01:00.000Z',0,'phone-test','local_only','faithful_transform',0,?)", [ideaSegments]);
        await store.executeSql("INSERT INTO sync_operations VALUES ('operation-v1','draft','test-draft','upsert',3,'phone-test','2026-09-26T00:02:00.000Z',?)", [payload]);
        await store.executeSql("INSERT INTO conflicts (id, entity_id, local_copy_id, server_entity_json, created_at, resolved) VALUES ('conflict-v1','test-draft','test-draft-conflict',?, '2026-09-26T00:03:00.000Z', 0)", [payload]);
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
        const conflictRows = await store.querySql("SELECT entity_type, entity_id, local_copy_id, server_entity_json, resolved FROM conflicts WHERE id = 'conflict-v1'");
        try {
          expect(conflictRows.goToFirstRow()).assertTrue();
          expect(conflictRows.getString(0)).assertEqual('draft');
          expect(conflictRows.getString(1)).assertEqual('test-draft');
          expect(conflictRows.getString(2)).assertEqual('test-draft-conflict');
          expect(conflictRows.getString(3)).assertEqual(payload);
          expect(conflictRows.getLong(4)).assertEqual(0);
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
        store.version = 4;
        let high = false;
        try { await migrateWorkspaceStore(store); } catch (error) { high = true; }
        expect(high).assertTrue(); expect(store.version).assertEqual(4);
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
        await migrateWorkspaceStore(store); expect(store.version).assertEqual(3);
        const repository = new RdbAIResultRepository(store, false);
        await store.close();
        let writeFailed = false;
        const record = new IDERecord(); record.id = 'closed-store';
        try { await repository.save(record, true); } catch (error) { writeFailed = true; }
        expect(writeFailed).assertTrue();
      } finally { await relationalStore.deleteRdbStore(context, name); }
    });
    it('pr23_legacy_artifacts_import_idempotency_and_corrupt_rollback', 0, async () => {
      const context = abilityDelegatorRegistry.getAbilityDelegator().getAppContext();
      const name = `algoflow_pr23_migration_${Date.now()}.db`;
      const store = await relationalStore.getRdbStore(context, { name: name, securityLevel: relationalStore.SecurityLevel.S1 });
      try {
        await store.executeSql('CREATE TABLE IF NOT EXISTS drafts (' +
          'id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, idea TEXT NOT NULL, ' +
          'code TEXT NOT NULL, short_code TEXT NOT NULL, rewrite TEXT NOT NULL, version INTEGER NOT NULL, ' +
          'created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL, ' +
          'last_modified_client_id TEXT NOT NULL, sync_status TEXT NOT NULL, ai_mode TEXT NOT NULL, ' +
          'artifact_hidden INTEGER NOT NULL, ai_artifacts_json TEXT NOT NULL DEFAULT \'\', idea_segments_json TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS sync_operations (' +
          'operation_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, ' +
          'operation_type TEXT NOT NULL, base_version INTEGER NOT NULL, client_id TEXT NOT NULL, ' +
          'occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS sync_state (state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL)');
        await store.executeSql('CREATE TABLE IF NOT EXISTS conflicts (' +
          'id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, local_copy_id TEXT NOT NULL, ' +
          'server_entity_json TEXT NOT NULL, created_at TEXT NOT NULL, resolved INTEGER NOT NULL)');
        // Recreate the actual PR #23 v1 boundary. The v1->v2 migration adds
        // independent AI result tables, source history, and conflicts.entity_type;
        // the following v2->v3 step imports the embedded artifacts.
        store.version = 1;
        const ideaSegments = '[{"id":"segment-1","content":"按右端点排序","position":0}]';
        await store.executeSql("INSERT INTO drafts VALUES ('pr23-draft','workspace-pr23','PR23迁移','按右端点排序','int x = 0;','','',2,'2026-09-26T00:00:00.000Z','2026-09-26T00:01:00.000Z',0,'phone-pr23','local_only','feasibility_analysis',0,'{\"broken\":true}',?)", [ideaSegments]);
        let corruptFailed = false;
        try { await migrateWorkspaceStore(store); } catch (error) { corruptFailed = true; }
        expect(corruptFailed).assertTrue();
        expect(store.version).assertEqual(2);
        const invalidSource = '[{"mode":"faithful_transform","pseudocode":[{"id":"step_1","step":"Unknown source","source_refs":["missing-segment"]}],"code_snippet":null,"code_mappings":[],"assumptions":[],"missing_information":[],"risk_flags":[],"added_algorithm_steps":[],"source_draft_version":2,"model_id":"legacy-model","rule_version":"1.0.0","output_kind":"pseudocode","visibility":"visible","template_id":null}]';
        await store.executeSql("UPDATE drafts SET ai_artifacts_json = ? WHERE id = 'pr23-draft'", [invalidSource]);
        await migrateWorkspaceStore(store);
        expect(store.version).assertEqual(3);
        const isolatedRepository = new RdbAIResultRepository(store, false);
        const isolated = await isolatedRepository.list('pr23-draft', AIMode.FAITHFUL_TRANSFORM);
        expect(isolated.length).assertEqual(1);
        expect(isolated[0].hidden).assertTrue();
        expect(isolated[0].context.segments.length).assertEqual(1);
        expect(isolated[0].context.segments[0].id).assertEqual('missing-segment');
        await store.executeSql("DELETE FROM ai_results WHERE draft_id = 'pr23-draft'");
        store.version = 2;
        const legacyArtifacts = '[{"mode":"faithful_transform","pseudocode":[{"id":"step_1","step":"Sort by right endpoint","source_refs":["segment-1"]}],"code_snippet":null,"code_mappings":[],"assumptions":[],"missing_information":[],"risk_flags":[],"added_algorithm_steps":[],"source_draft_version":2,"model_id":"legacy-model","rule_version":"1.0.0","output_kind":"pseudocode","visibility":"visible","template_id":null},{"mode":"feasibility_analysis","pseudocode":[{"id":"step_2","step":"Analyze greedy choice","source_refs":["segment-1"]}],"code_snippet":null,"code_mappings":[],"assumptions":[],"missing_information":[],"risk_flags":["greedy choice not proven"],"added_algorithm_steps":["Consider exchange argument"],"source_draft_version":2,"model_id":"legacy-model","rule_version":"1.0.0","output_kind":"pseudocode","visibility":"visible","template_id":null},{"mode":"progressive_hint","pseudocode":[{"id":"step_3","step":"Check current interval","source_refs":["segment-1"]}],"code_snippet":"if (cur.left >= lastRight) { lastRight = cur.right; }","code_mappings":[{"step_id":"step_3","start_line":1,"end_line":1}],"assumptions":[],"missing_information":[],"risk_flags":[],"added_algorithm_steps":["Track last selected endpoint"],"source_draft_version":2,"model_id":"legacy-model","rule_version":"1.0.0","output_kind":"code_snippet","visibility":"hidden","template_id":null}]';
        await store.executeSql("UPDATE drafts SET ai_artifacts_json = ? WHERE id = 'pr23-draft'", [legacyArtifacts]);
        await migrateWorkspaceStore(store);
        expect(store.version).assertEqual(3);
        const repository = new RdbAIResultRepository(store, false);
        const faithful = await repository.list('pr23-draft', AIMode.FAITHFUL_TRANSFORM);
        expect(faithful.length).assertEqual(1);
        expect(faithful[0].id).assertEqual('legacy-pr23-draft-0');
        expect(faithful[0].context.mode).assertEqual(AIMode.FAITHFUL_TRANSFORM);
        expect(faithful[0].restored).assertTrue();
        const feasibility = await repository.list('pr23-draft', AIMode.FEASIBILITY_ANALYSIS);
        expect(feasibility.length).assertEqual(1);
        expect(feasibility[0].id).assertEqual('legacy-pr23-draft-1');
        expect(feasibility[0].context.mode).assertEqual(AIMode.FEASIBILITY_ANALYSIS);
        expect(feasibility[0].restored).assertTrue();
        const hint = await repository.list('pr23-draft', AIMode.PROGRESSIVE_HINT);
        expect(hint.length).assertEqual(1);
        expect(hint[0].hidden).assertTrue();
        const hintText = parseIDEResult(hint[0].body, hint[0]).transformText;
        expect(hintText.includes('if (cur.left >= lastRight)')).assertTrue();
        expect(hintText.includes('step_3: L1-L1')).assertTrue();
        store.version = 2;
        await migrateWorkspaceStore(store);
        expect(store.version).assertEqual(3);
        expect((await repository.list('pr23-draft', AIMode.FAITHFUL_TRANSFORM)).length).assertEqual(1);
        expect((await repository.list('pr23-draft', AIMode.FEASIBILITY_ANALYSIS)).length).assertEqual(1);
        expect((await repository.list('pr23-draft', AIMode.PROGRESSIVE_HINT)).length).assertEqual(1);
      } finally { await store.close(); await relationalStore.deleteRdbStore(context, name); }
    });
  });
}
