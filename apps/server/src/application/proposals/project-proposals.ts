import {
  CREATE_PROJECT_PROPOSAL_KIND,
  CreateProjectProposalPayloadSchema,
  INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH,
  INTERNAL_TOOL_RECEIPT_HEADLINE_MAX_LENGTH,
  MOUNT_DIRECTORY_PROPOSAL_KIND,
  MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND,
  MoveSessionToProjectOptionsSchema,
  MoveSessionToProjectProposalPayloadSchema,
  ProjectDirectoryProposalPayloadSchema,
  SET_PRIMARY_DIRECTORY_PROPOSAL_KIND,
  SOURCE_IN_USE_NOTE,
  UNMOUNT_DIRECTORY_PROPOSAL_KIND,
  type AssistantToolObjectRef,
  type CreateProject,
  type CreateProjectProposalPayload,
  type CreateProjectProposalPreview,
  type MountDirectoryProposalPreview,
  type MoveSessionToProjectProposalPreview,
  type Project,
  type ProjectDirectory,
  type ProjectDirectoryKind,
  type SessionMoveResult,
  type SessionTempEntries,
  type SetPrimaryDirectoryProposalPreview,
  type TempRetentionDays,
  type UnmountDirectoryProposalPreview,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { defineProposalKind, ProposalExecutionError, type ProposalKind } from '../../modules/proposals/proposal.js';
import { clip, projectLink, projectRef, sessionRef } from '../internal-tools/tool-text.js';
import { ProjectServiceError, type ProjectService } from '../project-service.js';
import { WorkspaceSessionServiceError, type WorkspaceSessionService } from '../workspace-session-service.js';

/**
 * 项目与归入项目的提议种类（执行器）：新建项目、挂载 / 卸载目录、设主目录、会话归入项目。
 *
 * 它们都改变会话能自动执行的范围，只在用户于对话中的确认卡上确认、按当前状态重新校验通过后执行。
 * 校验与执行调用界面同一套服务（`ProjectService` 的新建前核对与更新、`WorkspaceSessionService` 的归入前核对与归入），
 * 不另写规则：
 * - prepare：对象不存在（项目、会话、目录不在项目中）等无法提出的情况工具失败、不生成卡片；
 *   可以提出但目前不能执行的（非法目录、重名、只剩一个目录等），卡片写明服务端给出的原因、不能确认；
 * - revalidate：确认时再按同一套规则核对一次，并与提出时的预览比较，目标已变化即过期、不执行；
 * - execute：执行时服务本身还会再校验一次（例如归入时在会话互斥区内复核没有在运行）。
 * 执行参数只来自提议记录（模型提出时的参数快照与服务端的预览）和用户在卡上的选择。
 */

export interface ProjectProposalDependencies {
  projects: Pick<
    ProjectService,
    | 'getProject' | 'previewProject' | 'createProject' | 'previewDirectories' | 'normalizeDirectoryPath'
    | 'directoryOwner' | 'updateProject'
  >;
}

export interface MoveSessionProposalDependencies {
  sessions: Pick<WorkspaceSessionService, 'get' | 'isRunning' | 'previewMoveToProject' | 'moveToProject'>;
  /** 全部工作区：卡片写明会话原来在哪里、归入哪个项目。 */
  workspaces: () => readonly Workspace[];
}

/** 项目目录类型的称呼（与界面新建项目卡、设置 · 项目同一口径）。 */
const PROJECT_DIRECTORY_LABELS: Readonly<Record<ProjectDirectoryKind, string>> = {
  managed: '项目托管目录',
  mounted: '挂载目录',
};

/** 修改目录的影响（与设置 · 项目同一句）。 */
const DIRECTORY_CHANGE_NOTE = '修改目录只影响之后新建的会话；已有会话继续使用创建时的工作目录。';

const RUNNING_REASON = '会话正在运行（或在等待授权），请先停止这一轮，再归入项目。';

function workspaceRef(project: Pick<Project, 'projectId' | 'name'>): AssistantToolObjectRef {
  return { kind: 'workspace', workspaceId: project.projectId, label: project.name };
}

/** 回执的标题与补充按回执允许的长度截断（路径可能很长），超出的部分以省略号结尾。 */
function receiptHeadline(text: string): string {
  return clip(text, INTERNAL_TOOL_RECEIPT_HEADLINE_MAX_LENGTH - 1);
}

function receiptDetail(text: string): string {
  return clip(text, INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH - 1);
}

function directoryText(directory: Pick<ProjectDirectory, 'kind' | 'path'>): string {
  return `${PROJECT_DIRECTORY_LABELS[directory.kind]} ${directory.path}`;
}

/** 执行时服务给出的中文原因写进结果；其他异常交给提议服务给出通用说明。 */
function executionError(error: unknown): never {
  if (error instanceof ProjectServiceError || error instanceof WorkspaceSessionServiceError) {
    throw new ProposalExecutionError(error.message);
  }
  throw error;
}

/** 提出时按 id 读取项目；不存在时工具失败，不生成卡片。 */
function requireProject(dependencies: ProjectProposalDependencies, projectId: string, action: string): Project {
  try {
    return dependencies.projects.getProject(projectId);
  } catch (error) {
    if (error instanceof ProjectServiceError) {
      throw new InternalToolError(`没有提出${action}：没有 id 为 ${projectId} 的项目。可以先用 list_projects 查看项目 id。`);
    }
    throw error;
  }
}

/** 确认时读取项目；已不存在时返回 null（提议过期）。 */
function currentProject(dependencies: ProjectProposalDependencies, projectId: string): Project | null {
  try {
    return dependencies.projects.getProject(projectId);
  } catch (error) {
    if (error instanceof ProjectServiceError) return null;
    throw error;
  }
}

/**
 * 在项目已有的目录中按路径找到一个（路径按项目目录的写法规范化后比较）。路径不合法或不在项目中时工具失败，
 * 写明项目现有的目录，便于模型改正。
 */
function requireProjectDirectory(
  dependencies: ProjectProposalDependencies,
  project: Project,
  rawPath: string,
  action: string,
): { directory: ProjectDirectory; index: number } {
  let path: string;
  try {
    path = dependencies.projects.normalizeDirectoryPath(rawPath);
  } catch (error) {
    if (error instanceof ProjectServiceError) throw new InternalToolError(`没有提出${action}：${error.message}`);
    throw error;
  }
  const index = project.directories.findIndex((directory) => directory.path === path);
  if (index < 0) {
    const existing = project.directories.map((directory) => directory.path).join('、');
    throw new InternalToolError(`没有提出${action}：项目「${project.name}」中没有目录 ${path}。它现在的目录：${existing}。`);
  }
  return { directory: project.directories[index]!, index };
}

/** 确认时目录在项目中的位置；已不在项目中时为 -1。 */
function directoryIndex(project: Project, path: string): number {
  return project.directories.findIndex((directory) => directory.path === path);
}

function paths(project: Project): string[] {
  return project.directories.map((directory) => directory.path);
}

// ---------- 新建项目 ----------

function createInput(payload: CreateProjectProposalPayload): CreateProject {
  return { name: payload.name, ...(payload.directory === null ? {} : { directory: payload.directory }) };
}

/**
 * 新建项目：与界面“新建项目…”同一套核对（`previewProject`）。目录已是某个项目的目录时不生成卡片，
 * 直接说明它已经在那个项目里、不用重复创建；其他不合法的目录与名称在卡上写明原因、不能确认。
 * 确认时再核对一次，将使用的名称或目录（如托管目录的重名序号）与卡上不同即过期。
 */
export function createProjectKind(dependencies: ProjectProposalDependencies): ProposalKind {
  return defineProposalKind<typeof CreateProjectProposalPayloadSchema, CreateProjectProposalPreview>({
    kind: CREATE_PROJECT_PROPOSAL_KIND,
    payload: CreateProjectProposalPayloadSchema,
    prepare(payload) {
      if (payload.directory !== null) {
        const owner = dependencies.projects.directoryOwner(payload.directory);
        if (owner) {
          throw new InternalToolError(`没有提出新建项目：${payload.directory.trim()} 已经是项目 ${projectLink(owner)}` +
            `（id: ${owner.projectId}）的目录，不用重复创建。可以直接在这个项目的工作区里工作，或把会话归入它。`);
        }
      }
      const name = payload.name.trim() || payload.name;
      try {
        const preview = dependencies.projects.previewProject(createInput(payload));
        return { title: `新建项目「${preview.name}」`, preview: { name: preview.name, directory: preview.directory } };
      } catch (error) {
        if (!(error instanceof ProjectServiceError)) throw error;
        return {
          title: `新建项目「${name}」`,
          preview: {
            name,
            directory: payload.directory === null
              ? { kind: 'managed', path: null }
              : { kind: 'mounted', path: payload.directory.trim() || payload.directory },
          },
          problem: error.message,
        };
      }
    },
    revalidate(payload, preview) {
      let next;
      try {
        next = dependencies.projects.previewProject(createInput(payload));
      } catch (error) {
        if (error instanceof ProjectServiceError) return error.message;
        throw error;
      }
      if (next.name !== preview.name) return `项目名称将是「${next.name}」，与卡上的「${preview.name}」不同。`;
      if (next.directory.kind !== preview.directory.kind || next.directory.path !== preview.directory.path) {
        return `将使用的目录已变为 ${directoryText(next.directory)}（卡上是 ${preview.directory.path ?? '未能核对的目录'}）。`;
      }
      return null;
    },
    execute(payload, _preview, origin) {
      let created;
      try {
        created = dependencies.projects.createProject(createInput(payload), origin);
      } catch (error) {
        executionError(error);
      }
      const { project } = created;
      const primary = project.directories[0]!;
      return {
        summary: `已创建项目「${project.name}」`,
        refs: [projectRef(project), workspaceRef(project)],
        receipt: {
          headline: receiptHeadline(`已创建项目「${project.name}」`),
          detail: receiptDetail(`同名工作区已就绪；目录：${directoryText(primary)}，目录内的修改将自动执行`),
          actions: [
            { kind: 'open-workspace', workspaceId: project.projectId },
            { kind: 'open-project', projectId: project.projectId },
          ],
        },
      };
    },
  });
}

// ---------- 挂载目录 ----------

/**
 * 挂载目录：与设置 · 项目的挂载同一套校验（挂载后的全部目录交给 `previewDirectories`，即更新接口的校验）。
 * 不合法的目录（不存在、根目录、已在本项目或其他项目中等）卡上写明原因、不能确认；确认时目录已被别处挂载等即过期。
 */
export function mountDirectoryKind(dependencies: ProjectProposalDependencies): ProposalKind {
  return defineProposalKind<typeof ProjectDirectoryProposalPayloadSchema, MountDirectoryProposalPreview>({
    kind: MOUNT_DIRECTORY_PROPOSAL_KIND,
    payload: ProjectDirectoryProposalPayloadSchema,
    prepare(payload) {
      const project = requireProject(dependencies, payload.projectId, '挂载目录');
      const raw = payload.directory.trim() || payload.directory;
      const title = `把 ${raw} 挂载到项目「${project.name}」`;
      const refs = [projectRef(project)];
      try {
        const mounted = dependencies.projects.previewDirectories(project.projectId, [...paths(project), raw]).at(-1)!;
        return { title, preview: { projectName: project.name, directory: mounted }, refs };
      } catch (error) {
        if (!(error instanceof ProjectServiceError)) throw error;
        return { title, preview: { projectName: project.name, directory: { kind: 'mounted', path: raw } }, problem: error.message, refs };
      }
    },
    revalidate(payload, preview) {
      const project = currentProject(dependencies, payload.projectId);
      if (!project) return `项目「${preview.projectName}」已不存在。`;
      let mounted: ProjectDirectory;
      try {
        mounted = dependencies.projects.previewDirectories(project.projectId, [...paths(project), payload.directory]).at(-1)!;
      } catch (error) {
        if (error instanceof ProjectServiceError) return error.message;
        throw error;
      }
      if (mounted.path !== preview.directory.path) return `要挂载的目录已变为 ${mounted.path}（卡上是 ${preview.directory.path}）。`;
      return null;
    },
    execute(payload, _preview, origin) {
      let updated;
      try {
        const project = dependencies.projects.getProject(payload.projectId);
        updated = dependencies.projects.updateProject(project.projectId, { directories: [...paths(project), payload.directory] }, origin);
      } catch (error) {
        executionError(error);
      }
      const { project } = updated;
      const mounted = project.directories.at(-1)!;
      return {
        summary: `已把 ${mounted.path} 挂载到「${project.name}」`,
        refs: [projectRef(project)],
        receipt: {
          headline: receiptHeadline(`已把目录挂载到「${project.name}」`),
          detail: receiptDetail(`${mounted.path}；目录内的修改将自动执行。${DIRECTORY_CHANGE_NOTE}`),
          actions: [{ kind: 'open-project', projectId: project.projectId }],
        },
      };
    },
  });
}

// ---------- 卸载目录 ----------

/**
 * 卸载目录：只解除项目与目录的关系，目录本身不删除；至少保留一个目录（只剩它一个时卡上写明、不能确认）。
 * 卸载主目录时由下一个目录接替；确认时主目录的关系与卡上不同即过期。
 */
export function unmountDirectoryKind(dependencies: ProjectProposalDependencies): ProposalKind {
  return defineProposalKind<typeof ProjectDirectoryProposalPayloadSchema, UnmountDirectoryProposalPreview>({
    kind: UNMOUNT_DIRECTORY_PROPOSAL_KIND,
    payload: ProjectDirectoryProposalPayloadSchema,
    prepare(payload) {
      const project = requireProject(dependencies, payload.projectId, '卸载目录');
      const { directory, index } = requireProjectDirectory(dependencies, project, payload.directory, '卸载目录');
      const primary = index === 0;
      return {
        title: `从项目「${project.name}」卸载 ${directory.path}`,
        preview: {
          projectName: project.name,
          directory,
          primary,
          nextPrimary: primary ? project.directories[1] ?? null : null,
        },
        problem: project.directories.length === 1 ? '项目至少保留一个目录；要换目录，先挂载新目录再卸载这个。' : null,
        refs: [projectRef(project)],
      };
    },
    revalidate(payload, preview) {
      const project = currentProject(dependencies, payload.projectId);
      if (!project) return `项目「${preview.projectName}」已不存在。`;
      const index = directoryIndex(project, preview.directory.path);
      if (index < 0) return `${preview.directory.path} 已不在项目「${project.name}」中。`;
      if (project.directories.length === 1) return '项目只剩这一个目录，至少要保留一个目录。';
      if ((index === 0) !== preview.primary) {
        return preview.primary ? '它已经不是主目录了。' : '它已经成为主目录，卸载后接替的目录与卡上不同。';
      }
      if (preview.primary && project.directories[1]!.path !== preview.nextPrimary?.path) {
        return `卸载后接替的主目录将是 ${project.directories[1]!.path}，与卡上不同。`;
      }
      return null;
    },
    execute(payload, preview, origin) {
      let updated;
      try {
        const project = dependencies.projects.getProject(payload.projectId);
        const remaining = paths(project).filter((path) => path !== preview.directory.path);
        updated = dependencies.projects.updateProject(project.projectId, { directories: remaining }, origin);
      } catch (error) {
        executionError(error);
      }
      const { project } = updated;
      return {
        summary: `已从「${project.name}」卸载 ${preview.directory.path}`,
        refs: [projectRef(project)],
        receipt: {
          headline: receiptHeadline(`已从「${project.name}」卸载目录`),
          detail: receiptDetail([
            `${preview.directory.path}；目录本身和其中的文件没有删除，之后可以重新挂载`,
            ...(preview.primary ? [`主目录改为 ${project.directories[0]!.path}`] : []),
            '已有会话继续使用创建时的工作目录',
          ].join('；')),
          actions: [{ kind: 'open-project', projectId: project.projectId }],
        },
      };
    },
  });
}

// ---------- 设主目录 ----------

/** 设主目录：项目中新建的会话在主目录中工作；已是主目录时卡上写明、不能确认；确认时主目录已换过即过期。 */
export function setPrimaryDirectoryKind(dependencies: ProjectProposalDependencies): ProposalKind {
  return defineProposalKind<typeof ProjectDirectoryProposalPayloadSchema, SetPrimaryDirectoryProposalPreview>({
    kind: SET_PRIMARY_DIRECTORY_PROPOSAL_KIND,
    payload: ProjectDirectoryProposalPayloadSchema,
    prepare(payload) {
      const project = requireProject(dependencies, payload.projectId, '设主目录');
      const { directory, index } = requireProjectDirectory(dependencies, project, payload.directory, '设主目录');
      return {
        title: `把 ${directory.path} 设为项目「${project.name}」的主目录`,
        preview: { projectName: project.name, directory, previousPrimary: project.directories[0]! },
        problem: index === 0 ? `它已经是项目「${project.name}」的主目录。` : null,
        refs: [projectRef(project)],
      };
    },
    revalidate(payload, preview) {
      const project = currentProject(dependencies, payload.projectId);
      if (!project) return `项目「${preview.projectName}」已不存在。`;
      const index = directoryIndex(project, preview.directory.path);
      if (index < 0) return `${preview.directory.path} 已不在项目「${project.name}」中。`;
      if (index === 0) return '它已经是主目录了。';
      if (project.directories[0]!.path !== preview.previousPrimary.path) {
        return `主目录已换为 ${project.directories[0]!.path}（卡上是 ${preview.previousPrimary.path}）。`;
      }
      return null;
    },
    execute(payload, preview, origin) {
      let updated;
      try {
        const project = dependencies.projects.getProject(payload.projectId);
        const others = paths(project).filter((path) => path !== preview.directory.path);
        updated = dependencies.projects.updateProject(project.projectId, { directories: [preview.directory.path, ...others] }, origin);
      } catch (error) {
        executionError(error);
      }
      const { project } = updated;
      return {
        summary: `「${project.name}」的主目录改为 ${preview.directory.path}`,
        refs: [projectRef(project)],
        receipt: {
          headline: receiptHeadline(`「${project.name}」的主目录已改为 ${preview.directory.path}`),
          detail: receiptDetail(`项目中新建的会话在这个目录中工作；${DIRECTORY_CHANGE_NOTE}`),
          actions: [{ kind: 'open-project', projectId: project.projectId }],
        },
      };
    },
  });
}

// ---------- 会话归入项目 ----------

/** 两次核对的临时目录条目是否相同（用户在卡上看到的就是将要移入的）。 */
function sameEntries(left: SessionTempEntries | null, right: SessionTempEntries | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function retentionOutcome(days: TempRetentionDays): string {
  return days === null ? '一直保留（偏好为从不清理）' : `保留 ${days} 天后移到废纸篓`;
}

/** 归入结果的一句补充（与界面归入后的提示同一内容）：在哪里继续、文件移入与留下、原临时目录的去留。 */
function moveResultDetail(result: SessionMoveResult, preview: MoveSessionToProjectProposalPreview): string {
  const { from, to } = preview.move;
  const parts = [`之后在项目目录 ${to.path} 中继续，对话历史不变`];
  // 原临时目录正被项目或其他会话使用：保留原处、不会被清理，保留时长对它不适用。
  const inUse = from.kind === 'session-temp' && result.sourceInUse === true;
  const later = `从现在起${retentionOutcome(result.tempRetentionDays)}`;
  if (result.files && result.files.moved > 0) parts.push(`${result.files.moved} 项已移入项目目录`);
  if (result.files && result.files.skippedTotal > 0) {
    parts.push(inUse
      ? `${result.files.skippedTotal} 项与项目目录中已有的同名或没能移动，留在原临时目录`
      : `${result.files.skippedTotal} 项与项目目录中已有的同名或没能移动，留在原临时目录 ${from.path}，${later}`);
  } else if (!result.files && from.kind === 'session-temp' && !result.sourceRemoved && !inUse) {
    parts.push(`临时目录里的文件留在原处：${from.path}，${later}`);
  }
  if (inUse) parts.push(`原临时目录 ${from.path} ${SOURCE_IN_USE_NOTE}`);
  if (result.sourceRemoved) parts.push('空的临时目录已删除');
  return parts.join('；');
}

/**
 * 会话归入项目：与界面归入项目卡同一份核对（`previewMoveToProject`）与同一次归入（`moveToProject`）。
 * 临时目录里的文件是否一并移入由用户在卡上勾选（模型的 moveFiles 只是默认值）。
 * 会话运行中（含等待授权）时卡片按会话的实时状态不能确认；确认时仍在运行、已归档、已被移走、
 * 项目主目录已变化，或要移入的文件与卡上列出的不同，都按过期处理、不执行；归入时服务还会在会话互斥区内再判一次。
 */
export function moveSessionToProjectKind(dependencies: MoveSessionProposalDependencies): ProposalKind {
  const workspaceNamed = (workspaceId: string) =>
    dependencies.workspaces().find((workspace) => workspace.workspaceId === workspaceId);
  const readSession = (sessionId: string): WorkspaceSession | null => {
    try {
      return dependencies.sessions.get(sessionId);
    } catch (error) {
      if (error instanceof WorkspaceSessionServiceError) return null;
      throw error;
    }
  };

  return defineProposalKind<
    typeof MoveSessionToProjectProposalPayloadSchema,
    MoveSessionToProjectProposalPreview,
    typeof MoveSessionToProjectOptionsSchema
  >({
    kind: MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND,
    payload: MoveSessionToProjectProposalPayloadSchema,
    options: MoveSessionToProjectOptionsSchema,
    prepare(payload) {
      let session: WorkspaceSession;
      try {
        session = dependencies.sessions.get(payload.sessionId);
      } catch (error) {
        if (error instanceof WorkspaceSessionServiceError && error.code === 'NOT_FOUND') {
          throw new InternalToolError(`没有提出归入项目：没有 id 为 ${payload.sessionId} 的会话。可以先用 list_sessions 查找会话 id。`);
        }
        if (error instanceof WorkspaceSessionServiceError) {
          throw new InternalToolError(`没有提出归入项目：${error.message}只有工作会话可以归入项目。`);
        }
        throw error;
      }
      if (session.archivedAt !== null) {
        throw new InternalToolError(`没有提出归入项目：会话「${session.title}」已归档，已归档的会话不能归入项目。` +
          '可以先用 restore_session 恢复它。');
      }
      const target = workspaceNamed(payload.projectId);
      let move;
      try {
        move = dependencies.sessions.previewMoveToProject(session.sessionId, payload.projectId);
      } catch (error) {
        if (error instanceof WorkspaceSessionServiceError && error.code === 'NOT_FOUND') {
          throw new InternalToolError(`没有提出归入项目：没有 id 为 ${payload.projectId} 的项目。可以先用 list_projects 查看项目 id。`);
        }
        if (error instanceof WorkspaceSessionServiceError) throw new InternalToolError(`没有提出归入项目：${error.message}`);
        throw error;
      }
      const from = workspaceNamed(session.workspaceId);
      const projectName = target?.name ?? payload.projectId;
      return {
        title: `把「${session.title}」归入项目「${projectName}」`,
        preview: {
          sessionTitle: session.title,
          projectName,
          fromWorkspaceId: session.workspaceId,
          fromWorkspaceName: from?.name ?? session.workspaceId,
          fromProject: Boolean(from?.project),
          move,
        },
        refs: [sessionRef(session), { kind: 'project', projectId: payload.projectId, label: projectName }],
      };
    },
    revalidate(payload, preview, options) {
      const session = readSession(payload.sessionId);
      if (!session) return `会话「${preview.sessionTitle}」已不存在。`;
      if (session.archivedAt !== null) return `会话「${session.title}」已归档。`;
      if (session.workspaceId !== preview.fromWorkspaceId) {
        return `会话「${session.title}」已不在「${preview.fromWorkspaceName}」中（提出之后被移动过）。`;
      }
      let current;
      try {
        current = dependencies.sessions.previewMoveToProject(session.sessionId, payload.projectId);
      } catch (error) {
        if (error instanceof WorkspaceSessionServiceError) return error.message;
        throw error;
      }
      if (current.to.path !== preview.move.to.path) {
        return `项目「${preview.projectName}」的主目录已变为 ${current.to.path}（卡上是 ${preview.move.to.path}）。`;
      }
      if (current.from.path !== preview.move.from.path) return `会话的工作目录已变为 ${current.from.path}，与卡上不同。`;
      if (dependencies.sessions.isRunning(session.sessionId)) return RUNNING_REASON;
      if (options.moveFiles && (preview.move.files?.total ?? 0) > 0 && !sameEntries(current.files, preview.move.files)) {
        return `临时目录里的文件在提出之后有变化（现在 ${current.files?.total ?? 0} 项），为避免移入卡上没有列出的文件，没有执行。` +
          '可以请 Multivac 重新提出。';
      }
      return null;
    },
    async execute(payload, preview, origin, options) {
      // 用户在卡上的选择；临时目录里本来没有文件时不起作用。
      const moveFiles = options.moveFiles && (preview.move.files?.total ?? 0) > 0;
      let result: SessionMoveResult;
      try {
        result = await dependencies.sessions.moveToProject(payload.sessionId, { projectId: payload.projectId, moveFiles }, origin);
      } catch (error) {
        if (error instanceof WorkspaceSessionServiceError && error.code === 'COMMAND_STATE_MISMATCH') {
          throw new ProposalExecutionError(RUNNING_REASON);
        }
        executionError(error);
      }
      const session = result.session;
      return {
        summary: `已把「${session.title}」归入「${preview.projectName}」`,
        refs: [sessionRef(session), { kind: 'project', projectId: payload.projectId, label: preview.projectName }],
        receipt: {
          headline: receiptHeadline(`已把「${session.title}」归入「${preview.projectName}」`),
          detail: receiptDetail(moveResultDetail(result, preview)),
          actions: [{ kind: 'open-session', sessionId: session.sessionId }],
        },
      };
    },
  });
}
