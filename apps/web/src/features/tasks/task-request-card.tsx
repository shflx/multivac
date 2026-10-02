import { CircleHelp, Check, Pause, Play } from 'lucide-react';
import type { HumanRequest } from '@multivac/contracts';
import { useTaskRequests } from './task-requests-provider.js';
import { ArtifactPreview } from './artifact-preview.js';

export function TaskRequestCard({ request }: { request: HumanRequest }) {
  const { store, pending, errors, drafts } = useTaskRequests();
  const busy = pending.has(request.requestId);
  if (!store) return null;
  if (request.status !== 'pending') return <div className="proposal-receipt" data-request-id={request.requestId}><Check aria-hidden="true" /><span>{request.status === 'answered' ? '回应已保存' : '请求已失效'}{request.answer ? `：${request.answer}` : ''}</span></div>;
  return <section className="task-receipt proposal-card pending task-request-card" aria-label="任务人工请求" data-request-id={request.requestId}>
    <div className="receipt-title"><CircleHelp aria-hidden="true" /><div><strong>{request.kind === 'recovery' ? '恢复待确认' : request.kind === 'review' ? '成果待验收' : '需要你回应'}</strong></div></div>
    <p>{request.question}</p>
    {request.kind === 'review' && request.artifactVersionId && <ArtifactPreview versionId={request.artifactVersionId} />}
    {request.kind !== 'recovery' && <textarea aria-label={request.kind === 'review' ? '修改意见' : '澄清回应'} maxLength={4000} rows={3} value={drafts[request.requestId] ?? ''} onChange={(event) => store.draft(request.requestId, event.target.value)} />}
    {errors[request.requestId] && <p className="proposal-error" role="alert">{errors[request.requestId]}</p>}
    <footer className="receipt-actions">
      {request.kind === 'recovery' ? <><button type="button" className="secondary" disabled={busy} onClick={() => void store.decide(request, 'stop')}><Pause />保持停止</button><button type="button" className="primary" disabled={busy || !request.stopConfirmed} onClick={() => void store.decide(request, 'continue')}><Play />继续</button></> : request.kind === 'review' ? <><button type="button" className="secondary" disabled={busy || !drafts[request.requestId]?.trim()} onClick={() => void store.decide(request, 'changes')}>要求修改</button><button type="button" className="primary" disabled={busy} onClick={() => void store.decide(request, 'accept')}><Check />接受成果</button></> : <><button type="button" className="secondary" disabled={busy} onClick={() => void store.decide(request, 'deny')}>不采用</button><button type="button" className="primary" disabled={busy || !drafts[request.requestId]?.trim()} onClick={() => void store.decide(request, 'answer')}><Check />提交回应</button></>}
    </footer>
  </section>;
}
export function SessionTaskRequests({ sessionId }: { sessionId: string }) {
  const { requests } = useTaskRequests();
  return <>{requests.filter((request) => request.sessionId === sessionId && request.kind !== 'authorization').map((request) => <TaskRequestCard key={request.requestId} request={request} />)}</>;
}
