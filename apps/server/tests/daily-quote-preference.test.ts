import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreferencesService } from '../src/application/preferences-service.js';
import { SqliteAssistantStore, SqlitePreferenceRepository } from '../src/storage/sqlite-assistant-store.js';

test('每日一句默认开启，旧值兼容；修改只更新本项并通知订阅者', () => {
  const values = new Map<string, unknown>([['recentDays', 1], ['executionDiagnosticsEnabled', false]]);
  const repository = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value); }, clearForTest: () => values.clear() };
  const service = new PreferencesService(repository);
  assert.equal(service.get().showDailyQuote, true);
  const changed: boolean[] = [];
  service.onChanged(preferences => changed.push(preferences.showDailyQuote!));
  const disabled = service.update({ showDailyQuote: false });
  assert.equal(disabled.showDailyQuote, false);
  assert.equal(disabled.recentDays, 1);
  assert.equal(disabled.executionDiagnosticsEnabled, false);
  assert.equal(new PreferencesService(repository).get().showDailyQuote, false);
  service.update({ recentDays: 3 });
  assert.equal(service.get().showDailyQuote, false);
  values.set('showDailyQuote', 'false');
  assert.equal(service.get().showDailyQuote, true);
  service.update({ showDailyQuote: true });
  assert.deepEqual(changed, [false, false, true]);
});

test('每日一句开关在 SQLite 重开后保留，重置恢复默认开启', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-daily-quote-'));
  const path = join(root, 'preferences.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    new PreferencesService(new SqlitePreferenceRepository(store)).update({ showDailyQuote: false });
    store.close(); store = new SqliteAssistantStore(path);
    const service = new PreferencesService(new SqlitePreferenceRepository(store));
    assert.equal(service.get().showDailyQuote, false);
    service.resetForTest();
    assert.equal(service.get().showDailyQuote, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
