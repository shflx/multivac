import { ArrowDown, FolderInput, LoaderCircle, Pause } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SessionMovePreview, SessionMoveResult, WorkingDirectory, WorkspaceSession } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { previewSessionMove } from '../../data/workspace-api.js';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { multivacProcessing } from '../assistant/sidebar-collapse.js';
import { entryList, moveTargets, type ProjectWorkspace } from './move-to-project.js';
import { WORKING_DIRECTORY_KINDS, workingDirectoryRule } from './working-directory.js';
import { useWorkspaces, useWorkspaceSessions } from './workspace-sessions-provider.js';
import { workspaceName } from './workspaces.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 核对结果：对应哪个项目、哪一次核对（运行状态变化后重新核对）。 */
type PreviewState =
  | { key: string; status: 'checking' }
  | { key: string; status: 'ok'; preview: SessionMovePreview }
  | { key: string; status: 'failed'; reason: string };

interface MoveToProjectCardProps {
  session: WorkspaceSession;
  /** 归入完成：会话已以接口返回的结果写回共享列表。 */
  onMoved: (result: SessionMoveResult, context: { project: ProjectWorkspace; from: WorkingDirectory }) => void;
  onCancel: () => void;
  /** 打开卡片的元素随之消失（如会话列表已收起、会话离开了本工作区）时，关闭后焦点的去处。 */
  fallbackFocus?: () => HTMLElement | null | undefined;
}

/**
 * 归入项目的确认卡：标题栏菜单、工作区会话列表与管理 · 会话页共用这一张。
 *
 * 选择项目后由服务端核对（不做修改），卡上写明工作目录从哪里换到哪里、之后的执行边界与记住的授权如何变化；
 * 原工作目录是临时目录时可以选择把其中的文件一并移入（同名的不覆盖、留在原处，卡上事先列出）。
 * 会话正在运行（含等待授权）时卡片照常打开、说明需要先停止，确认不可执行；运行状态随会话实时更新，
 * 最终以服务端在会话互斥区内的判定为准，拒绝原因留在卡上。
 */
export function MoveToProjectCard({ session, onMoved, onCancel, fallbackFocus }: MoveToProjectCardProps) {
  const { workspaces } = useWorkspaces();
  const { moveToProject } = useWorkspaceSessions();
  const targets = moveTargets(workspaces ?? [], session);
  const [projectId, setProjectId] = useState(targets[0]?.workspaceId ?? '');
  const target = targets.find((item) => item.workspaceId === projectId) ?? null;
  const [moveFiles, setMoveFiles] = useState(true);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 运行状态以会话的实时状态为准（卡片打开期间保持该会话的订阅）；尚未读到时用核对结果。
  const live = useAssistantSession(session.sessionId)?.session;
  const liveRunning = live?.status === 'ready' ? multivacProcessing(live) : null;
  const key = `${projectId}:${liveRunning === null ? '-' : String(liveRunning)}`;
  const current = preview?.key === key ? preview : null;
  const checked = current?.status === 'ok' ? current.preview : null;
  const running = liveRunning ?? checked?.running ?? false;

  // 选择项目或运行状态变化（这一轮可能刚写下文件）后重新核对；只采用与当前选择一致的结果。
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setPreview({ key, status: 'checking' });
    previewSessionMove(session.sessionId, projectId, controller.signal).then(
      (result) => setPreview({ key, status: 'ok', preview: result }),
      (cause: unknown) => {
        if (!controller.signal.aborted) setPreview({ key, status: 'failed', reason: errorText(cause, '无法核对归入的变化，请重试。') });
      },
    );
    return () => controller.abort();
    // key 已涵盖项目与运行状态。
  }, [key, session.sessionId]);

  async function submit(): Promise<void> {
    if (!target || !checked) return;
    setError('');
    setBusy(true);
    try {
      const withFiles = moveFiles && (checked.files?.total ?? 0) > 0;
      const result = await moveToProject(session.sessionId, { projectId: target.workspaceId, moveFiles: withFiles });
      onMoved(result, { project: target, from: checked.from });
    } catch (cause) {
      setError(errorText(cause, '归入项目没有完成，请重试。'));
      setBusy(false);
    }
  }

  const sourceProject = workspaces?.find((item) => item.workspaceId === session.workspaceId)?.project ?? null;
  const files = checked?.files ?? null;

  return (
    <ConfirmCard
      title={`把「${session.title}」归入项目`}
      description="会话随之出现在该项目的工作区里，对话历史不变"
      icon={FolderInput}
      confirmLabel="归入项目"
      confirmDisabled={!target || !checked || running}
      busy={busy}
      error={error || (current?.status === 'failed' ? current.reason : '')}
      {...(fallbackFocus ? { fallbackFocus } : {})}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      <dl className="confirm-card-fields move-card">
        <div>
          <dt>项目</dt>
          <dd>
            {targets.length ? (
              <select aria-label="归入的项目" value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>
                {targets.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.name}</option>)}
              </select>
            ) : '还没有其他项目，可以先在工作区切换菜单中“新建项目…”。'}
          </dd>
        </div>
        {target && (
          <>
            <div>
              <dt>目录</dt>
              <dd className="move-change" aria-live="polite">
                {checked ? (
                  <>
                    <DirectoryChange label="现在" directory={checked.from} />
                    <ArrowDown aria-hidden="true" />
                    <DirectoryChange label="归入后" directory={checked.to} />
                  </>
                ) : current?.status === 'failed' ? (
                  <small className="move-files">没能核对目录的变化。</small>
                ) : (
                  <small className="directory-rule-checking">
                    <LoaderCircle className="spin" aria-hidden="true" />
                    正在核对
                  </small>
                )}
              </dd>
            </div>
            <div>
              <dt>边界</dt>
              <dd>
                之后按「{target.name}」的项目目录执行：{workingDirectoryRule(checked?.to.kind ?? 'project-managed')}
                原来的目录对这个会话来说也成了目录外。
              </dd>
            </div>
            <div>
              <dt>授权</dt>
              <dd>
                本会话内记住的授权继续有效；「{target.name}」中“本项目内始终允许”的授权随即适用
                {sourceProject ? `，「${workspaceName(workspaces, session.workspaceId)}」的不再适用` : ''}。
              </dd>
            </div>
            {files && (
              <div>
                <dt>文件</dt>
                <dd>
                  {files.total === 0 ? '临时目录是空的，归入后删除。' : (
                    <>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={moveFiles}
                          disabled={busy}
                          onChange={(event) => setMoveFiles(event.target.checked)}
                        />
                        <span>把临时目录里的 {files.total} 项一并移入项目目录</span>
                      </label>
                      <small className="move-files">{entryList(files.names, files.total)}</small>
                      <small className="move-files">
                        {!moveFiles
                          ? '不移入：文件留在原临时目录，不再是会话的工作目录。'
                          : files.conflictTotal > 0
                            ? `${entryList(files.conflicts, files.conflictTotal)} 与项目目录中已有的同名，不覆盖，留在原临时目录，原临时目录随之保留。`
                            : '同名的不会覆盖；全部移入后删除空的临时目录。'}
                      </small>
                    </>
                  )}
                </dd>
              </div>
            )}
          </>
        )}
      </dl>
      {running && (
        <p className="move-warning" role="status">
          <Pause aria-hidden="true" />
          这个会话正在运行（或在等待你的授权）。请先停止这一轮，再归入项目。
        </p>
      )}
    </ConfirmCard>
  );
}

/** 目录变化的一端：类型、完整路径与这类目录的规则。 */
function DirectoryChange({ label, directory }: { label: string; directory: WorkingDirectory }) {
  return (
    <span className="directory-rule" data-directory-kind={directory.kind}>
      <span>
        <small>{label}</small>
        <strong>{WORKING_DIRECTORY_KINDS[directory.kind].label}</strong>
        <code>{directory.path}</code>
      </span>
    </span>
  );
}
