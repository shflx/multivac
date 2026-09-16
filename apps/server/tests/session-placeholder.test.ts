import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ensurePersistedSessionManager, type SessionPlaceholderOperations } from '../src/runtime/executors/pi-session-factory.js';

test('占位准备 open/stat/read 失败且路径替换或追加时所有清理分支保留文件', async () => {
  for (const stage of ['open', 'stat', 'read'] as const) {
    for (const mutation of ['replace', 'append', 'unverifiable'] as const) {
      const root = await mkdtemp(join(tmpdir(), `multivac-placeholder-${stage}-${mutation}-`));
      const cwd = join(root, 'workspace');
      const sessionDir = join(root, 'sessions');
      await mkdir(cwd, { recursive: true });
      const manager = SessionManager.create(cwd, sessionDir);
      const path = manager.getSessionFile()!;
      let failed = false;
      const inject = () => {
        if (failed) {
          if (mutation === 'unverifiable') throw new Error('ownership cannot be verified');
          return;
        }
        failed = true;
        if (mutation === 'replace') {
          const content = readFileSync(path, 'utf8');
          renameSync(path, `${path}.original`);
          writeFileSync(path, content);
        } else if (mutation === 'append') {
          appendFileSync(path, `${JSON.stringify({ type: 'custom', id: 'other-writer' })}\n`);
        }
        throw new Error('preparation failed');
      };
      const operations: SessionPlaceholderOperations = {
        openSession: (file, directory, workspace) => {
          if (stage === 'open') inject();
          return SessionManager.open(file, directory, workspace);
        },
        stat: (file) => {
          if (stage === 'stat') inject();
          return statSync(file, { bigint: true });
        },
        read: (file) => {
          if (stage === 'read' || (stage === 'open' && mutation === 'unverifiable')) inject();
          return readFileSync(file, 'utf8');
        },
        unlink: (file) => unlinkSync(file),
      };
      try {
        assert.throws(() => ensurePersistedSessionManager(manager, { cwd, sessionDir }, operations));
        assert.equal(existsSync(path), true, `${stage}/${mutation}`);
        if (mutation === 'append') assert.match(readFileSync(path, 'utf8'), /other-writer/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
