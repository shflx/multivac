import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspace, WorkspaceSession } from '@multivac/contracts';
import {
  DEFAULT_SESSION_FILTER,
  filterSessions,
  projectFilterOptions,
  sessionKindLabel,
  type SessionFilter,
} from '../src/features/sessions/session-filter.js';

function session(sessionId: string, title: string, patch: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    sessionId,
    title,
    kind: 'work',
    workspaceId: 'default',
    createdAt: '2026-09-28T08:00:00.000Z',
    archivedAt: null,
    parentSessionId: null,
    originText: null,
    workingDirectory: { kind: 'session-temp', path: `/work/sessions/${sessionId}` },
    ...patch,
  };
}

// 按创建时间升序，与列表接口一致。
const sessions = [
  session('nav', '导航结构'),
  session('nav-child', 'Fake 子话题', { parentSessionId: 'nav', originText: '选中的一段' }),
  session('draft', '旧草稿', { archivedAt: '2026-09-28T09:00:00.000Z' }),
  session('archived-child', '归档的子话题', { parentSessionId: 'nav', archivedAt: '2026-09-28T09:00:00.000Z' }),
  session('project', '项目里的会话', { workspaceId: 'project-a' }),
];

const ids = (patch: Partial<SessionFilter>) =>
  filterSessions(sessions, { ...DEFAULT_SESSION_FILTER, ...patch }).map((item) => item.sessionId);

test('默认只看全部工作区里进行中的会话，新建的在前', () => {
  assert.deepEqual(ids({}), ['project', 'nav-child', 'nav']);
});

test('按状态、类型与工作区筛选，条件可以叠加', () => {
  assert.deepEqual(ids({ status: 'archived' }), ['archived-child', 'draft']);
  assert.deepEqual(ids({ status: 'all' }), ['project', 'archived-child', 'draft', 'nav-child', 'nav']);

  assert.deepEqual(ids({ status: 'all', kind: 'stacked' }), ['archived-child', 'nav-child']);
  assert.deepEqual(ids({ status: 'all', kind: 'top' }), ['project', 'draft', 'nav']);
  assert.deepEqual(ids({ status: 'archived', kind: 'stacked' }), ['archived-child']);

  assert.deepEqual(ids({ status: 'all', workspaceId: 'default' }), ['archived-child', 'draft', 'nav-child', 'nav']);
  assert.deepEqual(ids({ workspaceId: 'project-a' }), ['project']);
  assert.deepEqual(ids({ workspaceId: 'missing' }), []);
});

test('按标题搜索：忽略首尾空白与大小写，只看标题', () => {
  assert.deepEqual(ids({ status: 'all', query: '  fake ' }), ['nav-child']);
  assert.deepEqual(ids({ status: 'all', query: '子话题' }), ['archived-child', 'nav-child']);
  assert.deepEqual(ids({ status: 'all', query: '子话题', kind: 'top' }), []);
  // 不按内容搜索：栈式来源的选中内容不参与匹配。
  assert.deepEqual(ids({ status: 'all', query: '选中的一段' }), []);
  assert.deepEqual(ids({ query: '   ' }), ids({}));
});

test('类型说明', () => {
  assert.equal(sessionKindLabel(sessions[0]!), '顶层会话');
  assert.equal(sessionKindLabel(sessions[1]!), '栈式子会话');
});

function workspace(workspaceId: string, name: string, project: boolean): Workspace {
  return {
    workspaceId,
    name,
    project: project
      ? {
        projectId: workspaceId,
        name,
        directories: [{ kind: 'managed', path: `/work/projects/${name}` }],
        defaultConstraints: '',
        createdAt: '2026-09-28T08:00:00.000Z',
        updatedAt: '2026-09-28T08:00:00.000Z',
      }
      : null,
  };
}

test('项目筛选：全部项目、各项目、不属于项目（默认工作区）；还没有项目时不显示', () => {
  const fallback = workspace('default', '默认工作区', false);
  assert.equal(projectFilterOptions([fallback]), null);
  assert.equal(projectFilterOptions([]), null);
  assert.deepEqual(projectFilterOptions([workspace('project-a', '技术研究', true), workspace('project-b', '读书笔记', true), fallback]), [
    { value: 'all', label: '全部项目' },
    { value: 'project-a', label: '技术研究' },
    { value: 'project-b', label: '读书笔记' },
    { value: 'default', label: '不属于项目' },
  ]);
});
