import { ArrowDown, Pause } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SessionMovePreview, WorkingDirectory } from '@multivac/contracts';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { multivacProcessing } from '../assistant/sidebar-collapse.js';
import { entryList } from './entry-list.js';
import { moveFilesNote } from './move-to-project.js';
import { WORKING_DIRECTORY_KINDS, workingDirectoryRule } from './working-directory.js';

/**
 * 归入项目确认卡的共用内容：目录从哪里换到哪里、之后的执行边界、记住的授权如何适用、临时目录里的文件是否一并移入，
 * 以及运行中先停止的说明。界面上的归入项目卡（标题栏菜单、会话列表、管理 · 会话页）与 Multivac 在对话中提出的
 * 归入项目卡都用这里，两条路径的内容一致；“文件”一栏的勾选是用户在卡上的选择。
 */

/** 会话运行中（含等待授权）时卡片上的说明：确认不可用，需要先停止。 */
export const MOVE_RUNNING_WARNING = '这个会话正在运行（或在等待你的授权）。请先停止这一轮，再归入项目。';

export function MoveRunningWarning() {
  return (
    <p className="move-warning" role="status">
      <Pause aria-hidden="true" />
      {MOVE_RUNNING_WARNING}
    </p>
  );
}

/**
 * 会话此刻是否在运行（含等待授权），取自会话的实时状态：卡片显示期间保持该会话的订阅，状态变化随即反映在卡上。
 * 尚未读到时为 null，由调用方用服务端核对的结果代替。最终以服务端在会话互斥区内的判定为准。
 */
export function useLiveRunning(sessionId: string): boolean | null {
  const live = useAssistantSession(sessionId)?.session;
  return live?.status === 'ready' ? multivacProcessing(live) : null;
}

interface MoveChangeFieldsProps {
  /** 归入的项目名称。 */
  targetName: string;
  /** 会话原来所在的项目名称（授权说明写明它的“本项目内”不再适用）；原来不在项目中时为 null。 */
  sourceProjectName: string | null;
  /** 服务端的归入前核对；还没有结果时为 null。 */
  preview: SessionMovePreview | null;
  /** 还没有核对结果时“目录”一栏显示的内容（正在核对、没能核对）。 */
  pending: ReactNode;
  /** 用户在卡上是否勾选“一并移入”。 */
  moveFiles: boolean;
  onMoveFilesChange: (moveFiles: boolean) => void;
  disabled: boolean;
}

/** 归入项目卡的两列字段（`<dl>` 中的若干 `<div><dt/><dd/></div>`）：目录、边界、授权，原目录是临时目录时还有文件。 */
export function MoveChangeFields({
  targetName, sourceProjectName, preview, pending, moveFiles, onMoveFilesChange, disabled,
}: MoveChangeFieldsProps) {
  const files = preview?.files ?? null;
  // 留在原临时目录的文件从归入时起按偏好的保留时长到期移到废纸篓；原临时目录正被使用时保留原处、不会被清理。
  const retentionDays = preview?.tempRetentionDays ?? null;
  const sourceInUse = preview?.sourceInUse ?? false;
  return (
    <>
      <div>
        <dt>目录</dt>
        <dd className="move-change" aria-live="polite">
          {preview ? (
            <>
              <DirectoryChange label="现在" directory={preview.from} />
              <ArrowDown aria-hidden="true" />
              <DirectoryChange label="归入后" directory={preview.to} />
            </>
          ) : pending}
        </dd>
      </div>
      <div>
        <dt>边界</dt>
        <dd>
          之后按「{targetName}」的项目目录执行：{workingDirectoryRule(preview?.to.kind ?? 'project-managed')}
          原来的目录对这个会话来说也成了目录外。
        </dd>
      </div>
      <div>
        <dt>授权</dt>
        <dd>
          本会话内记住的授权继续有效；「{targetName}」中“本项目内始终允许”的授权随即适用
          {sourceProjectName ? `，「${sourceProjectName}」的不再适用` : ''}。
        </dd>
      </div>
      {files && (
        <div>
          <dt>文件</dt>
          <dd>
            {files.total === 0 ? moveFilesNote({ files, moveFiles, retentionDays, sourceInUse }) : (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={moveFiles}
                    disabled={disabled}
                    onChange={(event) => onMoveFilesChange(event.target.checked)}
                  />
                  <span>把临时目录里的 {files.total} 项一并移入项目目录</span>
                </label>
                <small className="move-files">{entryList(files.names, files.total)}</small>
                <small className="move-files">{moveFilesNote({ files, moveFiles, retentionDays, sourceInUse })}</small>
              </>
            )}
          </dd>
        </div>
      )}
    </>
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
