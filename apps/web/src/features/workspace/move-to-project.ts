import type { Project, SessionMoveResult, WorkingDirectory, Workspace, WorkspaceSession } from '@multivac/contracts';

/**
 * 归入项目的文案与候选，与界面无关，便于单独测试。
 *
 * 规则（与服务端一致）：
 * - 只在会话空闲时归入；运行中（含等待授权）先停止。
 * - 归入后会话在项目主目录中继续，id 与对话历史不变；原目录对这个会话来说成了目录外。
 * - 原工作目录是临时目录时可以把其中的文件一并移入：按第一层条目移动，项目目录中已有同名的不覆盖、留在原处；
 *   原临时目录为空（或已全部移入）时删除，仍有文件时保留。
 */

export type ProjectWorkspace = Workspace & { project: Project };

/** 可以归入的项目：全部项目工作区，按工作区列表的顺序，除去会话当前所在的那个。 */
export function moveTargets(workspaces: readonly Workspace[], session: Pick<WorkspaceSession, 'workspaceId'>): ProjectWorkspace[] {
  return workspaces.filter((workspace): workspace is ProjectWorkspace =>
    workspace.project !== null && workspace.workspaceId !== session.workspaceId);
}

/** 条目名的简短列表：最多列出 max 个，其余只说数量，如“a、b、c 等 12 项”。 */
export function entryList(names: readonly string[], total: number, max = 5): string {
  const shown = names.slice(0, max).join('、');
  return total > Math.min(names.length, max) ? `${shown} 等 ${total} 项` : shown;
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
  if (files && files.moved > 0) parts.push(`${files.moved} 项已移入项目目录。`);
  if (files && files.skippedTotal > 0) {
    parts.push(`${entryList(files.skipped, files.skippedTotal)} 与项目目录中已有的同名或没能移动，留在原临时目录 ${from.path}。`);
  } else if (!files && from.kind === 'session-temp' && !result.sourceRemoved) {
    parts.push(`临时目录里的文件留在原处：${from.path}。`);
  }
  if (result.sourceRemoved) parts.push('空的临时目录已删除。');
  return parts.join('');
}
