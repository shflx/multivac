import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  CreateProjectSchema,
  CreateWorkspaceSessionSchema,
  normalizeProjectName,
  PROJECT_NAME_MAX_LENGTH,
  ProjectSchema,
  WorkspaceSchema,
  WorkspaceSessionListResponseSchema,
} from '../src/index.js';

const project = {
  projectId: 'p-1',
  name: '技术研究',
  directories: [{ kind: 'managed', path: '/Users/me/Multivac/projects/技术研究' }],
  defaultConstraints: '',
  createdAt: '2026-09-28T08:00:00.000Z',
  updatedAt: '2026-09-28T08:00:00.000Z',
};

test('项目至少一个目录，目录只有托管与挂载两种；工作区可以不属于项目', () => {
  assert.equal(Check(ProjectSchema, project), true);
  assert.equal(Check(ProjectSchema, { ...project, directories: [] }), false);
  assert.equal(Check(ProjectSchema, { ...project, directories: [{ kind: 'worktree', path: '/x' }] }), false);
  assert.equal(Check(WorkspaceSchema, { workspaceId: 'p-1', name: '技术研究', project }), true);
  assert.equal(Check(WorkspaceSchema, { workspaceId: 'default', name: '默认工作区', project: null }), true);
});

test('新建项目与会话列表的请求形状', () => {
  assert.equal(Check(CreateProjectSchema, { name: '研究' }), true);
  assert.equal(Check(CreateProjectSchema, { name: '研究', directory: '/Users/me/code', defaultConstraints: '只读' }), true);
  assert.equal(Check(CreateProjectSchema, { name: '研究', directories: [] }), false);
  assert.equal(Check(CreateWorkspaceSessionSchema, { sessionId: 's-1', title: '会话', workspaceId: 'p-1' }), true);
  assert.equal(Check(WorkspaceSessionListResponseSchema, { workspaceId: null, sessions: [] }), true);
  assert.equal(normalizeProjectName('  研究  '), '研究');
  assert.equal(normalizeProjectName('   '), null);
  assert.equal(normalizeProjectName('长'.repeat(PROJECT_NAME_MAX_LENGTH + 1)), null);
});
