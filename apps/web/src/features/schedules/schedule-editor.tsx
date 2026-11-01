import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'typebox/value';
import { Bell, Bot, Clock, Folder, FolderOpen, Globe, LoaderCircle, Timer, UserCog, X } from 'lucide-react';
import { ScheduleDraftSchema, previewSchedule, scheduleLocalInstants, validateScheduleRule, type Schedule, type ScheduleDraft } from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import type { getScheduleContext } from '../../data/schedules-api.js';
import { useAgents } from '../agents/use-agents.js';
import { TaskFilter } from '../tasks/task-filter.js';
import { TaskIconButton } from '../tasks/task-icon-button.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { ACTION_LABELS, MISSED_POLICIES, WEEKDAY_LABELS, WEEK_ORDER, budgetOptions, durationLabel, formatAt, nextWholeHour, timeZoneLabel, timeZoneOptions } from './schedule-format.js';

type Context = Awaited<ReturnType<typeof getScheduleContext>>;
type Kind = ScheduleDraft['action']['kind'];
type RuleKind = ScheduleDraft['rule']['kind'];

/** 表单字段；提交时再组装成契约里的草稿，切换类型或频率不丢已填内容。 */
interface Form {
  name: string; kind: Kind; text: string; zone: string;
  ruleKind: RuleKind; date: string; time: string; days: number[]; instant: string;
  missed: ScheduleDraft['missedPolicy'];
  agentId: string; projectId: string; directory: string; budget: Extract<ScheduleDraft['action'], { kind: 'agent' }>['budget'];
}

function initialForm(schedule: Schedule | null, context: Context): Form {
  const rule = schedule?.rule;
  const agent = schedule?.action.kind === 'agent' ? schedule.action : null;
  const once = rule?.kind === 'once' ? { date: rule.localTime.slice(0, 10), time: rule.localTime.slice(11, 19).replace(/:00$/, '') } : nextWholeHour(context.localTime);
  return {
    name: schedule?.name ?? '', kind: schedule?.action.kind ?? 'reminder',
    text: !schedule ? '' : schedule.action.kind === 'reminder' ? schedule.action.text : schedule.action.instruction,
    zone: schedule?.timeZone ?? context.timeZone ?? 'UTC',
    ruleKind: rule?.kind ?? 'daily', date: once.date,
    time: rule && rule.kind !== 'once' ? rule.time : rule?.kind === 'once' ? once.time : '09:00',
    days: rule?.kind === 'weekly' ? rule.days : [1, 2, 3, 4, 5],
    instant: rule?.kind === 'once' ? rule.scheduledAt : '',
    missed: schedule?.missedPolicy ?? 'skip',
    agentId: agent?.agentId ?? context.defaultAgentId, projectId: agent?.projectId ?? '', directory: agent?.directory ?? '',
    budget: agent?.budget ?? context.defaultBudget,
  };
}

/** 新建与编辑共用的弹窗：保存只影响之后的触发，已有记录保留当时的快照。 */
export function ScheduleEditor({ schedule, context, disabled, onSave, onClose }: {
  schedule: Schedule | null; context: Context; disabled: boolean;
  onSave: (draft: ScheduleDraft) => Promise<void>; onClose: () => void;
}) {
  const agents = useAgents(), workspaces = useWorkspaces(), confirm = useConfirm();
  useEffect(() => { void workspaces.ensureLoaded().catch(() => {}); }, [workspaces.ensureLoaded]);
  const [initial] = useState(() => initialForm(schedule, context));
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [opener] = useState(() => document.activeElement);
  const titleId = useId();
  const set = (patch: Partial<Form>) => { setForm((current) => ({ ...current, ...patch })); setError(''); };
  const editing = !!schedule;
  const agentAction = form.kind === 'agent';

  useEffect(() => {
    const element = dialog.current;
    nameInput.current?.focus();
    return () => {
      // StrictMode 的模拟卸载仍保留节点，不提前归还焦点。
      if (element?.isConnected) return;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  const localTime = `${form.date}T${form.time.length === 5 ? `${form.time}:00` : form.time}`;
  const candidates = useMemo(() => {
    if (form.ruleKind !== 'once') return [];
    try { return scheduleLocalInstants(localTime, form.zone); } catch { return []; }
  }, [form.ruleKind, localTime, form.zone]);

  // 以服务端返回时间为基准，避免浏览器时钟偏差改变近期预览。
  const serverNow = () => new Date(Date.parse(context.currentTime) + Date.now() - context.receivedAt);
  const now = serverNow();
  const built = useMemo(() => {
    const now = serverNow();
    try {
      const rule: ScheduleDraft['rule'] = form.ruleKind === 'once'
        ? { kind: 'once', localTime, scheduledAt: candidates.length === 1 ? candidates[0]! : candidates.includes(form.instant) ? form.instant : '' }
        : form.ruleKind === 'daily' ? { kind: 'daily', time: form.time } : { kind: 'weekly', time: form.time, days: form.days };
      if (form.ruleKind === 'weekly' && !form.days.length) throw new Error('请至少选择一个星期几。');
      if (rule.kind === 'once' && !rule.scheduledAt) throw new Error(candidates.length ? '这个当地时刻因夏令时出现两次，请选择其中一次。' : '这个当地时刻因夏令时不存在，请调整日期或时间。');
      validateScheduleRule(rule, form.zone, now);
      const action: ScheduleDraft['action'] = form.kind === 'reminder' ? { kind: 'reminder', text: form.text.trim() }
        : { kind: 'agent', instruction: form.text.trim(), agentId: form.agentId, projectId: form.projectId || null, directory: form.projectId && form.directory ? form.directory : null, budget: form.budget };
      const draft: ScheduleDraft = { name: form.name.trim(), timeZone: form.zone, rule, missedPolicy: form.missed, action };
      return { draft, preview: previewSchedule(rule, form.zone, now), error: '' };
    } catch (cause) {
      return { draft: null, preview: [], error: cause instanceof Error ? cause.message : '时间规则无效。' };
    }
  }, [form, localTime, candidates, context]);

  const problem = !form.name.trim() ? '请填写名称。'
    : !form.text.trim() ? (agentAction ? '请填写要执行的指令。' : '请填写提醒内容。')
      : built.error || (built.draft && !Check(ScheduleDraftSchema, built.draft) ? '内容超出长度或额度无效。' : '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (problem || !built.draft || disabled) return;
    try { await onSave(built.draft); } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
  }

  async function requestClose() {
    if (disabled) return;
    if (JSON.stringify(form) !== JSON.stringify(initial) && !await confirm({ title: '放弃当前编辑？', description: '未保存的安排内容将丢失。', tone: 'danger', confirmLabel: '放弃编辑' })) return;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // 弹窗内的快捷键不触发管理导航；下拉菜单优先处理自己的 Esc。
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      void requestClose();
    } else if (event.key === 'Tab') {
      const items = focusableWithin(event.currentTarget);
      const next = wrapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (next !== null) { event.preventDefault(); (items[next] ?? dialog.current)?.focus(); }
    }
  }

  function toggleDay(day: number) {
    set({ days: form.days.includes(day) ? form.days.filter((item) => item !== day) : [...form.days, day].sort() });
  }

  const projects = workspaces.workspaces?.filter((workspace) => workspace.project).map((workspace) => workspace.project!) ?? [];
  const project = projects.find((item) => item.projectId === form.projectId);
  const usableAgents = agents?.agents.filter((agent) => !agent.fixed) ?? [];
  const agentOptions = [
    ...(usableAgents.some((agent) => agent.agentId === form.agentId) ? [] : [{ id: form.agentId, label: `当前智能体不可用（${form.agentId}）`, disabled: true }]),
    ...usableAgents.map((agent) => ({ id: agent.agentId, label: agent.name })),
  ];
  const projectOptions = [
    { id: '', label: '不属于项目', description: '每轮使用独立执行目录' },
    ...(form.projectId && !project ? [{ id: form.projectId, label: `项目不可用（${form.projectId}）`, disabled: true }] : []),
    ...projects.map((item, index) => ({ id: item.projectId, label: item.name, divider: index === 0 })),
  ];
  const directories = project?.directories.map((item) => item.path) ?? [];
  const directoryOptions = [
    { id: '', label: '项目主目录', description: '执行时按项目当前的主目录解析' },
    ...[...new Set([...directories.slice(1), ...(form.directory && !directories.slice(1).includes(form.directory) ? [form.directory] : [])])].map((path) => ({ id: path, label: path })),
  ];

  return createPortal(<div className="confirm-scrim task-create-scrim" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => {
    if (event.target === event.currentTarget) { event.preventDefault(); void requestClose(); }
  }}>
    <div ref={dialog} className="task-create-dialog schedule-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={disabled || undefined} tabIndex={-1} onKeyDown={handleKeyDown}>
      <form noValidate onSubmit={(event) => void submit(event)}>
        <header><div><h2 id={titleId}>{editing ? '编辑安排' : '新建安排'}</h2><p>到点提醒你，或在独立会话里执行一段指令。</p></div><TaskIconButton label="关闭" disabled={disabled} onClick={() => void requestClose()}><X /></TaskIconButton></header>

        <fieldset className="schedule-editor-body" disabled={disabled}>
          <label className="schedule-field"><span>名称</span><input ref={nameInput} maxLength={200} value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="例如：检查依赖安全公告" /></label>

          <div className="schedule-field"><span>到时做什么</span>
            <div className="segmented" role="radiogroup" aria-label="动作类型">
              {(Object.keys(ACTION_LABELS) as Kind[]).map((kind) => {
                const Icon = kind === 'agent' ? Bot : Bell;
                return <button key={kind} type="button" role="radio" aria-checked={form.kind === kind} className={form.kind === kind ? 'active' : ''} disabled={editing} onClick={() => set({ kind })}><Icon aria-hidden="true" />{ACTION_LABELS[kind]}</button>;
              })}
            </div>
            <small>{agentAction ? '每轮新建独立会话执行指令，结果进入 Inbox；不会创建待办任务。' : '只在 Inbox 生成通知，不调用模型。'}{editing ? ' 动作类型创建后不能更改。' : ''}</small>
          </div>

          {agentAction ? <>
            <label className="schedule-field"><span>指令</span><textarea rows={3} maxLength={16000} value={form.text} onChange={(event) => set({ text: event.target.value })} placeholder="写清楚要做什么、产出放在哪里、哪些事不要做" /></label>
            <div className="schedule-field-row">
              <div className="schedule-field"><span>执行范围</span><TaskFilter label="执行范围" name="执行范围" icon={Folder} appearance="field" disabled={disabled} value={form.projectId} options={projectOptions} onChange={(projectId) => set({ projectId, directory: '' })} /></div>
              <div className="schedule-field"><span>智能体</span><TaskFilter label="智能体" name="智能体" icon={UserCog} appearance="field" disabled={disabled} value={form.agentId} options={agentOptions} onChange={(agentId) => set({ agentId })} /></div>
            </div>
            {form.projectId && directoryOptions.length > 1 && <div className="schedule-field"><span>执行目录</span><TaskFilter label="执行目录" name="执行目录" icon={FolderOpen} appearance="field" disabled={disabled} value={form.directory} options={directoryOptions} onChange={(directory) => set({ directory })} /></div>}
            <div className="schedule-field"><span>每次执行时长上限</span>
              <TaskFilter label="时长上限" name="每次执行时长上限" icon={Timer} appearance="field" disabled={disabled} value={String(form.budget.maxMillis)} options={budgetOptions(form.budget.maxMillis).map((millis) => ({ id: String(millis), label: durationLabel(millis) }))} onChange={(value) => set({ budget: { ...form.budget, maxMillis: Number(value) } })} />
              <small>用完即停止这一轮并通知你，不会自动加额度；等待你回应的时间也计入时长。</small>
            </div>
          </> : <label className="schedule-field"><span>提醒内容</span><textarea rows={2} maxLength={16000} value={form.text} onChange={(event) => set({ text: event.target.value })} placeholder="到时提醒你的内容" /></label>}

          <div className="schedule-field"><span>什么时候</span>
            <div className="segmented" role="radiogroup" aria-label="重复方式">
              {([['once', '单次'], ['daily', '每天'], ['weekly', '每周']] as const).map(([kind, label]) => <button key={kind} type="button" role="radio" aria-checked={form.ruleKind === kind} className={form.ruleKind === kind ? 'active' : ''} onClick={() => set({ ruleKind: kind })}>{label}</button>)}
            </div>
          </div>
          <div className="schedule-field-row">
            {form.ruleKind === 'once' && <label className="schedule-field"><span>日期</span><input type="date" value={form.date} onChange={(event) => set({ date: event.target.value, instant: '' })} /></label>}
            <label className="schedule-field"><span>时间</span><input type="time" value={form.time} onChange={(event) => set({ time: event.target.value, instant: '' })} /></label>
            <div className="schedule-field"><span>时区</span><TaskFilter label="时区" name="时区" icon={Globe} appearance="field" disabled={disabled} value={form.zone} options={timeZoneOptions(initial.zone, context.timeZone).map((zone) => ({ id: zone, label: timeZoneLabel(zone) }))} onChange={(zone) => set({ zone, instant: '' })} /></div>
          </div>
          {form.ruleKind === 'weekly' && <div className="schedule-weekdays" role="group" aria-label="星期几">
            {WEEK_ORDER.map((day) => <button key={day} type="button" aria-pressed={form.days.includes(day)} className={form.days.includes(day) ? 'active' : ''} onClick={() => toggleDay(day)}>{WEEKDAY_LABELS[day]}</button>)}
          </div>}
          {form.ruleKind === 'once' && candidates.length > 1 && <div className="schedule-field"><span>重复的当地时刻</span>
            <div className="segmented" role="radiogroup" aria-label="重复的当地时刻">
              {candidates.map((at, index) => <button key={at} type="button" role="radio" aria-checked={form.instant === at} className={form.instant === at ? 'active' : ''} title={at} onClick={() => set({ instant: at })}>{index === 0 ? '较早一次' : '较晚一次'}</button>)}
            </div>
            <small>夏令时切换使这个时刻出现两次，请选择其中一次。</small>
          </div>}

          <div className="schedule-field"><span>错过的时间</span>
            <div className="schedule-radio-list">
              {(Object.keys(MISSED_POLICIES) as Form['missed'][]).map((id) => <label key={id} className={form.missed === id ? 'selected' : ''}><input type="radio" name="missed-policy" checked={form.missed === id} onChange={() => set({ missed: id })} /><span><strong>{MISSED_POLICIES[id].label}</strong><small>{MISSED_POLICIES[id].hint}</small></span></label>)}
            </div>
          </div>

          <section className="schedule-preview" aria-label="触发预览">
            <h3><Clock aria-hidden="true" />{form.ruleKind === 'once' ? '将在' : '接下来 3 次'}</h3>
            {built.preview.length ? <ol>{built.preview.map((item) => <li key={item.scheduledAt}><time dateTime={item.scheduledAt}>{formatAt(item.scheduledAt, form.zone, now)}</time>{item.skipReason && <small>夏令时不存在，将跳过并记录</small>}</li>)}</ol>
              : <p role="status">{built.error || '没有可触发的时间。'}</p>}
            <p className="schedule-preview-note">{agentAction ? '同一安排上一轮未结束时，本轮记为跳过；' : ''}服务关闭或系统休眠时不执行，按“错过的时间”处理。</p>
          </section>
        </fieldset>

        {(touched && problem || error) && <p className="schedule-problem" role="alert">{error || problem}</p>}
        <footer>
          {editing && <span className="schedule-editor-hint">保存后只影响之后的触发</span>}
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => void requestClose()}>取消</button>
          <button type="submit" className="primary-button" disabled={disabled}>{disabled && <LoaderCircle className="spin" aria-hidden="true" />}{editing ? '保存' : '保存并启用'}</button>
        </footer>
      </form>
    </div>
  </div>, document.body);
}
