import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentSessions } from '../src/recent-sessions.js';

test('最近窗口含边界，按真实活动排序，归档、未来时间与隐藏不参与', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const session = (id: string, days: number, archivedAt: string | null = null) => ({
    id, createdAt: '2026-01-01T00:00:00Z', lastActivityAt: new Date(now - days * 86_400_000).toISOString(), archivedAt,
  });
  const all = [session('boundary', 7), session('old', 7.01), session('new', 0), session('archived', 1, 'archived'), session('future', -1)];
  for (const days of [1, 3, 7, 14]) assert.deepEqual(recentSessions(all, days, now).map((s) => s.id), days < 7 ? ['new'] : days === 7 ? ['new', 'boundary'] : ['new', 'boundary', 'old']);
  assert.deepEqual(recentSessions(all, 0, now), []);
});
