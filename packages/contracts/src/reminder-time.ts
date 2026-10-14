/** 返回明确的用户日历时间；不使用服务器默认时区。 */
export function reminderLocalTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

/** 拒绝无偏移、无效日期、已过时间和时区不一致；不推算下一天。 */
export function normalizeReminderTime(input: { scheduledAt: string; timeZone: string; localTime: string }, now: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input.scheduledAt);
  if (!match) throw new Error('时间必须是包含 Z 或 UTC 偏移的绝对时间。');
  const [, year, month, day, hour, minute, second, , offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (offset !== 'Z' && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))) throw new Error('日历时间或 UTC 偏移无效。');
  const instant = new Date(input.scheduledAt);
  if (!Number.isFinite(instant.getTime())) throw new Error('绝对时间无效。');
  let local: string;
  try { local = reminderLocalTime(instant, input.timeZone); }
  catch { throw new Error('用户时区无效，请提供 IANA 时区，例如 Asia/Shanghai。'); }
  if (local !== input.localTime) throw new Error('绝对时间与用户时区下的计划时间不一致，请澄清日期、时区或夏令时偏移。');
  if (instant.getTime() <= now.getTime()) throw new Error('计划时间已经过去，请用户明确新的日期和时间，不能静默顺延。');
  return instant.toISOString();
}
