import { Type } from 'typebox';
import { ProjectIdSchema } from './project.js';

/**
 * 项目资料：围绕项目整理的一组文件，与项目目录里的工作成果分开呈现。
 * 资料都是文件，由系统默认程序打开；智能体通过资料索引与 read_project_resource 使用它们。
 */
export const PROJECT_RESOURCE_LIMITS = {
  /** 一个项目最多的资料条数。 */
  count: 200,
  titleLength: 120,
  summaryLength: 300,
  fileNameLength: 120,
  /** 从本机添加的单个文件上限。 */
  uploadBytes: 20 * 1024 * 1024,
  /** 常驻资料合计的字符上限：全文随会话带上，超出时拒绝再设为常驻。 */
  pinnedChars: 24_000,
  /** read_project_resource 单次返回的字符上限。 */
  readChars: 40_000,
} as const;

/** 添加本机文件的请求体上限：base64 约为原文件的 4/3，另留 JSON 字段余量。 */
export const PROJECT_RESOURCE_UPLOAD_BODY_LIMIT_BYTES = Math.ceil(PROJECT_RESOURCE_LIMITS.uploadBytes / 3) * 4 + 64 * 1024;

/** 可以作为文本读取（常驻全文、智能体读取）的扩展名；其余类型只进入索引。 */
export const PROJECT_RESOURCE_TEXT_EXTENSIONS: readonly string[] = [
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'csv', 'tsv', 'xml', 'html', 'htm', 'svg',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'sh', 'sql',
];

/** 资料文件的扩展名（小写，不含点）；没有扩展名时为空字符串。 */
export function projectResourceExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index > 0 ? fileName.slice(index + 1).toLowerCase() : '';
}

export function isProjectResourceText(fileName: string): boolean {
  return PROJECT_RESOURCE_TEXT_EXTENSIONS.includes(projectResourceExtension(fileName));
}

/**
 * 资料来源：
 * - managed：项目资料目录中的文件（在 Multivac 中新建，或从本机复制进来），移除时一并移到废纸篓；
 * - directory：项目目录中已有文件的引用，不复制，移除时只去掉引用。
 */
export const ProjectResourceSourceSchema = Type.Union([Type.Literal('managed'), Type.Literal('directory')]);
export type ProjectResourceSource = Type.Static<typeof ProjectResourceSourceSchema>;

export const ProjectResourceIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });

export const ProjectResourceSchema = Type.Object(
  {
    resourceId: ProjectResourceIdSchema,
    projectId: ProjectIdSchema,
    source: ProjectResourceSourceSchema,
    /** 文件的绝对路径。 */
    path: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    /** 自定义标题；为 null 时显示文件名。 */
    title: Type.Union([Type.String({ minLength: 1, maxLength: PROJECT_RESOURCE_LIMITS.titleLength }), Type.Null()]),
    summary: Type.String({ maxLength: PROJECT_RESOURCE_LIMITS.summaryLength }),
    pinned: Type.Boolean(),
    /** 是否可以作为文本读取：决定能否常驻、智能体能否读取正文。 */
    text: Type.Boolean(),
    /** 读取列表时的文件状态；文件被移走或删除时为 missing。 */
    file: Type.Object(
      {
        status: Type.Union([Type.Literal('available'), Type.Literal('missing')]),
        size: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        modifiedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ProjectResource = Type.Static<typeof ProjectResourceSchema>;

export const ProjectResourceListResponseSchema = Type.Object(
  {
    resources: Type.Array(ProjectResourceSchema),
    /** 当前常驻资料合计的字符数与上限。 */
    pinnedChars: Type.Integer({ minimum: 0 }),
    pinnedLimit: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ProjectResourceListResponse = Type.Static<typeof ProjectResourceListResponseSchema>;

const FileName = Type.String({ minLength: 1, maxLength: PROJECT_RESOURCE_LIMITS.fileNameLength });

/**
 * 添加资料：
 * - new：在资料目录中新建 Markdown 文档（未带扩展名时补 .md）；
 * - directory：引用项目目录中的已有文件（绝对路径，或相对主目录的路径）；
 * - upload：把本机文件复制进资料目录。
 * 资料目录中重名时自动追加序号，不覆盖已有文件。
 */
export const CreateProjectResourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('new'), fileName: FileName }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('directory'), path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('upload'), fileName: FileName, contentBase64: Type.String() }, { additionalProperties: false }),
]);
export type CreateProjectResource = Type.Static<typeof CreateProjectResourceSchema>;

/** 修改资料的标题（null 恢复为文件名）、简介与常驻，只改给出的字段。 */
export const UpdateProjectResourceSchema = Type.Object(
  {
    title: Type.Optional(Type.Union([Type.String({ maxLength: PROJECT_RESOURCE_LIMITS.titleLength }), Type.Null()])),
    summary: Type.Optional(Type.String({ maxLength: PROJECT_RESOURCE_LIMITS.summaryLength })),
    pinned: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateProjectResource = Type.Static<typeof UpdateProjectResourceSchema>;

export const ProjectResourceResponseSchema = Type.Object({ resource: ProjectResourceSchema }, { additionalProperties: false });
export type ProjectResourceResponse = Type.Static<typeof ProjectResourceResponseSchema>;

/** 资料的显示标题：自定义标题优先，否则为文件名。 */
export function projectResourceTitle(resource: Pick<ProjectResource, 'title' | 'fileName'>): string {
  return resource.title ?? resource.fileName;
}
