import type { HumanRequest } from '@multivac/contracts';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { ArtifactPreview } from './artifact-preview.js';

export function TaskReviewItems({ request, inboxId }: { request: HumanRequest | null; inboxId?: string }) {
  if (!request?.reviewItems?.length) return null;
  return <div className="task-review-items">
    <h4>随顶层验收的子任务</h4>
    {request.reviewItems.map(item => <details key={item.taskId}>
      <summary>{item.title} · {item.requiresJudgment ? '需要人工判断' : '服务端自检通过'}</summary>
      {item.kind === 'artifact' ? <ArtifactPreview versionId={item.versionId} {...(inboxId ? {
        url: `/api/inbox/${encodeURIComponent(inboxId)}/artifact?child=${encodeURIComponent(item.taskId)}`,
      } : {})} /> : <>
        <p className="muted">工作会话完成说明 · 来源会话 {item.report.sessionId}</p>
        <MarkdownBody identity={`completion-report:${item.report.reportId}`} text={item.report.summary} />
      </>}
    </details>)}
  </div>;
}
