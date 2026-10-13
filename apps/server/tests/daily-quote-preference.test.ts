import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreferencesService } from '../src/application/preferences-service.js';
import { SqliteAssistantStore, SqlitePreferenceRepository } from '../src/storage/sqlite-assistant-store.js';

test('每日一句默认关闭，旧值兼容；修改只更新本项并通知订阅者', () => {
  const values = new Map<string, unknown>([['recentDays', 1], ['executionDiagnosticsEnabled', false]]);
  const repository = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value); }, clearForTest: () => values.clear() };
  const service = new PreferencesService(repository);
  assert.equal(service.get().showDailyQuote, false);
  const changed: boolean[] = [];
  service.onChanged(preferences => changed.push(preferences.showDailyQuote!));
  const enabled = service.update({ showDailyQuote: true });
  assert.equal(enabled.showDailyQuote, true);
  assert.equal(enabled.recentDays, 1);
  assert.equal(enabled.executionDiagnosticsEnabled, false);
  assert.equal(new PreferencesService(repository).get().showDailyQuote, true);
  service.update({ recentDays: 3 });
  assert.equal(service.get().showDailyQuote, true);
  values.set('showDailyQuote', 'true');
  assert.equal(service.get().showDailyQuote, false);
  service.update({ showDailyQuote: false });
  assert.deepEqual(changed, [true, true, false]);
});

test('每日一句开关在 SQLite 重开后保留，重置恢复默认关闭', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-daily-quote-'));
  const path = join(root, 'preferences.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    new PreferencesService(new SqlitePreferenceRepository(store)).update({ showDailyQuote: true });
    store.close(); store = new SqliteAssistantStore(path);
    const service = new PreferencesService(new SqlitePreferenceRepository(store));
    assert.equal(service.get().showDailyQuote, true);
    service.resetForTest();
    assert.equal(service.get().showDailyQuote, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
