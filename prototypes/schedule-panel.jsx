import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, Bot, CalendarClock, Check, ChevronDown, CircleAlert, Clock, Globe, Inbox, LoaderCircle, MessageSquare, Pause, Pencil, Play, Plus,
  Search, Square, Trash2, X, Zap,
} from 'lucide-react';
import {
  ACTION_LABELS, AGENT_BUDGETS, MISSED_POLICIES, OCCURRENCE_STATES, SCHEDULE_STATES, TIME_ZONES, WEEKDAY_LABELS,
  activeOccurrence, describeRule, emptySchedule, filterSchedules, finishOccurrence, formatAt, lastFinishedOccurrence,
  nextOccurrence, scheduleProblem, seedSchedules, setScheduleState, stopOccurrence, timeZoneLabel, triggerNow,
  upcomingOccurrences,
} from './schedule-state.js';

const ACTION_FILTERS = [
  { id: 'all', label: '全部类型', hint: '提醒与 Agent 执行', Icon: CalendarClock },
  { id: 'reminder', label: '提醒', hint: '到点在 Inbox 生成通知', Icon: Bell },
  { id: 'agent', label: 'Agent 执行', hint: '在独立会话中执行指令', Icon: Bot },
];

/** 类型筛选菜单：触发器显示当前类型；方向键在选项间移动，Esc 或点外部关闭并把焦点还给触发器。 */
function TypeFilter({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const current = ACTION_FILTERS.find((item) => item.id === value) || ACTION_FILTERS[0];
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('[aria-checked="true"]')?.focus();
    const outside = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function close() { setOpen(false); trigger.current?.focus(); }
  function onMenuKey(event) {
    const items = [...root.current.querySelectorAll('[role="menuitemradio"]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    if (event.key === 'Tab') setOpen(false);
  }
  return <div className="schedule-type-filter" ref={root}>
    <button ref={trigger} type="button" className={`schedule-type-trigger ${value !== 'all' ? 'filtered' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={`按类型筛选：${current.label}`} onClick={() => setOpen((state) => !state)}>
      <current.Icon aria-hidden="true" />{current.label}<ChevronDown className="schedule-type-chevron" aria-hidden="true" />
    </button>
    {open && <div className="schedule-type-menu" role="menu" aria-label="按类型筛选" onKeyDown={onMenuKey}>
      {ACTION_FILTERS.map((item) => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === value} onClick={() => { onChange(item.id); close(); }}>
        <span className={`schedule-type-icon ${item.id}`}><item.Icon aria-hidden="true" /></span>
        <span className="schedule-type-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
        {item.id === value && <Check className="schedule-type-check" aria-hidden="true" />}
      </button>)}
    </div>}
  </div>;
}
const STATE_FILTERS = [['all', '全部'], ['active', '启用'], ['paused', '已暂停'], ['completed', '已完成']];
/** 星期按周一开头排列。 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function ActionIcon({ kind }) {
  return kind === 'agent' ? <Bot aria-hidden="true" /> : <Bell aria-hidden="true" />;
}

function StatePill({ meta, spinning = false }) {
  return <span className={`schedule-pill ${meta.tone}`}>{spinning && <LoaderCircle className="status-spinner" aria-hidden="true" />}{meta.label}</span>;
}

/** 列表排序：启用的按下次时间先后，其后是暂停与已完成。 */
function sortSchedules(schedules, now) {
  const rank = { active: 0, paused: 1, completed: 2 };
  return [...schedules].sort((a, b) => rank[a.state] - rank[b.state]
    || (nextOccurrence(a, now)?.getTime() ?? Infinity) - (nextOccurrence(b, now)?.getTime() ?? Infinity)
    || a.name.localeCompare(b.name, 'zh-CN'));
}

function ScheduleListItem({ schedule, now, selected, onSelect }) {
  const busy = activeOccurrence(schedule);
  const last = lastFinishedOccurrence(schedule);
  const next = nextOccurrence(schedule, now);
  return <button type="button" className={`schedule-list-item ${selected ? 'selected' : ''} ${schedule.state}`} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(schedule.id)}>
    <span className={`schedule-kind ${schedule.action.kind}`}><ActionIcon kind={schedule.action.kind} /></span>
    <span className="schedule-item-main">
      <span className="schedule-item-title"><strong>{schedule.name}</strong>{schedule.state !== 'active' && <StatePill meta={SCHEDULE_STATES[schedule.state]} />}</span>
      <span className="schedule-item-rule">{describeRule(schedule.rule)}</span>
    </span>
    <span className="schedule-item-side">
      {busy ? <StatePill meta={OCCURRENCE_STATES[busy.status]} spinning={busy.status === 'running'} />
        : last && <StatePill meta={OCCURRENCE_STATES[last.status]} />}
      <span className="schedule-item-next">{next ? <>下次 {formatAt(next, schedule.timeZone, now)}</> : schedule.state === 'paused' ? '暂停中不触发' : '不再触发'}</span>
    </span>
  </button>;
}

function Facts({ entries }) {
  return <dl className="schedule-facts">{entries.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

/** 正在占用这一安排的触发：执行中可停止；等待人工处理去 Inbox；结果未知只读核对。 */
function ActiveOccurrence({ schedule, occurrence, now, onStop, onOpenInbox, onOpenSession }) {
  const meta = OCCURRENCE_STATES[occurrence.status];
  return <section className={`schedule-active ${meta.tone}`} aria-label="当前这一轮">
    <div className="schedule-active-heading">
      {occurrence.status === 'running' ? <LoaderCircle className="status-spinner" aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <strong>{occurrence.source === 'manual' ? '手动执行' : '本轮'} · {meta.label}</strong>
      <time>{formatAt(new Date(occurrence.startedAt || occurrence.plannedAt), schedule.timeZone, now)} 开始</time>
    </div>
    <p>{occurrence.reason || occurrence.step}</p>
    <div className="schedule-active-actions">
      {occurrence.status === 'waiting' && <button type="button" className="secondary compact" onClick={onOpenInbox}><Inbox />去 Inbox 处理</button>}
      {occurrence.session && <button type="button" className="secondary compact" onClick={() => onOpenSession(occurrence.session)}><MessageSquare />{occurrence.status === 'reconcile' ? '进入会话核对' : '查看执行会话'}</button>}
      {(occurrence.status === 'running' || occurrence.status === 'waiting') && <button type="button" className="secondary compact danger" onClick={onStop}><Square />停止本次</button>}
    </div>
    <small>{occurrence.status === 'reconcile' ? '结果未知时不会自动重跑；核对前同一安排不会开始新一轮。' : '停止本次只结束这一轮，不暂停安排。'}</small>
  </section>;
}

function OccurrenceRow({ schedule, occurrence, now, onOpenInbox, onOpenSession }) {
  const meta = OCCURRENCE_STATES[occurrence.status];
  const started = occurrence.startedAt && new Date(occurrence.startedAt);
  const minutes = started && occurrence.endedAt ? Math.max(0, Math.round((new Date(occurrence.endedAt) - started) / 60000)) : null;
  return <li className="schedule-occurrence">
    <div className="schedule-occurrence-head">
      <time dateTime={occurrence.plannedAt}>{formatAt(new Date(occurrence.plannedAt), schedule.timeZone, now)}</time>
      {occurrence.source === 'manual' && <span className="schedule-source">手动</span>}
      <StatePill meta={meta} spinning={occurrence.status === 'running'} />
      {minutes !== null && schedule.action.kind === 'agent' && <span className="schedule-duration">用时 {minutes || '<1'} 分钟</span>}
    </div>
    {(occurrence.result || occurrence.reason || occurrence.step) && <p>{occurrence.result || occurrence.reason || occurrence.step}</p>}
    {(occurrence.session || occurrence.notification) && <div className="schedule-occurrence-links">
      {occurrence.session && <button type="button" className="inline-link" onClick={() => onOpenSession(occurrence.session)}><MessageSquare />执行会话</button>}
      {occurrence.notification && <button type="button" className="inline-link" onClick={onOpenInbox}><Inbox />Inbox 通知</button>}
    </div>}
  </li>;
}

function ScheduleDetail({ schedule, now, projects, agents, onEdit, onTrigger, onToggle, onStop, onDelete, onOpenInbox, onOpenSession }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [schedule.id]);
  const busy = activeOccurrence(schedule);
  const preview = schedule.state === 'active' ? upcomingOccurrences(schedule.rule, schedule.timeZone, now, 3) : { results: [], skipped: [] };
  const project = projects.find((item) => item.id === schedule.action.projectId);
  const agent = agents.find((item) => item.id === schedule.action.agentId);
  const agentAction = schedule.action.kind === 'agent';
  return <aside className="schedule-detail" aria-label="安排详情">
    <header className="schedule-detail-header">
      <span className={`schedule-kind ${schedule.action.kind}`}><ActionIcon kind={schedule.action.kind} /></span>
      <div>
        <h2>{schedule.name}</h2>
        <p>{ACTION_LABELS[schedule.action.kind]} · {describeRule(schedule.rule)}{schedule.origin ? ` · ${schedule.origin}` : ''}</p>
      </div>
      <StatePill meta={SCHEDULE_STATES[schedule.state]} />
    </header>

    <div className="schedule-detail-actions">
      {schedule.state !== 'completed' && <button type="button" className="secondary compact" onClick={onToggle}>{schedule.state === 'active' ? <><Pause />暂停</> : <><Play />启用</>}</button>}
      <button type="button" className="secondary compact" onClick={onTrigger} title="不改变原计划的下次时间">{<Zap />}立即执行一次</button>
      {schedule.state !== 'completed' && <button type="button" className="secondary compact" onClick={onEdit}><Pencil />编辑</button>}
      <button type="button" className="secondary compact danger" onClick={() => setConfirmDelete(true)}><Trash2 />删除</button>
    </div>

    {confirmDelete && <div className="schedule-confirm" role="alertdialog" aria-label="删除安排">
      {busy ? <>
        <p><strong>这一轮仍{OCCURRENCE_STATES[busy.status].label}。</strong>请先停止本次执行或等待结束，再删除安排；删除不会替你停止执行。</p>
        <div><button type="button" className="secondary compact" onClick={() => setConfirmDelete(false)}>知道了</button></div>
      </> : <>
        <p><strong>删除“{schedule.name}”？</strong>之后不再触发。触发记录、执行会话和已生成的 Inbox 通知都会保留。</p>
        <div><button type="button" className="secondary compact" onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="secondary compact danger" onClick={onDelete}>删除安排</button></div>
      </>}
    </div>}

    <div className="schedule-detail-scroll">
      {busy && <ActiveOccurrence schedule={schedule} occurrence={busy} now={now} onStop={() => onStop(busy.id)} onOpenInbox={onOpenInbox} onOpenSession={onOpenSession} />}

      <section className="schedule-section" aria-label="接下来">
        <h3><CalendarClock aria-hidden="true" />接下来</h3>
        {schedule.state === 'paused' ? <p className="schedule-muted">已暂停，不会触发。启用后从未来的时间继续，暂停期间的轮次不补跑。</p>
          : schedule.state === 'completed' ? <p className="schedule-muted">单次安排已完成，不再触发。</p>
            : <ol className="schedule-upcoming">{preview.results.map((item, index) => <li key={item.at.toISOString()}><time>{formatAt(item.at, schedule.timeZone, now)}</time>
              {/* 不重叠：这一轮到时仍未结束，下一次就记为跳过。 */}
              {index === 0 && busy ? <small>本轮仍{OCCURRENCE_STATES[busy.status].label}时将跳过</small> : item.note && <small>{item.note}</small>}</li>)}</ol>}
        {preview.skipped.length > 0 && <p className="schedule-muted">{preview.skipped.length} 个时间因夏令时不存在，将跳过并留下记录。</p>}
        <p className="schedule-zone"><Globe aria-hidden="true" />{timeZoneLabel(schedule.timeZone)}</p>
      </section>

      <section className="schedule-section" aria-label="配置">
        <h3>{agentAction ? '执行内容' : '提醒内容'}</h3>
        <blockquote className="schedule-content">{agentAction ? schedule.action.instruction : schedule.action.text}</blockquote>
        <Facts entries={agentAction ? [
          ['执行范围', project ? `${project.name} · ${project.directories?.[0]?.path || '项目目录'}` : '独立执行目录'],
          ['智能体', agent?.name || '已删除，到时会明确失败'],
          ['每次额度', `${schedule.action.budgetMinutes} 分钟；输出与调用沿用任务执行上限`],
          ['每次会话', '新建独立会话，不继承上一轮历史'],
          ['错过时间', MISSED_POLICIES[schedule.missedPolicy].label],
          ['重叠', '上一轮未结束时，本轮记为跳过'],
          ['结果通知', '成功、失败或停止都在 Inbox 生成一条通知，不外发微信'],
        ] : [
          ['通知方式', '到点在 Inbox 生成通知；已启用的渠道（如微信）发送副本'],
          ['错过时间', schedule.rule.kind === 'once' ? '服务离线错过时，启动后补发一次' : MISSED_POLICIES[schedule.missedPolicy].label],
        ]} />
      </section>

      <section className="schedule-section" aria-label="触发记录">
        <h3>触发记录<span>{schedule.occurrences.length} 次</span></h3>
        {schedule.occurrences.length ? <ol className="schedule-history">{schedule.occurrences.map((occurrence) => <OccurrenceRow key={occurrence.id} schedule={schedule} occurrence={occurrence} now={now} onOpenInbox={onOpenInbox} onOpenSession={onOpenSession} />)}</ol>
          : <p className="schedule-muted">还没有触发过。</p>}
      </section>
    </div>
  </aside>;
}

/** 新建与编辑共用：保存只影响之后的触发，已有记录保留当时的配置。 */
function ScheduleEditor({ initial, editing, now, projects, agents, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const set = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const setAction = (patch) => setDraft((current) => ({ ...current, action: { ...current.action, ...patch } }));
  const setRule = (patch) => setDraft((current) => ({ ...current, rule: { ...current.rule, ...patch } }));
  const problem = scheduleProblem(draft, now);
  const preview = upcomingOccurrences(draft.rule, draft.timeZone, now, 3);
  const agentAction = draft.action.kind === 'agent';
  function toggleDay(day) {
    const days = new Set(draft.rule.days || []);
    if (days.has(day)) days.delete(day); else days.add(day);
    setRule({ days: [...days] });
  }
  function submit(event) {
    event.preventDefault();
    setTouched(true);
    if (!problem) onSave(draft);
  }
  return <div className="creation-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="creation-dialog schedule-editor" role="dialog" aria-modal="true" aria-labelledby="schedule-editor-title" onSubmit={submit}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div className="creation-header"><div><span>定时安排</span><h2 id="schedule-editor-title">{editing ? '编辑安排' : '新建安排'}</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X /></button></div>

      <div className="schedule-editor-body">
        <label className="schedule-field"><span>名称</span><input ref={nameRef} value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：检查依赖安全公告" /></label>

        <div className="schedule-field"><span>到时做什么</span>
          <div className="segmented" role="radiogroup" aria-label="动作类型">
            {Object.entries(ACTION_LABELS).map(([kind, label]) => <button key={kind} type="button" role="radio" aria-checked={draft.action.kind === kind} className={draft.action.kind === kind ? 'active' : ''} disabled={editing} onClick={() => setAction({ kind })}><ActionIcon kind={kind} />{label}</button>)}
          </div>
          <small>{agentAction ? '在独立会话中执行指令并保存结果；不会创建待办任务。' : '只在 Inbox 生成通知，不调用模型。'}{editing ? ' 动作类型创建后不能更改。' : ''}</small>
        </div>

        {agentAction ? <>
          <label className="schedule-field"><span>指令</span><textarea rows={3} value={draft.action.instruction} onChange={(event) => setAction({ instruction: event.target.value })} placeholder="写清楚要做什么、产出放在哪里、哪些事不要做" /></label>
          <div className="schedule-field-row">
            <label className="schedule-field"><span>执行范围</span><select value={draft.action.projectId} onChange={(event) => setAction({ projectId: event.target.value })}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              <option value="">不属于项目（独立执行目录）</option>
            </select></label>
            <label className="schedule-field"><span>智能体</span><select value={draft.action.agentId} onChange={(event) => setAction({ agentId: event.target.value })}>
              {agents.filter((agent) => !agent.fixed).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select></label>
          </div>
          <label className="schedule-field"><span>每次执行时长上限</span><select value={draft.action.budgetMinutes} onChange={(event) => setAction({ budgetMinutes: Number(event.target.value) })}>
            {AGENT_BUDGETS.map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
          </select><small>用完即停止这一轮并通知你，不会自动加额度。需要你决定的操作照常进入 Inbox 等待。</small></label>
        </> : <label className="schedule-field"><span>提醒内容</span><textarea rows={2} value={draft.action.text} onChange={(event) => setAction({ text: event.target.value })} placeholder="到时提醒你的内容" /></label>}

        <div className="schedule-field"><span>什么时候</span>
          <div className="segmented" role="radiogroup" aria-label="重复方式">
            {[['once', '单次'], ['daily', '每天'], ['weekly', '每周']].map(([kind, label]) => <button key={kind} type="button" role="radio" aria-checked={draft.rule.kind === kind} className={draft.rule.kind === kind ? 'active' : ''} onClick={() => setRule({ kind })}>{label}</button>)}
          </div>
        </div>
        <div className="schedule-field-row">
          {draft.rule.kind === 'once' && <label className="schedule-field"><span>日期</span><input type="date" value={draft.rule.date} onChange={(event) => setRule({ date: event.target.value })} /></label>}
          <label className="schedule-field"><span>时间</span><input type="time" value={draft.rule.time} onChange={(event) => setRule({ time: event.target.value })} /></label>
          <label className="schedule-field"><span>时区</span><select value={draft.timeZone} onChange={(event) => set({ timeZone: event.target.value })}>
            {TIME_ZONES.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
          </select></label>
        </div>
        {draft.rule.kind === 'weekly' && <div className="schedule-weekdays" role="group" aria-label="星期几">
          {WEEK_ORDER.map((day) => <button key={day} type="button" aria-pressed={draft.rule.days?.includes(day)} className={draft.rule.days?.includes(day) ? 'active' : ''} onClick={() => toggleDay(day)}>{WEEKDAY_LABELS[day]}</button>)}
        </div>}

        {draft.rule.kind !== 'once' && <div className="schedule-field"><span>错过的时间</span>
          <div className="schedule-radio-list">
            {Object.entries(MISSED_POLICIES).map(([id, policy]) => <label key={id} className={draft.missedPolicy === id ? 'selected' : ''}><input type="radio" name="missed-policy" checked={draft.missedPolicy === id} onChange={() => set({ missedPolicy: id })} /><span><strong>{policy.label}</strong><small>{policy.hint}</small></span></label>)}
          </div>
        </div>}

        <section className="schedule-preview" aria-label="触发预览">
          <h3><Clock aria-hidden="true" />{draft.rule.kind === 'once' ? '将在' : '接下来 3 次'}</h3>
          {preview.results.length ? <ol>{preview.results.map((item) => <li key={item.at.toISOString()}><time>{formatAt(item.at, draft.timeZone, now)}</time>{item.note && <small>{item.note}</small>}</li>)}</ol>
            : <p>没有可触发的时间。</p>}
          <p className="schedule-preview-note">{agentAction ? '同一安排上一轮未结束时，本轮记为跳过；' : ''}服务离线时不能准时执行，{draft.rule.kind === 'once' && !agentAction ? '提醒会在启动后补发。' : '按“错过的时间”处理。'}</p>
        </section>
      </div>

      {touched && problem && <p className="schedule-problem" role="alert">{problem}</p>}
      <div className="creation-actions">
        {editing && <span className="schedule-editor-hint">保存后只影响之后的触发</span>}
        <button type="button" className="secondary" onClick={onClose}>取消</button>
        <button type="submit" className="primary">{editing ? '保存' : '保存并启用'}</button>
      </div>
    </form>
  </div>;
}

/**
 * 管理 → 工作 → 定时：统一管理提醒与 Agent 定时执行。
 * 原型数据只在本页内存中变化；“执行”用计时器模拟，不调用模型。
 */
export function ScheduleView({ projects, agents, notify, onOpenInbox }) {
  const [now, setNow] = useState(() => new Date());
  const [schedules, setSchedules] = useState(() => seedSchedules(new Date()));
  const [filters, setFilters] = useState({ action: 'all', state: 'all', query: '' });
  const [selectedId, setSelectedId] = useState('deps-audit');
  const [editor, setEditor] = useState(null);
  const timers = useRef([]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 30_000);
    return () => { window.clearInterval(clock); timers.current.forEach((timer) => window.clearTimeout(timer)); };
  }, []);

  const visible = useMemo(() => sortSchedules(filterSchedules(schedules, filters), now), [schedules, filters, now]);
  const selected = schedules.find((item) => item.id === selectedId && !item.deleted) || visible[0];
  const counts = useMemo(() => ({
    active: schedules.filter((item) => !item.deleted && item.state === 'active').length,
    running: schedules.filter((item) => !item.deleted && activeOccurrence(item)).length,
  }), [schedules]);
  // 状态标签上的数量随类型与搜索变化，只不受状态本身影响。
  const stateCounts = useMemo(() => Object.fromEntries(STATE_FILTERS.map(([id]) => [id, filterSchedules(schedules, { ...filters, state: id }).length])), [schedules, filters]);

  const update = (id, change) => setSchedules((current) => current.map((item) => item.id === id ? change(item) : item));
  const later = (delay, action) => timers.current.push(window.setTimeout(action, delay));
  const openSession = (name) => notify(`原型：打开执行会话“${name}”`);

  function trigger(schedule) {
    const id = `${schedule.id}-manual-${Date.now()}`;
    const triggered = triggerNow(schedule, new Date(), id);
    update(schedule.id, () => triggered);
    const occurrence = triggered.occurrences[0];
    if (occurrence.status === 'skipped') { notify('上一轮仍未结束，本次已记为跳过'); return; }
    if (schedule.action.kind === 'reminder') { notify('已立即提醒，下次计划时间不变'); return; }
    notify('已开始执行一次，下次计划时间不变');
    const session = `${schedule.name} · 手动`;
    update(schedule.id, (current) => finishOccurrence(current, id, { session }));
    later(6000, () => update(schedule.id, (current) => current.occurrences.find((item) => item.id === id)?.status === 'running'
      ? finishOccurrence(current, id, { status: 'succeeded', endedAt: new Date().toISOString(), result: '（原型示例）执行完成，结果已保存并在 Inbox 生成通知。', notification: true })
      : current));
  }

  function stop(schedule, occurrenceId) {
    update(schedule.id, (current) => stopOccurrence(current, occurrenceId));
    notify('正在停止本次执行，安排保持启用');
    later(1500, () => update(schedule.id, (current) => finishOccurrence(current, occurrenceId, { status: 'stopped', endedAt: new Date().toISOString(), result: '由你停止本次执行。' })));
  }

  function toggle(schedule) {
    const next = schedule.state === 'active' ? 'paused' : 'active';
    update(schedule.id, (current) => setScheduleState(current, next));
    notify(next === 'paused' ? (activeOccurrence(schedule) ? '已暂停，后续不再触发；进行中的这一轮不受影响' : '已暂停，后续不再触发') : '已启用，从未来的时间继续');
  }

  function remove(schedule) {
    update(schedule.id, (current) => ({ ...current, deleted: true }));
    notify(`已删除“${schedule.name}”，触发记录与通知保留`);
  }

  function save(draft) {
    if (editor.id) {
      update(editor.id, (current) => ({ ...current, ...draft, name: draft.name.trim() }));
      notify('已保存，只影响之后的触发');
    } else {
      const id = `schedule-${Date.now()}`;
      setSchedules((current) => [{ ...draft, id, name: draft.name.trim(), state: 'active', createdAt: new Date().toISOString(), occurrences: [] }, ...current]);
      setSelectedId(id);
      setFilters({ action: 'all', state: 'all', query: '' });
      notify('已创建并启用');
    }
    setEditor(null);
  }

  return <div className="page-column schedules-page">
    <div className="page-intro">
      <div><span className="eyebrow">按时执行</span><h1>定时安排</h1><p>到点提醒你，或在独立会话里替你执行一段指令。与待办任务分开：不进任务树，也不需要验收。</p></div>
      <div className="page-actions"><span className="schedule-summary">{counts.active} 个启用{counts.running ? ` · ${counts.running} 个本轮未结束` : ''}</span><button type="button" className="primary" onClick={() => setEditor({ draft: emptySchedule(now) })}><Plus />新建安排</button></div>
    </div>

    <div className="master-detail schedule-layout">
      <section className="schedule-list" aria-label="定时安排列表">
        {/* 筛选与列表连成一块：状态用带数量的标签，类型与搜索收在同一行右侧。 */}
        <div className="schedule-filters">
          <div className="schedule-tabs" role="tablist" aria-label="按状态筛选">
            {STATE_FILTERS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={filters.state === id} className={filters.state === id ? 'active' : ''} onClick={() => setFilters((current) => ({ ...current, state: id }))}>{label}<span>{stateCounts[id]}</span></button>)}
          </div>
          <div className="schedule-filter-tools">
            <TypeFilter value={filters.action} onChange={(action) => setFilters((current) => ({ ...current, action }))} />
            <label className="schedule-search"><Search aria-hidden="true" /><input aria-label="搜索安排" placeholder="搜索" value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} /></label>
          </div>
        </div>
        {visible.map((schedule) => <ScheduleListItem key={schedule.id} schedule={schedule} now={now} selected={selected?.id === schedule.id} onSelect={setSelectedId} />)}
        {!visible.length && <div className="schedule-empty"><CalendarClock aria-hidden="true" /><strong>{schedules.some((item) => !item.deleted) ? '没有符合筛选的安排' : '还没有定时安排'}</strong><p>可以在这里新建，也可以直接对 Multivac 说“每个工作日早上 9 点检查依赖安全公告”。</p></div>}
      </section>
      {selected ? <ScheduleDetail key={selected.id} schedule={selected} now={now} projects={projects} agents={agents}
        onEdit={() => setEditor({ id: selected.id, draft: { name: selected.name, action: selected.action, rule: selected.rule, timeZone: selected.timeZone, missedPolicy: selected.missedPolicy } })}
        onTrigger={() => trigger(selected)} onToggle={() => toggle(selected)} onStop={(occurrenceId) => stop(selected, occurrenceId)} onDelete={() => remove(selected)}
        onOpenInbox={onOpenInbox} onOpenSession={openSession} />
        : <aside className="schedule-detail schedule-detail-empty" aria-label="安排详情"><p>选择一个安排查看详情。</p></aside>}
    </div>

    {editor && <ScheduleEditor initial={editor.draft} editing={Boolean(editor.id)} now={now} projects={projects} agents={agents} onSave={save} onClose={() => setEditor(null)} />}
  </div>;
}
