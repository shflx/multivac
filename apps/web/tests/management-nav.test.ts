import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu } from 'lucide-react';
import { MANAGEMENT_PAGE_IDS, ManagementPageIdSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  resolveManagementPage,
  MANAGEMENT_NAV,
  MANAGEMENT_PAGES,
  managementNavGroups,
  managementSummary,
  type ManagementPageDefinition,
} from '../src/app/management-nav.js';

function page(id: string, group: ManagementPageDefinition['group']): ManagementPageDefinition {
  return { id, group, label: id, icon: Cpu, width: 'full' };
}

test('管理导航只列已实现的工作、读书应用与设置页面', () => {
  // 第一项是进入管理时默认打开的页面；设置组顺序：归档、项目、模型、偏好。
  // 记住的授权按归属放在项目详情、会话授权窗口与标题栏的工作目录里，没有单独的页面。
  assert.deepEqual(MANAGEMENT_PAGES.map((item) => item.id), ['tasks', 'inbox', 'reading', 'archive', 'projects', 'models', 'preferences']);
  assert.deepEqual([...MANAGEMENT_PAGE_IDS].sort(), MANAGEMENT_PAGES.map(item => item.id).sort());
  assert.equal(Check(ManagementPageIdSchema, 'conversations'), false);
  assert.equal(Check(ManagementPageIdSchema, 'notes'), false);
  assert.deepEqual(
    MANAGEMENT_NAV.map((group) => ({ id: group.id, label: group.label, pages: group.pages.map((item) => item.label) })),
    [{ id: 'work', label: '工作', pages: ['待办', 'Inbox'] }, { id: 'apps', label: '应用', pages: ['读书'] }, { id: 'settings', label: '设置', pages: ['归档', '项目', '模型', '偏好'] }],
  );
});

test('分组按“工作 / 应用 / 设置”排序，组内按登记顺序，没有页面的分组不出现', () => {
  const groups = managementNavGroups([
    page('models', 'settings'),
    page('tasks', 'work'),
    page('preferences', 'settings'),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.pages.map((item) => item.id)]),
    [['工作', ['tasks']], ['设置', ['models', 'preferences']]],
  );

  assert.deepEqual(managementNavGroups([]), []);
});

test('面板跳转里“管理”的说明由注册表派生：列出工作组的页面，设置组合称“设置”，应用组不列入', () => {
  assert.equal(managementSummary(MANAGEMENT_NAV), '待办、Inbox与设置');
  assert.equal(managementSummary(managementNavGroups([
    page('tasks', 'work'),
    page('runs', 'work'),
    page('reviews', 'work'),
    page('reading', 'apps'),
    page('models', 'settings'),
  ])), 'tasks、runs、reviews与设置');
  assert.equal(managementSummary(managementNavGroups([page('models', 'settings')])), '设置');
  assert.equal(managementSummary(managementNavGroups([page('tasks', 'work')])), 'tasks');
});

test('页面宽度由注册表声明：列表 + 详情的页铺满，偏好这类简单规则页限宽', () => {
  assert.deepEqual(
    Object.fromEntries(MANAGEMENT_PAGES.map((item) => [item.id, item.width])),
    { tasks: 'full', inbox: 'full', reading: 'full', archive: 'full', projects: 'full', models: 'full', preferences: 'limited' },
  );
});

test('旧会话页状态迁移到归档，未知页不会留下空白容器', () => {
  assert.equal(resolveManagementPage('sessions'), 'archive');
  assert.equal(resolveManagementPage('conversations'), 'reading');
  assert.equal(resolveManagementPage('notes'), 'reading');
  assert.equal(resolveManagementPage('gone'), MANAGEMENT_PAGES[0].id);
  assert.equal(resolveManagementPage('models'), 'models');
});
