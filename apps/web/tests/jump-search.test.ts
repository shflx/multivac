import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentJumpItems, searchJumpItems } from '../src/app/jump-search.js';

test('空查询保序，全词项不区分大小写，标题前缀、包含、位置依次排序', () => {
  const items = [
    { label: '检查接口', hint: 'API 项目' }, { label: '旧 API', hint: '项目' },
    { label: 'API 文档', hint: '项目' }, { label: 'API 测试', hint: '项目', keywords: ['回归'] },
  ];
  assert.equal(searchJumpItems(items, '  '), items);
  assert.deepEqual(searchJumpItems(items, 'aPi 项目').map((i) => i.label), ['API 文档', 'API 测试', '旧 API', '检查接口']);
  assert.deepEqual(searchJumpItems(items, 'API 回归').map((i) => i.label), ['API 测试']);
  assert.deepEqual(searchJumpItems(items, '不存在'), []);
});

test('最近五项按活动时间排序，排除无效/未来时间，等时间保序且不修改原列表', () => {
  const items = [{ id: 'a', activity: 1 }, { id: 'b', activity: 9 }, { id: 'c', activity: 3 }, { id: 'd', activity: 8 }, { id: 'e', activity: 8 }, { id: 'f', activity: 5 }, { id: 'g', activity: 4 }, { id: 'future', activity: 20 }, { id: 'invalid', activity: NaN }, { id: 'page' }];
  assert.deepEqual(recentJumpItems(items, 10).map((item) => item.id), ['b', 'd', 'e', 'f', 'g']);
  assert.equal(items[0]?.id, 'a');
  assert.deepEqual(recentJumpItems([], 10), []);
});
