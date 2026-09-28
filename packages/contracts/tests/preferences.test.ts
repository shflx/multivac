import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  DEFAULT_PREFERENCES,
  PreferencesSchema,
  SESSION_ARCHIVE_ENTRY_LIST_LIMIT,
  SessionArchivePreviewSchema,
  SessionRestoreResultSchema,
  TempDirectoryUsageSchema,
  UpdatePreferencesSchema,
} from '../src/index.js';

const temp = { kind: 'session-temp', path: '/Users/me/Multivac/sessions/2026-09-28-调研-abcd1234' };

test('偏好：临时目录保留 7 / 30 / 90 天或从不，默认 30 天；更新只接受已知字段且至少一项', () => {
  assert.deepEqual(DEFAULT_PREFERENCES, { tempRetentionDays: 30 });
  for (const days of [7, 30, 90, null]) {
    assert.equal(Check(PreferencesSchema, { tempRetentionDays: days }), true);
    assert.equal(Check(UpdatePreferencesSchema, { tempRetentionDays: days }), true);
  }
  for (const days of [0, 14, -1, '30', undefined]) assert.equal(Check(PreferencesSchema, { tempRetentionDays: days }), false);
  assert.equal(Check(UpdatePreferencesSchema, {}), false);
  assert.equal(Check(UpdatePreferencesSchema, { tempRetentionDays: 30, autoArchive: '3d' }), false);
});

test('临时目录占用、归档前核对与恢复结果的结构', () => {
  assert.equal(Check(TempDirectoryUsageSchema, { directories: 2, bytes: 1024, truncated: false, measuredAt: '2026-09-28T08:00:00.000Z' }), true);
  assert.equal(Check(TempDirectoryUsageSchema, { directories: -1, bytes: 0, truncated: false, measuredAt: 'x' }), false);

  const preview = { sessionId: 's-1', workingDirectory: temp, files: { total: 1, names: ['a.md'] }, tempRetentionDays: 30 };
  assert.equal(Check(SessionArchivePreviewSchema, preview), true);
  assert.equal(Check(SessionArchivePreviewSchema, { ...preview, files: null, tempRetentionDays: null }), true);
  const tooMany = Array.from({ length: SESSION_ARCHIVE_ENTRY_LIST_LIMIT + 1 }, (_, index) => `f-${index}`);
  assert.equal(Check(SessionArchivePreviewSchema, { ...preview, files: { total: tooMany.length, names: tooMany } }), false);

  const session = {
    sessionId: 's-1', title: '调研', kind: 'work', workspaceId: 'default', createdAt: '2026-09-28T08:00:00.000Z',
    archivedAt: null, parentSessionId: null, originText: null, workingDirectory: temp,
  };
  assert.equal(Check(SessionRestoreResultSchema, { session, trashedDirectory: null }), true);
  assert.equal(Check(SessionRestoreResultSchema, {
    session, trashedDirectory: { trashedAt: '2026-10-28T08:00:00.000Z', trashPath: '/Users/me/.Trash/2026-09-28-调研-abcd1234' },
  }), true);
  assert.equal(Check(SessionRestoreResultSchema, session), false);
});
