import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Workspace } from '@multivac/contracts';
import { createProjectInput, directoryName, directoryPaths, displayPath, mountPathError, projectsOf } from '../src/features/projects/project-directories.js';

const project: Project = {
  projectId: 'p-1', name: '文档', defaultConstraints: '',
  directories: [
    { kind: 'managed', path: '/w/projects/文档' },
    { kind: 'mounted', path: '/code/docs' },
    { kind: 'mounted', path: '/code/site' },
  ],
  createdAt: '2026-09-28T08:00:00.000Z', updatedAt: '2026-09-28T08:00:00.000Z',
};

test('目录调整转为整体提交的路径列表：挂载排在最后，卸载主目录由下一个接替，设为主目录移到最前', () => {
  assert.deepEqual(directoryPaths(project, { mount: '  /code/notes ' }), ['/w/projects/文档', '/code/docs', '/code/site', '/code/notes']);
  assert.deepEqual(directoryPaths(project, { unmount: '/code/docs' }), ['/w/projects/文档', '/code/site']);
  assert.deepEqual(directoryPaths(project, { unmount: '/w/projects/文档' }), ['/code/docs', '/code/site']);
  assert.deepEqual(directoryPaths(project, { primary: '/code/site' }), ['/code/site', '/w/projects/文档', '/code/docs']);
});

test('新建项目的请求去掉首尾空白，目录为空时不带 directory（创建托管目录）；项目取自工作区列表', () => {
  assert.deepEqual(createProjectInput('  文档 ', '   '), { name: '文档' });
  assert.deepEqual(createProjectInput('文档', ' ~/code/docs '), { name: '文档', directory: '~/code/docs' });
  const workspaces: Workspace[] = [
    { workspaceId: 'p-1', name: '文档', project },
    { workspaceId: 'default', name: '默认工作区', project: null },
  ];
  assert.deepEqual(projectsOf(workspaces), [project]);
  assert.deepEqual(projectsOf(null), []);
});

test('挂载前就地核对：空路径与项目中已有的目录（忽略首尾空白与末尾斜杠）直接说明原因，其余交给服务端', () => {
  assert.equal(mountPathError(project, ''), '请输入要挂载的目录。');
  assert.equal(mountPathError(project, '   '), '请输入要挂载的目录。');
  assert.equal(mountPathError(project, '/code/docs'), '这个目录已经在项目里了。');
  assert.equal(mountPathError(project, ' /code/site/ '), '这个目录已经在项目里了。');
  assert.equal(mountPathError(project, '/code/docs-2'), '');
  assert.equal(mountPathError(project, '~/code/notes'), '');
});

test('展示路径：主目录简写为 ~，目录名取最后一级', () => {
  assert.equal(displayPath('/Users/shuffle/code/docs'), '~/code/docs');
  assert.equal(displayPath('/home/shuffle'), '~');
  assert.equal(displayPath('/tmp/Users/shuffle/docs'), '/tmp/Users/shuffle/docs');
  assert.equal(directoryName('/code/docs/'), 'docs');
  assert.equal(directoryName('/'), '/');
});
