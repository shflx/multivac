import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIRECTORY_NAME_MAX_LENGTH,
  OUTSIDE_WORKING_DIRECTORY_RULE,
  WORKING_DIRECTORY_KINDS,
  truncateMiddle,
  workingDirectoryName,
  workingDirectoryRule,
} from '../src/features/workspace/working-directory.js';

test('目录名取路径最后一段，忽略结尾分隔符；根目录原样返回', () => {
  assert.equal(workingDirectoryName('/Users/me/Multivac/sessions/2026-09-28-调研-3f9a2c1d'), '2026-09-28-调研-3f9a2c1d');
  assert.equal(workingDirectoryName('/Users/me/code/multivac/'), 'multivac');
  assert.equal(workingDirectoryName('/Users/me/Multivac/projects/技术研究'), '技术研究');
  assert.equal(workingDirectoryName('C:\\work\\notes'), 'notes');
  assert.equal(workingDirectoryName('/'), '/');
});

test('中间截断保留首尾、结果恰为上限；未超出时原样返回，代理对不被拆开', () => {
  const name = '2026-09-28-梳理导航结构与会话标题栏的目录显示-3f9a2c1d';
  const short = truncateMiddle(name, DIRECTORY_NAME_MAX_LENGTH);
  assert.equal(Array.from(short).length, DIRECTORY_NAME_MAX_LENGTH);
  // 开头的日期与结尾的短 id 都保留，便于辨认。
  assert.ok(short.startsWith('2026-09-28-'));
  assert.ok(short.endsWith('-3f9a2c1d'));
  assert.ok(short.includes('…'));

  assert.equal(truncateMiddle('multivac', DIRECTORY_NAME_MAX_LENGTH), 'multivac');
  assert.equal(truncateMiddle('abcdef', 6), 'abcdef');
  assert.equal(truncateMiddle('abcdefg', 6), 'abc…fg');
  assert.equal(truncateMiddle('abcdefg', 2), 'a…');
  assert.equal(truncateMiddle('abcdefg', 1), '…');
  assert.equal(truncateMiddle('😀😀😀😀😀😀', 4), '😀😀…😀');
});

test('每类目录都写明目录内自动执行与目录外需要确认，以及会不会被清理', () => {
  for (const kind of Object.keys(WORKING_DIRECTORY_KINDS) as Array<keyof typeof WORKING_DIRECTORY_KINDS>) {
    const rule = workingDirectoryRule(kind);
    assert.match(rule, /目录内的读写与命令自动执行。/);
    assert.ok(rule.endsWith(OUTSIDE_WORKING_DIRECTORY_RULE));
  }
  // 临时目录归档后按偏好保留、到期移到废纸篓；其他类型永不自动清理（worktree 为预留类型，不作承诺）。
  assert.match(WORKING_DIRECTORY_KINDS['session-temp'].rule, /归档后.*“设置 · 偏好”.*默认 30 天.*移到废纸篓.*空目录直接删除/);
  for (const kind of ['multivac', 'project-managed', 'project-mounted'] as const) {
    assert.match(WORKING_DIRECTORY_KINDS[kind].rule, /不会(自动)?清理/);
    assert.doesNotMatch(WORKING_DIRECTORY_KINDS[kind].rule, /废纸篓|到期/);
  }
  assert.equal(WORKING_DIRECTORY_KINDS['session-temp'].label, '临时目录');
  assert.equal(WORKING_DIRECTORY_KINDS['project-managed'].label, '项目托管目录');
  assert.equal(WORKING_DIRECTORY_KINDS['project-mounted'].label, '挂载目录');
});
