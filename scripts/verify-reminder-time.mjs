import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(readFileSync(new URL('../packages/contracts/src/reminder-time.ts', import.meta.url), 'utf8'));
const { normalizeReminderTime, reminderLocalTime } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const now = new Date('2026-10-14T00:00:00Z');
const valid = { scheduledAt: '2026-10-14T15:00:00+08:00', timeZone: 'Asia/Shanghai', localTime: '2026-10-14T15:00:00' };
assert.equal(normalizeReminderTime(valid, now), '2026-10-14T07:00:00.000Z');
for (const changed of [
  { scheduledAt: '2026-10-14T15:00:00' }, { scheduledAt: '2026-02-30T15:00:00+08:00' },
  { scheduledAt: '2026-10-14T08:00:00+08:00', localTime: '2026-10-14T08:00:00' },
  { timeZone: 'invalid/zone' }, { localTime: '2026-10-14T16:00:00' },
]) assert.throws(() => normalizeReminderTime({ ...valid, ...changed }, now));
const dst = { timeZone: 'America/New_York', localTime: '2026-11-01T01:30:00' };
assert.equal(normalizeReminderTime({ ...dst, scheduledAt: '2026-11-01T01:30:00-04:00' }, now), '2026-11-01T05:30:00.000Z');
assert.equal(normalizeReminderTime({ ...dst, scheduledAt: '2026-11-01T01:30:00-05:00' }, now), '2026-11-01T06:30:00.000Z');
assert.throws(() => normalizeReminderTime({ timeZone: 'America/New_York', localTime: '2027-03-14T02:30:00', scheduledAt: '2027-03-14T02:30:00-05:00' }, now));
assert.equal(reminderLocalTime(now, 'UTC'), '2026-10-14T00:00:00');
console.log('PASS: 时间边界、显式偏移、夏令时及用户时区（10 项断言）。');
