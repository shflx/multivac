import { Type } from 'typebox';

/**
 * 项目属于执行层：回答“任务在哪里做、能动什么”。每个项目至少有一个目录，
 * 并自动带一个同名工作区；不属于项目的会话在默认工作区中，使用各自的临时目录。
 */
export const PROJECT_NAME_MAX_LENGTH = 80;
export const PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH = 4_000;
export const PROJECT_BODY_LIMIT_BYTES = 16 * 1024;

/** 项目 id 由服务端生成；项目的同名工作区使用同一个 id。 */
export const ProjectIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });

/**
 * 项目目录的来源：
 * - managed：没有挂载目录时由 Multivac 托管的目录（工作文件根目录下 `projects/<项目名>/`）；
 * - mounted：用户挂载的已有目录。
 */
export const ProjectDirectoryKindSchema = Type.Union([Type.Literal('managed'), Type.Literal('mounted')]);
export type ProjectDirectoryKind = Type.Static<typeof ProjectDirectoryKindSchema>;

export const ProjectDirectorySchema = Type.Object(
  {
    kind: ProjectDirectoryKindSchema,
    /** 绝对路径。 */
    path: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ProjectDirectory = Type.Static<typeof ProjectDirectorySchema>;

const Timestamp = Type.String({ minLength: 1 });

export const ProjectSchema = Type.Object(
  {
    projectId: ProjectIdSchema,
    name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_LENGTH }),
    /** 项目目录，至少一个；第一个是主目录，项目中新建的会话以它为工作目录。 */
    directories: Type.Array(ProjectDirectorySchema, { minItems: 1 }),
    /** 默认约束：项目内会话遵守的长期约定，目前按文本保存。 */
    defaultConstraints: Type.String({ maxLength: PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
  { additionalProperties: false },
);
export type Project = Type.Static<typeof ProjectSchema>;

/**
 * 工作区属于注意力层：只决定“把哪些会话放在一起看”。项目工作区与项目同名、同 id；
 * 默认工作区不属于任何项目（project 为 null）。
 */
export const WorkspaceSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    project: Type.Union([ProjectSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Workspace = Type.Static<typeof WorkspaceSchema>;

/** 项目工作区按创建顺序在前，默认工作区在最后。 */
export const WorkspaceListResponseSchema = Type.Object(
  { workspaces: Type.Array(WorkspaceSchema) },
  { additionalProperties: false },
);
export type WorkspaceListResponse = Type.Static<typeof WorkspaceListResponseSchema>;

export const ProjectListResponseSchema = Type.Object(
  { projects: Type.Array(ProjectSchema) },
  { additionalProperties: false },
);
export type ProjectListResponse = Type.Static<typeof ProjectListResponseSchema>;

export const CreateProjectSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_LENGTH }),
    /** 挂载的已有目录（绝对路径）；不填时创建托管目录。 */
    directory: Type.Optional(Type.String({ minLength: 1 })),
    defaultConstraints: Type.Optional(Type.String({ maxLength: PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH })),
  },
  { additionalProperties: false },
);
export type CreateProject = Type.Static<typeof CreateProjectSchema>;

/** 新建项目的结果：项目与随之出现的同名工作区。 */
export const CreateProjectResponseSchema = Type.Object(
  { project: ProjectSchema, workspace: WorkspaceSchema },
  { additionalProperties: false },
);
export type CreateProjectResponse = Type.Static<typeof CreateProjectResponseSchema>;

/** 名称去掉首尾空白后才计算长度；全空白视为未填写。 */
export function normalizeProjectName(name: string): string | null {
  const normalized = name.trim();
  if (!normalized || normalized.length > PROJECT_NAME_MAX_LENGTH) return null;
  return normalized;
}
