import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessageView } from '@multivac/contracts';
import { messageFileReferences, MessageFileSources } from '../src/application/message-file-sources.js';
import { SqliteAssistantStore, SqliteMessageFileSourceRepository } from '../src/storage/sqlite-assistant-store.js';

test('只从语义 Markdown 文件链接提取来源，校验路径与定位，忽略代码、图片和外部链接', () => {
  const text = '[源码](src/main.ts#L12-L20) [章节](docs/readme.md#阅读现场) [外部](https://example.com) [越界](../secret) [非法](notes.txt#L0) ![图片](image.txt) `notes.txt`\n\n```md\n[代码](fake.txt)\n```\n\n[索引][ref]\n\n[ref]: notes.txt';
  const references = messageFileReferences(text, '/workspace');
  assert.deepEqual(references.map((item) => item.path), ['src/main.ts', 'docs/readme.md', 'notes.txt']);
  assert.equal(references[0]?.line, 12); assert.equal(references[0]?.endLine, 20); assert.equal(references[1]?.section, '阅读现场');
  assert.deepEqual(messageFileReferences('[越界](file:///etc/passwd) [编码](%2e%2e/secret) [反斜线](a%5Cb) [非法行](a.txt#L20001)', '/workspace'), []);
});

test('来源在 SQLite 重开后保持当时根目录，旧历史不补造来源，重复投影不覆盖', () => {
  const directory = mkdtempSync(join(tmpdir(), 'multivac-file-sources-'));
  const database = join(directory, 'state.sqlite');
  let store = new SqliteAssistantStore(database);
  try {
    let sources = new MessageFileSources(new SqliteMessageFileSourceRepository(store));
    const message: AssistantMessageView = { id: 'msg', piSessionId: 'pi', piEntryId: 'entry', role: 'assistant', text: '[源码](source.ts#L2)', createdAt: new Date().toISOString() };
    sources.seed('session', [{ ...message, piEntryId: 'legacy' }]);
    sources.capture('session', '/original', [message]);
    store.close(); store = new SqliteAssistantStore(database);
    sources = new MessageFileSources(new SqliteMessageFileSourceRepository(store));
    sources.seed('session', [message]); sources.capture('session', '/changed', [message]);
    assert.equal(sources.project('session', message).fileReferences?.[0]?.root, '/original');
    assert.equal(sources.project('session', { ...message, piEntryId: 'legacy' }).fileReferences, undefined);
    assert.equal(sources.project('other', message).fileReferences, undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
