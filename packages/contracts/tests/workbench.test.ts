import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  WindowIdSchema,
  WorkbenchEventSchema,
  WorkspaceSceneSchema,
} from '../src/index.js';

const scene = {
  workspaceId: 'default',
  scene: { parallelCount: 2, slots: ['a'], focusedSessionId: 'a', viewMode: 'focus', widths: {}, barVisible: true },
  revision: 3,
};

test('窗口 id 与会话 id 同一字符集；现场带非负整数版本', () => {
  assert.equal(Check(WindowIdSchema, '0f9e3c1e-4a8b-4c1d-9b6a-2f3e4d5c6b7a'), true);
  assert.equal(Check(WindowIdSchema, ''), false);
  assert.equal(Check(WindowIdSchema, 'bad id'), false);
  assert.equal(Check(WindowIdSchema, 'x'.repeat(129)), false);
  assert.equal(Check(WorkspaceSceneSchema, scene), true);
  assert.equal(Check(WorkspaceSceneSchema, { ...scene, revision: -1 }), false);
  const { revision: _revision, ...withoutRevision } = scene;
  assert.equal(Check(WorkspaceSceneSchema, withoutRevision), false);
});

test('工作台事件：带序号与来源的对象快照；连接消息只登记窗口；多余字段与未知类型不接受', () => {
  const origin = { windowId: 'window-a', commandId: null };
  assert.equal(Check(WorkbenchEventSchema, { type: 'workbench.connected', seq: 1, windowId: null }), true);
  assert.equal(Check(WorkbenchEventSchema, { type: 'scene.changed', seq: 2, origin, scene }), true);
  assert.equal(Check(WorkbenchEventSchema, {
    type: 'scene.changed', seq: 2, origin: { windowId: null, commandId: 'turn-1' }, scene,
  }), true);
  assert.equal(Check(WorkbenchEventSchema, { type: 'scene.changed', seq: 0, origin, scene }), false);
  assert.equal(Check(WorkbenchEventSchema, { type: 'scene.changed', seq: 2, origin: { windowId: 'a' }, scene }), false);
  assert.equal(Check(WorkbenchEventSchema, { type: 'scene.changed', seq: 2, origin, scene, extra: true }), false);
  assert.equal(Check(WorkbenchEventSchema, { type: 'session.changed', seq: 3, origin, change: 'deleted', session: {} }), false);
  assert.equal(Check(WorkbenchEventSchema, { type: 'window.navigate', seq: 4, origin }), false);
});

test('导航指令：切到某个工作区（带切换后的当前会话）或打开已实现的管理页（可带选中对象）；未实现的页面与多余字段不接受', () => {
  const origin = { windowId: 'window-a', commandId: 'turn-1' };
  const navigate = (target: unknown) => Check(WorkbenchEventSchema, { type: 'window.navigate', seq: 3, origin, target });
  assert.equal(navigate({ kind: 'workspace', workspaceId: 'default', sessionId: 's-1' }), true);
  assert.equal(navigate({ kind: 'workspace', workspaceId: 'default', sessionId: null }), true);
  assert.equal(navigate({ kind: 'management', page: 'models', selection: null }), true);
  assert.equal(navigate({ kind: 'management', page: 'projects', selection: { kind: 'project', projectId: 'p-1' } }), true);
  assert.equal(navigate({ kind: 'management', page: 'unimplemented', selection: null }), false);
  assert.equal(navigate({ kind: 'workspace', workspaceId: 'default' }), false);
  assert.equal(navigate({ kind: 'workspace', workspaceId: 'default', sessionId: null, scene: {} }), false);
  assert.equal(navigate({ kind: 'home' }), false);
});
