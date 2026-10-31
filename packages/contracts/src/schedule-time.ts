import { normalizeReminderTime, reminderLocalTime } from './reminder-time.js';
import type { ScheduleRule, SchedulePreview } from './schedule.js';

/** 只接受明确的 IANA 区域或 UTC，不采用服务器默认时区或裸偏移。 */
export function validateScheduleZone(zone: string): void {
  if (zone !== 'UTC' && !zone.includes('/')) throw new Error('请提供 IANA 时区，例如 Asia/Shanghai。');
  reminderLocalTime(new Date(0), zone);
}

/** 将日历时刻映射为绝对时刻；重复时刻固定取较早偏移，缺失时刻仅提供记录水位。 */
export function resolveScheduleLocal(localTime: string, timeZone: string): SchedulePreview {
  validateScheduleZone(timeZone);
  const nominal = Date.parse(`${localTime}Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 19) !== localTime) throw new Error('日历时间无效。');
  const offsets = new Set<number>();
  // 覆盖日期线变化和非整小时 DST；候选偏移由时区数据库计算，不硬编码一小时。
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = nominal + hours * 3600000;
    offsets.add(Date.parse(`${reminderLocalTime(new Date(instant), timeZone)}Z`) - instant);
  }
  const candidates = [...offsets].map(offset => nominal - offset).sort((a, b) => a - b);
  const matches = candidates.filter(at => reminderLocalTime(new Date(at), timeZone) === localTime);
  const at = matches[0] ?? candidates.find(at => reminderLocalTime(new Date(at), timeZone) > localTime);
  if (at === undefined) throw new Error('无法解析该日历时刻。');
  return { scheduledAt: new Date(at).toISOString(), localTime, skipReason: matches.length ? null : 'dst-gap' };
}

export function validateScheduleRule(rule: ScheduleRule, timeZone: string, now: Date): void {
  validateScheduleZone(timeZone);
  if (rule.kind === 'once') normalizeReminderTime({ ...rule, timeZone }, now);
  else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) throw new Error('时间须使用 HH:mm。');
    if (rule.kind === 'weekly' && (!rule.days.length || new Set(rule.days).size !== rule.days.length || rule.days.some(day => day < 0 || day > 6))) throw new Error('请选择有效且不重复的星期。');
  }
}

/** 页面预览与服务端游标共用此函数。after 为开区间，跨 DST 按当地日历推进。 */
export function previewSchedule(rule: ScheduleRule, timeZone: string, after: Date, count = 3): SchedulePreview[] {
  validateScheduleZone(timeZone);
  if (count < 1 || count > 100) throw new Error('预览数量须为 1–100。');
  if (rule.kind === 'once') return Date.parse(rule.scheduledAt) > after.getTime()
    ? [{ scheduledAt: new Date(rule.scheduledAt).toISOString(), localTime: rule.localTime, skipReason: null }] : [];
  const localDate = reminderLocalTime(after, timeZone).slice(0, 10);
  const start = Date.parse(`${localDate}T00:00:00Z`);
  const result: SchedulePreview[] = [];
  for (let day = 0; day < 740 && result.length < count; day++) {
    const date = new Date(start + day * 86400000);
    if (rule.kind === 'weekly' && !rule.days.includes(date.getUTCDay())) continue;
    const item = resolveScheduleLocal(`${date.toISOString().slice(0, 10)}T${rule.time}:00`, timeZone);
    if (Date.parse(item.scheduledAt) > after.getTime()) result.push(item);
  }
  return result;
}
