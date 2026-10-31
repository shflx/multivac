import { Check } from 'typebox/value';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Schedule, type ScheduleDetail, type ScheduleDraft, type ScheduleList, type ScheduleOccurrence, type ControlSchedule, CreateScheduleSchema, UpdateScheduleSchema, ControlScheduleSchema } from '@multivac/contracts';
import { Bell, Bot, Plus, RefreshCw } from 'lucide-react';
import { useConfirm } from '../../components/confirm-card.js';
import { AssistantApiError } from '../../data/assistant-api.js';
import { newCommandId } from '../../data/command-id.js';
import * as api from '../../data/schedules-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { ScheduleEditor } from './schedule-editor.js';
import './schedules.css';

const states = { active: '启用', paused: '暂停', completed: '已结束', deleted: '已删除' };
const statuses: Record<ScheduleOccurrence['status'], string> = {pending:'待执行',running:'执行中',waiting:'等待人工',stopping:'停止中',succeeded:'成功',failed:'失败',stopped:'已停止',skipped:'已跳过',reconcile:'待恢复核对'};
const date = (at: string | null, zone?: string) => at ? new Date(at).toLocaleString('zh-CN', { ...(zone ? {timeZone:zone} : {}), hour12:false }) : '—';
const ruleText = (item: Schedule) => item.rule.kind === 'once' ? `单次 ${item.rule.localTime.replace('T',' ')}` : `${item.rule.kind === 'daily' ? '每日' : `每周 ${item.rule.days.map(d => '日一二三四五六'[d]).join('、')}`} ${item.rule.time}`;
const pendingKey = 'multivac.schedule.pending-command';
function readPending(): api.ScheduleWrite | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    const schema = value?.path === '' ? CreateScheduleSchema : value?.path === '/update' ? UpdateScheduleSchema : value?.path === '/control' ? ControlScheduleSchema : null;
    return schema && Check(schema, value.body) ? value : null;
  } catch { return null; }
}

export function SchedulesPage({active, onSession, onInbox}: {active: boolean; onSession: (id: string) => void; onInbox: (id: string | null) => void}) {
  const [state,setState] = useState('active'), [kind,setKind] = useState(''), [query,setQuery] = useState(''), [offset,setOffset] = useState(0);
  const [page,setPage] = useState<ScheduleList | null>(null), [selected,setSelected] = useState<string | null>(null), [detail,setDetail] = useState<ScheduleDetail | null>(null), [historyOffset,setHistoryOffset] = useState(0);
  const [context,setContext] = useState<Awaited<ReturnType<typeof api.getScheduleContext>> | null>(null), [editor,setEditor] = useState<{schedule: Schedule | null; key: string} | null>(null);
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [pending,setPending] = useState(readPending), [unsavedCommand,setUnsavedCommand] = useState(false);
  const listSeq = useRef(0), detailSeq = useRef(0), lock = useRef(false), confirm = useConfirm();
  const refreshList = useCallback(async () => {
    const seq = ++listSeq.current;
    const params = new URLSearchParams({offset:String(offset),limit:'30'}); if (state) params.set('state',state); if(kind) params.set('kind',kind); if(query.trim()) params.set('query',query.trim());
    try { const result = await api.listSchedules(params); if (seq === listSeq.current) {setPage(result); if(offset && !result.items.length) setOffset(0);} } catch(cause) {if(seq === listSeq.current) setError(message(cause));}
  },[state,kind,query,offset]);
  const refreshDetail = useCallback(async () => {
    const seq = ++detailSeq.current; if (!selected) {setDetail(null);return;}
    try { const result = await api.getSchedule(selected,historyOffset); if(seq === detailSeq.current) {setDetail(result); if(historyOffset && !result.history.items.length) setHistoryOffset(0);} } catch(cause) {if(seq === detailSeq.current) setError(message(cause));}
  },[selected,historyOffset]);
  const refresh = useCallback(async () => { await Promise.all([refreshList(),refreshDetail()]); },[refreshList,refreshDetail]);
  useEffect(() => { if(!active) return; void refresh(); return () => {listSeq.current++;detailSeq.current++;}; },[active,refresh]);
  useEffect(() => { if(!active) return; let live=true; void api.getScheduleContext(Intl.DateTimeFormat().resolvedOptions().timeZone).then(c => {if(live) setContext(c);}).catch(cause => {if(live) setError(message(cause));}); return () => {live=false;}; },[active]);
  useWorkbenchEvents(event => { if(active && (event.type === 'schedules.changed' || event.type === 'workbench.connected')) void refresh(); });
  async function discard(): Promise<boolean> { return !editor || confirm({title:'放弃当前编辑？',description:'未保存的安排内容将丢失。',tone:'danger',confirmLabel:'放弃编辑'}); }
  async function select(id: string) { if(!await discard()) return; setEditor(null);setDetail(null);setSelected(id);setHistoryOffset(0); }
  function clearPending() {sessionStorage.removeItem(pendingKey);setPending(null);setUnsavedCommand(false);}
  async function write(command: api.ScheduleWrite) {
    if(lock.current) return; lock.current=true;setBusy(true);setError('');
    try {
      // 请求前保存完整命令。连接中断后先查回执，不能另造身份重放副作用。
      sessionStorage.setItem(pendingKey,JSON.stringify(command));setPending(command);setUnsavedCommand(false);
      const result = await api.writeSchedule(command);clearPending();setEditor(null);setDetail(null);setSelected(result.scheduleId);setHistoryOffset(0);await refresh();
    } catch(cause) {
      if(cause instanceof AssistantApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) clearPending();
      setError(message(cause));throw cause;
    } finally {lock.current=false;setBusy(false);}
  }
  async function reconcile() {
    if(!pending || lock.current) return; lock.current=true;setBusy(true);setError('');
    try { const receipt = await api.reconcileSchedule(pending.body.commandId); if(receipt.saved) {clearPending();setEditor(null);if(receipt.result) setSelected(receipt.result.scheduleId);await refresh();} else {setUnsavedCommand(true);setError('尚无原命令回执。可再核对，或使用原命令身份重试。');} }
    catch(cause) {setError(message(cause));} finally {lock.current=false;setBusy(false);}
  }
  async function save(draft: ScheduleDraft) { if(pending) return; await write(editor?.schedule ? {path:'/update',body:{...draft,scheduleId:editor.schedule.scheduleId,revision:editor.schedule.revision,commandId:newCommandId()}} : {path:'',body:{...draft,commandId:newCommandId()}}); }
  async function control(operation: ControlSchedule['operation']) {
    if(!detail || pending || busy) return;
    const descriptions = { pause:'只阻止后续开始；当前轮次继续执行。',enable:'重新计算下次计划时间。',trigger:'新增一次手动触发；原定计划时间保持不变。同安排有未结束轮次时将记录跳过。',stop:'只停止当前轮次，后续计划保持不变。停止事实未确认时保留占用。',delete:'删除后不再触发；历史、会话和通知仍保留。' };
    const titles = {pause:'暂停安排',enable:'启用安排',trigger:'立即执行一次',stop:'停止本次',delete:'删除安排'};
    if(!await confirm({title:titles[operation],description:descriptions[operation],confirmLabel:titles[operation],tone:operation === 'delete' || operation === 'stop' ? 'danger' : 'default'})) return;
    try {await write({path:'/control',body:{scheduleId:detail.schedule.scheduleId,revision:detail.schedule.revision,operation,commandId:newCommandId()}});} catch { /* 页面保留错误和原命令供核对。 */ }
  }
  const current = detail?.schedule;
  return <div className="schedules-page" data-management-page="schedules">
    <div className="schedule-toolbar"><p>统一管理提醒与 Agent 定时执行</p><button className="secondary-button" onClick={() => {setError('');void refresh();}} aria-label="刷新安排"><RefreshCw size={16}/></button><button className="primary-button" disabled={!context || busy || !!pending} onClick={() => {void discard().then(ok => {if(ok) setEditor({schedule:null,key:newCommandId()});});}}><Plus size={16}/>新建安排</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {pending && <div className="schedule-pending" role="status">上次操作尚待核对（{pending.body.commandId}）。<button className="secondary-button" disabled={busy} onClick={() => void reconcile()}>核对上次操作</button>{unsavedCommand && <button className="secondary-button" disabled={busy} onClick={() => void write(pending).catch(() => {})}>重试原命令</button>}</div>}
    <div className="schedule-filters"><div role="group" aria-label="安排状态">{Object.entries(states).map(([value,label]) => <button className="secondary-button" aria-pressed={state === value} key={value} onClick={() => {setState(value);setOffset(0);}}>{label}</button>)}<button className="secondary-button" aria-pressed={state === ''} onClick={() => {setState('');setOffset(0);}}>全部</button></div><label>类型<select value={kind} onChange={e => {setKind(e.target.value);setOffset(0);}}><option value="">全部类型</option><option value="reminder">提醒</option><option value="agent">Agent 执行</option></select></label><input type="search" aria-label="搜索安排" placeholder="搜索安排名称" maxLength={200} value={query} onChange={e => {setQuery(e.target.value);setOffset(0);}} /></div>
    <div className="schedule-columns"><section className="schedule-list" aria-label="安排列表">
      {!page && <p role="status">正在读取安排…</p>}{page && !page.items.length && <p className="schedule-empty">当前筛选下没有安排</p>}
      {page?.items.map(item => {const Icon = item.action.kind === 'reminder' ? Bell : Bot;return <button key={item.scheduleId} className="schedule-list-item" aria-pressed={selected === item.scheduleId && !editor} onClick={() => void select(item.scheduleId)}><Icon size={18}/><span><strong>{item.name}</strong><small>{item.action.kind === 'agent' ? 'Agent 执行' : '提醒'} · {states[item.state]}</small><small>{ruleText(item)} · {item.timeZone}</small><small>下次 {date(item.nextAt,item.timeZone)}</small><small>最近：{item.latest ? statuses[item.latest.status] : '尚未触发'}</small></span></button>;})}
      {page && <div className="schedule-pagination"><small>共 {page.total} 项</small><button disabled={!offset} onClick={() => setOffset(Math.max(0,offset-30))}>上一页</button><button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>下一页</button></div>}
    </section><section className="schedule-detail" aria-label="安排详情">
      {editor && context ? <ScheduleEditor key={editor.key} schedule={editor.schedule} context={context} disabled={busy || !!pending} onSave={save} onCancel={() => {void discard().then(ok => {if(ok) setEditor(null);});}}/> : current ? <>
        <header><h2>{current.name}</h2><span className="schedule-state">{states[current.state]} · {current.action.kind === 'agent' ? 'Agent 执行' : '提醒'}</span></header>
        <p className="schedule-content">{current.action.kind === 'reminder' ? current.action.text : current.action.instruction}</p>
        <dl className="schedule-facts"><dt>时间规则</dt><dd>{ruleText(current)} · {current.timeZone}</dd><dt>下次触发</dt><dd>{date(current.nextAt,current.timeZone)}</dd><dt>错过策略</dt><dd>{current.missedPolicy === 'latest' ? '仅补最近一次' : '跳过'}</dd><dt>版本</dt><dd>{current.revision}</dd>{current.action.kind === 'agent' && <><dt>智能体 / 项目</dt><dd>{current.action.agentId} / {current.action.projectId ?? '无项目'}</dd><dt>目录</dt><dd>{current.action.directory ?? '运行前解析当前默认目录'}</dd><dt>每轮额度</dt><dd>{current.action.budget.maxMillis} 毫秒 · {current.action.budget.maxOutputBytes} 字节 · {current.action.budget.maxToolCalls} 次工具调用</dd></>}</dl>
        {current.state !== 'deleted' && <div className="schedule-actions"><button className="secondary-button" disabled={busy || !!pending} onClick={() => setEditor({schedule:current,key:newCommandId()})}>编辑安排</button><button className="secondary-button" disabled={busy || !!pending} onClick={() => void control(current.state === 'active' ? 'pause' : 'enable')}>{current.state === 'active' ? '暂停安排' : '启用安排'}</button><button className="primary-button" disabled={busy || !!pending || !!detail.active} onClick={() => void control('trigger')}>立即执行</button>{detail.active && <button className="secondary-button danger" disabled={busy || !!pending || ['reconcile','stopping'].includes(detail.active.status)} onClick={() => void control('stop')}>停止本次</button>}<button className="secondary-button danger" disabled={busy || !!pending || !!detail.active} onClick={() => void control('delete')}>删除安排</button></div>}
        {detail.active && <div className="schedule-current"><h3>当前轮次 · {statuses[detail.active.status]}</h3>{detail.active.status === 'reconcile' && <p>执行结果或停止事实尚未确认，安排保持占用。请打开原会话核对；系统不会重放本次或继续重叠执行。</p>}{detail.active.status === 'waiting' && <p>请到 Inbox 回应；等待计入本轮时长额度。</p>}<Occurrence item={detail.active} zone={current.timeZone} onSession={onSession} onInbox={onInbox}/></div>}
        {!!detail.preview.length && <section className="schedule-preview"><h3>后续预览</h3>{detail.preview.map(p => <p key={p.scheduledAt}>{p.localTime.replace('T',' ')} · {current.timeZone}<small>UTC {p.scheduledAt}{p.skipReason && ' · DST 缺失，将跳过并记录'}</small></p>)}</section>}
        <section><h3>触发历史 <small>{detail.history.total} 次</small></h3>{!detail.history.items.length && <p className="muted">尚无触发记录</p>}{detail.history.items.map(item => <Occurrence key={item.occurrenceId} item={item} zone={current.timeZone} onSession={onSession} onInbox={onInbox}/>)}<div className="schedule-pagination"><button disabled={!historyOffset} onClick={() => setHistoryOffset(Math.max(0,historyOffset-20))}>历史上一页</button><button disabled={detail.history.nextOffset === null} onClick={() => setHistoryOffset(detail.history.nextOffset!)}>历史下一页</button></div></section>
      </> : <p className="schedule-empty">选择安排查看详情，或新建一个安排</p>}
    </section></div><p className="schedule-limitation">服务关闭或系统休眠时不执行。默认跳过离线错过的触发；旧单次提醒按原承诺补发。同安排不重叠，结果未知时保留核对状态。Agent 结果只进入 Inbox。</p>
  </div>;
}
function message(cause: unknown) {return cause instanceof Error ? cause.message : '读取或保存安排失败。';}
function Occurrence({item,zone,onSession,onInbox}: {item: ScheduleOccurrence;zone:string;onSession:(id:string)=>void;onInbox:(id:string | null)=>void}) {
  return <article className="schedule-occurrence" data-occurrence-status={item.status}><div><strong>{statuses[item.status]}</strong> · {item.source === 'manual' ? '手动' : '计划'} · 版本 {item.scheduleRevision}</div><small>计划 {date(item.plannedAt,zone)} · {zone}</small><small>开始 {date(item.startedAt,zone)} · 结束 {date(item.endedAt,zone)}</small>{item.reason && <p>{item.reason}</p>}{item.summary && <p className="schedule-content">{item.summary}</p>}<div className="schedule-actions">{item.sessionId && <button className="secondary-button" onClick={() => onSession(item.sessionId!)}>打开执行会话</button>}{item.notificationId && <button className="secondary-button" onClick={() => onInbox(item.notificationId!)}>查看 Inbox</button>}{item.status === 'waiting' && !item.notificationId && <button className="secondary-button" onClick={() => onInbox(null)}>前往 Inbox 回应</button>}</div><details><summary>本次固定快照</summary><pre>{JSON.stringify({occurrenceId:item.occurrenceId,snapshot:item.snapshot,execution:item.executionSnapshot},null,2)}</pre></details></article>;
}
