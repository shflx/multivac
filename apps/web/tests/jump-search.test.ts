import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchJumpItems } from '../src/app/jump-search.js';

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
