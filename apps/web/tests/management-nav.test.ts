import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu } from 'lucide-react';
import {
  MANAGEMENT_NAV,
  MANAGEMENT_PAGES,
  managementNavGroups,
  type ManagementPageDefinition,
} from '../src/app/management-nav.js';

function page(id: string, group: ManagementPageDefinition['group']): ManagementPageDefinition {
  return { id, group, label: id, icon: Cpu, description: '' };
}

test('管理导航只列已实现的页面：目前只有设置组的“模型”', () => {
  assert.deepEqual(MANAGEMENT_PAGES.map((item) => item.id), ['models']);
  assert.deepEqual(
    MANAGEMENT_NAV.map((group) => ({ id: group.id, label: group.label, pages: group.pages.map((item) => item.label) })),
    [{ id: 'settings', label: '设置', pages: ['模型'] }],
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
