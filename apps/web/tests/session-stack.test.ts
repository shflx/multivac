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
