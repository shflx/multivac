import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu } from 'lucide-react';
import {
  MANAGEMENT_NAV,
  MANAGEMENT_PAGES,
  managementNavGroups,
  managementSummary,
  type ManagementPageDefinition,
} from '../src/app/management-nav.js';

function page(id: string, group: ManagementPageDefinition['group']): ManagementPageDefinition {
  return { id, group, label: id, icon: Cpu, width: 'full' };
}

test('管理导航只列已实现的页面：工作组的“会话”，设置组的“项目”“模型”与“偏好”', () => {
  // 第一项是进入管理时默认打开的页面；设置组按原型顺序：项目、模型、偏好。
  // 记住的授权按归属放在项目详情、会话页详情与标题栏的工作目录里，没有单独的页面。
  assert.deepEqual(MANAGEMENT_PAGES.map((item) => item.id), ['sessions', 'projects', 'models', 'preferences']);
  assert.deepEqual(
    MANAGEMENT_NAV.map((group) => ({ id: group.id, label: group.label, pages: group.pages.map((item) => item.label) })),
    [{ id: 'work', label: '工作', pages: ['会话'] }, { id: 'settings', label: '设置', pages: ['项目', '模型', '偏好'] }],
  );
});

test('分组按“工作 / 应用 / 设置”排序，组内按登记顺序，没有页面的分组不出现', () => {
  const groups = managementNavGroups([
    page('models', 'settings'),
    page('sessions', 'work'),
    page('preferences', 'settings'),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.label, group.pages.map((item) => item.id)]),
    [['工作', ['sessions']], ['设置', ['models', 'preferences']]],
  );

  assert.deepEqual(managementNavGroups([]), []);
});

test('面板跳转里“管理”的说明由注册表派生：列出工作组的页面，设置组合称“设置”，应用组不列入', () => {
  assert.equal(managementSummary(MANAGEMENT_NAV), '会话与设置');
  assert.equal(managementSummary(managementNavGroups([
    page('tasks', 'work'),
    page('runs', 'work'),
    page('sessions', 'work'),
    page('reading', 'apps'),
    page('models', 'settings'),
  ])), 'tasks、runs、sessions与设置');
  assert.equal(managementSummary(managementNavGroups([page('models', 'settings')])), '设置');
  assert.equal(managementSummary(managementNavGroups([page('sessions', 'work')])), 'sessions');
});

test('页面宽度由注册表声明：列表 + 详情的页铺满，偏好这类简单规则页限宽', () => {
  assert.deepEqual(
    Object.fromEntries(MANAGEMENT_PAGES.map((item) => [item.id, item.width])),
    { sessions: 'full', projects: 'full', models: 'full', preferences: 'limited' },
  );
});
