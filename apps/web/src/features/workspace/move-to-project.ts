import {
  SOURCE_IN_USE_NOTE,
  type Project,
  type SessionMoveResult,
  type SessionTempEntries,
  type TempRetentionDays,
  type WorkingDirectory,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import { entryList } from './entry-list.js';
import { retentionOutcome } from './temp-retention.js';

export { entryList };

/**
 * 归入项目的文案与候选，与界面无关，便于单独测试。
 *
 * 规则（与服务端一致）：
 * - 只在会话空闲时归入；运行中（含等待授权）先停止。
 * - 归入后会话在项目主目录中继续，id 与对话历史不变；原目录对这个会话来说成了目录外。
 * - 原工作目录是临时目录时可以把其中的文件一并移入：按第一层条目移动，项目目录中已有同名的不覆盖、留在原处；
 *   原临时目录为空（或已全部移入）时删除，仍有文件时保留，从归入时起按偏好的保留时长到期移到废纸篓；
 *   原临时目录正被项目（挂载为项目目录）或其他会话使用时（sourceInUse）保留原处，不删除也不清理。
 */

export type ProjectWorkspace = Workspace & { project: Project };

/** 可以归入的项目：全部项目工作区，按工作区列表的顺序，除去会话当前所在的那个。 */
export function moveTargets(workspaces: readonly Workspace[], session: Pick<WorkspaceSession, 'workspaceId'>): ProjectWorkspace[] {
  return workspaces.filter((workspace): workspace is ProjectWorkspace =>
    workspace.project !== null && workspace.workspaceId !== session.workspaceId);
}


/** 归入完成后的说明：去了哪里、文件移入了多少、哪些留在原处，以及原临时目录的去留。 */
export function moveResultText(input: {
  title: string;
  projectName: string;
  from: WorkingDirectory;
  result: SessionMoveResult;
}): string {
  const { title, projectName, from, result } = input;
  const parts = [`已把「${title}」归入「${projectName}」，之后在项目目录中继续。`];
  const files = result.files;
  // 原临时目录正被项目或其他会话使用：保留原处、不会被清理，保留时长对它不适用。
  const inUse = from.kind === 'session-temp' && result.sourceInUse === true;
  if (files && files.moved > 0) parts.push(`${files.moved} 项已移入项目目录。`);
  const later = `从现在起${retentionOutcome(result.tempRetentionDays)}`;
  if (files && files.skippedTotal > 0) {
    const skipped = `${entryList(files.skipped, files.skippedTotal)} 与项目目录中已有的同名或没能移动，留在原临时目录`;
    parts.push(inUse ? `${skipped}。` : `${skipped} ${from.path}，${later}。`);
  } else if (!files && from.kind === 'session-temp' && !result.sourceRemoved && !inUse) {
    parts.push(`临时目录里的文件留在原处：${from.path}，${later}。`);
  }
  if (inUse) parts.push(`原临时目录 ${from.path} ${SOURCE_IN_USE_NOTE}。`);
  if (result.sourceRemoved) parts.push('空的临时目录已删除。');
  return parts.join('');
}

/**
 * 归入卡上“文件”一栏的说明：按是否移入、有没有同名，写明文件与原临时目录的去留。
 * 原临时目录正被项目或其他会话使用时（sourceInUse）写明保留原处、不会被清理，不说删除或到期移到废纸篓。
 */
export function moveFilesNote(input: {
  files: SessionTempEntries;
  moveFiles: boolean;
  retentionDays: TempRetentionDays;
  sourceInUse: boolean;
}): string {
  const { files, moveFiles, retentionDays, sourceInUse } = input;
  const kept = `原临时目录${SOURCE_IN_USE_NOTE}。`;
  const later = `从归入时起${retentionOutcome(retentionDays)}。`;
  if (files.total === 0) return sourceInUse ? `临时目录是空的；${kept}` : '临时目录是空的，归入后删除。';
  if (!moveFiles) return `不移入：文件留在原临时目录，不再是会话的工作目录；${sourceInUse ? kept : later}`;
  if (files.conflictTotal > 0) {
    const conflicts = `${entryList(files.conflicts, files.conflictTotal)} 与项目目录中已有的同名，不覆盖，留在原临时目录`;
    return sourceInUse ? `${conflicts}；${kept}` : `${conflicts}，原临时目录随之保留，${later}`;
  }
  return sourceInUse ? `同名的不会覆盖；全部移入后，${kept}` : '同名的不会覆盖；全部移入后删除空的临时目录。';
}
