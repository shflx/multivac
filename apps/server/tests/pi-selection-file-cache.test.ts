import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, renameSync, unlinkSync, rmSync, statSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { PiSelectionDisplayHistory } from '../src/runtime/executors/pi-selection-display-history.js';

function contents(id = 'pi-a', modelId = 'model-a') {
  return [
    { type: 'session', version: 3, id, timestamp: '2026-10-21T00:00:00.000Z', cwd: '/ignored' },
    { type: 'model_change', id: 'model', parentId: null, timestamp: '2026-10-21T00:00:00.000Z', provider: 'fixture', modelId },
    { type: 'thinking_level_change', id: 'level', parentId: 'model', timestamp: '2026-10-21T00:00:00.000Z', thinkingLevel: 'off' },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

test('Pi文件解析按真实版本复用；替换、保留mtime改写、截断、删除、身份和清理失效', async () => {
  mkdirSync('.tmp', { recursive: true });
  const root = mkdtempSync(resolve('.tmp/pi-selection-cache-'));
  const path = join(root, 'session.jsonl'); writeFileSync(path, contents());
  const adapter = new PiCoordinatorAdapter({ agentDir: root, sessionDir: root, modelsPath: null, temporaryRoot: root });
  const identity = { harness: 'pi' as const, runtimeSessionId: 'pi-a', runtimeSessionRef: path };
  const original = SessionManager.open;
  let parses = 0;
  SessionManager.open = (...args) => { parses++; return original(...args); };
  const read = () => adapter.readPersistedModelSelection(identity, root);
  try {
    const first = read(); assert.equal(first.ok && first.value?.modelId, 'model-a');
    const results = await Promise.all(Array.from({ length: 10 }, async () => read()));
    assert.ok(results.every(result => result.ok)); assert.equal(parses, 1);
    if (first.ok && first.value) first.value.modelId = 'mutated';
    assert.equal(read().ok && (read() as any).value.modelId, 'model-a');
    const before = statSync(path);
    writeFileSync(path, contents('pi-a', 'model-b')); utimesSync(path, before.atime, before.mtime);
    assert.equal((read() as any).value.modelId, 'model-b'); assert.equal(parses, 2);
    const replacement = join(root, 'replacement'); writeFileSync(replacement, contents('pi-a', 'model-c'));
    renameSync(replacement, path); assert.equal((read() as any).value.modelId, 'model-c'); assert.equal(parses, 3);
    appendFileSync(path, JSON.stringify({ type: 'thinking_level_change', id: 'new-level', parentId: 'level', timestamp: '2026-10-21T00:00:01.000Z', thinkingLevel: 'high' }) + '\n');
    assert.equal((read() as any).value.thinkingLevel, 'high'); assert.equal(parses, 4);
    assert.equal(adapter.readPersistedModelSelection({ ...identity, runtimeSessionId: 'wrong' }, root).ok, false);
    assert.equal(read().ok, true); assert.equal(parses, 6);
    writeFileSync(path, 'broken\n'); assert.equal(read().ok, false);
    writeFileSync(path, contents()); assert.equal(read().ok, true);
    unlinkSync(path); assert.equal(read().ok, false); assert.equal(read().ok, false);
    assert.equal(statSync(root).isDirectory(), true);
    writeFileSync(path, contents()); assert.equal(read().ok, true);
    const count = parses; adapter.dispose(); assert.equal(read().ok, true); assert.equal(parses, count + 1);
  } finally { SessionManager.open = original; adapter.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('展示缓存仅复用普通追加，分支与文件替换交回完整核对', () => {
  mkdirSync('.tmp', { recursive: true });
  const root = mkdtempSync(resolve('.tmp/pi-selection-display-'));
  const path = join(root, 'session.jsonl');
  const history = new PiSelectionDisplayHistory();
  let reads = 0;
  const read = () => history.read(path, () => { reads++; return { value: null, leafId: 'level' }; });
  const append = (parentId: string) => appendFileSync(path, JSON.stringify({ type: 'message', id: 'message', parentId, message: { role: 'user' } }) + '\n');
  try {
    writeFileSync(path, contents());
    const first = read();
    append('level');
    assert.deepEqual(read(), first);
    append('model');
    const branched = read();
    assert.notEqual(branched?.version, first?.version);
    const replacement = join(root, 'replacement');
    writeFileSync(replacement, contents('pi-a', 'model-b'));
    renameSync(replacement, path);
    assert.notEqual(read()?.version, branched?.version);
    assert.equal(reads, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('离线会话历史缓存有上限，不随历史无限增长', () => {
  mkdirSync('.tmp', { recursive: true }); const root = mkdtempSync(resolve('.tmp/pi-selection-bounds-'));
  const adapter = new PiCoordinatorAdapter({ agentDir: root, sessionDir: root, modelsPath: null, temporaryRoot: root });
  const original = SessionManager.open; let parses = 0;
  SessionManager.open = (...args) => { parses++; return original(...args); };
  try {
    for (let i = 0; i < 130; i++) {
      const path = join(root, i + '.jsonl'); writeFileSync(path, contents());
      assert.equal(adapter.readPersistedModelSelection({ harness: 'pi', runtimeSessionId: 'pi-a', runtimeSessionRef: path }, root).ok, true);
    }
    adapter.readPersistedModelSelection({ harness: 'pi', runtimeSessionId: 'pi-a', runtimeSessionRef: join(root, '0.jsonl') }, root);
    assert.equal(parses, 131);
  } finally { SessionManager.open = original; adapter.dispose(); rmSync(root, { recursive: true, force: true }); }
});
