import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import {
  DEFAULT_WORKSPACE_ID,
  INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH,
  WORKSPACE_SESSION_TITLE_MAX_LENGTH,
  type SessionArchivePreview,
  type SessionRestoreResult,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { localDateStamp } from '../../modules/sessions/working-directory.js';
import { WorkspaceSessionServiceError } from '../workspace-session-service.js';
import {
  defineInternalTool,
  type InternalToolCallContext,
  type InternalToolServices,
} from './internal-tool-service.js';
import {
  clip,
  requireSession,
  sessionLink,
  sessionRef,
  summaryOf,
  WORKING_DIRECTORY_LABELS,
} from './tool-text.js';

/**
 * 会话管理类内部工具：新建、改名、归档、恢复工作会话。不扩大权限、可以撤回，直接执行，
 * 调用与界面操作同一套服务与校验（`WorkspaceSessionService`），写方法传入上下文中的 origin，
 * 变更事件由服务发布，各窗口随之更新。
 *
 * - 会话一律按 id 指定，不按名称模糊匹配：有副作用的操作必须落在确定的对象上。名称有歧义（同名多个）时，
 *   由模型先用查询工具（list_sessions / get_current_view）确认，必要时问用户。
 * - 成功时除正文外返回回执（公开结果的 receipt）：界面据此在这一轮之后显示一行回执，
 *   带“在工作区打开”（新建、改名、恢复）或“恢复”（归档）；点击是用户操作，走界面已有的做法。
 * - 新建后不自动打开，也不发送任何消息（打开由用户在回执上点，或明确要求时由导航完成）。
 */

const SessionIdParameter = Type.String({
  minLength: 1,
  maxLength: 128,
  description: '会话 id（不是名称）：从 list_sessions、get_session 或 get_current_view 得到。',
});

const TitleParameter = (description: string) =>
  Type.String({ minLength: 1, maxLength: WORKSPACE_SESSION_TITLE_MAX_LENGTH, description });

/** 会话参数的共同说明：按 id 指定，名称有歧义时先查询、向用户确认。 */
const SESSION_ID_GUIDE = 'sessionId 是会话 id，不是名称：先用 list_sessions（按名称查找）、get_current_view（“这个 / 第二栏”）或 get_session 得到；' +
  '同名的会话有多个时向用户确认是哪一个，不要猜。';

/**
 * 新建会话的客户端 id：由本次调用的幂等命令 id 派生，写成 UUID 的形式（与界面生成的 id 同一写法）。
 * 同一次调用重放时得到同一个 id，新建按既有记录返回，不会建出第二个会话；临时目录名中的短 id 也各不相同。
 */
export function sessionIdForCommand(commandId: string): string {
  const hex = createHash('sha256').update('create_session\0').update(commandId).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 服务可预期的错误（中文说明）转成模型可读的失败原因；其他异常交给框架给出通用说明。 */
function rethrow(action: string, error: unknown): never {
  if (error instanceof WorkspaceSessionServiceError) throw new InternalToolError(`没有${action}：${error.message}`);
  throw error;
}

function workspaceById(services: InternalToolServices, workspaceId: string): Workspace | undefined {
  return services.projects.listWorkspaces().workspaces.find((workspace) => workspace.workspaceId === workspaceId);
}

function detailOf(parts: ReadonlyArray<string | null>): string {
  return clip(parts.filter(Boolean).join('；'), INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH - 1);
}

/**
 * 新会话建在哪个工作区：
 * - 指定了父会话：父会话所在的工作区（父会话须未归档；另给的工作区与它不同时拒绝）；
 * - 指定了工作区：它（须存在）；
 * - 否则发起窗口的当前工作区（取自发送时的当前视图）；拿不到或已不存在时默认工作区，并说明原因。
 */
function targetWorkspace(
  params: { workspaceId?: string; parentSessionId?: string },
  { services, originView }: InternalToolCallContext,
): { workspace: Workspace; parent: WorkspaceSession | null; fallback: string | null } {
  if (params.parentSessionId !== undefined) {
    const parent = requireSession(services, params.parentSessionId, '新建会话');
    if (parent.archivedAt !== null) {
      throw new InternalToolError(`没有新建会话：父会话「${parent.title}」已归档，不能在它下面新建栈式子会话。` +
        '可以先用 restore_session 恢复它，或不指定父会话、新建一个顶层会话。');
    }
    const workspace = workspaceById(services, parent.workspaceId);
    if (!workspace) throw new InternalToolError(`没有新建会话：父会话「${parent.title}」所在的工作区已不存在。`);
    if (params.workspaceId !== undefined && params.workspaceId !== parent.workspaceId) {
      throw new InternalToolError(`没有新建会话：栈式子会话只能留在父会话所在的工作区「${workspace.name}」` +
        `（id: ${workspace.workspaceId}）。去掉 workspaceId 或改为这个工作区即可。`);
    }
    return { workspace, parent, fallback: null };
  }
  if (params.workspaceId !== undefined) {
    const workspace = workspaceById(services, params.workspaceId);
    if (!workspace) {
      throw new InternalToolError(`没有新建会话：没有 id 为 ${params.workspaceId} 的工作区。可以先用 list_workspaces 查看工作区 id。`);
    }
    return { workspace, parent: null, fallback: null };
  }
  const current = originView?.workspace?.workspaceId;
  const workspace = current === undefined ? undefined : workspaceById(services, current);
  if (workspace) return { workspace, parent: null, fallback: null };
  const fallback = current === undefined
    ? (originView ? '发起的窗口还没有当前工作区' : '拿不到发起这条消息的窗口的当前工作区')
    : '发起的窗口所在的工作区已不存在';
  return { workspace: workspaceById(services, DEFAULT_WORKSPACE_ID)!, parent: null, fallback: `${fallback}，已建在默认工作区` };
}

/** 新建工作会话：与界面“新会话”同一服务；可以作为某个会话的栈式子会话。新建后不自动打开。 */
export const createSessionTool = defineInternalTool({
  name: 'create_session',
  effect: 'manage',
  description: '新建一个工作会话（与界面上新建会话相同，直接执行）。title 为会话名称（必填）。' +
    'workspaceId 指定工作区（项目与它的工作区同 id，默认工作区为 default）；不给时建在用户发送这条消息时所在窗口的当前工作区，' +
    '拿不到时建在默认工作区并在结果中说明。parentSessionId 指定父会话时新建为它的栈式子会话：父会话须未归档，' +
    '子会话留在父会话的工作区，承接父会话最近内容的摘录（不带选中内容）。工作目录与界面新建一致：项目工作区中用项目主目录，' +
    '默认工作区中为会话新建临时目录。新建后不会自动打开，也不会向它发送任何消息；对话里的回执带“在工作区打开”。' +
    '用户明确要求新建时才用，一次要求只调用一次。',
  parameters: Type.Object(
    {
      title: TitleParameter('会话名称。'),
      workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: '工作区 id；默认工作区为 default。' })),
      parentSessionId: Type.Optional(Type.String({
        minLength: 1, maxLength: 128, description: '父会话 id：新建为它的栈式子会话。',
      })),
    },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const { services, commandId, origin } = context;
    const { workspace, parent, fallback } = targetWorkspace(params, context);
    let session: WorkspaceSession;
    try {
      ({ session } = await services.sessions.create({
        sessionId: sessionIdForCommand(commandId),
        title: params.title,
        ...(parent ? { parent: { sessionId: parent.sessionId } } : { workspaceId: workspace.workspaceId }),
      }, origin));
    } catch (error) {
      rethrow('新建会话', error);
    }

    const directory = `${WORKING_DIRECTORY_LABELS[session.workingDirectory.kind]} ${session.workingDirectory.path}`;
    return {
      content: [
        `已在工作区「${workspace.name}」新建会话 ${sessionLink(session)}（id: ${session.sessionId}）` +
          (parent ? `，它是 ${sessionLink(parent)} 的栈式子会话，承接了父会话最近内容的摘录（没有带选中内容）。` : '。'),
        `工作目录：${directory}。`,
        ...(fallback ? [`注意：${fallback}；需要换到别的工作区时，请告诉用户。`] : []),
        '没有自动打开它，也没有向它发送消息：用户可以点对话中回执上的“在工作区打开”。',
      ].join('\n'),
      result: {
        summary: summaryOf(`已新建「${session.title}」`),
        refs: [sessionRef(session), ...(parent ? [sessionRef(parent)] : [])],
        receipt: {
          headline: clip(`已新建会话「${session.title}」`, 119),
          detail: detailOf([
            `在「${workspace.name}」中`,
            parent ? `「${parent.title}」的栈式子会话` : null,
            fallback,
          ]),
          actions: [{ kind: 'open-session', sessionId: session.sessionId }],
        },
      },
    };
  },
});

/** 给工作会话改名：与界面改名同一服务。已归档的会话不能改名。 */
export const renameSessionTool = defineInternalTool({
  name: 'rename_session',
  effect: 'manage',
  description: `给一个工作会话改名（与界面上改名相同，直接执行）。${SESSION_ID_GUIDE}title 为新名称。已归档的会话不能改名，需要先恢复。`,
  parameters: Type.Object(
    { sessionId: SessionIdParameter, title: TitleParameter('新名称。') },
    { additionalProperties: false },
  ),
  async execute(params, { services, origin }) {
    const session = requireSession(services, params.sessionId, '改名会话');
    if (session.archivedAt !== null) {
      throw new InternalToolError(`没有改名：会话「${session.title}」已归档。可以先用 restore_session 恢复，再改名。`);
    }
    let renamed: WorkspaceSession;
    try {
      renamed = services.sessions.rename(session.sessionId, params.title, origin);
    } catch (error) {
      rethrow('改名', error);
    }
    if (renamed.title === session.title) {
      return {
        content: `会话 ${sessionLink(renamed)}（id: ${renamed.sessionId}）本来就叫这个名字，没有改动。`,
        result: { summary: '名称没有变化', refs: [sessionRef(renamed)] },
      };
    }
    return {
      content: `已把会话「${session.title}」改名为 ${sessionLink(renamed)}（id: ${renamed.sessionId}）。需要改回时再改一次名即可。`,
      result: {
        summary: summaryOf(`「${session.title}」改名为「${renamed.title}」`),
        refs: [sessionRef(renamed)],
        receipt: {
          headline: `已改名为「${renamed.title}」`,
          detail: detailOf([`原名「${session.title}」`]),
          actions: [{ kind: 'open-session', sessionId: renamed.sessionId }],
        },
      },
    };
  },
});

/**
 * 归档前核对到的工作目录去留（与界面归档确认卡同一规则）：临时目录为空时随归档删除；有文件时按偏好保留，
 * 到期移到废纸篓；项目目录与 Multivac 工作目录不会被清理。
 */
function archivedDirectoryText(preview: SessionArchivePreview): string {
  const { files, tempRetentionDays: days, workingDirectory } = preview;
  if (!files) return `工作目录是${WORKING_DIRECTORY_LABELS[workingDirectory.kind]}，不会被清理。`;
  if (files.total === 0) return '临时目录是空的，已随归档删除。';
  const shown = files.names.slice(0, 5).join('、');
  const names = files.total > 5 ? `${shown} 等` : shown;
  return `临时目录里还有 ${files.total} 个文件（${names}），` + (days === null
    ? '一直保留（偏好为从不清理）。'
    : `保留 ${days} 天后移到废纸篓，到期前恢复会话则取消清理。`);
}

/** 归档工作会话：与界面归档同一服务。运行中（含等待授权）的会话拒绝；回执带“恢复”。 */
export const archiveSessionTool = defineInternalTool({
  name: 'archive_session',
  effect: 'manage',
  description: '归档一个工作会话（与界面上归档相同，直接执行）：会话移出会话列表与工作区栏位，对话历史保留，可以恢复。' +
    `${SESSION_ID_GUIDE}正在运行（含等待授权）的会话不能归档。临时目录为空时随归档删除，有文件时按“设置 · 偏好”的保留时长` +
    '到期移到废纸篓，结果中会写明。对话里的回执带“恢复”。',
  parameters: Type.Object({ sessionId: SessionIdParameter }, { additionalProperties: false }),
  async execute(params, { services, origin }) {
    const session = requireSession(services, params.sessionId, '归档会话');
    if (session.archivedAt !== null) {
      throw new InternalToolError(`没有归档：会话「${session.title}」已经归档（归档于 ${session.archivedAt}），不需要再次归档。` +
        '需要找回时用 restore_session 恢复。');
    }
    const running = () => new InternalToolError(`没有归档：会话「${session.title}」正在运行（或在等待授权），运行中的会话不能归档。` +
      '请用户先在工作区停止这一轮或处理授权，之后再归档。');
    if (services.sessions.isRunning(session.sessionId)) throw running();

    let preview: SessionArchivePreview;
    let archived: WorkspaceSession;
    try {
      preview = services.sessions.previewArchive(session.sessionId);
      archived = services.sessions.archive(session.sessionId, origin);
    } catch (error) {
      if (error instanceof WorkspaceSessionServiceError && error.code === 'COMMAND_STATE_MISMATCH') throw running();
      rethrow('归档', error);
    }
    const directory = archivedDirectoryText(preview);
    return {
      content: `已归档会话 ${sessionLink(archived)}（id: ${archived.sessionId}）。对话历史保留；${directory}` +
        '需要找回时可以用 restore_session 恢复，对话中的回执上也有“恢复”。',
      result: {
        summary: summaryOf(`已归档「${archived.title}」`),
        refs: [sessionRef(archived)],
        receipt: {
          headline: clip(`已归档「${archived.title}」`, 119),
          detail: detailOf([directory]),
          actions: [{ kind: 'restore-session', sessionId: archived.sessionId }],
        },
      },
    };
  },
});

/** 恢复时临时目录已到期移到废纸篓的说明（与界面恢复提示同一内容）；没有移走时为 null。 */
function trashedDirectoryText(result: SessionRestoreResult): string | null {
  const trashed = result.trashedDirectory;
  if (!trashed) return null;
  return `它的临时目录已于 ${localDateStamp(new Date(trashed.trashedAt))} 到期移到废纸篓（${trashed.trashPath}），` +
    '已重建空的临时目录；需要原来的文件，可以从废纸篓找回。';
}

/** 恢复已归档的工作会话：与界面恢复同一服务，回到原工作区；目录已被移到废纸篓时如实说明。不自动打开。 */
export const restoreSessionTool = defineInternalTool({
  name: 'restore_session',
  effect: 'manage',
  description: '恢复一个已归档的工作会话（与界面上恢复相同，直接执行）：回到原来的工作区，对话历史、工作目录与父子关系照旧；' +
    `临时目录在归档期间已被移到废纸篓时重建空目录，并在结果中写明。${SESSION_ID_GUIDE}` +
    '已归档的会话可以用 list_sessions（status 为 archived）查找。恢复后不会自动打开，对话里的回执带“在工作区打开”。',
  parameters: Type.Object({ sessionId: SessionIdParameter }, { additionalProperties: false }),
  async execute(params, { services, origin }) {
    const session = requireSession(services, params.sessionId, '恢复会话');
    if (session.archivedAt === null) {
      throw new InternalToolError(`没有恢复：会话「${session.title}」没有归档，不需要恢复。`);
    }
    let result: SessionRestoreResult;
    try {
      result = services.sessions.restore(session.sessionId, origin);
    } catch (error) {
      rethrow('恢复', error);
    }
    const restored = result.session;
    const workspace = workspaceById(services, restored.workspaceId);
    const place = workspace ? `工作区「${workspace.name}」` : '原来的工作区';
    const trashed = trashedDirectoryText(result);
    return {
      content: [
        `已恢复会话 ${sessionLink(restored)}（id: ${restored.sessionId}），它回到${place}，对话历史、工作目录与父子关系照旧。`,
        ...(trashed ? [trashed] : []),
        '没有自动打开它：用户可以点对话中回执上的“在工作区打开”。',
      ].join('\n'),
      result: {
        summary: summaryOf(`已恢复「${restored.title}」`),
        refs: [sessionRef(restored)],
        receipt: {
          headline: clip(`已恢复「${restored.title}」`, 119),
          detail: detailOf([`回到${place}`, trashed]),
          actions: [{ kind: 'open-session', sessionId: restored.sessionId }],
        },
      },
    };
  },
});
