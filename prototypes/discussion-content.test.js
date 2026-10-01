import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionContents, discussionContent, onboardingConversation, nextReading, previousReading, forwardReading, fileTree, contentReference, restoreReadingScenes, saveReading } from './discussion-content.js';

test('切换引用和返回保存上一处滚动位置，不污染讨论状态', () => {
  const first = nextReading(null, { id: 'source', line: 9 });
  const scrolled = { ...first, scrollTop: 186 };
  const second = nextReading(scrolled, { id: 'readme', section: '阅读现场' });
  const third = nextReading(second, { id: 'source', line: 18 });
  assert.equal(third.history.length, 2);
  assert.equal(previousReading(third).section, '阅读现场');
  assert.equal(previousReading(previousReading(third)).scrollTop, 186);
  assert.equal(previousReading(previousReading(third)).line, 9);
  assert.equal(scrolled.scrollTop, 186);
  assert.deepEqual(scrolled.history, []);
});

test('前进后退恢复滚动和查找，新分支清空前进历史并保留目录偏好', () => {
  const first = { ...nextReading(null, { id: 'source', line: 18 }), scrollTop: 120, scrollLeft: 64, query: 'pending', directoryOpen: true, expandedDirs: ['examples'] };
  const second = { ...nextReading(first, { id: 'design' }), scrollTop: 80 };
  const back = previousReading(second);
  assert.equal(back.scrollTop, 120);
  assert.equal(back.scrollLeft, 64);
  assert.equal(back.query, 'pending');
  const forward = forwardReading(back);
  assert.equal(forward.id, 'design');
  assert.equal(forward.scrollTop, 80);
  const branch = nextReading(back, { id: 'readme' });
  assert.deepEqual(branch.future, []);
  assert.equal(branch.directoryOpen, true);
  assert.deepEqual(branch.expandedDirs, ['examples']);
  assert.deepEqual(branch.recent, ['readme', 'design', 'source']);
  assert.equal(forwardReading(branch), branch);
});

test('主动入口不占导航历史，目录叶子与演示材料对应', () => {
  assert.deepEqual(nextReading({ recent: [], directoryOpen: true }, { id: 'readme' }).history, []);
  const leaves = [];
  const walk = (nodes) => nodes.forEach((node) => node.file ? leaves.push(node.file) : walk(node.children));
  walk(fileTree(discussionContents));
  assert.deepEqual(leaves.map((file) => file.id).sort(), discussionContents.map((file) => file.id).sort());
  assert.equal(fileTree(discussionContents)[0].name, 'examples');
});

test('演示回复引用的源码行与 Markdown 章节确实存在', () => {
  for (const message of onboardingConversation.messages) {
    for (const ref of message.contentRefs || []) {
      const content = discussionContent(ref.id);
      assert.ok(content);
      if (ref.line) assert.match(content.text.split('\n')[ref.line - 1], /export function/);
      if (ref.section) assert.ok(content.text.includes(`## ${ref.section}`));
    }
  }
  assert.match(discussionContent('source').text.split('\n')[18], /pending: true/);
});

test('引用只携带明确选择的片段与位置，不隐式带上全文', () => {
  const content = discussionContent('source');
  const quote = contentReference(content, '12–13', 'reading: next,');
  assert.ok(quote.includes(`${content.path}:12–13`));
  assert.ok(quote.endsWith('\nreading: next,'));
  assert.ok(!quote.includes('type Discussion'));
});

test('同一会话在不同工作区的阅读现场互不串用，保存后完整恢复', () => {
  const source = { ...nextReading(null, { id: 'source', line: 18 }), scrollTop: 120, scrollLeft: 64, directoryOpen: true, expandedDirs: ['examples'], hidden: false, view: 'original' };
  const design = nextReading(source, { id: 'design' });
  const withFirst = saveReading({}, 'multivac', 'onboarding', design);
  const withSecond = saveReading(withFirst, 'recent', 'onboarding', nextReading(null, { id: 'readme', section: '阅读现场' }));
  const withOther = saveReading(withSecond, 'multivac', 'prototype', nextReading(null, { id: 'notes' }));
  const restored = restoreReadingScenes(JSON.parse(JSON.stringify(withOther)), null, () => 'multivac');
  assert.equal(restored.multivac.onboarding.id, 'design');
  assert.equal(previousReading(restored.multivac.onboarding).scrollTop, 120);
  assert.equal(previousReading(restored.multivac.onboarding).scrollLeft, 64);
  assert.equal(restored.multivac.onboarding.directoryOpen, true);
  assert.deepEqual(restored.multivac.onboarding.expandedDirs, ['examples']);
  assert.equal(restored.recent.onboarding.id, 'readme');
  assert.equal(restored.multivac.prototype.id, 'notes');
  assert.equal(withFirst.multivac.onboarding.id, 'design');
});

test('旧版目录偏好只迁移到会话所属工作区，不覆盖新的阅读现场', () => {
  const legacy = { onboarding: { directoryOpen: true, expandedDirs: ['examples'], recent: ['source'] } };
  const migrated = restoreReadingScenes(null, legacy, () => 'multivac');
  assert.equal(migrated.multivac.onboarding.hidden, true);
  assert.equal(migrated.multivac.onboarding.directoryOpen, true);
  const restored = restoreReadingScenes({ multivac: { onboarding: nextReading(null, { id: 'notes' }) } }, legacy, () => 'multivac');
  assert.equal(restored.multivac.onboarding.id, 'notes');
  assert.equal(restored.multivac.onboarding.directoryOpen, undefined);
  assert.equal(restored.recent, undefined);
});
