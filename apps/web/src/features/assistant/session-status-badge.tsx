import { Circle, LoaderCircle } from 'lucide-react';
import { useAssistantSession } from './assistant-session.js';
import { useSessionReadCursor } from './session-read.js';
import { sessionStatus } from './session-status.js';

/** 导航里的轻量图标：转动表示处理中，实心点表示未查看；已查看不占视觉空间。 */
export function SessionStatusBadge({ sessionId, id }: { sessionId: string; id?: string }) {
  const entry = useAssistantSession(sessionId);
  const readCursor = useSessionReadCursor(sessionId);
  const status = sessionStatus(entry?.session, readCursor);
  if (!status || status.kind === 'viewed') return <span id={id} hidden>{status ? `会话状态：${status.label}` : ''}</span>;
  const Icon = status.kind === 'processing' ? LoaderCircle : Circle;
  return <span id={id} className={`session-status-badge ${status.kind}`} data-status={status.kind} role="img" aria-label={`会话状态：${status.label}`} title={`${status.label} · ${status.detail}`}>
    <Icon aria-hidden="true" />
  </span>;
}
