import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceSession } from '@multivac/contracts';
import { returnableParent, stackLevel, stackPath } from '../src/features/workspace/session-stack.js';

function session(sessionId: string, title: string, parentSessionId: string | null, archived = false): WorkspaceSession {
  return {
    sessionId, title, parentSessionId, kind: 'work', workspaceId: 'default',
    createdAt: '2026-09-28T08:00:00.000Z', archivedAt: archived ? '2026-09-28T09:00:00.000Z' : null,
    originText: parentSessionId ? '选中内容' : null,
    workingDirectory: { kind: 'session-temp', path: `/work/sessions/${sessionId}` },
  };
}

test('栈式路径与层级沿父会话链取名称，已归档的父会话标注“已归档”且不能返回', () => {
  const sessions = [
    session('root', '导航结构', null, true),
    session('child', '子话题', 'root'),
    session('grandchild', '孙话题', 'child'),
  ];
  assert.deepEqual(stackPath(sessions, 'grandchild'), ['导航结构（已归档）', '子话题', '孙话题']);
  assert.deepEqual(stackPath(sessions, 'root'), ['导航结构（已归档）']);
  assert.equal(stackLevel(sessions, 'child'), '第 2 层 · 来自「导航结构（已归档）」');
  assert.equal(stackLevel(sessions, 'grandchild'), '第 3 层 · 来自「子话题」');
  assert.equal(stackLevel(sessions, 'root'), null);

  // 父会话已归档时不能返回；父会话恢复后重新可用。
  assert.equal(returnableParent(sessions, 'child'), null);
  assert.equal(returnableParent(sessions, 'grandchild'), 'child');
  const restored = sessions.map((item) => item.sessionId === 'root' ? { ...item, archivedAt: null } : item);
  assert.equal(returnableParent(restored, 'child'), 'root');
  assert.deepEqual(stackPath(restored, 'child'), ['导航结构', '子话题']);
});

test('父会话不在列表中时路径止于本会话，层级只说明是栈式子会话；环形数据不会死循环', () => {
  const orphan = [session('child', '子话题', 'elsewhere')];
  assert.deepEqual(stackPath(orphan, 'child'), ['子话题']);
  assert.equal(stackLevel(orphan, 'child'), '栈式子会话');
  assert.equal(returnableParent(orphan, 'child'), null);

  const cyclic = [session('a', 'A', 'b'), session('b', 'B', 'a')];
  assert.deepEqual(stackPath(cyclic, 'a'), ['B', 'A']);
});

test('父子分属不同工作区（归入项目后）：路径照常沿父会话链并注明所在工作区，只在同一工作区时可以返回', () => {
  const sessions = [
    session('root', '导航结构', null),
    { ...session('child', '子话题', 'root'), workspaceId: 'p-1' },
    { ...session('grandchild', '孙话题', 'child'), workspaceId: 'p-1' },
  ];
  const names: Record<string, string> = { default: '默认工作区', 'p-1': '技术研究' };
  const inProject = { workspaceId: 'p-1', nameOf: (id: string) => names[id] ?? id };
  assert.deepEqual(stackPath(sessions, 'child', inProject), ['导航结构（在「默认工作区」）', '子话题']);
  assert.equal(stackLevel(sessions, 'child', inProject), '第 2 层 · 来自「导航结构（在「默认工作区」）」');
  assert.equal(stackLevel(sessions, 'grandchild', inProject), '第 3 层 · 来自「子话题」');
  assert.equal(returnableParent(sessions, 'child', 'p-1'), null);
  assert.equal(returnableParent(sessions, 'grandchild', 'p-1'), 'child');
  // 已归档且在别的工作区：两项都注明。
  const archived = sessions.map((item) => item.sessionId === 'root' ? { ...item, archivedAt: '2026-09-28T09:00:00.000Z' } : item);
  assert.deepEqual(stackPath(archived, 'child', inProject), ['导航结构（已归档，在「默认工作区」）', '子话题']);
  // 不给工作区时（沿用旧的调用方式）不注明所在，也不限制返回。
  assert.deepEqual(stackPath(sessions, 'child'), ['导航结构', '子话题']);
  assert.equal(returnableParent(sessions, 'child'), 'root');
});
