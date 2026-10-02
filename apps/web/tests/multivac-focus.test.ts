import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectFocus,
  workspaceSessionFocus,
} from '../src/features/assistant/multivac-focus.js';

test('侧栏正在看的对象：工作区只写会话名，会话页与项目页写明对象类型，引用只带 id', () => {
  assert.deepEqual(workspaceSessionFocus({ sessionId: 'work-1', title: '核对接口' }), {
    ref: { kind: 'workspace-session', sessionId: 'work-1' }, label: '「核对接口」',
  });
  assert.deepEqual(projectFocus({ projectId: 'project-1', name: 'Multivac 开发' }), {
    ref: { kind: 'project', projectId: 'project-1' }, label: '项目「Multivac 开发」',
  });
  assert.equal(workspaceSessionFocus(null), null);
  assert.equal(projectFocus(null), null);
});
