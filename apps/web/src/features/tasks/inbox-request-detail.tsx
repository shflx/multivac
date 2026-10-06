import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Type } from 'typebox';
import { InboxItemSchema, type DecideHumanRequest, type InboxItem } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { approvedDetail, authorizationDeadline, AUTHORIZATION_OUTCOMES, AUTHORIZATION_TOOL_ACTIONS, GRANT_REVOKE_PLACES } from '../assistant/tool-authorizations.js';
import { ArtifactPreview } from './artifact-preview.js';
import { useTaskRequests } from './task-requests-provider.js';

export const INBOX_LABELS: Record<InboxItem['kind'], string> = { clarification: '澄清', authorization: '目录授权', external: '外发授权', review: '成果验收', recovery: '恢复确认' };

function Facts({ entries }: { entries: [string, ReactNode][] }) {
  return <dl className="inbox-facts">{entries.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

interface Choice { value: string; label: string; description: string; disabled?: boolean }
function DecisionOptions({ legend, choices, value, onChange, disabled }: { legend: string; choices: Choice[]; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const name = useId();
  return <fieldset className="inbox-decision-options" disabled={disabled}><legend>{legend}</legend>{choices.map(choice => <label key={choice.value} className={`inbox-decision-option${value === choice.value ? ' selected' : ''}${choice.disabled ? ' unavailable' : ''}`}>
    <input type="radio" name={name} value={choice.value} checked={value === choice.value} disabled={choice.disabled} onChange={() => onChange(choice.value)} /><span><strong>{choice.label}</strong><small>{choice.description}</small></span>
  </label>)}</fieldset>;
}

function receipt(item: InboxItem): string {
  if (item.authorization) return item.authorization.status === 'approved' ? approvedDetail(item.authorization) : item.authorization.status === 'pending' ? '' : AUTHORIZATION_OUTCOMES[item.authorization.status].detail;
  if (item.external) return item.external.result || '发布请求已处理。';
  if (item.human) return item.human.status === 'answered' ? `回应已保存${item.human.answer ? `：${item.human.answer}` : ''}` : item.human.reason || '请求已失效。';
  return '本项已处理。';
}

/** Inbox 采用证据、决定和固定操作栏；仍通过共享请求存储提交原业务决定。 */
export function InboxRequestDetail({ item, active, source, sourceAvailable, onSource, onRetainSelection, next, onNext, onReturn, onFinish, compact, scroll, choices }: {
  item: InboxItem; active: boolean; source: string; sourceAvailable: boolean; onSource: () => void; onRetainSelection: () => void;
  next: InboxItem | undefined; onNext: (id: string) => void; onReturn: () => void; onFinish: () => void; compact: boolean;
  scroll: MutableRefObject<Record<string, number>>; choices: MutableRefObject<Record<string, string>>;
}) {
  const { store, drafts, errors, pending } = useTaskRequests();
  const [choice, setChoice] = useState(() => choices.current[item.id] ?? (item.kind === 'authorization' ? 'once' : ''));
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const answer = useRef<HTMLTextAreaElement>(null);
  const human = item.human;
  const authorization = item.authorization;
  const external = item.external;
  const draft = drafts[item.id] ?? '';
  const busy = pending.has(item.id) || checking;
  const resolved = item.status !== 'pending' && item.status !== 'unknown';
  const safeChoice = authorization && (choice === 'project' && !authorization.remember?.projectId || choice === 'session' && !authorization.remember) ? 'once' : choice;
  useEffect(() => { if (active) setChoice(choices.current[item.id] ?? (item.kind === 'authorization' ? 'once' : '')); }, [active, item.id, item.kind, choices]);
  useEffect(() => { if (active && resolved) result.current?.focus({ preventScroll: true }); }, [active, resolved]);
  useEffect(() => { if (active && (choice === 'changes' || choice === 'answer')) answer.current?.focus({ preventScroll: true }); }, [active, choice]);
  useEffect(() => { if (active && body.current) body.current.scrollTop = scroll.current[item.id] ?? 0; }, [active, item.id, scroll]);
  function choose(value: string) { choices.current[item.id] = value; setChoice(value); }
  function decide(value: DecideHumanRequest['decision']) {
    if (!store || busy) return;
    // 管理页默认显示首项；提交前固定选中项，让回执保留在原位。
    onRetainSelection();
    void store.decideItem(item, value);
  }
  async function reconcile() {
    if (!store || checking) return;
    onRetainSelection();
    setChecking(true); setCheckError('');
    try {
      const response = await fetchJson<{ item: InboxItem }>(`/api/inbox/${encodeURIComponent(item.id)}/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, Type.Object({ item: InboxItemSchema }));
      store.applyInbox(response.item);
    } catch { setCheckError('远端核对失败，请稍后重试；没有再次执行发布。'); }
    finally { setChecking(false); }
  }
  const finishLabel = compact ? '关闭 Inbox' : '返回任务面板';
  const responseField = (label: string, placeholder: string) => <label className="inbox-answer">{label}<textarea ref={answer} aria-label={label} maxLength={4000} rows={4} value={draft} placeholder={placeholder} disabled={busy} onChange={event => store?.draft(item.id, event.target.value)} /></label>;
  let actions: ReactNode;
  if (resolved) actions = next ? <><button className="secondary-button" onClick={onReturn}>返回列表</button><button className="primary-button inbox-next" onClick={() => onNext(next.id)}><span>处理下一项：{next.title}</span><ArrowRight /></button></> : <button className="primary-button" onClick={onFinish}>{finishLabel}</button>;
  else if (external) actions = item.status === 'unknown' ? external.status === 'unknown' ? <button className="secondary-button" disabled={busy} onClick={() => void reconcile()}>只读核对远端结果</button> : <span className="inbox-action-note">正在发布，等待服务端核对结果。</span> : <><button className="secondary-button" disabled={busy} onClick={() => decide('deny')}>拒绝发布</button><button className="primary-button" disabled={busy} onClick={() => decide('once')}>允许本次发布</button></>;
  else if (authorization) actions = <><button className="secondary-button" disabled={busy} onClick={() => decide('deny')}>拒绝</button><button className="primary-button" disabled={busy} onClick={() => decide(safeChoice as 'once' | 'session' | 'project')}>允许并继续</button></>;
  else if (item.kind === 'recovery') actions = <><button className="secondary-button" onClick={onReturn}>返回列表</button><button className="primary-button" disabled={busy || !choice || choice !== 'stop' && !human?.recovery?.canResume} onClick={() => decide(choice as 'continue' | 'restart' | 'stop')}>确认恢复方式</button></>;
  else if (item.kind === 'review') actions = choice === 'changes' ? <><button className="secondary-button" disabled={busy} onClick={() => choose('')}>返回</button><button className="primary-button" disabled={busy || !draft.trim()} onClick={() => decide('changes')}>提交修改意见</button></> : <><button className="secondary-button" disabled={busy} onClick={() => choose('changes')}>提出修改</button><button className="primary-button" disabled={busy} onClick={() => decide('accept')}>接受成果</button></>;
  else if (human?.clarificationScope) actions = <><span className="inbox-action-note">仅对本次引用范围生效</span><button className="primary-button" disabled={busy || !choice || choice === 'answer' && !draft.trim()} onClick={() => decide(choice as 'use_scope' | 'deny' | 'answer')}>确认并继续</button></>;
  else actions = <><button className="secondary-button" disabled={busy} onClick={() => decide('deny')}>不采用</button><button className="primary-button" disabled={busy || !draft.trim()} onClick={() => decide('answer')}>提交回应</button></>;
  return <>
    <div className="inbox-detail-scroll" ref={body} onScroll={event => { if (active) scroll.current[item.id] = event.currentTarget.scrollTop; }}>
      {resolved ? <div ref={result} className="inbox-decision-result" role="status" tabIndex={-1}><CheckCircle2 aria-hidden="true" /><h3>{receipt(item)}</h3>{human?.reason && <p>{human.reason}</p>}{!next && <div className="inbox-completion inline"><h3>全部处理完毕</h3><p>新的决策请求会显示在这里。</p></div>}</div> : <>
        {authorization ? <section className="inbox-evidence"><h3>拟执行的操作</h3><Facts entries={[
          ['操作', AUTHORIZATION_TOOL_ACTIONS[authorization.toolName]], ['目标路径', <code>{authorization.targetPath}</code>], ['工作目录', <code>{authorization.workingDirectory.path}</code>], ['有效期', authorizationDeadline(authorization)],
        ]} /><p className="inbox-operation-effect">目标路径位于当前工作目录之外，需要你的授权。</p><DecisionOptions legend="允许范围" value={safeChoice} onChange={choose} disabled={busy} choices={[
          { value: 'once', label: '仅这一次', description: '再次执行相同操作时仍需确认' },
          ...(authorization.remember ? [{ value: 'session', label: '当前会话', description: `允许本会话中${AUTHORIZATION_TOOL_ACTIONS[authorization.toolName]}「${authorization.remember.directory}」及其子目录` }] : []),
          ...(authorization.remember?.projectId ? [{ value: 'project', label: '当前项目', description: `允许当前项目中的会话${AUTHORIZATION_TOOL_ACTIONS[authorization.toolName]}「${authorization.remember.directory}」及其子目录` }] : []),
        ]} /><p className="inbox-grant-note"><ShieldCheck aria-hidden="true" /><span>{safeChoice === 'once' ? '仅允许本次操作，不新增长期授权。' : `记住的授权可在${safeChoice === 'project' ? GRANT_REVOKE_PLACES.project : GRANT_REVOKE_PLACES.session}中撤销。`}</span></p></section> : external ? <section className="inbox-evidence"><h3>本次发布到哪里</h3><Facts entries={[
          ['目标', external.target], ['远端分支', external.ref], ['固定提交', <code>{external.commit}</code>], ['认证', external.account],
        ]} /><h4>待发布内容</h4><pre className="inbox-output-preview">{external.summary}</pre>{external.result && <p role="status">{external.result}</p>}<p className="inbox-muted">仅创建新的远端分支。拒绝发布会保留已有成果；授权不会自动完成来源任务。</p></section> : item.kind === 'recovery' ? <section className="inbox-evidence"><h3>中断时的现场</h3><Facts entries={[
          ['中断原因', human?.recovery?.reason], ['最后检查点', human?.recovery?.checkpoint ?? '没有已持久化检查点'], ['未核对工具', human?.recovery?.pendingTools ?? '未知'], ['保留目录', human?.recovery?.directory ?? '尚无执行目录'],
        ]} /><p className="inbox-operation-effect">先核对已有变更与遗留命令，保留现有目录，不回滚或重放旧操作。</p><DecisionOptions legend="选择恢复方式" value={choice} onChange={choose} disabled={busy} choices={[
          { value: 'continue', label: '继续上次执行', description: '复用原会话，核对遗留命令后继续', disabled: !human?.recovery?.canResume },
          { value: 'restart', label: '从安全起点重新执行', description: '保留已有变更，从新会话核对后执行', disabled: !human?.recovery?.canResume },
          { value: 'stop', label: '保持停止', description: '保留现场，不恢复任务' },
        ]} />{!human?.recovery?.canResume && <p className="inbox-muted">停止或副作用尚未核实，继续和重做暂不可用。</p>}</section> : item.kind === 'review' ? <section className="inbox-evidence"><h3>成果与自检</h3><p className="inbox-request-question">{human?.question}</p>{item.artifactVersionId ? <ArtifactPreview versionId={item.artifactVersionId} /> : <p>工作会话完成说明没有后台运行或文件成果自检证据，请核对原文与来源。</p>}{choice === 'changes' && responseField('修改意见', '说明需要修改的内容和期望结果')}</section> : human?.clarificationScope ? <section className="inbox-evidence"><h3>本次想引用什么</h3><Facts entries={[
          ['资料', human.clarificationScope.materials.join('、')], ['引用范围', human.clarificationScope.scope], ['用途', human.clarificationScope.purpose],
        ]} /><blockquote>{human.clarificationScope.evidence}</blockquote><DecisionOptions legend="决定本次资料引用范围" value={choice} onChange={choose} disabled={busy} choices={[
          { value: 'use_scope', label: '允许本次引用', description: '只用于所列任务和引用范围' }, { value: 'deny', label: '不引用这份资料', description: '按现有已授权资料继续' }, { value: 'answer', label: '指定其他范围', description: '补充可以引用的内容和限制' },
        ]} />{choice === 'answer' && responseField('澄清回应', '说明可以引用的内容和限制')}<p className="inbox-muted">此决定不扩大目录或工具权限。</p></section> : <section className="inbox-evidence"><h3>补充说明</h3><p className="inbox-request-question">{human?.question}</p>{responseField('澄清回应', '补充需要的资料范围或具体要求')}</section>}
      </>}
      {(errors[item.id] || checkError) && <p className="inbox-error" role="alert">{errors[item.id] || checkError}{errors[item.id] && draft && <button className="inline-link" onClick={() => void store?.retryDraft(item.id)}>保留本窗口草稿并重试保存</button>}</p>}
      <details className="inbox-supporting-details"><summary>来源与补充说明</summary>{human && <p className="inbox-request-question">{human.question}</p>}<Facts entries={[
        ['来源', source], ['创建时间', new Date(item.createdAt).toLocaleString()], ['影响', item.status === 'pending' ? item.blocksWork ? '工作等待你的决定' : '仅本次操作' : item.status === 'unknown' ? '结果待核对' : '本项已处理'],
      ]} />{sourceAvailable ? <button className="inline-link" onClick={onSource}>返回来源会话 <ArrowRight /></button> : <p>来源会话不可用；请求仍以服务端记录为准。</p>}</details>
    </div>
    <footer className="inbox-action-bar">{actions}</footer>
  </>;
}
