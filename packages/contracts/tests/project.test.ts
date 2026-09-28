import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  CreateProjectSchema,
  CreateWorkspaceSessionSchema,
  normalizeProjectName,
  PROJECT_DIRECTORY_MAX_COUNT,
  PROJECT_NAME_MAX_LENGTH,
  ProjectPreviewResponseSchema,
  ProjectSchema,
  UpdateProjectSchema,
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

test('更新项目只改给出的字段，至少一项；目录按顺序给出路径，至少保留一个', () => {
  assert.equal(Check(UpdateProjectSchema, { name: '新名称' }), true);
  assert.equal(Check(UpdateProjectSchema, { directories: ['/Users/me/code', '/Users/me/docs'], defaultConstraints: '' }), true);
  assert.equal(Check(UpdateProjectSchema, {}), false);
  assert.equal(Check(UpdateProjectSchema, { directories: [] }), false);
  assert.equal(Check(UpdateProjectSchema, { directories: [{ kind: 'mounted', path: '/x' }] }), false);
  assert.equal(Check(UpdateProjectSchema, { directories: Array.from({ length: PROJECT_DIRECTORY_MAX_COUNT + 1 }, (_, index) => `/d${index}`) }), false);
  assert.equal(Check(UpdateProjectSchema, { name: '研究', projectId: 'p-2' }), false);
  assert.equal(Check(ProjectPreviewResponseSchema, { name: '研究', directory: { kind: 'managed', path: '/w/projects/研究' } }), true);
});
