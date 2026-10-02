import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionArchivePreview } from '@multivac/contracts';
import { archiveConfirmOptions } from '../src/features/workspace/archive-confirm.js';
import {
  archiveDirectoryDetails,
  formatBytes,
  restoreNoticeText,
  retentionFromOption,
  retentionOptionValue,
  retentionOutcome,
  TEMP_RETENTION_CHOICES,
} from '../src/features/workspace/temp-retention.js';

const temp = { kind: 'session-temp' as const, path: '/work/sessions/2026-09-28-调研-abcd1234' };

function preview(patch: Partial<SessionArchivePreview>): SessionArchivePreview {
  return { sessionId: 's-1', workingDirectory: temp, files: { total: 0, names: [] }, tempRetentionDays: 30, ...patch };
}

test('偏好选项：7 / 30 / 90 天与从不，下拉框取值与保留天数互相转换', () => {
  assert.deepEqual(TEMP_RETENTION_CHOICES.map((choice) => [choice.value, choice.label]), [
    [7, '归档 7 天后'], [30, '归档 30 天后'], [90, '归档 90 天后'], [null, '从不清理'],
  ]);
  for (const choice of TEMP_RETENTION_CHOICES) {
    assert.equal(retentionFromOption(retentionOptionValue(choice.value)), choice.value);
  }
  assert.equal(retentionOptionValue(null), 'never');
  assert.equal(retentionOutcome(30), '保留 30 天后移到废纸篓');
  assert.equal(retentionOutcome(null), '一直保留（偏好为从不清理）');
});

test('占用按 1024 进位', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024 + 100), '5 MB');
  assert.equal(formatBytes(3.25 * 1024 ** 3), '3.3 GB');
});

test('归档确认卡：有文件时提示一次（列出文件与保留时长），空目录一并删除，项目目录保留，核对失败写通用规则', () => {
  const withFiles = archiveDirectoryDetails(preview({ files: { total: 7, names: ['a.md', 'b.md', 'c', 'd', 'e', 'f'] } }));
  assert.deepEqual(withFiles, [
    '临时目录里还有文件：a.md、b.md、c、d、e 等 7 项。',
    '归档后临时目录保留 30 天，到期移到废纸篓；到期前恢复会话则取消清理。',
  ]);
  assert.equal(
    archiveDirectoryDetails(preview({ files: { total: 1, names: ['a.md'] }, tempRetentionDays: null }))[1],
    '归档后临时目录一直保留（偏好为从不清理）。',
  );
  assert.deepEqual(archiveDirectoryDetails(preview({})), ['对话历史会保留；临时目录是空的，归档时一并删除。']);
  assert.deepEqual(
    archiveDirectoryDetails(preview({ workingDirectory: { kind: 'project-managed', path: '/work/projects/研究' }, files: null })),
    ['对话历史与工作目录都会保留，项目目录不会被清理。'],
  );
  assert.match(archiveDirectoryDetails(null).join(''), /默认 30 天.*废纸篓.*空的临时目录归档时删除/);

  // 卡片的标题、说明与最后一条“怎样找回”各处一致。
  const options = archiveConfirmOptions('调研', preview({ files: { total: 1, names: ['a.md'] }, tempRetentionDays: 7 }));
  assert.equal(options.title, '归档「调研」');
  assert.equal(options.description, '归档后不再出现在工作区中。');
  assert.deepEqual(options.details, [
    '临时目录里还有文件：a.md。',
    '归档后临时目录保留 7 天，到期移到废纸篓；到期前恢复会话则取消清理。',
    '可以在“设置 · 归档”中恢复。',
  ]);
});

test('恢复说明只在临时目录已移到废纸篓时出现，写明移走的时间与位置', () => {
  assert.equal(restoreNoticeText('调研', { trashedDirectory: null }), null);
  const text = restoreNoticeText('调研', {
    trashedDirectory: { trashedAt: new Date(2026, 9, 28, 10).toISOString(), trashPath: '/trash/2026-09-28-调研-abcd1234' },
  });
  assert.equal(text, '已恢复「调研」。它的临时目录已于 2026/10/28 到期移到废纸篓（/trash/2026-09-28-调研-abcd1234），'
    + '已重建空的临时目录；需要原来的文件，可以从废纸篓找回。');
});
