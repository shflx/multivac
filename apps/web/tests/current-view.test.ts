import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { CurrentViewSnapshotSchema } from '@multivac/contracts';
import { currentViewSnapshot, type CurrentViewInput } from '../src/features/assistant/current-view.js';

/** 发送时的当前视图快照：由外壳状态组成，只含面板、布局与对象 id，符合契约。 */

const base: CurrentViewInput = {
  panel: 'workspace',
  narrow: false,
  workspace: {
    workspaceId: 'default',
    scene: { parallelCount: 3, viewMode: 'parallel', slots: ['a', 'b', 'c'], focusedSessionId: 'b' },
  },
  rememberedWorkspaceId: 'project-1',
  managementPage: 'archive',
  selectedSessionId: 'a',
  selectedProjectId: 'p1',
};

test('工作区中：带上工作区视图报告的栏位与焦点会话，不带管理页', () => {
  const view = currentViewSnapshot(base);
  assert.deepEqual(view, {
    panel: 'workspace', narrow: false, workspace: base.workspace, management: null,
  });
  assert.equal(Check(CurrentViewSnapshotSchema, view), true);
});

test('工作区还没在本窗口打开：当前工作区取本机记住的那个，现场留给服务端补充', () => {
  const view = currentViewSnapshot({ ...base, panel: 'home', narrow: true, workspace: null });
  assert.deepEqual(view.workspace, { workspaceId: 'project-1', scene: null });
  assert.equal(view.narrow, true);
  assert.equal(view.management, null);
});

test('管理中：只带当前页选中的对象（归档页的会话、项目页的项目），其他页没有选中对象', () => {
  assert.deepEqual(currentViewSnapshot({ ...base, panel: 'management' }).management, {
    page: 'archive', selection: { kind: 'session', sessionId: 'a' },
  });
  assert.deepEqual(currentViewSnapshot({ ...base, panel: 'management', managementPage: 'projects' }).management, {
    page: 'projects', selection: { kind: 'project', projectId: 'p1' },
  });
  assert.deepEqual(currentViewSnapshot({ ...base, panel: 'management', managementPage: 'models' }).management, {
    page: 'models', selection: null,
  });
  assert.equal(Check(CurrentViewSnapshotSchema, currentViewSnapshot({ ...base, panel: 'management' })), true);
});
