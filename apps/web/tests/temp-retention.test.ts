import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatBytes,
  retentionFromOption,
  retentionOptionValue,
  retentionOutcome,
  TEMP_RETENTION_CHOICES,
} from '../src/features/workspace/temp-retention.js';

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
