import { Type } from 'typebox';
import {
  CREATE_PROJECT_PROPOSAL_KIND,
  MOUNT_DIRECTORY_PROPOSAL_KIND,
  MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND,
  normalizeProjectName,
  PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  SET_PRIMARY_DIRECTORY_PROPOSAL_KIND,
  UNMOUNT_DIRECTORY_PROPOSAL_KIND,
  type Project,
  type UpdateProjectResponse,
} from '@multivac/contracts';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { ProjectServiceError } from '../project-service.js';
import { defineInternalTool, proposedToolResult, type InternalToolServices } from './internal-tool-service.js';
import { clip, detailOf, projectLink, projectRef, summaryOf } from './tool-text.js';

/**
 * 项目相关的内部工具。
 *
 * 管理类（不扩大权限、可以撤回，直接执行并回一句回执）：项目改名、修改默认约束。只调用项目服务中
 * 只改名称 / 只改默认约束的收窄方法，拿不到能修改目录的更新。
 *
 * 提议类（扩大或改变会话能自动执行的范围）：新建项目、挂载 / 卸载目录、设主目录、会话归入项目。
 * 只经 propose 生成对话中的确认卡，校验、预览与执行都在服务端注册的提议种类里（见 `proposals/project-proposals.ts`），
 * 与界面的新建项目卡、设置 · 项目、归入项目卡同一套规则；用户在卡上确认之前什么都不做。
 */

/** 项目与会话 id 的字符集（与契约一致）：模型给出名称而不是 id 时，参数校验直接说明。 */
const ID_PATTERN = '^[A-Za-z0-9._:-]+$';

const ProjectIdParameter = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: ID_PATTERN,
  description: '项目 id（与项目的同名工作区 id 相同）：从 list_projects 或 list_workspaces 得到。',
});

const DirectoryParameter = (description: string) => Type.String({ minLength: 1, maxLength: 4_096, description });

/** 项目参数的共同说明：按 id 指定，名称有歧义时先查询、向用户确认。 */
const PROJECT_ID_GUIDE = 'projectId 是项目 id，不是名称：先用 list_projects 查到；名称相近的项目有多个时向用户确认是哪一个，不要猜。';

/** 按 id 读取项目；不存在时说明怎么查到 id。 */
function requireProject(services: InternalToolServices, projectId: string, action: string): Project {
  const project = services.projects.listProjects().projects.find((candidate) => candidate.projectId === projectId);
  if (!project) throw new InternalToolError(`没有${action}：没有 id 为 ${projectId} 的项目。可以先用 list_projects 查看项目 id。`);
  return project;
}

/** 服务可预期的错误（中文说明）转成模型可读的失败原因；其他异常交给框架给出通用说明。 */
function update(action: string, run: () => UpdateProjectResponse): UpdateProjectResponse {
  try {
    return run();
  } catch (error) {
    if (error instanceof ProjectServiceError) throw new InternalToolError(`没有${action}：${error.message}`);
    throw error;
  }
}

/** 默认约束的说明：如实写明目前只保存在项目中，还不会自动带入会话（与设置 · 项目同一句）。 */
const CONSTRAINTS_NOTE = '默认约束目前只保存在项目中，还不会自动带入会话。';

/** 项目改名：与设置 · 项目的改名同一校验，同名工作区随之改名。 */
export const renameProjectTool = defineInternalTool({
  name: 'rename_project',
  effect: 'manage',
  description: `给项目改名（与“设置 · 项目”中改名相同，直接执行），同名工作区随之改名。${PROJECT_ID_GUIDE}` +
    'name 为新名称：去掉首尾空白后不能为空，不区分大小写地不能与其他项目重名，不能叫“默认工作区”。不改变目录与权限。',
  parameters: Type.Object(
    {
      projectId: ProjectIdParameter,
      name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_LENGTH, description: '新的项目名称。' }),
    },
    { additionalProperties: false },
  ),
  async execute(params, { services, origin }) {
    const project = requireProject(services, params.projectId, '项目改名');
    if (normalizeProjectName(params.name) === project.name) {
      return {
        content: `项目 ${projectLink(project)}（id: ${project.projectId}）本来就叫这个名字，没有改动。`,
        result: { summary: '名称没有变化', refs: [projectRef(project)] },
      };
    }
    const renamed = update('项目改名', () => services.projects.renameProject(project.projectId, params.name, origin)).project;
    return {
      content: `已把项目「${project.name}」改名为 ${projectLink(renamed)}（id: ${renamed.projectId}），同名工作区随之改名；` +
        '目录与会话不变。需要改回时再改一次名即可。',
      result: {
        summary: summaryOf(`项目「${project.name}」改名为「${renamed.name}」`),
        refs: [projectRef(renamed)],
        receipt: {
          headline: clip(`已把项目改名为「${renamed.name}」`, 119),
          detail: detailOf([`原名「${project.name}」`, '同名工作区随之改名']),
          actions: [{ kind: 'open-project', projectId: renamed.projectId }],
        },
      },
    };
  },
});

/** 修改默认约束：与设置 · 项目的默认约束同一校验；如实说明目前只保存、还不会自动带入会话。 */
export const updateProjectConstraintsTool = defineInternalTool({
  name: 'update_project_constraints',
  effect: 'manage',
  description: `修改项目的默认约束（与“设置 · 项目”中保存默认约束相同，直接执行）。${PROJECT_ID_GUIDE}` +
    `defaultConstraints 是完整的新文本（替换原来的，去掉首尾空白；空字符串表示清空），不超过 ${PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH} 字。` +
    `注意：${CONSTRAINTS_NOTE}告诉用户时要如实说明这一点。`,
  parameters: Type.Object(
    {
      projectId: ProjectIdParameter,
      defaultConstraints: Type.String({
        maxLength: PROJECT_DEFAULT_CONSTRAINTS_MAX_LENGTH,
        description: '新的默认约束全文；空字符串表示清空。',
      }),
    },
    { additionalProperties: false },
  ),
  async execute(params, { services, origin }) {
    const project = requireProject(services, params.projectId, '修改默认约束');
    const text = params.defaultConstraints.trim();
    if (text === project.defaultConstraints) {
      return {
        content: `项目 ${projectLink(project)} 的默认约束本来就是这样，没有改动。${CONSTRAINTS_NOTE}`,
        result: { summary: '默认约束没有变化', refs: [projectRef(project)] },
      };
    }
    const updated = update('修改默认约束', () =>
      services.projects.setDefaultConstraints(project.projectId, text, origin)).project;
    const cleared = updated.defaultConstraints === '';
    return {
      content: `已${cleared ? '清空' : '更新'}项目 ${projectLink(updated)}（id: ${updated.projectId}）的默认约束。${CONSTRAINTS_NOTE}` +
        '已有会话与之后新建的会话都不会因此改变行为；如果用户以为已经生效，请如实说明。',
      result: {
        summary: summaryOf(`已${cleared ? '清空' : '更新'}「${updated.name}」的默认约束`),
        refs: [projectRef(updated)],
        receipt: {
          headline: clip(`已${cleared ? '清空' : '更新'}「${updated.name}」的默认约束`, 119),
          detail: detailOf([CONSTRAINTS_NOTE]),
          actions: [{ kind: 'open-project', projectId: updated.projectId }],
        },
      },
    };
  },
});

/** 提议类工具的共同说明：只生成确认卡，用户确认后才执行；结果在下一轮由服务端通知。 */
const PROPOSAL_GUIDE = '这是扩大（或改变）会话能自动执行的范围的操作：只在对话中生成一张确认卡（与界面上的同一张），' +
  '用户在卡上确认后才执行，确认之前什么都不做，也不要说已经完成；结果会在下一轮开始时由服务端通知你。' +
  '用户明确要求时才提出，一次要求只提出一次。';

/** 新建项目（挂载已有目录或创建托管目录）：与界面“新建项目…”同一张确认卡。 */
export const proposeCreateProjectTool = defineInternalTool({
  name: 'propose_create_project',
  effect: 'propose',
  description: `提议新建一个项目（例如用户说“把 ~/code/x 作为项目”）。${PROPOSAL_GUIDE}` +
    'name 为项目名称（用户没说时可以取目录的最后一段）；directory 为要挂载的已有目录（绝对路径或 ~/ 开头），' +
    '不给时由 Multivac 创建托管目录。卡上写明将使用的目录、类型与“这个目录内的修改将自动执行”；' +
    '目录不合法或名称重名时卡上写明原因、不能确认；目录已经是某个项目的目录时不生成卡片，而是告诉你它在哪个项目里。' +
    '确认后项目与同名工作区出现。',
  parameters: Type.Object(
    {
      name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_LENGTH, description: '项目名称。' }),
      directory: Type.Optional(DirectoryParameter('要挂载的已有目录；不给时创建托管目录。')),
    },
    { additionalProperties: false },
  ),
  async execute(params, { propose }) {
    return proposedToolResult(await propose({
      kind: CREATE_PROJECT_PROPOSAL_KIND,
      payload: { name: params.name, directory: params.directory ?? null },
    }));
  },
});

/** 挂载目录：与设置 · 项目的挂载同一校验与确认卡内容。 */
export const proposeMountDirectoryTool = defineInternalTool({
  name: 'propose_mount_directory',
  effect: 'propose',
  description: `提议把一个已有目录挂载到项目，之后这个目录内的修改也将自动执行。${PROPOSAL_GUIDE}${PROJECT_ID_GUIDE}` +
    'directory 为已有目录（绝对路径或 ~/ 开头）；挂载后排在已有目录之后，不改变主目录。目录不存在、范围过大或已属于某个项目时，' +
    '卡上写明原因、不能确认。修改目录只影响之后新建的会话。',
  parameters: Type.Object(
    { projectId: ProjectIdParameter, directory: DirectoryParameter('要挂载的已有目录。') },
    { additionalProperties: false },
  ),
  async execute(params, { propose }) {
    return proposedToolResult(await propose({ kind: MOUNT_DIRECTORY_PROPOSAL_KIND, payload: params }));
  },
});

/** 卸载目录：与设置 · 项目的卸载同一校验与确认卡内容；至少保留一个目录。 */
export const proposeUnmountDirectoryTool = defineInternalTool({
  name: 'propose_unmount_directory',
  effect: 'propose',
  description: `提议从项目中卸载一个目录（只解除关系，目录本身和其中的文件不删除）。${PROPOSAL_GUIDE}${PROJECT_ID_GUIDE}` +
    'directory 为项目中已有的目录路径（list_projects 列出）。项目至少保留一个目录：只剩它一个时卡上写明、不能确认；' +
    '卸载主目录时由下一个目录成为主目录。已有会话继续使用创建时的工作目录。',
  parameters: Type.Object(
    { projectId: ProjectIdParameter, directory: DirectoryParameter('要卸载的目录（项目中已有的）。') },
    { additionalProperties: false },
  ),
  async execute(params, { propose }) {
    return proposedToolResult(await propose({ kind: UNMOUNT_DIRECTORY_PROPOSAL_KIND, payload: params }));
  },
});

/** 设主目录：项目中新建的会话在主目录中工作。 */
export const proposeSetPrimaryDirectoryTool = defineInternalTool({
  name: 'propose_set_primary_directory',
  effect: 'propose',
  description: `提议把项目中已有的一个目录设为主目录（项目中新建的会话在主目录中工作）。${PROPOSAL_GUIDE}${PROJECT_ID_GUIDE}` +
    'directory 为项目中已有的目录路径（list_projects 列出）；已经是主目录时卡上写明、不能确认。已有会话继续使用创建时的工作目录。',
  parameters: Type.Object(
    { projectId: ProjectIdParameter, directory: DirectoryParameter('要设为主目录的目录（项目中已有的）。') },
    { additionalProperties: false },
  ),
  async execute(params, { propose }) {
    return proposedToolResult(await propose({ kind: SET_PRIMARY_DIRECTORY_PROPOSAL_KIND, payload: params }));
  },
});

/** 会话归入项目：与界面“归入项目…”同一张确认卡；文件是否一并移入由用户在卡上选择。 */
export const proposeMoveSessionToProjectTool = defineInternalTool({
  name: 'propose_move_session_to_project',
  effect: 'propose',
  description: `提议把一个工作会话归入项目：会话随之出现在项目的工作区，之后在项目主目录中工作，对话历史不变。${PROPOSAL_GUIDE}` +
    'sessionId 是会话 id（先用 list_sessions、get_current_view 查到，同名多个时向用户确认），projectId 是目标项目 id。' +
    '卡上写明目录与执行边界的变化、记住的授权如何适用；原工作目录是临时目录时，是否把其中的文件一并移入项目目录由用户在卡上勾选，' +
    'moveFiles 只是你建议的默认值（不给时默认勾选），最终以用户的选择为准。会话正在运行（含等待授权）时卡片不能确认，' +
    '需要用户先停止这一轮；已归档的会话不能归入。',
  parameters: Type.Object(
    {
      sessionId: Type.String({ minLength: 1, maxLength: 128, pattern: ID_PATTERN, description: '要归入的工作会话 id。' }),
      projectId: ProjectIdParameter,
      moveFiles: Type.Optional(Type.Boolean({ description: '建议卡上默认是否勾选“一并移入临时目录里的文件”。' })),
    },
    { additionalProperties: false },
  ),
  async execute(params, { propose }) {
    return proposedToolResult(await propose({ kind: MOVE_SESSION_TO_PROJECT_PROPOSAL_KIND, payload: params }));
  },
});
