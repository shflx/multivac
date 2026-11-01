import type { OccurrenceStatus, Schedule, ScheduleAction, ScheduleRule } from '@multivac/contracts';

/**
 * 定时安排的展示规则：规则说明、按安排时区显示时间、状态文案与色调。
 * 时间一律按安排自己的 IANA 时区显示，不用浏览器本地时区代替。
 */

export type Tone = 'success' | 'accent' | 'warn' | 'danger' | 'muted';

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
/** 编辑器里的星期按周一开头排列。 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const ACTION_LABELS: Record<ScheduleAction['kind'], string> = { reminder: '提醒', agent: 'Agent 执行' };

/** 安排本身的状态，与某一次触发的状态分开。 */
export const SCHEDULE_STATES: Record<Schedule['state'], { label: string; tone: Tone }> = {
  active: { label: '启用', tone: 'success' },
  paused: { label: '已暂停', tone: 'muted' },
  completed: { label: '已完成', tone: 'muted' },
  deleted: { label: '已删除', tone: 'muted' },
};

/** 单次触发的状态；未知结果单列为待恢复核对，不当作成功或失败。 */
export const OCCURRENCE_STATES: Record<OccurrenceStatus, { label: string; tone: Tone }> = {
  pending: { label: '待执行', tone: 'muted' },
  running: { label: '执行中', tone: 'accent' },
  waiting: { label: '等待人工处理', tone: 'warn' },
  stopping: { label: '停止中', tone: 'warn' },
  reconcile: { label: '待恢复核对', tone: 'warn' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  stopped: { label: '已停止', tone: 'muted' },
  skipped: { label: '已跳过', tone: 'muted' },
};

/** 提醒成功即已送达，比“成功”更贴近用户关心的结果。 */
export function occurrenceLabel(status: OccurrenceStatus, kind: ScheduleAction['kind']): string {
  return status === 'succeeded' && kind === 'reminder' ? '已提醒' : OCCURRENCE_STATES[status].label;
}

export const MISSED_POLICIES: Record<Schedule['missedPolicy'], { label: string; hint: string }> = {
  skip: { label: '跳过错过的轮次', hint: '服务离线或暂停期间错过的时间不补跑，从下一个未来时间继续。' },
  latest: { label: '仅补最近一次', hint: '恢复后只补跑错过的最近一次，不积压补跑全部历史。' },
};

const ZONE_NAMES: Record<string, string> = {
  'Asia/Shanghai': '北京时间',
  'Asia/Tokyo': '东京',
  'Europe/London': '伦敦',
  'America/New_York': '纽约',
  UTC: '协调世界时',
};

export function timeZoneLabel(zone: string): string {
  const name = ZONE_NAMES[zone];
  return name ? `${name}（${zone}）` : zone;
}

/** 时区候选：当前值与浏览器时区在前，其后是常用时区，去重。 */
export function timeZoneOptions(...preferred: (string | null | undefined)[]): string[] {
  return [...new Set([...preferred.filter((zone): zone is string => !!zone), ...Object.keys(ZONE_NAMES)])];
}

/** 每次 Agent 执行的时长上限候选（毫秒）。 */
export const AGENT_BUDGET_MILLIS = [15, 30, 60, 120].map((minutes) => minutes * 60_000);

export function durationLabel(millis: number): string {
  if (millis < 60_000) return `${Math.round(millis / 1000)} 秒`;
  if (millis % 3_600_000 === 0) return `${millis / 3_600_000} 小时`;
  return `${Math.round(millis / 60_000)} 分钟`;
}

/** 时长候选包含当前值，旧安排里不在候选中的额度也能原样保留。 */
export function budgetOptions(current: number): number[] {
  return [...new Set([...AGENT_BUDGET_MILLIS, current])].sort((a, b) => a - b);
}

export function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 去掉零秒，保留单次安排里精确到秒的时刻。 */
function clock(time: string): string {
  return time.length > 5 && time.slice(5) !== ':00' ? time.slice(0, 8) : time.slice(0, 5);
}

/** 规则的一句话说明，如“每周一、四 18:30”“工作日 09:00”。 */
export function describeRule(rule: ScheduleRule): string {
  if (rule.kind === 'once') {
    const [date = '', time = ''] = rule.localTime.split('T');
    const [year, month, day] = date.split('-').map(Number);
    return `单次 · ${year}年${month}月${day}日 ${clock(time)}`;
  }
  if (rule.kind === 'daily') return `每天 ${rule.time}`;
  const days = [...rule.days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
  if (days.length === 7) return `每天 ${rule.time}`;
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return `工作日 ${rule.time}`;
  return `每周${days.map((day) => WEEKDAY_LABELS[day]).join('、')} ${rule.time}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!) };
}

/** 绝对时刻按安排时区显示：今天、明天、昨天用相对说法，其余显示月日与星期；时区无效时退回 ISO。 */
export function formatAt(at: string | Date | null, zone: string, now: Date = new Date()): string {
  if (!at) return '—';
  const date = typeof at === 'string' ? new Date(at) : at;
  try {
    const parts = zonedParts(date, zone);
    const today = zonedParts(now, zone);
    const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
    const days = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000);
    if (days === 0) return `今天 ${time}`;
    if (days === 1) return `明天 ${time}`;
    if (days === -1) return `昨天 ${time}`;
    const year = parts.year === today.year ? '' : `${parts.year}年`;
    return `${year}${parts.month}月${parts.day}日 周${WEEKDAY_LABELS[parts.weekday]} ${time}`;
  } catch {
    return date.toISOString();
  }
}

/** 浏览器时区下的当地时刻往后取整点，作为新单次安排的默认时间。 */
export function nextWholeHour(localTime: string | null): { date: string; time: string } {
  const [date = '', time = '00:00'] = (localTime ?? '').split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour] = time.split(':').map(Number);
  const next = new Date(Date.UTC(year || 2000, (month || 1) - 1, day || 1, (hour || 0) + 1));
  return { date: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`, time: `${pad(next.getUTCHours())}:00` };
}
