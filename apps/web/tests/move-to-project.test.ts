import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, SessionMoveResult, Workspace, WorkspaceSession } from '@multivac/contracts';
import { entryList, moveResultText, moveTargets } from '../src/features/workspace/move-to-project.js';

function project(projectId: string, name: string): Project {
  return {
    projectId, name, directories: [{ kind: 'managed', path: `/work/projects/${name}` }], defaultConstraints: '',
    createdAt: '2026-09-28T08:00:00.000Z', updatedAt: '2026-09-28T08:00:00.000Z',
  };
}

const workspaces: Workspace[] = [
  { workspaceId: 'p-1', name: '技术研究', project: project('p-1', '技术研究') },
  { workspaceId: 'p-2', name: '读书', project: project('p-2', '读书') },
  { workspaceId: 'default', name: '默认工作区', project: null },
];

const temp = { kind: 'session-temp' as const, path: '/work/sessions/2026-09-28-调研-abcd1234' };
const moved: WorkspaceSession = {
  sessionId: 's-1', title: '调研', kind: 'work', workspaceId: 'p-1', createdAt: '2026-09-28T08:00:00.000Z',
  archivedAt: null, parentSessionId: null, originText: null,
  workingDirectory: { kind: 'project-managed', path: '/work/projects/技术研究' },
};

function result(patch: Partial<SessionMoveResult>): SessionMoveResult {
  return { session: moved, files: null, sourceRemoved: false, tempRetentionDays: 30, ...patch };
}

test('可以归入的项目：全部项目工作区，按列表顺序，除去会话当前所在的项目，不含默认工作区', () => {
  assert.deepEqual(moveTargets(workspaces, { workspaceId: 'default' }).map((item) => item.workspaceId), ['p-1', 'p-2']);
  assert.deepEqual(moveTargets(workspaces, { workspaceId: 'p-1' }).map((item) => item.workspaceId), ['p-2']);
  assert.deepEqual(moveTargets(workspaces.slice(2), { workspaceId: 'default' }), []);
});

test('条目名列表最多列出前几个，其余只说数量', () => {
  assert.equal(entryList(['a.md', 'b.md'], 2), 'a.md、b.md');
  assert.equal(entryList(['a', 'b', 'c', 'd', 'e', 'f'], 6), 'a、b、c、d、e 等 6 项');
  // 服务端只返回了前若干个名称，总数更多。
  assert.equal(entryList(['a', 'b'], 120), 'a、b 等 120 项');
});

test('归入结果的说明：去了哪里、移入了多少、哪些留在原处，以及原临时目录的去留', () => {
  const text = (patch: Partial<SessionMoveResult>, from = temp) =>
    moveResultText({ title: '调研', projectName: '技术研究', from, result: result(patch) });
  assert.equal(text({ files: { moved: 3, skippedTotal: 0, skipped: [] }, sourceRemoved: true }),
    '已把「调研」归入「技术研究」，之后在项目目录中继续。3 项已移入项目目录。空的临时目录已删除。');
  assert.equal(text({ files: { moved: 1, skippedTotal: 1, skipped: ['README.md'] } }),
    `已把「调研」归入「技术研究」，之后在项目目录中继续。1 项已移入项目目录。README.md 与项目目录中已有的同名或没能移动，留在原临时目录 ${temp.path}。`);
  assert.equal(text({}), `已把「调研」归入「技术研究」，之后在项目目录中继续。临时目录里的文件留在原处：${temp.path}。`);
  assert.equal(text({ sourceRemoved: true }), '已把「调研」归入「技术研究」，之后在项目目录中继续。空的临时目录已删除。');
  // 原目录是项目目录：不涉及文件。
  assert.equal(text({}, { kind: 'project-managed', path: '/work/projects/读书' }), '已把「调研」归入「技术研究」，之后在项目目录中继续。');
});
