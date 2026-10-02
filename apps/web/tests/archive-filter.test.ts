import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspace, WorkspaceSession } from '@multivac/contracts';
import { archiveWorkspaceFilter, DEFAULT_ARCHIVE_FILTER, filterArchives, projectFilterOptions } from '../src/features/archive/archive-filter.js';
function session(sessionId: string, archivedAt: string | null, patch: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return { sessionId, title: sessionId, kind: 'work', workspaceId: 'default', createdAt: '2026-01-01T00:00:00Z', archivedAt, parentSessionId: null, originText: null, workingDirectory: { kind: 'session-temp', path: `/work/${sessionId}` }, ...patch };
}
const sessions = [session('Old', '2026-01-02T00:00:00Z'), session('Child', '2026-01-04T00:00:00Z', { parentSessionId: 'Old', workspaceId: 'real-workspace' }), session('Active', null), session('Middle', '2026-01-03T00:00:00Z')];
test('归档只含已归档工作会话，按归档时间排序；不改变原列表', () => {
  assert.deepEqual(filterArchives(sessions, DEFAULT_ARCHIVE_FILTER).map((s) => s.title), ['Child', 'Middle', 'Old']);
  assert.equal(sessions[0]!.title, 'Old');
});
test('标题搜索与真实工作区筛选叠加，忽略大小写及空白', () => {
  assert.deepEqual(filterArchives(sessions, { workspaceId: 'real-workspace', query: ' child ' }).map((s) => s.title), ['Child']);
  assert.deepEqual(filterArchives(sessions, { workspaceId: 'default', query: 'child' }), []);
});
const workspaces = [{ workspaceId: 'default', name: '默认工作区', project: null }, { workspaceId: 'real-workspace', name: '项目', project: { projectId: 'different-project-id' } }] as Workspace[];
test('筛选使用 workspaceId，最近与失效工作区打开全部归档；无项目时不显示项目筛选', () => {
  assert.equal(archiveWorkspaceFilter(workspaces, 'recent'), 'all');
  assert.equal(archiveWorkspaceFilter(workspaces, 'missing'), 'all');
  assert.equal(archiveWorkspaceFilter(workspaces, 'real-workspace'), 'real-workspace');
  assert.equal(projectFilterOptions([workspaces[0]!]), null);
  assert.deepEqual(projectFilterOptions(workspaces), [{ value: 'all', label: '全部项目' }, { value: 'default', label: '默认工作区' }, { value: 'real-workspace', label: '项目' }]);
});
