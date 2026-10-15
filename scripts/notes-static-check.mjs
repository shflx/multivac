import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// 单进程、无网络，仅检查任务目录内的真实文件与新增迁移 SQL；不冒充 TypeScript 或产品链路验证。
const root = process.cwd();
const files = [
  'packages/contracts/src/notes.ts', 'packages/contracts/src/note-assistant.ts', 'packages/contracts/src/note-suggestions.ts',
  'apps/server/src/storage/sqlite-notes-repository.ts', 'apps/server/src/storage/sqlite-note-assistant-repository.ts', 'apps/server/src/storage/sqlite-note-suggestions-repository.ts',
  'apps/server/src/application/notes-service.ts', 'apps/server/src/application/note-assistant-service.ts', 'apps/server/src/application/note-suggestion-parser.ts', 'apps/server/src/application/note-suggestions-service.ts',
  'apps/server/src/adapters/http/notes-routes.ts', 'apps/server/src/adapters/http/note-assistant-routes.ts', 'apps/server/src/adapters/http/note-suggestions-routes.ts',
  'apps/web/src/data/notes-api.ts', 'apps/web/src/data/note-assistant-api.ts',
  'apps/web/src/features/notes/note-draft.ts', 'apps/web/src/features/notes/note-editor.tsx', 'apps/web/src/features/notes/notes-app.tsx', 'apps/web/src/features/notes/note-assistant.tsx', 'apps/web/src/features/notes/note-selection-toolbar.ts', 'apps/web/src/features/notes/note-versions.tsx',
];
const checks = [];
for (const file of files) {
  const source = readFileSync(join(root, file), 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/gu)) {
    const path = resolve(dirname(join(root, file)), match[1]);
    assert.ok(!relative(root, path).startsWith('..'), `目录外引用: ${file}`);
    const candidates = [path, path.replace(/\.js$/u, '.ts'), path.replace(/\.js$/u, '.tsx')];
    assert.ok(candidates.some(candidate => existsSync(candidate)), `缺失相对依赖: ${file} -> ${match[1]}`);
  }
}
checks.push({ check: '新增模块的相对引用存在且位于目录内', result: 'pass', fileCount: files.length });
const database = new DatabaseSync(':memory:');
try {
  database.exec('PRAGMA foreign_keys=ON; CREATE TABLE assistant_session_registry (session_id TEXT PRIMARY KEY) STRICT;');
  for (const file of files.filter(file => file.includes('/storage/'))) {
    const source = readFileSync(join(root, file), 'utf8');
    const sql = /export const [A-Z_]+_MIGRATION = `([\s\S]*?)`;/u.exec(source)?.[1];
    assert.ok(sql, `未找到新增迁移: ${file}`); database.exec(sql); database.exec(sql);
  }
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(names, ['app_note', 'app_note_command', 'app_note_context', 'app_note_discussion', 'app_note_suggestion', 'app_note_suggestion_source', 'app_note_version', 'assistant_session_registry']);
  database.prepare('INSERT INTO app_note VALUES (?,?)').run('note', '{}');
  database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run('note', 1, '{}');
  assert.throws(() => database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run('note', 1, '{}'));
  database.prepare('INSERT INTO assistant_session_registry VALUES (?)').run('discussion');
  database.prepare('INSERT INTO app_note_discussion VALUES (?,?,?)').run('discussion', 'note', '{}');
  database.prepare('INSERT INTO app_note_context VALUES (?,?,?,?,?)').run('context', 'discussion', 'note', 1, '{}');
  assert.throws(() => database.prepare('INSERT INTO app_note_context VALUES (?,?,?,?,?)').run('missing-version', 'discussion', 'note', 2, '{}'));
  checks.push({ check: '新增迁移 SQL 执行及重放、版本唯一约束、上下文版本外键', result: 'pass', tables: names });
} finally { database.close(); }
const ui = files.filter(file => file.includes('/features/notes/')).map(file => readFileSync(join(root, file), 'utf8')).join('\n');
assert.ok(!/交给\s*Multivac|收进笔记|纳入知识库|HandoverHint|IncludeKnowledgeButton/u.test(ui));
checks.push({ check: '独立笔记UI未包含排除的交接/收集/知识库入口', result: 'pass' });
const report = { kind: 'static-and-new-migration-sql-only', timestamp: new Date().toISOString(), checks,
  notRun: ['TypeScript检查', '完整数据库升级/服务测试', '真实Pi模型', '浏览器闭环/多窗口/重启/停止'],
};
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, 'artifacts/notes-static-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
