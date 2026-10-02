import { Type } from 'typebox';
import {
  assignSlotInScene,
  focusSessionInScene,
  MANAGEMENT_PAGE_IDS,
  MANAGEMENT_PAGE_LABELS,
  resizeParallelInScene,
  switchViewModeInScene,
  WORKSPACE_MAX_PARALLEL,
  type CurrentViewSnapshot,
  type ManagementPageIdValue,
  type ManagementSelection,
  type WindowNavigationTarget,
  type Workspace,
  type WorkspaceScene,
  type WorkspaceSceneState,
  type WorkspaceSession,
  type WorkspaceViewMode,
} from '@multivac/contracts';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { WorkspaceSessionServiceError } from '../workspace-session-service.js';
import { defineInternalTool, type InternalToolCallContext } from './internal-tool-service.js';
import {
  clip,
  detailOf,
  projectLink,
  projectRef,
  taskRef,
  requireSession,
  sessionLink,
  sessionRef,
  summaryOf,
  workspaceById,
  workspaceLink,
  workspaceRef,
} from './tool-text.js';

/**
 * 工作区操作类内部工具：切换工作区、在工作区打开会话（聚焦查看或放进第 N 栏）、调整并排数、切换并排 / 聚焦、
 * 打开管理中的某一页。不扩大权限、可以撤回（再切换一次即可），直接执行，成功时带回执。
 *
 * - 改现场（栏位、并排数、视图）经会话服务按界面同一套栏位规则保存（`changeScene`：在界面呈现的现场上修改，
 *   带版本），照常推给所有看着这个工作区的窗口；规则（放进已有会话的栏时互换、当前会话始终保留在显示中）
 *   与界面共用契约中的实现。
 * - 切换页面（面板、工作区、管理页）是只推给发起对话的窗口的导航指令，其他窗口不被切换。
 *   发起窗口已关闭或刷新（窗口 id 已没有连接）、或发送时处于窄屏时不切换页面，结果如实写明只更新了保存的现场。
 * - 发送时的当前视图是那一刻的快照：导航或改了发起窗口正在看的工作区之后，记下切换后的界面（`noteOriginView`），
 *   本轮后续的工具据此确定“当前工作区”；现场一律读服务端保存的，不用快照里的栏位。
 * - 只在用户明确要求“打开 / 切到 / 放到”时调用：写在各工具说明与系统提示词中，工具本身不判断意图。
 */

const WorkspaceIdParameter = (description: string) =>
  Type.String({ minLength: 1, maxLength: 128, description });

const OptionalWorkspaceId = Type.Optional(WorkspaceIdParameter(
  '工作区 id（项目的工作区与项目同 id，默认工作区为 default）；不给时是用户发送这条消息时所在窗口的当前工作区。',
));

/** 各工具说明中共同的调用条件（Q3）。 */
const EXPLICIT_ONLY = '只在用户明确要求时调用，不要为了展示结果主动切换。';

/** 工作区页面在发起窗口中是否切换过去了，没有时是什么原因。 */
type Delivery = 'shown' | 'narrow' | 'no-window' | 'elsewhere';

/** 没有在发起窗口中生效时，回执与正文里的说明。 */
function deliveryNote(delivery: Delivery, sceneChanged: boolean): string | null {
  if (delivery === 'narrow') return sceneChanged ? '窄屏下工作区不可用，已更新保存的现场' : '窄屏下工作区不可用，没有切换';
  if (delivery === 'no-window') return sceneChanged ? '界面没有打开，只更新了保存的现场' : '界面没有打开，没有切换';
  if (delivery === 'elsewhere') return '你现在没有在看这个工作区，已更新保存的现场，进入这个工作区时就是这样';
  return null;
}

/** 给模型的补充：为什么界面没有随之切换，需要照实告诉用户。 */
function deliveryContent(delivery: Delivery): string | null {
  if (delivery === 'narrow') {
    return '发起这条消息的窗口处于窄屏（只显示 Multivac 首页，工作区与管理不可用），没有切换页面；请照实告诉用户，需要在更宽的窗口中查看。';
  }
  if (delivery === 'no-window') {
    return '发起这条消息的界面已经没有打开（窗口已关闭或刷新），没有切换页面；请照实告诉用户。';
  }
  if (delivery === 'elsewhere') return '用户发送时没有在看这个工作区，页面没有切换，之后进入这个工作区时就是新的布局。';
  return null;
}

/**
 * 把导航指令推给发起窗口：发送时处于窄屏不推送；窗口已没有连接时推不到。
 * 送达后记下发起窗口切换后的界面，本轮后续的工具以它为当前视图。
 */
function navigateOrigin(context: InternalToolCallContext, target: WindowNavigationTarget): Delivery {
  const { originWindowId, originView, services, origin } = context;
  if (originView?.narrow) return 'narrow';
  if (!originWindowId || !services.windows.navigate(originWindowId, target, origin)) return 'no-window';
  const base: CurrentViewSnapshot = originView ?? { panel: 'home', narrow: false, workspace: null, management: null };
  context.noteOriginView(target.kind === 'workspace'
    ? { ...base, panel: 'workspace', workspace: { workspaceId: target.workspaceId, scene: null }, management: null }
    : { ...base, panel: 'management', management: { page: target.page, selection: target.selection } });
  return 'shown';
}

/**
 * 只改了现场、不切换页面（调整并排数、切换并排 / 聚焦）时，发起窗口能不能看到：窄屏、窗口已没有连接、
 * 窗口此刻不在这个工作区。发起窗口正看着这个工作区时，记下它的现场已变（本轮后续按服务端现场）。
 */
function sceneDelivery(context: InternalToolCallContext, workspaceId: string): Delivery {
  const { originWindowId, originView, services } = context;
  if (originView?.narrow) return 'narrow';
  if (!originWindowId || !services.windows.isOpen(originWindowId)) return 'no-window';
  if (originView?.workspace?.workspaceId !== workspaceId) return 'elsewhere';
  context.noteOriginView({ ...originView, workspace: { workspaceId, scene: null } });
  return originView.panel === 'workspace' ? 'shown' : 'elsewhere';
}

/** 要调整的工作区：参数优先，否则发起窗口的当前工作区（本轮中切换过的以切换后为准）。 */
function targetWorkspace(params: { workspaceId?: string }, context: InternalToolCallContext, action: string): Workspace {
  const workspaceId = params.workspaceId ?? context.originView?.workspace?.workspaceId;
  if (workspaceId === undefined) {
    throw new InternalToolError(`没有${action}：拿不到发起这条消息的窗口的当前工作区。请用 list_workspaces 确认是哪个工作区后带上 workspaceId，或向用户确认。`);
  }
  const workspace = workspaceById(context.services, workspaceId);
  if (workspace) return workspace;
  throw new InternalToolError(params.workspaceId === undefined
    ? `没有${action}：发起窗口的当前工作区（id: ${workspaceId}）已不存在。请向用户确认要调整哪个工作区。`
    : `没有${action}：没有 id 为 ${workspaceId} 的工作区。可以先用 list_workspaces 查看工作区 id（项目的工作区与项目同 id）。`);
}

/** 按界面同一套栏位规则改现场并保存（来源是这一轮与发起窗口）；服务的中文错误转成模型可读的原因。 */
function changeScene(
  context: InternalToolCallContext,
  workspaceId: string,
  action: string,
  change: (presented: WorkspaceSceneState) => WorkspaceSceneState,
): { before: WorkspaceScene; after: WorkspaceScene } {
  try {
    return context.services.sessions.changeScene(workspaceId, change, context.origin);
  } catch (error) {
    if (error instanceof WorkspaceSessionServiceError) throw new InternalToolError(`没有${action}：${error.message}`);
    throw error;
  }
}

function sceneChanged(result: { before: WorkspaceScene; after: WorkspaceScene }): boolean {
  return result.after.revision !== result.before.revision;
}

/** 栏位中会话的名称（都是这个工作区中未归档的会话）；读不到时写 id。 */
function titleOf(context: InternalToolCallContext, sessionId: string): string {
  try {
    return context.services.sessions.get(sessionId).title;
  } catch {
    return sessionId;
  }
}

function layoutText(scene: WorkspaceSceneState): string {
  return scene.viewMode === 'parallel' ? `并排 ${scene.parallelCount} 栏` : `聚焦（并排数 ${scene.parallelCount}）`;
}

/** 各栏的会话，写给模型核对“第 N 栏”。 */
function slotsText(context: InternalToolCallContext, scene: WorkspaceSceneState): string {
  if (scene.slots.length === 0) return '栏位中没有会话';
  return scene.slots.map((sessionId, index) => `第 ${index + 1} 栏「${titleOf(context, sessionId)}」`).join('，');
}

/** 切到一个工作区：只切换发起窗口的页面，不改任何现场。 */
export const switchWorkspaceTool = defineInternalTool({
  name: 'switch_workspace',
  effect: 'manage',
  changesView: true,
  description: '把用户发出这条消息的窗口切到工作区面板中的某个工作区（与界面上的工作区切换菜单相同，直接执行）。' +
    '用户说“切到项目 Y / 打开 Y 工作区”时使用：项目的工作区与项目同 id，先用 list_projects 或 list_workspaces 查到 id。' +
    '只切换发起的这个窗口，其他窗口不变；不改变工作区的现场。窗口已关闭或刷新、处于窄屏时不会切换，结果会说明。' + EXPLICIT_ONLY,
  parameters: Type.Object(
    { workspaceId: WorkspaceIdParameter('要切到的工作区 id（项目的工作区与项目同 id，默认工作区为 default）。') },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const workspace = targetWorkspace(params, context, '切换工作区');
    const { scene } = context.services.sessions.presentedScene(workspace.workspaceId);
    const delivery = navigateOrigin(context, {
      kind: 'workspace', workspaceId: workspace.workspaceId, sessionId: scene.focusedSessionId,
    });
    if (delivery !== 'shown') {
      throw new InternalToolError(`没有切到工作区「${workspace.name}」：${deliveryNote(delivery, false)}。${deliveryContent(delivery)}`);
    }
    const project = workspace.project;
    return {
      content: [
        `已把发起这条消息的窗口切到工作区 ${workspaceLink(workspace)}（id: ${workspace.workspaceId}）` +
          (project ? `，它是项目 ${projectLink(project)} 的工作区` : '') + '。',
        `这个工作区现在是${layoutText(scene)}：${slotsText(context, scene)}。其他窗口没有被切换。`,
      ].join('\n'),
      result: {
        summary: summaryOf(`已切到「${workspace.name}」`),
        refs: [workspaceRef(workspace), ...(project ? [projectRef(project)] : [])],
        receipt: {
          headline: clip(`已切到工作区「${workspace.name}」`, 119),
          detail: detailOf([layoutText(scene)]),
          actions: [{ kind: 'open-workspace', workspaceId: workspace.workspaceId }],
        },
      },
    };
  },
});

/**
 * 在工作区打开会话：不给栏位时聚焦查看（与在会话列表里点它相同），给出栏位时放进第 N 栏（与“放到第 N 栏”相同）。
 * 会话须未归档；它不在发起窗口的当前工作区时，先切到它所在的工作区。
 */
export const openSessionTool = defineInternalTool({
  name: 'open_session',
  effect: 'manage',
  changesView: true,
  description: '在工作区打开一个工作会话，并把用户发出这条消息的窗口切到它所在的工作区（与界面操作相同，直接执行）。' +
    '不给 slot 时聚焦查看这个会话（只显示它）；给出 slot 时把它放进并排的第 slot 栏：这一栏原来的会话退出显示，' +
    '它已在另一栏时两栏互换，放好后它成为当前会话并回到并排。slot 不能超过这个工作区当前的并排数（需要更多栏时先按用户要求调整并排数）。' +
    'sessionId 是会话 id，不是名称：先用 list_sessions、get_session 或 get_current_view 得到；同名的会话有多个时向用户确认。' +
    '会话须未归档（已归档的要用户要求恢复后才能打开）。工作区的现场会保存并同步到看着这个工作区的所有窗口，页面只切换发起的窗口；' +
    '窗口已关闭或刷新、处于窄屏时只更新保存的现场，结果会说明。' + EXPLICIT_ONLY,
  parameters: Type.Object(
    {
      sessionId: Type.String({ minLength: 1, maxLength: 128, description: '会话 id（不是名称）。' }),
      slot: Type.Optional(Type.Integer({
        minimum: 1, maximum: WORKSPACE_MAX_PARALLEL, description: '放进第几栏（从 1 起）；不给时聚焦查看。',
      })),
    },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const session: WorkspaceSession = requireSession(context.services, params.sessionId, '在工作区打开会话');
    if (session.archivedAt !== null) {
      throw new InternalToolError(`没有打开：会话「${session.title}」已归档，需要先恢复才能在工作区打开。` +
        '用户要求恢复时可以用 restore_session，之后再打开。');
    }
    const workspace = workspaceById(context.services, session.workspaceId);
    if (!workspace) throw new InternalToolError(`没有打开：会话「${session.title}」所在的工作区已不存在。`);
    const { slot } = params;
    const current = context.services.sessions.presentedScene(workspace.workspaceId).scene;
    if (slot !== undefined && slot > current.parallelCount) {
      throw new InternalToolError(`没有打开：工作区「${workspace.name}」现在并排 ${current.parallelCount} 栏，没有第 ${slot} 栏。` +
        `可以放进第 1–${current.parallelCount} 栏；用户要求更多栏时，先用 set_parallel_count 调整并排数。`);
    }
    const previousWorkspaceId = context.originView?.workspace?.workspaceId ?? null;
    const changed = changeScene(context, workspace.workspaceId, '打开', (scene) => slot === undefined
      ? focusSessionInScene(scene, session.sessionId)
      : assignSlotInScene(scene, session.sessionId, slot - 1));
    const { before, after } = changed;
    const delivery = navigateOrigin(context, {
      kind: 'workspace', workspaceId: workspace.workspaceId, sessionId: session.sessionId,
    });

    // 放进栏位后它实际所在的栏（会话不够时空栏会前移），以及被换下或互换的会话。
    const placedAt = after.scene.slots.indexOf(session.sessionId) + 1;
    const displacedId = slot === undefined ? undefined : before.scene.slots[slot - 1];
    const displaced = displacedId && displacedId !== session.sessionId
      ? before.scene.slots.includes(session.sessionId)
        ? `与原来在第 ${slot} 栏的「${titleOf(context, displacedId)}」互换`
        : `原来在第 ${slot} 栏的「${titleOf(context, displacedId)}」退出显示（仍在会话列表中）`
      : null;
    const switched = previousWorkspaceId !== workspace.workspaceId && delivery === 'shown'
      ? `已切到它所在的工作区「${workspace.name}」`
      : null;
    const headline = slot === undefined
      ? `已在工作区聚焦「${session.title}」`
      : `已把「${session.title}」放到第 ${placedAt} 栏`;
    const note = deliveryNote(delivery, sceneChanged(changed));
    return {
      content: [
        slot === undefined
          ? `已在工作区 ${workspaceLink(workspace)} 聚焦查看会话 ${sessionLink(session)}（id: ${session.sessionId}），只显示它，栏位不变。`
          : `已把会话 ${sessionLink(session)}（id: ${session.sessionId}）放到工作区 ${workspaceLink(workspace)} 的第 ${placedAt} 栏，` +
            `它是当前会话${displaced ? `；${displaced}` : ''}。`,
        `这个工作区现在是${layoutText(after.scene)}：${slotsText(context, after.scene)}。`,
        ...(switched ? [`${switched}。`] : []),
        delivery === 'shown' ? '只切换了发起的这个窗口；看着这个工作区的其他窗口同步了现场，但没有被切换页面。' : deliveryContent(delivery)!,
      ].join('\n'),
      result: {
        summary: summaryOf(headline),
        refs: [sessionRef(session), workspaceRef(workspace)],
        receipt: {
          headline: clip(headline, 119),
          detail: detailOf([`在「${workspace.name}」中`, displaced, switched, note]),
          actions: [{ kind: 'open-session', sessionId: session.sessionId }],
        },
      },
    };
  },
});

/** 调整并排数：与工作区条上的并排数选择相同（切回并排，当前会话始终保留在显示中）。只改现场，不切换页面。 */
export const setParallelCountTool = defineInternalTool({
  name: 'set_parallel_count',
  effect: 'manage',
  changesView: true,
  description: '调整工作区同时并排显示的栏数（2、3 或 4，与工作区条上的“并排数”相同，直接执行）：会切回并排；' +
    '多出的会话退出显示但不关闭（仍在会话列表中），当前会话始终保留在显示中，空出的栏按会话列表顺序补上。' +
    '只改这个工作区保存的现场（同步到看着它的所有窗口），不切换页面。' + EXPLICIT_ONLY,
  parameters: Type.Object(
    {
      count: Type.Union([Type.Literal(2), Type.Literal(3), Type.Literal(4)], { description: '并排栏数：2、3 或 4。' }),
      workspaceId: OptionalWorkspaceId,
    },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const workspace = targetWorkspace(params, context, '调整并排数');
    const changed = changeScene(context, workspace.workspaceId, '调整并排数', (scene) => resizeParallelInScene(scene, params.count));
    const { before, after } = changed;
    const delivery = sceneDelivery(context, workspace.workspaceId);
    if (!sceneChanged(changed)) {
      return {
        content: `工作区 ${workspaceLink(workspace)} 本来就是并排 ${params.count} 栏，没有改动。`,
        result: { summary: '并排数没有变化', refs: [workspaceRef(workspace)] },
      };
    }
    const hidden = before.scene.slots.filter((sessionId) => !after.scene.slots.includes(sessionId));
    const hiddenText = hidden.length > 0
      ? `${hidden.map((sessionId) => `「${titleOf(context, sessionId)}」`).join('、')}退出显示（仍在会话列表中）`
      : null;
    const headline = `已把「${workspace.name}」调为并排 ${params.count} 栏`;
    return {
      content: [
        `已把工作区 ${workspaceLink(workspace)} 调为并排 ${params.count} 栏：${slotsText(context, after.scene)}` +
          `${hiddenText ? `；${hiddenText}` : ''}。当前会话保留在显示中。`,
        ...(delivery === 'shown' ? [] : [deliveryContent(delivery)!]),
      ].join('\n'),
      result: {
        summary: summaryOf(headline),
        refs: [workspaceRef(workspace)],
        receipt: {
          headline: clip(headline, 119),
          detail: detailOf([`原来是${layoutText(before.scene)}`, hiddenText, deliveryNote(delivery, true)]),
          actions: [{ kind: 'open-workspace', workspaceId: workspace.workspaceId }],
        },
      },
    };
  },
});

const VIEW_MODE_LABELS: Readonly<Record<WorkspaceViewMode, string>> = { parallel: '并排', focus: '聚焦' };

/** 切换并排 / 聚焦：与工作区条上的视图切换相同。只改现场，不切换页面。 */
export const setViewModeTool = defineInternalTool({
  name: 'set_view_mode',
  effect: 'manage',
  changesView: true,
  description: '切换工作区的视图（与工作区条上的“并排 / 聚焦”相同，直接执行）：focus 只显示当前会话；parallel 按并排数显示各栏，' +
    '当前会话不在栏位中时改为第一栏的会话。只改这个工作区保存的现场（同步到看着它的所有窗口），不切换页面。' + EXPLICIT_ONLY,
  parameters: Type.Object(
    {
      mode: Type.Union([Type.Literal('parallel'), Type.Literal('focus')], { description: 'parallel 并排，focus 聚焦。' }),
      workspaceId: OptionalWorkspaceId,
    },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const workspace = targetWorkspace(params, context, '切换视图');
    const changed = changeScene(context, workspace.workspaceId, '切换视图', (scene) => switchViewModeInScene(scene, params.mode));
    const { after } = changed;
    const label = VIEW_MODE_LABELS[params.mode];
    const delivery = sceneDelivery(context, workspace.workspaceId);
    if (!sceneChanged(changed)) {
      return {
        content: `工作区 ${workspaceLink(workspace)} 本来就是${label}，没有改动。`,
        result: { summary: `本来就是${label}`, refs: [workspaceRef(workspace)] },
      };
    }
    const currentId = after.scene.focusedSessionId;
    const current = currentId ? `当前会话「${titleOf(context, currentId)}」` : '工作区中没有会话';
    const headline = `已把「${workspace.name}」切到${label}`;
    return {
      content: [
        `已把工作区 ${workspaceLink(workspace)} 切到${label}（${layoutText(after.scene)}）：${current}；${slotsText(context, after.scene)}。`,
        ...(delivery === 'shown' ? [] : [deliveryContent(delivery)!]),
      ].join('\n'),
      result: {
        summary: summaryOf(headline),
        refs: [workspaceRef(workspace)],
        receipt: {
          headline: clip(headline, 119),
          detail: detailOf([current, deliveryNote(delivery, true)]),
          actions: [{ kind: 'open-workspace', workspaceId: workspace.workspaceId }],
        },
      },
    };
  },
});

const ManagementPageParameter = Type.Union(
  MANAGEMENT_PAGE_IDS.map((page) => Type.Literal(page)),
  {
    description: `管理中的页面：${MANAGEMENT_PAGE_IDS.map((page) => `${page}（${MANAGEMENT_PAGE_LABELS[page]}）`).join('、')}。`,
  },
);

/** 打开管理中已实现的某一页，可以同时选中归档页的会话或项目页的项目。只切换发起窗口。 */
export const openManagementPageTool = defineInternalTool({
  name: 'open_management_page',
  effect: 'manage',
  changesView: true,
  description: '在用户发出这条消息的窗口中打开管理中的某一页（与面板跳转、“管理模型配置”等入口相同，直接执行），' +
    '例如用户说“打开模型设置”时打开 models。只能打开下列已实现的页面。page 为 archive 时可以用 sessionId 选中一个已归档会话，' +
    'page 为 projects 时可以用 projectId 选中一个项目。只切换发起的这个窗口；窗口已关闭或刷新、处于窄屏时不会打开，结果会说明。' + EXPLICIT_ONLY,
  parameters: Type.Object(
    {
      page: ManagementPageParameter,
      sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: '归档页中选中的已归档会话 id（只用于 archive）。' })),
      projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: '项目页中选中的项目 id（只用于 projects）。' })),
      taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: '待办页中选中的任务 id（只用于 tasks）。' })),
    },
    { additionalProperties: false },
  ),
  async execute(params, context) {
    const page = params.page as ManagementPageIdValue;
    const label = MANAGEMENT_PAGE_LABELS[page];
    if (params.taskId !== undefined && page !== 'tasks') throw new InternalToolError('taskId 只能和待办页（tasks）一起用。');
    if ([params.taskId, params.projectId, params.sessionId].filter((id) => id !== undefined).length > 1) throw new InternalToolError('一次只选中一个对象。');
    if (params.sessionId !== undefined && page !== 'archive') {
      throw new InternalToolError(`没有打开：sessionId 只能和归档页（archive）一起用，${label}没有选中的会话。`);
    }
    if (params.projectId !== undefined && page !== 'projects') {
      throw new InternalToolError(`没有打开：projectId 只能和项目页（projects）一起用，${label}没有选中的项目。`);
    }

    let selection: ManagementSelection = null;
    let selected: { text: string; name: string; ref: ReturnType<typeof sessionRef> | ReturnType<typeof taskRef> } | null = null;
    if (params.sessionId !== undefined) {
      const session = requireSession(context.services, params.sessionId, '打开归档页');
      if (session.archivedAt === null) throw new InternalToolError('没有打开：该会话未归档，请用 open_session 在工作区打开，授权在会话标题栏菜单中查看。');
      selection = { kind: 'session', sessionId: session.sessionId };
      selected = { text: sessionLink(session), name: session.title, ref: sessionRef(session) };
    } else if (params.projectId !== undefined) {
      const project = context.services.projects.listProjects().projects
        .find((candidate) => candidate.projectId === params.projectId);
      if (!project) {
        throw new InternalToolError(`没有打开：没有 id 为 ${params.projectId} 的项目。可以先用 list_projects 查看项目 id。`);
      }
      selection = { kind: 'project', projectId: project.projectId };
      selected = { text: projectLink(project), name: project.name, ref: projectRef(project) };
    } else if (params.taskId !== undefined) {
      const task = context.services.tasks?.get(params.taskId);
      if (!task) throw new InternalToolError('任务不存在。');
      selection = { kind: 'task', taskId: task.taskId };
      selected = { text: `[${task.title}](multivac://task/${task.taskId})`, name: task.title, ref: taskRef(task) };
    }

    const delivery = navigateOrigin(context, { kind: 'management', page, selection });
    if (delivery !== 'shown') {
      throw new InternalToolError(`没有打开${label}：${deliveryNote(delivery, false)}。${deliveryContent(delivery)}`);
    }
    const headline = `已打开${label}${selected ? `并选中「${selected.name}」` : ''}`;
    return {
      content: `已在发起这条消息的窗口中打开${label}${selected ? `，并选中 ${selected.text}` : ''}。其他窗口没有被切换。`,
      result: {
        summary: summaryOf(headline),
        refs: selected ? [selected.ref] : [],
        receipt: {
          headline: clip(headline, 119),
          detail: '',
          actions: [{ kind: 'open-management-page', page }],
        },
      },
    };
  },
});
