## Summary

```text
AI 局部补全请求
├── 未接受结果 -> 仅本地 AI 结果存储，不进入同步桥
├── 接受前 -> 校验草稿、版本、main.cpp 和生成上下文
├── 接受后 -> 普通编辑器事务 -> Draft 保存/同步
└── 撤回 -> 仅在代码与上下文未变化时恢复原代码
```

Issue 31 isolates local completion candidates until explicit acceptance. Web and OpenHarmony now keep completion results out of AI result synchronization, validate the source context before writing `main.cpp`, preserve short code and other documents, and support a context-guarded withdrawal of the accepted edit.

## Evidence

- **Before:** completion persistence could be passed through the normal result bridge and had no explicit withdrawal state.
  **After:** completion records remain local; only accepted source edits use the ordinary Draft update path, and withdrawal is disabled after edits, context switches, synchronization changes, or restart.
- `node --test apps/web/test/ai-session.test.mjs tests/phone-ai.test.mjs`: 151 passed.
- `node --test services/ai-gateway/test/*.test.mjs services/sync-api/test/*.test.mjs`: 405 passed.
- `npm run build` in `apps/web`: passed.
- `npx tsc -p tsconfig.app.json --noEmit` in `apps/web`: passed.

## Merge Danger

**Door:** two-way

The change is isolated to AI completion session state, editor application, local AI result persistence, and focused tests. Reverting the commit restores the previous completion workflow without a schema or sync protocol migration.

**Blast Radius:** AI completion

Review and faithful-transform result synchronization remain unchanged. Accepted completion edits still follow normal Draft versioning and conflict handling.
