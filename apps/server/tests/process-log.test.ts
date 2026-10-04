import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessLog, redactProcessLog } from '../src/application/process-log.js';

test('日志遮蔽凭据及私钥、清理终端控制字符，HTML 保留为待纯文本渲染的数据', () => {
  const result = redactProcessLog('\x1b[31mhello\x1b[0m\nAuthorization: Bearer abc\napi_key=hidden\n<script>alert(1)</script>\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\n');
  assert.ok(result.includes('hello'));
  assert.ok(result.includes('<script>'));
  assert.equal(result.includes('abc'), false);
  assert.equal(result.includes('hidden'), false);
  assert.equal(result.includes('private'), false);
  assert.equal(result.includes('\x1b'), false);
});
test('大日志有界、部分敏感行不公开，追加后游标前进，未变更不重发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-log-'));
  const path = join(root, 'log');
  try {
    await writeFile(path, 'old line\n'.repeat(20000) + 'api_key=par');
    const first = await readProcessLog(path);
    assert.equal(first.truncated, true);
    assert.ok(Buffer.byteLength(first.text) <= 65536);
    assert.equal(first.text.includes('par'), false);
    await appendFile(path, 'tial-secret\nnext line\n');
    const next = await readProcessLog(path, first.cursor);
    assert.ok(next.cursor > first.cursor);
    assert.equal(next.text.includes('partial-secret'), false);
    assert.ok(next.text.includes('next line'));
    const same = await readProcessLog(path, next.cursor);
    assert.equal(same.unchanged, true); assert.equal(same.text, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
