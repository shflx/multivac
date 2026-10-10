import { useEffect, useState } from 'react';
import type { AssistantQuote, CurrentFileReading } from '@multivac/contracts';
import { ConversationPanel } from '../workspace/conversation-panel.js';
import { useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import type { WorkspaceViewReport } from '../assistant/current-view.js';

const TASK_VIEW_KEY = 'multivac.task-view';

/** 仅记住当前标签页正在查看的任务，刷新可恢复，不改变工作区的共享布局。 */
export function rememberedTaskSessionId(): string | null {
  try {
    const id = sessionStorage.getItem(TASK_VIEW_KEY);
    return id && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
  } catch { return null; }
}

export function rememberTaskSessionId(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(TASK_VIEW_KEY, id);
    else sessionStorage.removeItem(TASK_VIEW_KEY);
  } catch { /* 本机存储禁用时仍可查看任务。 */ }
}

export function TaskSessionView({ sessionId, active, onReturn, onManageModels, onHandToMultivac, onViewChange }: {
  sessionId: string; active: boolean; onReturn: () => void; onManageModels: () => void;
  onHandToMultivac: (quote: AssistantQuote) => void; onViewChange: (view: WorkspaceViewReport) => void;
}) {
  const { sessions, ensureLoaded } = useWorkspaceSessions();
  const [error, setError] = useState('');
  const [reading, setReading] = useState<CurrentFileReading | null>(null);
  const session = sessions?.find(item => item.sessionId === sessionId && item.taskId && !item.archivedAt);
  useEffect(() => {
    let current = true;
    void ensureLoaded().catch(reason => { if (current) setError(reason instanceof Error ? reason.message : '任务会话读取失败。'); });
    return () => { current = false; };
  }, [ensureLoaded]);
  useEffect(() => {
    if (!session) return;
    onViewChange({ workspaceId: session.workspaceId, taskSession: { sessionId, taskId: session.taskId! }, scene: { parallelCount: 2, viewMode: 'focus', slots: [sessionId], focusedSessionId: sessionId }, reading });
  }, [session, sessionId, reading, onViewChange]);
  return <section className="task-session-view" aria-label="任务会话视图" hidden={!active}>
    {session ? <ConversationPanel
      sessionId={sessionId} workspaceId={session.workspaceId} title={session.title} workingDirectory={session.workingDirectory}
      visible={active} current focused taskView collapseComposer={false} onReadingFocus={setReading}
      onActivate={() => undefined} onFocusMode={() => undefined} onReturnToParallel={onReturn}
      onManageModels={onManageModels} onHandToMultivac={onHandToMultivac}
    /> : <div className="workspace-empty">
      <h2>任务会话</h2><p role={error || sessions ? 'alert' : 'status'}>{error || (sessions ? '任务会话不存在或已归档。' : '正在读取任务会话…')}</p>
      <button type="button" className="secondary-button" onClick={onReturn}>返回工作区</button>
    </div>}
  </section>;
}
