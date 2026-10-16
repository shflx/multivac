import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  NOTE_SUMMARY_MIGRATION, NOTE_SUMMARIES_SELECT, NOTE_SUMMARY_SELECT, NOTE_SUMMARY_COUNT,
  NOTE_VERSION_SUMMARIES_SELECT, writeNoteSummaries,
} from '../apps/server/src/storage/sqlite-note-summaries.ts';

// 单进程、内存合成库；无文件访问、网络或派生进程。直接执行产品使用的迁移、查询与摘要写入函数。
const legacySchema = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE app_note(id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE app_note_version(note_id TEXT NOT NULL REFERENCES app_note(id), revision INTEGER NOT NULL,
    record_json TEXT NOT NULL, PRIMARY KEY(note_id, revision)) STRICT;
  CREATE INDEX app_note_active ON app_note(id) WHERE json_extract(record_json, '$.deleted') IS NOT 1;
`;
const legacySelect = `SELECT json_remove(record_json, '$.body') AS summary_json FROM app_note
  WHERE json_extract(record_json, '$.deleted') IS NOT 1
  ORDER BY json_extract(record_json, '$.updatedAt') DESC, id`;
const note = (id, body, revision = 1) => ({ id, title: `标题${id}`, body, revision, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-01-0${revision}T00:00:00.000Z` });
function putBody(database, value) {
  const json = JSON.stringify(value);
  database.prepare('INSERT INTO app_note VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(value.id, json);
  database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run(value.id, value.revision, json);
}
function measure(database, sql) {
  const statement = database.prepare(sql);
  const query = () => statement.all().map(row => JSON.parse(row.summary_json));
  query(); query();
  const samples = [];
  for (let index = 0; index < 7; index++) {
    const start = performance.now(); query(); samples.push(performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { samplesMs: samples, medianMs: sorted[3], minMs: sorted[0], maxMs: sorted.at(-1) };
}

// 派生摘要重建、历史不变、删除投影与同事务回滚的实际 SQL/函数检查。
const checks = [];
{
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(legacySchema);
    const first = note('a', '旧正文'); putBody(database, first);
    database.prepare('INSERT INTO app_note VALUES (?,?)').run('deleted', JSON.stringify({ id: 'deleted', deleted: true }));
    database.exec('BEGIN'); database.exec(NOTE_SUMMARY_MIGRATION); database.exec('COMMIT');
    assert.equal(database.prepare(NOTE_SUMMARY_COUNT).get().count, 1);
    assert.equal(database.prepare(NOTE_SUMMARY_SELECT).get('deleted'), undefined);
    const second = note('a', '新正文', 2);
    database.exec('BEGIN'); putBody(database, second); writeNoteSummaries(database, second); database.exec('COMMIT');
    assert.equal(JSON.parse(database.prepare(NOTE_SUMMARY_SELECT).get('a').summary_json).revision, 2);
    assert.deepEqual(database.prepare(NOTE_VERSION_SUMMARIES_SELECT).all('a', 3, 20).map(row => JSON.parse(row.summary_json).revision), [2, 1]);
    assert.equal(JSON.parse(database.prepare('SELECT record_json FROM app_note_version WHERE note_id=? AND revision=1').get('a').record_json).body, first.body);
    database.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON app_note_summary BEGIN SELECT RAISE(ABORT,'injected'); END;");
    database.exec('BEGIN');
    assert.throws(() => { const third = note('a', '不能提交', 3); putBody(database, third); writeNoteSummaries(database, third); }, /injected/);
    database.exec('ROLLBACK'); database.exec('DROP TRIGGER reject_summary');
    assert.equal(JSON.parse(database.prepare('SELECT record_json FROM app_note WHERE id=?').get('a').record_json).revision, 2);
    assert.equal(JSON.parse(database.prepare(NOTE_SUMMARY_SELECT).get('a').summary_json).revision, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM app_note_version WHERE revision=3').get().n, 0);
    database.exec('BEGIN'); database.exec(NOTE_SUMMARY_MIGRATION); database.exec('COMMIT');
    assert.equal(JSON.parse(database.prepare(NOTE_SUMMARY_SELECT).get('a').summary_json).revision, 2);
    database.exec("BEGIN; DELETE FROM app_note_summary WHERE id='a'; DELETE FROM app_note_version WHERE note_id='a'; UPDATE app_note SET record_json='{\"id\":\"a\",\"deleted\":true}' WHERE id='a'; COMMIT;");
    assert.equal(database.prepare(NOTE_SUMMARY_COUNT).get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM app_note_version_summary').get().n, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    checks.push('旧库回填排除墓碑、当前/历史摘要同步、不可变正文、注入失败回滚、迁移重放、删除与外键');
  } finally { database.close(); }
}

const cases = [];
for (const count of [100, 1000]) for (const bodyCharacters of [1000, 100000]) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(legacySchema);
    const body = 'x'.repeat(bodyCharacters);
    database.exec('BEGIN');
    for (let index = 0; index < count; index++) putBody(database, note(`note-${String(index).padStart(4, '0')}`, body));
    database.exec('COMMIT');
    const beforePlan = database.prepare(`EXPLAIN QUERY PLAN ${legacySelect}`).all();
    const before = measure(database, legacySelect);
    const start = performance.now();
    database.exec('BEGIN'); database.exec(NOTE_SUMMARY_MIGRATION); database.exec('COMMIT');
    const migrationMs = performance.now() - start;
    assert.deepEqual(database.prepare(NOTE_SUMMARIES_SELECT).all().map(row => JSON.parse(row.summary_json)), database.prepare(legacySelect).all().map(row => JSON.parse(row.summary_json)));
    const afterPlan = database.prepare(`EXPLAIN QUERY PLAN ${NOTE_SUMMARIES_SELECT}`).all();
    const after = measure(database, NOTE_SUMMARIES_SELECT);
    cases.push({ count, bodyCharacters, totalCurrentBodyCharacters: count * bodyCharacters, before, after, migrationMs, beforePlan, afterPlan });
  } finally { database.close(); }
}
console.log(JSON.stringify({
  kind: 'synthetic-sql-and-json-parse-only', node: process.version, platform: process.platform, arch: process.arch,
  generatedAt: new Date().toISOString(), repetitions: 7, warmups: 2,
  body: 'ASCII x；每篇一个历史版本，不使用用户数据库',
  method: '同进程同内存库先旧SQL，迁移后执行产品新SQL；包含Statement.all和JSON.parse，不含TypeBox校验、HTTP或浏览器',
  sql: { before: legacySelect, after: NOTE_SUMMARIES_SELECT, versions: NOTE_VERSION_SUMMARIES_SELECT }, checks, cases,
}, null, 2));
