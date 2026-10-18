import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('Skill 目录保留全局可用性，笔记讨论不能取得跨应用包', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'multivac-skill-host-')));
  const app = createMultivacApplication(testApplicationEnvironment(join(root, 'instance')));
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const source = join(root, 'sample');
    await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), '---\nname: sample\ndescription: 可复用资料\nallowed-tools: ""\n---\n仅供工作会话使用。');
    const preview = await post('/api/skills/preview', { source, displayName: '', projectId: null });
    assert.equal(preview.status, 200, await preview.clone().text());
    const { previewId } = await preview.json();
    assert.equal((await post('/api/skills/confirm', { commandId: 'import', previewId })).status, 200);
    const global = await fetch(base + '/api/skills/catalog?sessionId=global-coordinator');
    assert.equal(global.status, 200);
    assert.equal((await global.json()).length, 1);

    assert.equal((await post('/api/notes', { commandId: 'note', id: 'note', title: '笔记', body: '当前正文' })).status, 200);
    const companion = await post('/api/notes/note/companion', {});
    assert.equal(companion.status, 200);
    const { sessionId } = await companion.json();
    const catalog = await fetch(base + '/api/skills/catalog?sessionId=' + encodeURIComponent(sessionId));
    assert.equal(catalog.status, 403);
    assert.match((await catalog.json()).error.message, /笔记讨论不提供 Skill/u);
  } finally {
    app.server.closeAllConnections();
    if (app.server.listening) await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
