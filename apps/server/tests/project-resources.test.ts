import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROJECT_RESOURCE_LIMITS } from '@multivac/contracts';
import { ProjectResourceService } from '../src/application/project-resource-service.js';
import { ProjectService } from '../src/application/project-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/modules/sessions/work-paths.js';
import { DirectoryTrash } from '../src/storage/trash.js';

function fixture(name = '资料项目', strictInstanceBoundary = true) {
  const root = mkdtempSync(join(tmpdir(), 'project-resources-'));
  const data = join(root, 'data'); mkdirSync(data);
  const store = new SqliteAssistantStore(join(data, 'db.sqlite'));
  const paths = resolveMultivacWorkPaths(join(root, 'work'), data, strictInstanceBoundary);
  const projects = new ProjectService({ projects: store.projects, workspaces: store.workspaces, workPaths: paths, dataDir: data, homeDir: root });
  const project = projects.createProject({ name }).project;
  const calls: string[][] = [];
  const resources = new ProjectResourceService({ resources: store.projectResources, projects, workPaths: paths, trash: new DirectoryTrash(join(root, 'trash')), system: { platform: 'darwin', run: async (command, args) => { calls.push([command, ...args]); } } });
  return { root, store, projects, project, resources, calls, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('新建和复制重名不覆盖，引用不复制，移除遵守两种来源的保留边界', () => {
  const f = fixture();
  try {
    const first = f.resources.create(f.project.projectId, { kind: 'new', fileName: '需求' });
    const second = f.resources.create(f.project.projectId, { kind: 'upload', fileName: '需求.md', contentBase64: Buffer.from('复制正文').toString('base64') });
    assert.notEqual(first.path, second.path); assert.equal(readFileSync(first.path, 'utf8'), '# 需求\n');
    assert.equal(f.resources.read(f.project.projectId, second.resourceId).text, '复制正文');
    const original = join(f.project.directories[0]!.path, '原文.md'); writeFileSync(original, '引用正文');
    const reference = f.resources.create(f.project.projectId, { kind: 'directory', path: '原文.md' });
    assert.throws(() => f.resources.create(f.project.projectId, { kind: 'directory', path: '原文.md' }), /已经/u);
    f.resources.remove(f.project.projectId, reference.resourceId); assert.equal(readFileSync(original, 'utf8'), '引用正文');
    f.resources.remove(f.project.projectId, second.resourceId);
    const wrapper = readdirSync(join(f.root, 'trash'))[0]!;
    assert.equal(readFileSync(join(f.root, 'trash', wrapper, second.fileName), 'utf8'), '复制正文');
  } finally { f.close(); }
});

test('目录引用登记后被替换为外部链接，读取、常驻上下文与本机打开均不能越界', async () => {
  const f = fixture();
  try {
    const original = join(f.project.directories[0]!.path, 'reference.md'); writeFileSync(original, '原正文');
    const resource = f.resources.create(f.project.projectId, { kind: 'directory', path: original });
    f.resources.update(f.project.projectId, resource.resourceId, { pinned: true });
    const outside = join(f.root, 'outside.md'); writeFileSync(outside, '不得读取的项目外正文');
    unlinkSync(original); symlinkSync(outside, original);
    assert.throws(() => f.resources.read(f.project.projectId, resource.resourceId));
    assert.doesNotMatch(f.resources.context(f.project.projectId), /不得读取的项目外正文/u);
    await assert.rejects(f.resources.open(f.project.projectId, resource.resourceId));
    assert.equal(f.resources.list(f.project.projectId).resources[0]!.file.status, 'missing'); assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('项目卸载的目录不再提供资料正文或系统定位', async () => {
  const f = fixture();
  try {
    const original = join(f.project.directories[0]!.path, 'reference.md'); writeFileSync(original, '已卸载目录正文');
    const resource = f.resources.create(f.project.projectId, { kind: 'directory', path: original });
    f.resources.update(f.project.projectId, resource.resourceId, { pinned: true, summary: '' });
    const other = f.projects.createProject({ name: '其他项目' }).project;
    f.store.projects.update(f.project.projectId, { directories: other.directories, updatedAt: new Date().toISOString() });
    assert.throws(() => f.resources.read(f.project.projectId, resource.resourceId));
    assert.doesNotMatch(f.resources.context(f.project.projectId), /已卸载目录正文/u);
    await assert.rejects(f.resources.reveal(f.project.projectId, resource.resourceId));
  } finally { f.close(); }
});

test('常驻文件在外部变大时，实际注入全文的总量仍受共同预算限制', () => {
  const f = fixture();
  try {
    const resources = ['a.md', 'b.md'].map(fileName => f.resources.create(f.project.projectId, { kind: 'new', fileName }));
    for (const resource of resources) f.resources.update(f.project.projectId, resource.resourceId, { pinned: true });
    for (const resource of resources) writeFileSync(resource.path, '标'.repeat(PROJECT_RESOURCE_LIMITS.pinnedChars));
    const context = f.resources.context(f.project.projectId);
    assert.ok((context.match(/标/gu) ?? []).length <= PROJECT_RESOURCE_LIMITS.pinnedChars);
    assert.match(context, /截断|上限|预算|开头/u);
  } finally { f.close(); }
});

test('本机系统打开拒绝直接执行类型，资料身份不能跨项目读取', async () => {
  const f = fixture();
  try {
    const resource = f.resources.create(f.project.projectId, { kind: 'new', fileName: '脚本.command' });
    await assert.rejects(f.resources.open(f.project.projectId, resource.resourceId), /运行或安装/u);
    const other = f.projects.createProject({ name: '其他项目' }).project;
    assert.throws(() => f.resources.read(other.projectId, resource.resourceId), /不存在/u);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});


test('生产实例的资料目录被替换为外部链接时，不在外部创建文件或目录', () => {
  const f = fixture('生产实例', false);
  try {
    const outside = join(f.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(f.root, 'work', 'project-resources'));
    assert.throws(() => f.resources.create(f.project.projectId, { kind: 'new', fileName: '不能写入' }));
    assert.deepEqual(readdirSync(outside), []);
  } finally { f.close(); }
});


test('单份文本按字符上限截断，不拆开 emoji，非文本不能设为常驻', () => {
  const f = fixture();
  try {
    const resource = f.resources.create(f.project.projectId, { kind: 'new', fileName: '长文.md' });
    writeFileSync(resource.path, '文'.repeat(PROJECT_RESOURCE_LIMITS.readChars - 1) + '😀结尾');
    const result = f.resources.read(f.project.projectId, resource.resourceId);
    assert.equal(result.truncated, true); assert.equal(result.text.length, PROJECT_RESOURCE_LIMITS.readChars - 1);
    const binary = f.resources.create(f.project.projectId, { kind: 'upload', fileName: '附件.pdf', contentBase64: Buffer.from('pdf').toString('base64') });
    assert.throws(() => f.resources.update(f.project.projectId, binary.resourceId, { pinned: true }), /文本/u);
  } finally { f.close(); }
});

test('移除时项目名中的路径字符不能改变废纸篓包装目录的归属', () => {
  const f = fixture('../组/需求');
  try {
    const resource = f.resources.create(f.project.projectId, { kind: 'new', fileName: '需求.md' });
    f.resources.remove(f.project.projectId, resource.resourceId);
    const wrapper = readdirSync(join(f.root, 'trash'))[0]!;
    assert.ok(wrapper); assert.equal(readFileSync(join(f.root, 'trash', wrapper, resource.fileName), 'utf8'), '# 需求\n');
  } finally { f.close(); }
});
