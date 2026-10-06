import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, FileText, Maximize2, MessageSquare, ShieldCheck, X } from 'lucide-react';
import { canSubmitDecision } from './ui-state.js';
import { nextInboxRequest, pendingInboxRequests, toolAuthorizationAction } from './inbox-state.js';

function RequestType({ type }) {
  return <span className="inbox-type">{type}</span>;
}

function InboxCompletion({ inline = false }) {
  return <div className={`inbox-completion ${inline ? 'inline' : ''}`}>{!inline && <CheckCircle2 aria-hidden="true" />}<h3>全部处理完毕</h3><p>0 项待处理。新的决策请求会显示在这里。</p></div>;
}

function RequestListItem({ request, task, project, selected, onSelect }) {
  return <button type="button" className={`inbox-list-item ${selected ? 'selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(request.id)}>
    <span className="inbox-item-title"><strong>{request.title}</strong>{request.state === 'new' && <span className="inbox-unviewed" role="img" aria-label="未查看" />}</span>
    <span className="inbox-item-source">{task?.title || '来源任务不可用'} · {project?.name || '日常'}</span>
    <span className="inbox-item-meta"><RequestType type={request.type} /><span className={`inbox-impact ${request.blocksWork ? 'blocking' : ''}`}>{request.impact}</span><time dateTime={request.createdAt}>{request.age}</time></span>
  </button>;
}

export function InboxView({ requests, tasks, projects, outputs, selectedRequestId, setSelectedRequestId, resolveRequest, onOpenTask, markSeen, drafts, updateDraft, compact = false, detailOpen = true, setDetailOpen, close, expand, visible = true, onFinish, IconButton }) {
  const pending = pendingInboxRequests(requests);
  const selected = requests.find((request) => request.id === selectedRequestId) || pending[0];
  const detailVisible = visible && (!compact || detailOpen);
  const listRef = useRef(null);
  const detailRef = useRef(null);
  const focusDetail = useRef(false);
  const listScroll = useRef(0);

  useEffect(() => {
    if (selected) markSeen(selected.id, { visible, detailOpen: !compact || detailOpen });
  }, [selected?.id, selected?.state, visible, compact, detailOpen, markSeen]);

  useLayoutEffect(() => {
    if ((!compact || !detailOpen) && listRef.current) listRef.current.scrollTop = listScroll.current;
    if (detailVisible && focusDetail.current) {
      detailRef.current?.focus({ preventScroll: true });
      focusDetail.current = false;
    }
  }, [selected?.id, detailVisible, compact, detailOpen]);

  function select(id) {
    focusDetail.current = true;
    setSelectedRequestId(id);
    if (compact) setDetailOpen(true);
  }

  function backToList() {
    if (compact) setDetailOpen(false);
    requestAnimationFrame(() => listRef.current?.querySelector('[aria-current="true"], button')?.focus({ preventScroll: true }));
  }

  function decide(id, action, answer) {
    // 将实际处理的项固定为选中项，处理后原位呈现结果，不跳到队列首项。
    setSelectedRequestId(id);
    resolveRequest(id, action, answer);
  }

  const task = tasks.find((item) => item.id === selected?.taskId);
  const project = projects.find((item) => item.id === task?.projectId);
  const finish = compact ? close : onFinish;
  return <div className={`page-column inbox-page ${compact ? 'inbox-compact' : ''}`}>
    {compact ? <header className="inbox-drawer-header">
      {detailOpen && <IconButton label="返回 Inbox 列表" onClick={backToList}><ArrowLeft /></IconButton>}
      <h2 id="inbox-drawer-title">Inbox</h2><span>{pending.length} 项待处理</span>
      {expand && <IconButton label="展开到管理" onClick={expand}><Maximize2 /></IconButton>}
      <IconButton label="关闭 Inbox" onClick={close}><X /></IconButton>
    </header> : <header className="page-intro"><div><span className="eyebrow">集中处理</span><h1>Inbox</h1><p>查看需要决定的事项，处理后再继续下一项。</p></div><span className="inbox-pending-count">{pending.length} 项待处理</span></header>}
    <div className="master-detail inbox-layout">
      <section className="inbox-list-pane" aria-label="待处理事项" hidden={compact && detailOpen}>
        <div className="list-section-label">{pending.length} 项待处理</div>
        <div ref={listRef} className="inbox-list-scroll" onScroll={(event) => { if (visible && (!compact || !detailOpen)) listScroll.current = event.currentTarget.scrollTop; }}>
          {pending.map((request) => {
            const owner = tasks.find((item) => item.id === request.taskId);
            return <RequestListItem key={request.id} request={request} task={owner} project={projects.find((item) => item.id === owner?.projectId)} selected={selected?.id === request.id} onSelect={select} />;
          })}
          {!pending.length && <InboxCompletion />}
        </div>
        {compact && <footer className="inbox-list-footer"><span>{pending.length ? '选择事项查看详情' : '没有待处理事项'}</span><button type="button" className="secondary" onClick={close}>关闭 Inbox</button></footer>}
      </section>
      {selected ? <RequestDetail key={selected.id} focusRef={detailRef} request={selected} task={task} project={project} output={outputs.find((item) => item.id === selected.evidence?.outputId) || outputs.find((item) => item.taskId === selected.taskId)} resolveRequest={decide} onOpenTask={onOpenTask} nextRequest={nextInboxRequest(requests, selected.id)} onNext={select} draft={drafts[selected.id] || {}} updateDraft={(patch) => updateDraft(selected.id, patch)} hidden={compact && !detailOpen} active={detailVisible} pendingCount={pending.length} onFinish={finish} finishLabel={compact ? '关闭 Inbox' : '返回任务面板'} onReturn={backToList} /> : <section className="inbox-empty-detail" hidden={compact}><InboxCompletion /><button type="button" className="secondary" onClick={finish}>返回任务面板</button></section>}
    </div>
  </div>;
}

function Facts({ entries }) {
  return <dl className="inbox-facts">{entries.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function OutputEvidence({ output, preview, onOpen }) {
  if (!output) return <p className="inbox-muted">当前没有可用成果，请进入来源会话核对。</p>;
  return <section className="inbox-output" aria-label="成果与自检">
    <div className="inbox-section-heading"><h3><FileText aria-hidden="true" />{output.title}</h3><button type="button" className="inline-link" onClick={onOpen}>查看完整成果<ArrowRight /></button></div>
    <p>{output.summary}</p>
    {preview && <article className="inbox-output-preview" aria-label="成果预览"><h4>成果预览</h4>{preview.map((section) => <section key={section.title}><h5>{section.title}</h5><p>{section.text}</p></section>)}</article>}
    <div className="inbox-output-checks"><h4>自检结果</h4><ul>{[...new Set(output.checks || [])].map((check) => <li key={check}><Check aria-hidden="true" />{check}</li>)}</ul></div>
  </section>;
}

function RequestEvidence({ request, output, onOpenTask }) {
  const evidence = request.evidence || {};
  switch (request.type) {
    case '澄清':
      return <section className="inbox-evidence"><h3>本次想引用什么</h3><Facts entries={[[ '资料', evidence.material ], [ '引用范围', evidence.scope ], [ '用途', evidence.purpose ]]} />{evidence.excerpt && <blockquote>{evidence.excerpt}</blockquote>}</section>;
    case '工具授权':
      return <section className="inbox-evidence"><h3>拟执行的操作</h3><Facts entries={[[ '操作', request.capability ], [ '仓库', evidence.repository ], [ '分支', evidence.branch ], [ '账号', evidence.account ]]} /><h4>变更摘要</h4><ul>{(evidence.changes || []).map((change) => <li key={change}>{change}</li>)}</ul>{evidence.effect && <p className="inbox-operation-effect">{evidence.effect}</p>}</section>;
    case '外发授权':
      return <section className="inbox-evidence"><h3>本次发布到哪里</h3><Facts entries={[[ '目标', evidence.target ], [ '账号', evidence.account ]]} /><h4>待发布内容</h4><article className="inbox-output-preview"><strong>{output?.title || evidence.contentTitle}</strong><p>{evidence.content || output?.summary}</p></article><p className="inbox-muted">拒绝发布会保留已有成果。</p></section>;
    case '验收':
      return <OutputEvidence output={output} preview={evidence.preview} onOpen={() => onOpenTask(request.taskId, 'outputs')} />;
    case '恢复确认':
      return <section className="inbox-evidence"><h3>中断时的现场</h3><Facts entries={[[ '最后完成', evidence.lastCompleted ], [ '未确认状态', evidence.uncertain ], [ '已保留', evidence.preserved ]]} /><p className="inbox-operation-effect">选择恢复方式后，先核对已有变更与遗留命令。</p></section>;
    default:
      return <p>{request.detail}</p>;
  }
}

function DecisionOptions({ legend, name, options, value, onChange }) {
  return <fieldset className="inbox-decision-options"><legend>{legend}</legend>{options.map((option) => <label key={option.value} className={`inbox-decision-option ${value === option.value ? 'selected' : ''}`}>
    <input type="radio" disabled={option.disabled} name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span><strong>{option.label}</strong><small>{option.description}</small></span>
  </label>)}</fieldset>;
}

function RequestDecisionFields({ request, task, project, draft, updateDraft, answerId }) {
  const answer = draft.answer || '';
  if (request.type === '澄清') return <>
    <DecisionOptions legend="决定本次资料引用范围" name={`scope-${request.id}`} value={draft.choice || ''} onChange={(choice) => updateDraft({ choice })} options={[
      { value: 'allow', label: '允许本次引用', description: '只用于所列任务和引用范围' },
      { value: 'deny', label: '不引用这份资料', description: '按已授权的项目资料继续' },
      { value: 'custom', label: '指定其他范围', description: '补充可以引用的内容和限制' },
    ]} />
    {draft.choice === 'custom' && <label className="inbox-answer" htmlFor={answerId}>范围说明<textarea id={answerId} value={answer} onChange={(event) => updateDraft({ answer: event.target.value })} placeholder="例如：只引用公开资料摘要，不使用个人记录" required /></label>}
  </>;
  if (request.type === '工具授权') {
    const scope = toolAuthorizationAction(draft.grantScope, task?.projectId);
    return <>
      <DecisionOptions legend="允许范围" name={`grant-${request.id}`} value={scope} onChange={(grantScope) => updateDraft({ grantScope })} options={[
        { value: 'once', label: '仅这一次', description: '再次执行相同操作时仍需确认' },
        { value: 'session', label: '当前会话', description: `适用于「${task?.session || '当前会话'}」中的相同操作` },
        ...(task?.projectId ? [{ value: 'project', label: '当前项目', description: `适用于「${project?.name || '当前项目'}」内各会话中的相同操作` }] : []),
      ]} />
      <p className="inbox-grant-note"><ShieldCheck aria-hidden="true" /><span>{scope === 'once' ? `只允许本次「${request.capability}」。` : `允许「${request.capability}」在${scope === 'project' ? `项目「${project?.name || '当前项目'}」` : `会话「${task?.session || '当前会话'}」`}内使用。可在${scope === 'project' ? '项目权限' : '会话授权记录'}中撤销。`}</span></p>
    </>;
  }
  if (request.type === '恢复确认') return <DecisionOptions legend="选择恢复方式" name={`recovery-${request.id}`} value={draft.recoveryChoice || ''} onChange={(recoveryChoice) => updateDraft({ recoveryChoice })} options={[
    { value: 'resume', label: '继续上次执行', disabled: !request.stopConfirmed, description: request.stopConfirmed ? '旧执行已确认停止，按原边界继续' : '旧执行停止尚未确认，暂不能继续' },
    { value: 'stop', label: '保持停止', description: request.evidence?.outcomes?.stop || '保留现场，不恢复任务' },
  ]} />;
  if (request.type === '验收' && draft.choice === 'revise') return <label className="inbox-answer" htmlFor={answerId}>修改意见<textarea id={answerId} value={answer} onChange={(event) => updateDraft({ answer: event.target.value })} placeholder="说明需要修改的内容和期望结果" required /></label>;
  return null;
}

function RequestActions({ request, task, draft, updateDraft, nextRequest, onNext, onFinish, finishLabel, onReturn }) {
  if (request.state === 'done') return <footer className="inbox-action-bar">{nextRequest ? <>
    <button type="button" className="secondary" onClick={onReturn}>返回列表</button>
    <button type="button" className="primary inbox-next" onClick={() => onNext(nextRequest.id)}><span>处理下一项：{nextRequest.title}</span><ArrowRight /></button>
  </> : <button type="button" className="primary" onClick={onFinish}>{finishLabel}</button>}</footer>;
  const answer = draft.answer || '';
  const primary = (action, label) => <button type="submit" className="primary" name="action" value={action} disabled={!canSubmitDecision(request.type, action, answer) || (request.type === '恢复确认' && action === 'resume' && !request.stopConfirmed)}>{label}</button>;
  let actions;
  switch (request.type) {
    case '澄清':
      actions = <><span className="inbox-action-note">仅对本次任务生效</span>{primary(draft.choice || '', '确认并继续')}</>;
      break;
    case '工具授权':
      actions = <><button type="submit" className="secondary" name="action" value="deny">拒绝</button>{primary(toolAuthorizationAction(draft.grantScope, task?.projectId), '允许并继续')}</>;
      break;
    case '验收':
      actions = draft.choice === 'revise' ? <><button type="button" className="secondary" onClick={() => updateDraft({ choice: '' })}>返回</button>{primary('revise', '提交修改意见')}</> : <><button type="button" className="secondary" onClick={() => updateDraft({ choice: 'revise' })}>提出修改</button>{primary('accept', '接受成果')}</>;
      break;
    case '恢复确认':
      actions = <><button type="button" className="secondary" onClick={onReturn}>返回列表</button>{primary(draft.recoveryChoice || '', '确认恢复方式')}</>;
      break;
    case '外发授权':
      actions = <><button type="submit" className="secondary" name="action" value="deny">拒绝发布</button>{primary('allow', '允许本次发布')}</>;
      break;
    default:
      actions = <button type="button" className="secondary" onClick={onReturn}>返回列表</button>;
  }
  return <footer className="inbox-action-bar">{actions}</footer>;
}

function RequestDetail({ focusRef, request, task, project, output, resolveRequest, onOpenTask, nextRequest, onNext, draft, updateDraft, hidden, active, pendingCount, onFinish, finishLabel, onReturn }) {
  const scrollRef = useRef(null);
  const resultRef = useRef(null);
  const titleId = useId();
  const answerId = useId();
  const resolved = request.state === 'done';
  useLayoutEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = draft.scrollTop || 0;
  }, [active, request.id]);
  useEffect(() => {
    if (resolved && active) resultRef.current?.focus({ preventScroll: true });
  }, [resolved, active]);
  useEffect(() => {
    if (active && !resolved && (draft.choice === 'revise' || draft.choice === 'custom')) {
      document.getElementById(answerId)?.focus({ preventScroll: true });
      document.getElementById(answerId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [active, resolved, draft.choice, answerId]);

  function submit(event) {
    event.preventDefault();
    const action = event.nativeEvent.submitter?.value;
    if (!resolved && canSubmitDecision(request.type, action, draft.answer || '')) resolveRequest(request.id, action, draft.answer || '');
  }

  return <aside className="inbox-request-detail" hidden={hidden} aria-labelledby={titleId}>
    <header className="inbox-detail-header" ref={focusRef} tabIndex={-1}>
      <div className="inbox-detail-context"><RequestType type={request.type} />{request.demo && <span>原型示例</span>}<span>{pendingCount} 项待处理</span></div>
      <h2 id={titleId} title={request.title}>{request.title}</h2>
    </header>
    <form className="inbox-decision-form" onSubmit={submit}>
      <div ref={scrollRef} className="inbox-detail-scroll" onScroll={(event) => { if (active) updateDraft({ scrollTop: event.currentTarget.scrollTop }); }}>
        {resolved ? <div ref={resultRef} className="inbox-decision-result" role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}><CheckCircle2 aria-hidden="true" /><h3>{request.resolution || '本项已处理'}</h3><p>{request.consequence || task?.reason}</p>{!nextRequest && <InboxCompletion inline />}</div> : <>
          <RequestEvidence request={request} output={output} onOpenTask={onOpenTask} />
          <RequestDecisionFields request={request} task={task} project={project} draft={draft} updateDraft={updateDraft} answerId={answerId} />
        </>}
        <details className="inbox-supporting-details"><summary>来源与补充说明</summary><p>{request.detail}</p><Facts entries={[[ '来源任务', task?.title ], [ '项目', project?.name || '日常' ], [ '影响', resolved ? '本项已处理' : request.impact ]]} />{task && <button type="button" className="inline-link" onClick={() => onOpenTask(task.id, 'workspace')}><MessageSquare />返回来源会话：{task.session}<ArrowRight /></button>}</details>
      </div>
      <RequestActions request={request} task={task} draft={draft} updateDraft={updateDraft} nextRequest={nextRequest} onNext={onNext} onFinish={onFinish} finishLabel={finishLabel} onReturn={onReturn} />
    </form>
  </aside>;
}
