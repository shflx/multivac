import React from 'react';
import { Check, FileText, Pause, Play } from 'lucide-react';

/** 任务详情使用 dev 的就地决策；Inbox 作为原型额外入口共用请求与草稿。 */
export function TaskRequestCard({ request, output, draft, updateDraft, resolveRequest, onOutput }) {
  const answer = draft.answer || '';
  const review = request.type === '验收';
  const recovery = request.type === '恢复确认';
  return <section className="task-request-card" aria-label="任务人工请求">
    <h3>{review ? '成果待验收' : recovery ? '恢复待确认' : '需要你回应'}</h3><p>{request.title}</p><p>{request.detail}</p>
    {review && output && <div className="task-request-output"><h4><FileText />{output.title}</h4><p>{output.summary}</p>{request.evidence?.preview?.map((section) => <section key={section.title}><h4>{section.title}</h4><p>{section.text}</p></section>)}<ul>{output.checks?.map((check) => <li key={check}>{check}</li>)}</ul><button className="inline-link" onClick={() => onOutput(output.id)}>查看完整成果</button></div>}
    {!recovery && <textarea aria-label={review ? '修改意见' : '澄清回应'} rows={3} maxLength={4000} value={answer} onChange={(event) => updateDraft({ answer: event.target.value })} />}
    {recovery && !request.stopConfirmed && <p className="task-panel-muted">尚未确认旧执行已停止，暂不能继续。</p>}
    <div className="task-detail-actions">{recovery ? <><button className="secondary" onClick={() => resolveRequest(request.id, 'stop')}><Pause />保持停止</button><button className="primary" disabled={!request.stopConfirmed} onClick={() => resolveRequest(request.id, 'resume')}><Play />继续</button></> : review ? <><button className="secondary" disabled={!answer.trim()} onClick={() => resolveRequest(request.id, 'revise', answer)}>要求修改</button><button className="primary" onClick={() => resolveRequest(request.id, 'accept')}><Check />接受成果</button></> : <><button className="secondary" onClick={() => resolveRequest(request.id, 'deny')}>不采用</button><button className="primary" disabled={!answer.trim()} onClick={() => resolveRequest(request.id, 'custom', answer)}><Check />提交回应</button></>}</div>
  </section>;
}
