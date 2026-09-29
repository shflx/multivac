import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedSessionFocus,
  projectFocus,
  workspaceSessionFocus,
} from '../src/features/assistant/multivac-focus.js';

test('侧栏正在看的对象：工作区只写会话名，会话页与项目页写明对象类型，引用只带 id', () => {
  assert.deepEqual(workspaceSessionFocus({ sessionId: 'work-1', title: '核对接口' }), {
    ref: { kind: 'workspace-session', sessionId: 'work-1' }, label: '「核对接口」',
  });
  assert.deepEqual(managedSessionFocus({ sessionId: 'work-1', title: '核对接口', archivedAt: null }), {
    ref: { kind: 'workspace-session', sessionId: 'work-1' }, label: '会话「核对接口」',
  });
  assert.deepEqual(projectFocus({ projectId: 'project-1', name: 'Multivac 开发' }), {
    ref: { kind: 'project', projectId: 'project-1' }, label: '项目「Multivac 开发」',
  });
  assert.equal(workspaceSessionFocus(null), null);
  assert.equal(managedSessionFocus(null), null);
  assert.equal(projectFocus(null), null);
});

test('已归档的会话不作为上下文：服务端只接受未归档的工作会话', () => {
  assert.equal(managedSessionFocus({ sessionId: 'work-1', title: '核对接口', archivedAt: '2026-09-29T00:00:00.000Z' }), null);
});
