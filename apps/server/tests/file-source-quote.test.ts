import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantFileQuote, CoordinatorFileQuote } from '@multivac/contracts';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { SessionFilesService } from '../src/application/session-files-service.js';
import { assistantQuoteDetails, renderAssistantQuoteForModel, ASSISTANT_QUOTE_CUSTOM_TYPE } from '../src/runtime/executors/pi-quote-carriage.js';
import { mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';

export const sourceQuote = (root: string, path = 'binary.bin'): AssistantFileQuote => ({ sourceKind: 'file', quoteKind: 'source', sourceSessionId: 'work', sourceFile: { root, path }, text: '' });

test('文件来源不调用预览或读取正文，支持二进制和超大文件，并复核失效来源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-file-source-'));
  try {
    const session = { archivedAt: null as string | null, workingDirectory: { kind: 'session-temp' as const, path: root } };
    const service = new SessionFilesService({ get: () => session }, join(root, 'data'));
    service.read = async () => { throw new Error('不得读取正文'); };
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255, 254]));
    await writeFile(join(root, 'large.txt'), Buffer.alloc(512 * 1024 + 1));
    for (const path of ['binary.bin', 'large.txt']) {
      const quote = await service.validateQuote(sourceQuote(root, path));
      assert.equal(quote.quoteKind, 'source'); assert.equal(quote.text, '');
      assert.deepEqual(quote.sourceFile, { root, path });
    }
    await mkdir(join(root, 'folder'));
    await assert.rejects(service.validateQuote(sourceQuote(root, 'folder')), /类型已变化/);
    await symlink(join(root, 'binary.bin'), join(root, 'link'));
    await assert.rejects(service.validateQuote(sourceQuote(root, 'link')), /符号链接/);
    await assert.rejects(service.validateQuote(sourceQuote('/old-root')), /工作目录已变化/);
    session.archivedAt = '2026-10-20';
    await assert.rejects(service.validateQuote(sourceQuote(root)), /不可用/);
    session.archivedAt = null;
    await rm(join(root, 'binary.bin'));
    await assert.rejects(service.validateQuote(sourceQuote(root)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('文件来源按原始身份恢复历史，模型只取得位置和原权限说明', () => {
  const quote: CoordinatorFileQuote = { sourceKind: 'file', quoteKind: 'source', sourceFile: { root: '/原始 目录', path: '文件.bin' }, text: '', source: { sessionId: 'work', title: '所属会话' } };
  const details = assistantQuoteDetails(quote);
  const rendered = JSON.parse(renderAssistantQuoteForModel(quote));
  assert.deepEqual(rendered.file, quote.sourceFile);
  assert.match(rendered.scope, /未读取文件正文/);
  const entries = [
    { type: 'custom_message', id: 'quote', parentId: null, customType: ASSISTANT_QUOTE_CUSTOM_TYPE, content: '', display: false, details, timestamp: '2026-10-20T00:00:00Z' },
    { type: 'message', id: 'user', parentId: 'quote', message: { role: 'user', content: '请检查来源', timestamp: 0 }, timestamp: '2026-10-20T00:00:00Z' },
  ] as unknown as SessionEntry[];
  assert.deepEqual(mapPiActiveBranch('pi', entries)[0]?.quote, { ...sourceQuote('/原始 目录', '文件.bin'), sourceTitle: '所属会话' });
});
