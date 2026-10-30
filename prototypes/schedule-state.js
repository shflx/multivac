/**
 * 定时安排的纯逻辑：时间规则、触发预览、状态定义与原型示例数据。
 * 时间一律按安排自己的 IANA 时区计算，不用浏览器或服务器的本地时区代替。
 */

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const TIME_ZONES = [
  { id: 'Asia/Shanghai', label: '北京时间（Asia/Shanghai）' },
  { id: 'Asia/Tokyo', label: '东京（Asia/Tokyo）' },
  { id: 'Europe/London', label: '伦敦（Europe/London）' },
  { id: 'America/New_York', label: '纽约（America/New_York）' },
];

/** 动作类型：提醒只进 Inbox；Agent 执行在独立会话中运行指令。 */
export const ACTION_LABELS = { reminder: '提醒', agent: 'Agent 执行' };

/** 安排本身的状态，与某一次执行的状态分开。 */
export const SCHEDULE_STATES = {
  active: { label: '启用', tone: 'success' },
  paused: { label: '已暂停', tone: 'muted' },
  completed: { label: '已完成', tone: 'muted' },
};

/**
 * 单次触发（Occurrence）的状态。active 表示这一轮仍在占用安排，同一安排不会再开始新一轮。
 * 未知结果单列为待恢复核对，不当作成功或失败。
 */
export const OCCURRENCE_STATES = {
  pending: { label: '待执行', tone: 'muted', active: true },
  running: { label: '执行中', tone: 'accent', active: true },
  waiting: { label: '等待人工处理', tone: 'warn', active: true },
  stopping: { label: '停止中', tone: 'warn', active: true },
  reconcile: { label: '待恢复核对', tone: 'warn', active: true },
  succeeded: { label: '成功', tone: 'success', active: false },
  delivered: { label: '已提醒', tone: 'success', active: false },
  failed: { label: '失败', tone: 'danger', active: false },
  stopped: { label: '已停止', tone: 'muted', active: false },
  skipped: { label: '已跳过', tone: 'muted', active: false },
};

export const MISSED_POLICIES = {
  skip: { label: '跳过错过的轮次', hint: '服务离线或暂停期间错过的时间不补跑，从下一个未来时间继续。' },
  latest: { label: '仅补最近一次', hint: '恢复后只补跑错过的最近一次，不积压补跑全部历史。' },
};

/** 每次 Agent 执行的时长上限选项（分钟）；输出与调用额度沿用任务执行的固定上限。 */
export const AGENT_BUDGETS = [15, 30, 60, 120];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const partsFormatters = new Map();
function partsFormatter(timeZone) {
  if (!partsFormatters.has(timeZone)) {
    partsFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
    }));
  }
  return partsFormatters.get(timeZone);
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 某个绝对时刻在指定时区的墙上时间。 */
export function zonedParts(date, timeZone) {
  const values = Object.fromEntries(partsFormatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), weekday: WEEKDAY_INDEX[values.weekday],
  };
}

function offsetAt(ms, timeZone) {
  const parts = zonedParts(new Date(ms), timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

const sameWallTime = (parts, wall) => parts.year === wall.year && parts.month === wall.month && parts.day === wall.day && parts.hour === wall.hour && parts.minute === wall.minute;

/**
 * 当地墙上时间转为绝对时刻。
 * 夏令时开始时不存在的时间返回 gap；结束时重复出现的时间固定取较早的一次，并标记 overlap。
 */
export function zonedToUtc(wall, timeZone) {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const candidates = [...new Set([offsetAt(naive - DAY, timeZone), offsetAt(naive + DAY, timeZone), offsetAt(naive, timeZone)])]
    .map((offset) => naive - offset)
    .filter((ms) => sameWallTime(zonedParts(new Date(ms), timeZone), wall))
    .sort((a, b) => a - b);
  if (!candidates.length) return { status: 'gap', at: null };
  return { status: candidates.length > 1 ? 'overlap' : 'ok', at: new Date(candidates[0]) };
}

function parseTime(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  return { hour: Number.isFinite(hour) ? hour : 9, minute: Number.isFinite(minute) ? minute : 0 };
}

function addDays(wall, days) {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

/**
 * 从 from 之后计算接下来的计划时刻。界面预览和调度共用这一个计算。
 * 返回 { at, wall, note }；夏令时缺失的当地时间不计入结果，在 skipped 中留下记录。
 */
export function upcomingOccurrences(rule, timeZone, from, count = 3) {
  const results = [];
  const skipped = [];
  const { hour, minute } = parseTime(rule.time);
  if (rule.kind === 'once') {
    const [year, month, day] = String(rule.date || '').split('-').map(Number);
    if (!year || !month || !day) return { results, skipped };
    const wall = { year, month, day, hour, minute };
    const converted = zonedToUtc(wall, timeZone);
    if (converted.status === 'gap') skipped.push({ wall, reason: '该当地时间因夏令时不存在' });
    else if (converted.at > from) results.push({ at: converted.at, wall, note: converted.status === 'overlap' ? '夏令时重复时刻，取较早的一次' : null });
    return { results, skipped };
  }
  const days = rule.kind === 'weekly' ? new Set(rule.days || []) : null;
  if (days && !days.size) return { results, skipped };
  const start = zonedParts(from, timeZone);
  // 有界展开：最多向后看一年，避免无效规则陷入无限循环。
  for (let offset = 0; offset < 370 && results.length < count; offset += 1) {
    const date = addDays(start, offset);
    if (days && !days.has(date.weekday)) continue;
    const wall = { year: date.year, month: date.month, day: date.day, hour, minute };
    const converted = zonedToUtc(wall, timeZone);
    if (converted.status === 'gap') { skipped.push({ wall, reason: '该当地时间因夏令时不存在，本轮跳过' }); continue; }
    if (converted.at <= from) continue;
    results.push({ at: converted.at, wall, note: converted.status === 'overlap' ? '夏令时重复时刻，只触发较早的一次' : null });
  }
  return { results, skipped };
}

export function nextOccurrence(schedule, from) {
  if (schedule.state !== 'active') return null;
  return upcomingOccurrences(schedule.rule, schedule.timeZone, from, 1).results[0]?.at || null;
}

const pad = (value) => String(value).padStart(2, '0');

/** 规则的一句话说明，如“每周一、四 18:30”。 */
export function describeRule(rule) {
  const { hour, minute } = parseTime(rule.time);
  const time = `${pad(hour)}:${pad(minute)}`;
  if (rule.kind === 'once') {
    const [year, month, day] = String(rule.date || '').split('-').map(Number);
    return month ? `单次 · ${year}年${month}月${day}日 ${time}` : `单次 · ${time}`;
  }
  if (rule.kind === 'daily') return `每天 ${time}`;
  const days = [...(rule.days || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return `工作日 ${time}`;
  if (days.length === 7) return `每天 ${time}`;
  return `每周${days.map((day) => WEEKDAY_LABELS[day]).join('、')} ${time}`;
}

/** 绝对时刻按安排时区显示：今天/明天/昨天用相对说法，其余显示月日与星期。 */
export function formatAt(date, timeZone, now = new Date()) {
  if (!date) return '—';
  const parts = zonedParts(date, timeZone);
  const today = zonedParts(now, timeZone);
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  const dayDiff = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY);
  if (dayDiff === 0) return `今天 ${time}`;
  if (dayDiff === 1) return `明天 ${time}`;
  if (dayDiff === -1) return `昨天 ${time}`;
  const year = parts.year === today.year ? '' : `${parts.year}年`;
  return `${year}${parts.month}月${parts.day}日 周${WEEKDAY_LABELS[parts.weekday]} ${time}`;
}

export function timeZoneLabel(timeZone) {
  return TIME_ZONES.find((zone) => zone.id === timeZone)?.label || timeZone;
}

/** 同一安排是否仍有占用中的触发；占用时新一轮跳过，删除也需先停止或等待。 */
export function activeOccurrence(schedule) {
  return (schedule.occurrences || []).find((occurrence) => OCCURRENCE_STATES[occurrence.status]?.active) || null;
}

export function lastFinishedOccurrence(schedule) {
  return (schedule.occurrences || []).find((occurrence) => !OCCURRENCE_STATES[occurrence.status]?.active) || null;
}

/** 列表筛选：动作类型与安排状态各自独立。 */
export function filterSchedules(schedules, { action = 'all', state = 'all', query = '' } = {}) {
  const key = query.trim().toLocaleLowerCase();
  return schedules.filter((schedule) => !schedule.deleted
    && (action === 'all' || schedule.action.kind === action)
    && (state === 'all' || schedule.state === state)
    && (!key || schedule.name.toLocaleLowerCase().includes(key)));
}

/**
 * 立即执行一次：使用独立的手动触发身份，不移动原计划的下次时间。
 * 同一安排仍有占用中的触发时不重叠，记录为跳过。
 */
export function triggerNow(schedule, now, id) {
  const busy = activeOccurrence(schedule);
  const occurrence = busy
    ? { id, source: 'manual', plannedAt: now.toISOString(), status: 'skipped', reason: `上一轮仍${OCCURRENCE_STATES[busy.status].label}，本次未开始` }
    : schedule.action.kind === 'reminder'
      ? { id, source: 'manual', plannedAt: now.toISOString(), startedAt: now.toISOString(), endedAt: now.toISOString(), status: 'delivered', result: '已生成 Inbox 通知', notification: true }
      : { id, source: 'manual', plannedAt: now.toISOString(), startedAt: now.toISOString(), status: 'running', step: '读取指令并核对执行范围' };
  return { ...schedule, occurrences: [occurrence, ...(schedule.occurrences || [])] };
}

/** 暂停只阻止后续触发，不影响在途的这一轮；启用后从未来时间计算，暂停期间不补跑。 */
export function setScheduleState(schedule, state) {
  return { ...schedule, state };
}

/** 停止本次执行：只影响当前这一轮，安排保持原状态。 */
export function stopOccurrence(schedule, occurrenceId) {
  return {
    ...schedule,
    occurrences: schedule.occurrences.map((occurrence) => occurrence.id === occurrenceId ? { ...occurrence, status: 'stopping' } : occurrence),
  };
}

export function finishOccurrence(schedule, occurrenceId, patch) {
  return {
    ...schedule,
    occurrences: schedule.occurrences.map((occurrence) => occurrence.id === occurrenceId ? { ...occurrence, ...patch } : occurrence),
  };
}

/** 新建安排的默认值：明早 9 点的单次提醒。 */
export function emptySchedule(now, timeZone = DEFAULT_TIME_ZONE) {
  const tomorrow = addDays(zonedParts(now, timeZone), 1);
  return {
    name: '',
    action: { kind: 'reminder', text: '', instruction: '', projectId: 'multivac', agentId: 'general', budgetMinutes: 30 },
    rule: { kind: 'once', date: `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}`, time: '09:00', days: [1] },
    timeZone,
    missedPolicy: 'skip',
  };
}

/** 保存前校验；返回第一条问题，供表单就地提示。 */
export function scheduleProblem(draft, now) {
  if (!draft.name.trim()) return '请填写名称。';
  if (draft.action.kind === 'reminder' && !draft.action.text.trim()) return '请填写提醒内容。';
  if (draft.action.kind === 'agent' && !draft.action.instruction.trim()) return '请填写要执行的指令。';
  if (draft.rule.kind === 'weekly' && !draft.rule.days?.length) return '请至少选择一个星期几。';
  if (!upcomingOccurrences(draft.rule, draft.timeZone, now, 1).results.length) return draft.rule.kind === 'once' ? '计划时间已过去或不存在，请选择未来的时间。' : '这条规则没有可触发的时间。';
  return '';
}

const iso = (now, minutes) => new Date(now.getTime() + minutes * MINUTE).toISOString();

/** 原型示例：覆盖单次/每天/每周、两类动作、暂停、完成以及各种触发状态。 */
export function seedSchedules(now = new Date()) {
  const tomorrow = addDays(zonedParts(now, DEFAULT_TIME_ZONE), 1);
  const yesterday = addDays(zonedParts(now, DEFAULT_TIME_ZONE), -1);
  const date = (wall) => `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
  return [
    {
      id: 'deps-audit', name: '检查依赖安全公告', state: 'active', timeZone: DEFAULT_TIME_ZONE, missedPolicy: 'latest',
      action: { kind: 'agent', instruction: '查看 npm audit 与 GitHub 安全公告，列出影响 Multivac 的依赖及建议的升级版本，不直接修改 package.json。', projectId: 'multivac', agentId: 'general', budgetMinutes: 30 },
      rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, createdAt: iso(now, -60 * 24 * 21),
      occurrences: [
        { id: 'deps-6', source: 'scheduled', plannedAt: iso(now, -38), startedAt: iso(now, -38), status: 'running', step: '读取 npm audit 输出', session: '检查依赖安全公告 · 今天 09:00' },
        { id: 'deps-5', source: 'scheduled', plannedAt: iso(now, -60 * 24 - 38), startedAt: iso(now, -60 * 24 - 38), endedAt: iso(now, -60 * 24 - 31), status: 'succeeded', result: '发现 2 个中危公告：vite 6.0.1、undici 6.19.2，建议升级补丁版本。', session: '检查依赖安全公告 · 昨天 09:00', notification: true },
        { id: 'deps-4', source: 'scheduled', plannedAt: iso(now, -60 * 72 - 38), status: 'skipped', reason: '服务离线错过；按“仅补最近一次”已在恢复后补跑' },
        { id: 'deps-3', source: 'manual', plannedAt: iso(now, -60 * 70), startedAt: iso(now, -60 * 70), endedAt: iso(now, -60 * 70 + 6), status: 'succeeded', result: '没有新的安全公告。', session: '检查依赖安全公告 · 手动', notification: true },
      ],
    },
    {
      id: 'weekly-report', name: '整理本周成果周报', state: 'active', timeZone: DEFAULT_TIME_ZONE, missedPolicy: 'skip',
      action: { kind: 'agent', instruction: '汇总本周已完成的任务、成果与仍在等待的事项，写成一页周报草稿保存到 docs/weekly/，不对外发送。', projectId: 'multivac', agentId: 'general', budgetMinutes: 60 },
      rule: { kind: 'weekly', days: [5], time: '17:30' }, createdAt: iso(now, -60 * 24 * 40),
      occurrences: [
        { id: 'weekly-2', source: 'scheduled', plannedAt: iso(now, -60 * 26), startedAt: iso(now, -60 * 26), status: 'waiting', step: '等待授权：写入 docs/weekly/ 之外的目录', session: '整理本周成果周报 · 上周五 17:30', request: true },
        { id: 'weekly-1', source: 'scheduled', plannedAt: iso(now, -60 * 24 * 7 - 60 * 26), startedAt: iso(now, -60 * 24 * 7 - 60 * 26), endedAt: iso(now, -60 * 24 * 7 - 60 * 26 + 60), status: 'failed', result: '已达到本次执行时长上限（60 分钟），周报草稿未完成。', session: '整理本周成果周报 · 两周前', notification: true },
      ],
    },
    {
      id: 'quarter-report', name: '提交季度报告', state: 'active', timeZone: DEFAULT_TIME_ZONE, missedPolicy: 'skip',
      action: { kind: 'reminder', text: '提交 Q3 季度报告，记得附上用量统计截图。' },
      rule: { kind: 'once', date: date(tomorrow), time: '17:00' }, createdAt: iso(now, -60 * 5), origin: '对话中创建',
      occurrences: [],
    },
    {
      id: 'standup', name: '站会前过一遍 Inbox', state: 'active', timeZone: DEFAULT_TIME_ZONE, missedPolicy: 'skip',
      action: { kind: 'reminder', text: '站会前处理 Inbox 中阻塞工作的事项。' },
      rule: { kind: 'weekly', days: [1, 3, 5], time: '09:50' }, createdAt: iso(now, -60 * 24 * 30),
      occurrences: [
        { id: 'standup-2', source: 'scheduled', plannedAt: iso(now, -60 * 24 * 2), startedAt: iso(now, -60 * 24 * 2), endedAt: iso(now, -60 * 24 * 2), status: 'delivered', result: '已生成 Inbox 通知，已标记知道了', notification: true },
      ],
    },
    {
      id: 'index-rebuild', name: '重建知识库索引', state: 'paused', timeZone: DEFAULT_TIME_ZONE, missedPolicy: 'skip',
      action: { kind: 'agent', instruction: '运行 build-index.sh 重建知识库全文索引，完成后报告新增与删除的条目数。', projectId: 'research', agentId: 'research', budgetMinutes: 15 },
      rule: { kind: 'daily', time: '02:00' }, createdAt: iso(now, -60 * 24 * 60),
      occurrences: [
        { id: 'index-3', source: 'scheduled', plannedAt: iso(now, -60 * 24 * 3), startedAt: iso(now, -60 * 24 * 3), status: 'reconcile', reason: '服务重启时这一轮正在运行 build-index.sh，退出状态未知。不会自动重跑，请进入会话核对。', session: '重建知识库索引 · 3 天前' },
        { id: 'index-2', source: 'scheduled', plannedAt: iso(now, -60 * 24 * 4), startedAt: iso(now, -60 * 24 * 4), endedAt: iso(now, -60 * 24 * 4 + 4), status: 'stopped', result: '由你停止本次执行。', session: '重建知识库索引 · 4 天前' },
      ],
    },
    {
      id: 'call-mom', name: '给妈妈打电话', state: 'completed', timeZone: DEFAULT_TIME_ZONE, missedPolicy: 'skip',
      action: { kind: 'reminder', text: '问下周末回不回家吃饭。' },
      rule: { kind: 'once', date: date(yesterday), time: '19:30' }, createdAt: iso(now, -60 * 24 * 3), origin: '旧提醒迁移',
      occurrences: [
        { id: 'mom-1', source: 'scheduled', plannedAt: iso(now, -60 * 24), startedAt: iso(now, -60 * 24), endedAt: iso(now, -60 * 24), status: 'delivered', result: '已生成 Inbox 通知，并发送微信副本', notification: true },
      ],
    },
  ];
}
