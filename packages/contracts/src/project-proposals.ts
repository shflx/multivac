import { Type } from 'typebox';
import {
  PROJECT_NAME_MAX_LENGTH,
  ProjectDirectoryKindSchema,
  ProjectDirectorySchema,
  ProjectIdSchema,
} from './project.js';
import { SessionMovePreviewSchema, WorkspaceSessionIdSchema } from './workspace-session.js';

/**
 * 项目与归入项目的提议（全局 Multivac 在对话中提出、用户在确认卡上确认后执行）：新建项目、挂载 / 卸载目录、
 * 设主目录、会话归入项目。它们都扩大（或改变）会话能自动执行的范围，只能由用户确认；
 * 校验规则与界面上的新建项目卡、设置 · 项目、归入项目卡完全一致，卡片内容也复用界面上的同一部分。
 *
 * payload 是模型给出的参数快照（确认时据此重新校验与执行），preview 是提出时服务端核对得到的预览，
 * options 是用户在卡上的选择（只有归入项目有：是否一并移入临时目录里的文件）。
 */

export const CREATE_PROJECT_PROPOSAL_KIND = 'project.create';
export const MOUNT_DIRECTORY_PROPOSAL_KIND = 'project.mount_directory';
export const UNMOUNT_DIRECTORY_PROPOSAL_KIND = 'project.unmount_directory';
export const SET_PRIMARY_DIRECTORY_PROPOSAL_KIND = 'project.set_primary_directory';
export const MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND = 'session.move_to_project';

/** 模型给出的目录路径（绝对路径或 `~/…`，由服务端规范化与校验）。 */
const DirectoryInput = Type.String({ minLength: 1, maxLength: 4_096 });
const Name = Type.String({ minLength: 1 });

/** 新建项目：名称与可选的挂载目录（null 表示创建托管目录）。 */
export const CreateProjectProposalPayloadSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_LENGTH }),
    directory: Type.Union([DirectoryInput, Type.Null()]),
  },
  { additionalProperties: false },
);
export type CreateProjectProposalPayload = Type.Static<typeof CreateProjectProposalPayloadSchema>;

/**
 * 新建项目的预览：将使用的名称与目录（与界面“新建项目…”的核对同一结果：托管目录含重名后缀，挂载目录是规范化后的路径）。
 * 核对不通过时（卡片写明原因、不能确认）path 为输入的路径，托管目录的路径无法给出时为 null。
 */
export const CreateProjectProposalPreviewSchema = Type.Object(
  {
    name: Name,
    directory: Type.Object(
      { kind: ProjectDirectoryKindSchema, path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type CreateProjectProposalPreview = Type.Static<typeof CreateProjectProposalPreviewSchema>;

/** 挂载、卸载、设主目录：哪个项目、哪个目录。 */
export const ProjectDirectoryProposalPayloadSchema = Type.Object(
  { projectId: ProjectIdSchema, directory: DirectoryInput },
  { additionalProperties: false },
);
export type ProjectDirectoryProposalPayload = Type.Static<typeof ProjectDirectoryProposalPayloadSchema>;

/** 挂载的预览：项目名称与将挂载的目录（规范化后的路径；核对不通过时为输入的路径）。 */
export const MountDirectoryProposalPreviewSchema = Type.Object(
  { projectName: Name, directory: ProjectDirectorySchema },
  { additionalProperties: false },
);
export type MountDirectoryProposalPreview = Type.Static<typeof MountDirectoryProposalPreviewSchema>;

/**
 * 卸载的预览：要卸载的目录、它是否是主目录，是主目录时由哪个目录接替（只剩它一个时为 null，此时不能卸载）。
 * 确认时主目录的关系与提出时不同即视为目标已变化。
 */
export const UnmountDirectoryProposalPreviewSchema = Type.Object(
  {
    projectName: Name,
    directory: ProjectDirectorySchema,
    primary: Type.Boolean(),
    nextPrimary: Type.Union([ProjectDirectorySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type UnmountDirectoryProposalPreview = Type.Static<typeof UnmountDirectoryProposalPreviewSchema>;

/** 设主目录的预览：要设为主目录的目录与现在的主目录（确认时主目录已换过即视为目标已变化）。 */
export const SetPrimaryDirectoryProposalPreviewSchema = Type.Object(
  { projectName: Name, directory: ProjectDirectorySchema, previousPrimary: ProjectDirectorySchema },
  { additionalProperties: false },
);
export type SetPrimaryDirectoryProposalPreview = Type.Static<typeof SetPrimaryDirectoryProposalPreviewSchema>;

/**
 * 会话归入项目：哪个会话、归入哪个项目。moveFiles 是模型建议的“是否一并移入临时目录里的文件”，
 * 只作为卡上勾选框的默认值（缺省为勾选）；最终是否移入以用户在卡上的选择为准。
 */
export const MoveSessionToProjectProposalPayloadSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    projectId: ProjectIdSchema,
    moveFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type MoveSessionToProjectProposalPayload = Type.Static<typeof MoveSessionToProjectProposalPayloadSchema>;

/**
 * 归入项目的预览：会话与项目的名称、会话原来所在的工作区（原来在项目中时授权的说明不同），
 * 以及与界面归入项目卡同一份核对结果（目录从哪里换到哪里、提出时是否在运行、临时目录里的条目）。
 */
export const MoveSessionToProjectProposalPreviewSchema = Type.Object(
  {
    sessionTitle: Name,
    projectName: Name,
    fromWorkspaceId: Type.String({ minLength: 1 }),
    fromWorkspaceName: Name,
    fromProject: Type.Boolean(),
    move: SessionMovePreviewSchema,
  },
  { additionalProperties: false },
);
export type MoveSessionToProjectProposalPreview = Type.Static<typeof MoveSessionToProjectProposalPreviewSchema>;

/** 用户在归入项目卡上的选择：是否把临时目录里的文件一并移入项目目录（没有文件时不起作用）。 */
export const MoveSessionToProjectOptionsSchema = Type.Object(
  { moveFiles: Type.Boolean() },
  { additionalProperties: false },
);
export type MoveSessionToProjectOptions = Type.Static<typeof MoveSessionToProjectOptionsSchema>;
