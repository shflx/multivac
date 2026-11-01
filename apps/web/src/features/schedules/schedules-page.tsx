import { Check } from 'typebox/value';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { type ControlSchedule, type ScheduleDetail, type ScheduleDraft, type ScheduleList, type ScheduleOccurrence, type Schedule, CreateScheduleSchema, UpdateScheduleSchema, ControlScheduleSchema } from '@multivac/contracts';
import { Bell, Bot, CalendarClock, ChevronRight, CircleAlert, Globe, Inbox, LoaderCircle, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2, X, Zap } from 'lucide-react';
import { useConfirm } from '../../components/confirm-card.js';
import { AssistantApiError } from '../../data/assistant-api.js';
import { newCommandId } from '../../data/command-id.js';
import * as api from '../../data/schedules-api.js';
import { ManagementPageActions } from '../../app/management-layout.js';
import { agentName, useAgents } from '../agents/use-agents.js';
import { TaskFilter } from '../tasks/task-filter.js';
import { TaskIconButton } from '../tasks/task-icon-button.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { ScheduleEditor } from './schedule-editor.js';
import { ACTION_LABELS, MISSED_POLICIES, OCCURRENCE_STATES, SCHEDULE_STATES, bytesLabel, describeRule, durationLabel, formatAt, occurrenceLabel, timeZoneLabel, type Tone } from './schedule-format.js';
import './schedules.css';

/** 列表按安排状态分组；已结束与已删除默认折叠，已删除只为查看历史保留。 */
const GROUPS = [
  { id: 'active', label: '启用中', open: true },
  { id: 'paused', label: '已暂停', open: true },
  { id: 'completed', label: '已结束', open: false },
  { id: 'deleted', label: '已删除', open: false },
] as const;
type GroupId = (typeof GROUPS)[number]['id'];
type ListItem = ScheduleList['items'][number];
const KIND_OPTIONS = [
  { id: 'all', label: '全部类型', description: '提醒与 Agent 执行', icon: CalendarClock },
  { id: 'reminder', label: '提醒', description: '到点在 Inbox 生成通知', icon: Bell },
  { id: 'agent', label: 'Agent 执行', description: '在独立会话中执行指令', icon: Bot },
];
const GROUP_LIMIT = 100, HISTORY_SIZE = 20;

const pendingKey = 'multivac.schedule.pending-command';
function readPending(): api.ScheduleWrite | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    const schema = value?.path === '' ? CreateScheduleSchema : value?.path === '/update' ? UpdateScheduleSchema : value?.path === '/control' ? ControlScheduleSchema : null;
    return schema && Check(schema, value.body) ? value : null;
  } catch { return null; }
}

function message(cause: unknown) { return cause instanceof Error ? cause.message : '读取或保存安排失败。'; }

/** 管理 → 工作 → 定时安排：统一管理提醒与 Agent 定时执行，与待办任务分开。 */
export function SchedulesPage({ active, onSession, onInbox }: { active: boolean; onSession: (id: string) => void; onInbox: (id: string | null) => void }) {
  const [kind, setKind] = useState('all'), [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Record<GroupId, ScheduleList> | null>(null);
  const [open, setOpen] = useState<Record<GroupId, boolean>>(() => Object.fromEntries(GROUPS.map((group) => [group.id, group.open])) as Record<GroupId, boolean>);
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<ScheduleDetail | null>(null), [historyOffset, setHistoryOffset] = useState(0);
  const [context, setContext] = useState<Awaited<ReturnType<typeof api.getScheduleContext>> | null>(null), [editor, setEditor] = useState<{ schedule: Schedule | null; key: string } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState(readPending), [unsavedCommand, setUnsavedCommand] = useState(false);
  const listSeq = useRef(0), detailSeq = useRef(0), contextSeq = useRef(0), lock = useRef(false), confirm = useConfirm();

  const refreshList = useCallback(async () => {
    const seq = ++listSeq.current;
    const params = (state: GroupId) => {
      const search = new URLSearchParams({ state, offset: '0', limit: String(GROUP_LIMIT) });
      if (kind !== 'all') search.set('kind', kind);
      if (query.trim()) search.set('query', query.trim());
      return search;
    };
    try {
      const lists = await Promise.all(GROUPS.map((group) => api.listSchedules(params(group.id))));
      if (seq === listSeq.current) setGroups(Object.fromEntries(GROUPS.map((group, index) => [group.id, lists[index]])) as Record<GroupId, ScheduleList>);
    } catch (cause) { if (seq === listSeq.current) setError(message(cause)); }
  }, [kind, query]);
  const refreshDetail = useCallback(async () => {
    const seq = ++detailSeq.current;
    if (!selected) { setDetail(null); return; }
    try {
      const result = await api.getSchedule(selected, historyOffset);
      if (seq !== detailSeq.current) return;
      setDetail(result);
      if (historyOffset && !result.history.items.length) setHistoryOffset(0);
    } catch (cause) { if (seq === detailSeq.current) setError(message(cause)); }
  }, [selected, historyOffset]);
  const refresh = useCallback(async () => { await Promise.all([refreshList(), refreshDetail()]); }, [refreshList, refreshDetail]);
  useEffect(() => { if (!active) return; void refresh(); return () => { listSeq.current++; detailSeq.current++; }; }, [active, refresh]);
  const refreshContext = useCallback(async () => {
    const seq = ++contextSeq.current;
    try { const result = await api.getScheduleContext(Intl.DateTimeFormat().resolvedOptions().timeZone); if (seq === contextSeq.current) setContext(result); }
    catch (cause) { if (seq === contextSeq.current) setError(message(cause)); }
  }, []);
  useEffect(() => { if (!active) return; void refreshContext(); return () => { contextSeq.current++; }; }, [active, refreshContext]);
  useWorkbenchEvents((event) => { if (active && (event.type === 'schedules.changed' || event.type === 'workbench.connected')) void refresh(); });

  function select(id: string | null) { if (id === selected) return; setDetail(null); setSelected(id); setHistoryOffset(0); }
  function clearPending() { sessionStorage.removeItem(pendingKey); setPending(null); setUnsavedCommand(false); }

  async function write(command: api.ScheduleWrite) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      // 请求前保存完整命令。连接中断后先查回执，不能另造身份重放副作用。
      sessionStorage.setItem(pendingKey, JSON.stringify(command)); setPending(command); setUnsavedCommand(false);
      const result = await api.writeSchedule(command);
      clearPending(); setEditor(null);
      if (result.scheduleId !== selected) { setDetail(null); setSelected(result.scheduleId); }
      setHistoryOffset(0);
      await refresh();
    } catch (cause) {
      if (cause instanceof AssistantApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) clearPending();
      setError(message(cause)); throw cause;
    } finally { lock.current = false; setBusy(false); }
  }
  async function reconcile() {
    if (!pending || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const receipt = await api.reconcileSchedule(pending.body.commandId);
      if (receipt.saved) { clearPending(); setEditor(null); if (receipt.result) setSelected(receipt.result.scheduleId); await refresh(); }
      else { setUnsavedCommand(true); setError('尚无原命令回执。可再核对，或使用原命令身份重试。'); }
    } catch (cause) { setError(message(cause)); } finally { lock.current = false; setBusy(false); }
  }
  async function save(draft: ScheduleDraft) {
    if (pending) return;
    await write(editor?.schedule
      ? { path: '/update', body: { ...draft, scheduleId: editor.schedule.scheduleId, revision: editor.schedule.revision, commandId: newCommandId() } }
      : { path: '', body: { ...draft, commandId: newCommandId() } });
  }

  async function control(schedule: Schedule, operation: ControlSchedule['operation'], running = false) {
    if (pending || busy) return;
    // 暂停与启用可随时撤回，直接执行；会产生副作用或不可撤回的操作先确认。
    const confirmations: Partial<Record<ControlSchedule['operation'], { title: string; description: string; danger?: boolean }>> = {
      trigger: { title: '立即执行一次', description: running ? '这一轮仍未结束，本次将记为跳过。原定计划时间保持不变。' : '新增一次手动触发，原定计划时间保持不变。' },
      stop: { title: '停止本次', description: '只结束当前这一轮，不暂停安排。停止结果未确认前，安排仍保持占用。', danger: true },
      delete: { title: '删除安排', description: `删除“${schedule.name}”后不再触发。触发记录、执行会话和已生成的 Inbox 通知都会保留。`, danger: true },
    };
    const ask = confirmations[operation];
    if (ask && !await confirm({ title: ask.title, description: ask.description, confirmLabel: ask.title, tone: ask.danger ? 'danger' : 'default' })) return;
    // 列表开关操作的安排不一定是当前打开的那个，写入后不切换详情。
    const keep = selected;
    try { await write({ path: '/control', body: { scheduleId: schedule.scheduleId, revision: schedule.revision, operation, commandId: newCommandId() } }); if (keep !== schedule.scheduleId) select(keep); }
    catch { /* 页面保留错误和原命令供核对。 */ }
  }

  function openEditor(schedule: Schedule | null) { setEditor({ schedule, key: newCommandId() }); }
  const current = detail?.schedule.scheduleId === selected ? detail : null;
  const locked = busy || !!pending;

  return <div className="schedules-page" data-management-page="schedules">
    <ManagementPageActions>
      <label className="schedule-search"><Search aria-hidden="true" /><input type="search" aria-label="搜索安排" placeholder="搜索安排" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <TaskFilter label="类型" name="按类型筛选" icon={CalendarClock} value={kind} options={KIND_OPTIONS} onChange={setKind} />
      <button type="button" className="secondary-button" onClick={() => { setError(''); void refresh(); if (!context) void refreshContext(); }} aria-label="刷新安排" title="刷新安排"><RefreshCw aria-hidden="true" /></button>
      <button type="button" className="primary-button" disabled={!context || locked} onClick={() => openEditor(null)}><Plus aria-hidden="true" />新建安排</button>
    </ManagementPageActions>

    {(error || pending) && <div className="schedule-notice" role={error ? 'alert' : 'status'}>
      <CircleAlert aria-hidden="true" />
      <span>{[error, pending && '上次操作尚未确认结果。'].filter(Boolean).join(' ')}</span>
      {pending && <button type="button" className="inline-link" disabled={busy} onClick={() => void reconcile()}>核对上次操作</button>}
      {pending && unsavedCommand && <button type="button" className="inline-link" disabled={busy} onClick={() => void write(pending).catch(() => {})}>重试原命令</button>}
    </div>}

    <div className={`schedule-layout ${selected ? 'inspecting' : ''}`}>
      <section className="schedule-list" aria-label="安排列表">
        {!groups && (error ? <p className="schedule-empty">安排尚未读取，请点击“刷新安排”重试。</p> : <p className="schedule-empty" role="status">正在读取安排…</p>)}
        {groups && GROUPS.every((group) => !groups[group.id].total) && <div className="schedule-empty"><CalendarClock aria-hidden="true" /><strong>{query || kind !== 'all' ? '没有符合筛选的安排' : '还没有定时安排'}</strong><p>可以在这里新建，也可以直接对 Multivac 说“每个工作日早上 9 点检查依赖安全公告”。</p></div>}
        {groups && GROUPS.filter((group) => groups[group.id].total > 0).map((group) => {
          const list = groups[group.id];
          return <section key={group.id} className={`schedule-group ${group.id}`} aria-label={group.label}>
            <button type="button" className="schedule-group-header" aria-expanded={open[group.id]} onClick={() => setOpen((current) => ({ ...current, [group.id]: !current[group.id] }))}>
              <ChevronRight aria-hidden="true" /><span>{group.label}</span><span className="schedule-group-count">{list.total}</span>
            </button>
            {open[group.id] && <>
              {list.items.map((item) => <ScheduleRow key={item.scheduleId} item={item} selected={selected === item.scheduleId} locked={locked} onSelect={() => select(item.scheduleId)} onToggle={() => void control(item, item.state === 'active' ? 'pause' : 'enable')} />)}
              {list.total > list.items.length && <p className="schedule-group-more">仅显示前 {list.items.length} 项，可用搜索缩小范围。</p>}
            </>}
          </section>;
        })}
      </section>

      {selected && (current ? <ScheduleDetailView detail={current} locked={locked} historyOffset={historyOffset} onHistory={setHistoryOffset} onClose={() => select(null)}
        onEdit={() => openEditor(current.schedule)} onControl={(operation) => void control(current.schedule, operation, !!current.active)} onSession={onSession} onInbox={onInbox} />
        : <section className="schedule-detail schedule-detail-empty" aria-label="安排详情"><p role="status">正在读取安排详情…</p></section>)}
    </div>

    {editor && context && <ScheduleEditor key={editor.key} schedule={editor.schedule} context={context} disabled={locked} onSave={save} onClose={() => setEditor(null)} />}
  </div>;
}

function ActionIcon({ kind }: { kind: Schedule['action']['kind'] }) {
  return kind === 'agent' ? <Bot aria-hidden="true" /> : <Bell aria-hidden="true" />;
}

function StatePill({ label, tone, spinning = false }: { label: string; tone: Tone; spinning?: boolean }) {
  return <span className={`schedule-pill ${tone}`}>{spinning && <LoaderCircle className="spin" aria-hidden="true" />}{label}</span>;
}

/** 一行一个安排：名称与规则、下次时间、最近一轮结果，行尾直接启停。 */
function ScheduleRow({ item, selected, locked, onSelect, onToggle }: { item: ListItem; selected: boolean; locked: boolean; onSelect: () => void; onToggle: () => void }) {
  const latest = item.latest;
  const toggleable = item.state === 'active' || item.state === 'paused';
  return <div className={`schedule-row ${item.state}`} aria-current={selected || undefined}>
    <button type="button" className="schedule-row-main" onClick={onSelect}>
      <span className={`schedule-kind ${item.action.kind}`}><ActionIcon kind={item.action.kind} /></span>
      <span className="schedule-row-name"><strong title={item.name}>{item.name}</strong><small>{describeRule(item.rule)}</small></span>
      <span className="schedule-row-next">{item.nextAt ? <><time dateTime={item.nextAt}>{formatAt(item.nextAt, item.timeZone)}</time><small>下次触发</small></> : <small>{item.state === 'paused' ? '暂停中不触发' : '不再触发'}</small>}</span>
      <span className="schedule-row-latest">{latest ? <StatePill label={occurrenceLabel(latest.status, item.action.kind)} tone={OCCURRENCE_STATES[latest.status].tone} spinning={latest.status === 'running'} /> : <small>尚未触发</small>}</span>
    </button>
    <span className="schedule-row-switch">
      {toggleable && <button type="button" role="switch" className="preference-switch" aria-checked={item.state === 'active'} aria-label={`${item.name} 启用`} title={item.state === 'active' ? '暂停安排' : '启用安排'} disabled={locked} onClick={onToggle}><span aria-hidden="true" /></button>}
    </span>
  </div>;
}

function ScheduleDetailView({ detail, locked, historyOffset, onHistory, onClose, onEdit, onControl, onSession, onInbox }: {
  detail: ScheduleDetail; locked: boolean; historyOffset: number; onHistory: (offset: number) => void; onClose: () => void;
  onEdit: () => void; onControl: (operation: ControlSchedule['operation']) => void;
  onSession: (id: string) => void; onInbox: (id: string | null) => void;
}) {
  const { schedule, active: busy, history, preview } = detail;
  const agents = useAgents(), workspaces = useWorkspaces();
  useEffect(() => { if (schedule.action.kind === 'agent') void workspaces.ensureLoaded().catch(() => {}); }, [schedule.action.kind, workspaces.ensureLoaded]);
  const action = schedule.action;
  const project = action.kind === 'agent' && action.projectId ? workspaces.workspaces?.find((workspace) => workspace.project?.projectId === action.projectId)?.project : null;
  const live = schedule.state !== 'deleted';
  const busyLabel = busy && occurrenceLabel(busy.status, action.kind);

  return <section className="schedule-detail" aria-label="安排详情" data-schedule-state={schedule.state} onKeyDown={(event) => {
    // 抽屉内的 Esc 只收起详情，不离开管理页。
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <header className="schedule-detail-header">
      <span className={`schedule-kind ${action.kind}`}><ActionIcon kind={action.kind} /></span>
      <div>
        <h2>{schedule.name}</h2>
        <p>{ACTION_LABELS[action.kind]} · {describeRule(schedule.rule)}{schedule.legacyReminderId ? ' · 由旧提醒迁移' : ''}</p>
      </div>
      <StatePill {...SCHEDULE_STATES[schedule.state]} />
      <TaskIconButton label="关闭安排详情" onClick={onClose}><X /></TaskIconButton>
    </header>

    {live && <div className="schedule-detail-actions">
      {schedule.state !== 'completed' && <button type="button" className="secondary-button compact" disabled={locked} onClick={() => onControl(schedule.state === 'active' ? 'pause' : 'enable')}>{schedule.state === 'active' ? <><Pause aria-hidden="true" />暂停</> : <><Play aria-hidden="true" />启用</>}</button>}
      <button type="button" className="secondary-button compact" disabled={locked} title="不改变原计划的下次时间" onClick={() => onControl('trigger')}><Zap aria-hidden="true" />立即执行一次</button>
      {schedule.state !== 'completed' && <button type="button" className="secondary-button compact" disabled={locked} onClick={onEdit}><Pencil aria-hidden="true" />编辑</button>}
      {/* 删除不会替你停止执行：本轮未结束时先停止或等待结束。 */}
      <button type="button" className="secondary-button compact danger" disabled={locked || !!busy} title={busy ? `这一轮仍${busyLabel}，请先停止本次或等待结束` : undefined} onClick={() => onControl('delete')}><Trash2 aria-hidden="true" />删除</button>
    </div>}

    <div className="schedule-detail-scroll">
      {busy && <ActiveOccurrence occurrence={busy} schedule={schedule} locked={locked} onStop={() => onControl('stop')} onSession={onSession} onInbox={onInbox} />}

      {live && <section className="schedule-section" aria-label="接下来">
        <h3><CalendarClock aria-hidden="true" />接下来</h3>
        {schedule.state === 'paused' ? <p className="schedule-muted">已暂停，不会触发。启用后从未来的时间继续，暂停期间的轮次按“错过的时间”处理。</p>
          : schedule.state === 'completed' || !preview.length ? <p className="schedule-muted">不再触发。</p>
            : <ol className="schedule-upcoming">{preview.map((item, index) => <li key={item.scheduledAt}><time dateTime={item.scheduledAt}>{formatAt(item.scheduledAt, schedule.timeZone)}</time>
              {/* 不重叠：这一轮到时仍未结束，下一次就记为跳过。 */}
              {index === 0 && busy ? <small>本轮仍{busyLabel}时将跳过</small> : item.skipReason && <small>夏令时不存在，将跳过并记录</small>}</li>)}</ol>}
        <p className="schedule-zone"><Globe aria-hidden="true" />{timeZoneLabel(schedule.timeZone)}</p>
      </section>}

      <section className="schedule-section" aria-label="配置">
        <h3>{action.kind === 'agent' ? '执行内容' : '提醒内容'}</h3>
        <blockquote className="schedule-content">{action.kind === 'agent' ? action.instruction : action.text}</blockquote>
        <dl className="schedule-facts">
          {action.kind === 'agent' ? <>
            <Fact label="执行范围">{action.projectId ? `${project?.name ?? action.projectId} · ${action.directory ?? '项目主目录'}` : '独立执行目录'}</Fact>
            <Fact label="智能体">{agents?.agents.some((agent) => agent.agentId === action.agentId && !agent.fixed) ? agentName(agents, action.agentId) : `当前不可用（${action.agentId}），到时会明确失败`}</Fact>
            <Fact label="每次额度">{durationLabel(action.budget.maxMillis)}；输出 {bytesLabel(action.budget.maxOutputBytes)}，最多 {action.budget.maxToolCalls} 次工具调用</Fact>
            <Fact label="每次会话">新建独立会话，不继承上一轮历史</Fact>
            <Fact label="错过时间">{MISSED_POLICIES[schedule.missedPolicy].label}</Fact>
            <Fact label="重叠">上一轮未结束时，本轮记为跳过</Fact>
            <Fact label="结果通知">成功、失败或停止都在 Inbox 生成一条通知，不外发</Fact>
          </> : <>
            <Fact label="通知方式">到点在 Inbox 生成通知；已启用的渠道（如微信）发送副本</Fact>
            <Fact label="错过时间">{MISSED_POLICIES[schedule.missedPolicy].label}</Fact>
          </>}
        </dl>
      </section>

      <section className="schedule-section" aria-label="触发记录">
        <h3>触发记录<span>{history.total} 次</span></h3>
        {history.items.length ? <ol className="schedule-history">{history.items.map((item) => <OccurrenceRow key={item.occurrenceId} item={item} schedule={schedule} onSession={onSession} onInbox={onInbox} />)}</ol>
          : <p className="schedule-muted">还没有触发过。</p>}
        {(historyOffset > 0 || history.nextOffset !== null) && <div className="schedule-pagination"><button type="button" disabled={!historyOffset} onClick={() => onHistory(Math.max(0, historyOffset - HISTORY_SIZE))}>较新记录</button><button type="button" disabled={history.nextOffset === null} onClick={() => onHistory(history.nextOffset!)}>更早记录</button></div>}
      </section>
    </div>
  </section>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

/** 正在占用这一安排的触发：执行中可停止；等待人工处理去 Inbox；结果未知只读核对。 */
function ActiveOccurrence({ occurrence, schedule, locked, onStop, onSession, onInbox }: {
  occurrence: ScheduleOccurrence; schedule: Schedule; locked: boolean;
  onStop: () => void; onSession: (id: string) => void; onInbox: (id: string | null) => void;
}) {
  const meta = OCCURRENCE_STATES[occurrence.status];
  const note = occurrence.status === 'reconcile' ? '执行结果或停止事实尚未确认，安排保持占用。请打开原会话核对；系统不会重放本次或开始新一轮。'
    : occurrence.status === 'waiting' ? '需要你的回应才能继续，等待时间计入本轮时长额度。'
      : occurrence.status === 'stopping' ? '正在停止，确认后释放占用。' : null;
  return <section className={`schedule-active ${meta.tone}`} aria-label="当前这一轮" data-occurrence-status={occurrence.status}>
    <div className="schedule-active-heading">
      {occurrence.status === 'running' ? <LoaderCircle className="spin" aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <strong>{occurrence.source === 'manual' ? '手动执行' : '本轮'} · {occurrenceLabel(occurrence.status, schedule.action.kind)}</strong>
      <time dateTime={occurrence.startedAt ?? occurrence.plannedAt}>{formatAt(occurrence.startedAt ?? occurrence.plannedAt, schedule.timeZone)} 开始</time>
    </div>
    {(occurrence.reason || note) && <p>{occurrence.reason || note}</p>}
    <div className="schedule-active-actions">
      {occurrence.status === 'waiting' && <button type="button" className="secondary-button compact" onClick={() => onInbox(occurrence.notificationId)}><Inbox aria-hidden="true" />去 Inbox 处理</button>}
      {occurrence.sessionId && <button type="button" className="secondary-button compact" onClick={() => onSession(occurrence.sessionId!)}><MessageSquare aria-hidden="true" />{occurrence.status === 'reconcile' ? '进入会话核对' : '查看执行会话'}</button>}
      {['pending', 'running', 'waiting'].includes(occurrence.status) && <button type="button" className="secondary-button compact danger" disabled={locked} onClick={onStop}><Square aria-hidden="true" />停止本次</button>}
    </div>
    {occurrence.status !== 'reconcile' && <small>停止本次只结束这一轮，不暂停安排。</small>}
  </section>;
}

function OccurrenceRow({ item, schedule, onSession, onInbox }: { item: ScheduleOccurrence; schedule: Schedule; onSession: (id: string) => void; onInbox: (id: string | null) => void }) {
  const minutes = item.startedAt && item.endedAt ? Math.max(0, Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 60_000)) : null;
  const text = item.summary || item.reason;
  return <li className="schedule-occurrence" data-occurrence-status={item.status}>
    <div className="schedule-occurrence-head">
      <time dateTime={item.plannedAt}>{formatAt(item.plannedAt, schedule.timeZone)}</time>
      {item.source === 'manual' && <span className="schedule-source">手动</span>}
      <StatePill label={occurrenceLabel(item.status, schedule.action.kind)} tone={OCCURRENCE_STATES[item.status].tone} spinning={item.status === 'running'} />
      {minutes !== null && schedule.action.kind === 'agent' && <span className="schedule-duration">用时 {minutes || '<1'} 分钟</span>}
    </div>
    {text && <p>{text}</p>}
    {(item.sessionId || item.notificationId) && <div className="schedule-occurrence-links">
      {item.sessionId && <button type="button" className="inline-link" onClick={() => onSession(item.sessionId!)}><MessageSquare aria-hidden="true" />执行会话</button>}
      {item.notificationId && <button type="button" className="inline-link" onClick={() => onInbox(item.notificationId)}><Inbox aria-hidden="true" />Inbox 通知</button>}
    </div>}
  </li>;
}
