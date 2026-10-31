import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check } from 'typebox/value';
import { ScheduleDraftSchema, previewSchedule, scheduleLocalInstants, validateScheduleRule, type Schedule, type ScheduleDraft } from '@multivac/contracts';
import { useAgents } from '../agents/use-agents.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { getScheduleContext } from '../../data/schedules-api.js';

const weekdays = ['日','一','二','三','四','五','六'];
type Context = Awaited<ReturnType<typeof getScheduleContext>>;
export function ScheduleEditor({ schedule, context, disabled, onSave, onCancel }: {schedule: Schedule | null; context: Context; disabled: boolean; onSave: (draft: ScheduleDraft) => Promise<void>; onCancel: () => void}) {
  const agents = useAgents(), workspaces = useWorkspaces();
  useEffect(() => { void workspaces.ensureLoaded().catch(() => {}); }, [workspaces.ensureLoaded]);
  const [name, setName] = useState(schedule?.name ?? ''), [kind, setKind] = useState(schedule?.action.kind ?? 'reminder');
  const [text, setText] = useState(schedule ? schedule.action.kind === 'reminder' ? schedule.action.text : schedule.action.instruction : '');
  const [zone, setZone] = useState(schedule?.timeZone ?? context.timeZone ?? ''), [ruleKind, setRuleKind] = useState(schedule?.rule.kind ?? 'daily');
  const [time, setTime] = useState(schedule?.rule.kind !== 'once' ? schedule?.rule.time ?? '09:00' : '09:00');
  const [local, setLocal] = useState(schedule?.rule.kind === 'once' ? schedule.rule.localTime.slice(0,16) : (context.localTime ?? '').slice(0,16));
  const [instant, setInstant] = useState(schedule?.rule.kind === 'once' ? schedule.rule.scheduledAt : '');
  const [days, setDays] = useState(schedule?.rule.kind === 'weekly' ? schedule.rule.days : [1,2,3,4,5]);
  const [missed, setMissed] = useState(schedule?.missedPolicy ?? 'skip');
  const agent = schedule?.action.kind === 'agent' ? schedule.action : null;
  const [agentId, setAgentId] = useState(agent?.agentId ?? context.defaultAgentId), [projectId, setProjectId] = useState(agent?.projectId ?? '');
  const [directory, setDirectory] = useState(agent?.directory ?? '');
  const [budget, setBudget] = useState(agent?.budget ?? context.defaultBudget), [error, setError] = useState('');
  const candidates = useMemo(() => { try { return scheduleLocalInstants((local.length === 16 ? `${local}:00` : local), zone); } catch { return []; } }, [local,zone]);
  const built = useMemo(() => {
    try {
      // 以服务端返回时间为基准，避免浏览器时钟偏差改变近期预览。
      const now = new Date(Date.parse(context.currentTime) + Date.now() - context.receivedAt);
      const rule = ruleKind === 'once' ? { kind: 'once' as const, localTime: (local.length === 16 ? `${local}:00` : local), scheduledAt: candidates.length === 1 ? candidates[0]! : candidates.includes(instant) ? instant : '' }
        : ruleKind === 'daily' ? {kind: 'daily' as const, time} : {kind: 'weekly' as const, time, days};
      if (rule.kind === 'once' && !rule.scheduledAt) throw new Error(candidates.length ? '此时刻重复，请明确选择 UTC 时间。' : '此当地时刻不存在，请调整日期或时间。');
      validateScheduleRule(rule, zone, now);
      const draft: ScheduleDraft = { name, timeZone: zone, rule, missedPolicy: missed, action: kind === 'reminder' ? {kind, text} : { kind, instruction: text, agentId, projectId: projectId || null, directory: directory || null, budget } };
      return { draft, preview: previewSchedule(rule, zone, now), error: '' };
    } catch (cause) { return {draft: null, preview: [], error: cause instanceof Error ? cause.message : '规则无效。'}; }
  }, [name,zone,ruleKind,local,candidates,instant,time,days,missed,kind,text,agentId,projectId,directory,budget,context]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!built.draft || !Check(ScheduleDraftSchema, built.draft) || !name.trim() || !text.trim()) { setError(built.error || '请填写名称、内容及有效的有限额度。'); return; }
    try { await onSave(built.draft); } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
  }
  return <form className="schedule-editor" onSubmit={event => void submit(event)} aria-label={schedule ? '编辑安排' : '新建安排'}>
    <h2>{schedule ? '编辑安排' : '新建安排'}</h2>
    <fieldset disabled={disabled}><label>名称<input autoFocus required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>动作类型<select value={kind} disabled={!!schedule} onChange={e => setKind(e.target.value as typeof kind)}><option value="reminder">提醒</option><option value="agent">Agent 执行</option></select></label>
      <label>{kind === 'reminder' ? '提醒内容' : '执行指令'}<textarea required maxLength={16000} rows={5} value={text} onChange={e => setText(e.target.value)} /></label>
      {kind === 'agent' && <>
        <label>智能体<select value={agentId} onChange={e => setAgentId(e.target.value)}>{!agents?.agents.some(a => a.agentId === agentId && !a.fixed) && <option value={agentId} disabled>当前智能体不可用（{agentId}）</option>}{agents?.agents.filter(a => !a.fixed).map(a => <option value={a.agentId} key={a.agentId}>{a.name}</option>)}</select></label>
        <label>所属项目<select value={projectId} onChange={e => { setProjectId(e.target.value); setDirectory(''); }}><option value="">无项目（每轮独立目录）</option>{workspaces.workspaces?.filter(w => w.project).map(w => <option key={w.workspaceId} value={w.project!.projectId}>{w.name}</option>)}</select></label>
        <label>执行目录<input disabled={!projectId} value={directory} placeholder="留空使用执行时的项目主目录" onChange={e => setDirectory(e.target.value)} /></label>
        <div className="schedule-budget">{([['maxMillis','最长时长（毫秒）',1000,86400000],['maxOutputBytes','最大输出（字节）',1024,67108864],['maxToolCalls','最多工具调用',1,1000]] as const).map(([key,label,min,max]) => <label key={key}>{label}<input type="number" required min={min} max={max} value={budget[key]} onChange={e => setBudget({...budget,[key]: Number(e.target.value)})} /></label>)}</div>
        <p className="muted">每轮新建独立会话；等待人工也计入时长。结果进入 Inbox，沿用当前目录与工具授权。</p>
      </>}
      <div className="schedule-rule"><label>频率<select value={ruleKind} onChange={e => setRuleKind(e.target.value as typeof ruleKind)}><option value="once">单次</option><option value="daily">每日</option><option value="weekly">每周</option></select></label>
        <label>IANA 时区<input required value={zone} placeholder="Asia/Shanghai" onChange={e => { setZone(e.target.value); setInstant(''); }} /></label>
        {ruleKind === 'once' ? <label>当地日期与时间<input type="datetime-local" step={1} required value={local} onChange={e => {setLocal(e.target.value);setInstant('');}} /></label> : <label>当地时间<input type="time" required value={time} onChange={e => setTime(e.target.value)} /></label>}
      </div>
      {ruleKind === 'once' && candidates.length > 1 && <label>重复时刻的 UTC 时间<select required value={instant} onChange={e => setInstant(e.target.value)}><option value="">请选择明确偏移</option>{candidates.map(at => <option key={at} value={at}>{at}</option>)}</select></label>}
      {ruleKind === 'weekly' && <fieldset className="schedule-weekdays"><legend>星期</legend>{weekdays.map((day,i) => <label key={i}><input type="checkbox" checked={days.includes(i)} onChange={e => setDays(e.target.checked ? [...days,i].sort() : days.filter(d => d !== i))} />周{day}</label>)}</fieldset>}
      <label>错过时间<select value={missed} onChange={e => setMissed(e.target.value as typeof missed)}><option value="skip">跳过</option><option value="latest">仅补最近一次</option></select></label>
      <div className="schedule-preview"><strong>接下来三次（{zone}）</strong>{built.error ? <p role="status">{built.error}</p> : built.preview.map(p => <div key={p.scheduledAt}>{p.localTime.replace('T',' ')} <small>UTC {p.scheduledAt}{p.skipReason && ' · DST 缺失，将跳过并记录'}</small></div>)}</div>
      <p className="muted">服务关闭或系统休眠时不执行；周期重复时刻固定取较早偏移。编辑只影响后续，当前轮次保留原快照。</p>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="schedule-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={onCancel}>取消编辑</button><button className="primary-button" disabled={disabled || !built.draft}>{disabled ? '正在处理…' : '保存安排'}</button></div>
  </form>;
}
