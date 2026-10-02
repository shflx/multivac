import { Type } from 'typebox';
import { PreferencesSchema } from './preferences.js';
import { ManagementSelectionSchema } from './current-view.js';
import { ManagementPageIdSchema } from './management-pages.js';
import { WorkspaceSchema } from './project.js';
import { ProposalSchema } from './proposals.js';
import { ToolAuthorizationGrantSchema } from './tool-authorization.js';
import { WorkspaceSceneSchema, WorkspaceSessionIdSchema, WorkspaceSessionSchema } from './workspace-session.js';

/**
 * 工作台变更事件：会话、项目（随同名工作区）、工作区现场、记住的授权与对话内的提议在服务端发生变化后推给所有打开的窗口，
 * 让各窗口不刷新即看到别处（另一个窗口、Multivac 的内部工具）的改动。
 *
 * 通道：每个窗口一条的全局事件流（`GLOBAL_EVENTS_PATH`，SSE）中事件名为 `WORKBENCH_SSE_EVENT_NAME` 的消息，不带游标。
 * 变更事件不属于任何会话，也不持久化、不重放；断线重连后由窗口整体重读一次。
 *
 * `WORKBENCH_SSE_EVENT_NAME`：全局事件流中工作台变更的 SSE 事件名；data 是一条 `WorkbenchEvent`。
 */
export const WORKBENCH_SSE_EVENT_NAME = 'workbench-event';

/** 写请求携带发起窗口的请求头：服务端据此在变更事件中注明来源。 */
export const WINDOW_ID_HEADER = 'x-multivac-window-id';

/**
 * 窗口 id：每个浏览器标签页每次加载生成一个，不持久化、不写入服务端数据。
 * 写请求经 `WINDOW_ID_HEADER` 携带，事件流连接时经查询参数 `windowId` 登记。
 */
export const WindowIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });

/**
 * 变更的来源：
 * - windowId 有值、commandId 为 null：该窗口直接发起的请求（界面操作），窗口已按接口返回写回自己的状态；
 * - commandId 有值：Multivac 在发送命令 commandId 这一轮中经内部工具所做的改动，windowId 是发出这条消息的窗口（未知时为 null）；
 * - 两者都为 null：没有窗口身份的请求或服务端自身的改动。
 */
export const WorkbenchChangeOriginSchema = Type.Object(
  {
    windowId: Type.Union([WindowIdSchema, Type.Null()]),
    commandId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkbenchChangeOrigin = Type.Static<typeof WorkbenchChangeOriginSchema>;

/** 没有窗口身份、也不在 Multivac 一轮中的改动。 */
export const UNKNOWN_CHANGE_ORIGIN: WorkbenchChangeOrigin = { windowId: null, commandId: null };

/** 事件序号：服务进程内单调递增，便于排查与测试核对顺序；不持久化，重启后从 1 开始。 */
const Seq = Type.Integer({ minimum: 1 });

/** 连接建立后的第一条消息：窗口据此（首次连接或断线重连后）整体重读一次共享列表与当前现场。 */
export const WorkbenchConnectedEventSchema = Type.Object(
  {
    type: Type.Literal('workbench.connected'),
    seq: Seq,
    windowId: Type.Union([WindowIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

/** 会话新建、改名、归档、恢复或归入项目：载荷是变化后的会话快照。 */
export const WorkbenchSessionChangedEventSchema = Type.Object(
  {
    type: Type.Literal('session.changed'),
    seq: Seq,
    origin: WorkbenchChangeOriginSchema,
    change: Type.Union([
      Type.Literal('created'),
      Type.Literal('renamed'),
      Type.Literal('archived'),
      Type.Literal('restored'),
      Type.Literal('moved'),
      Type.Literal('activity'),
    ]),
    session: WorkspaceSessionSchema,
  },
  { additionalProperties: false },
);

/** 项目新建或更新：载荷是项目的同名工作区（带项目、目录与默认约束）。 */
export const WorkbenchWorkspaceChangedEventSchema = Type.Object(
  {
    type: Type.Literal('workspace.changed'),
    seq: Seq,
    origin: WorkbenchChangeOriginSchema,
    change: Type.Union([Type.Literal('created'), Type.Literal('updated')]),
    workspace: WorkspaceSchema,
  },
  { additionalProperties: false },
);

/** 工作区现场的内容变化（保存、归档或归入项目时服务端移出会话）：载荷是带版本的现场快照。 */
export const WorkbenchSceneChangedEventSchema = Type.Object(
  {
    type: Type.Literal('scene.changed'),
    seq: Seq,
    origin: WorkbenchChangeOriginSchema,
    scene: WorkspaceSceneSchema,
  },
  { additionalProperties: false },
);

/** 记住的授权产生（授权卡上选择记住）或被撤销：载荷是授权快照。 */
export const WorkbenchGrantChangedEventSchema = Type.Object(
  {
    type: Type.Literal('grant.changed'),
    seq: Seq,
    origin: WorkbenchChangeOriginSchema,
    change: Type.Union([Type.Literal('created'), Type.Literal('revoked')]),
    grant: ToolAuthorizationGrantSchema,
  },
  { additionalProperties: false },
);

/**
 * 全局 Multivac 的提议（对话内确认卡）新提出或状态变化（确认、执行、取消、过期、失败）：载荷是提议快照。
 * 各窗口据此让首页与侧栏中的卡片一致，确认或取消后原地变为回执。
 */
export const WorkbenchProposalChangedEventSchema = Type.Object(
  {
    type: Type.Literal('proposal.changed'),
    seq: Seq,
    origin: WorkbenchChangeOriginSchema,
    change: Type.Union([Type.Literal('created'), Type.Literal('updated')]),
    proposal: ProposalSchema,
  },
  { additionalProperties: false },
);

/**
 * 导航的目标：
 * - workspace：切到工作区面板与这个工作区。sessionId 是切换后这个工作区的当前会话：窗口从首页或管理切过来时，
 *   把输入焦点交给它（与界面上“在工作区打开”一致）；窗口本来就在工作区面板时焦点不动。现场（栏位、并排数、视图）
 *   由服务端保存并以 scene.changed 推送，导航本身不带现场。
 * - management：打开管理中的某一页（只限已实现的页面），可以同时选中归档页的会话或项目页的项目。
 */
export const WindowNavigationTargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('workspace'),
      workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
      sessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('management'),
      page: ManagementPageIdSchema,
      selection: ManagementSelectionSchema,
    },
    { additionalProperties: false },
  ),
]);
export type WindowNavigationTarget = Type.Static<typeof WindowNavigationTargetSchema>;

/**
 * 只推给发起对话的那个窗口的导航指令：Multivac 应用户明确要求（打开 / 切到 / 放到）切换界面时发出，
 * 其他窗口收不到，只收到常规的现场与会话变更。窗口在窄屏时不切换。来源是发起的那一轮。
 */
export const WorkbenchWindowNavigateEventSchema = Type.Object(
  {
    type: Type.Literal('window.navigate'),
    seq: Seq,
    origin: WorkbenchChangeOriginSchema,
    target: WindowNavigationTargetSchema,
  },
  { additionalProperties: false },
);

export const WorkbenchPreferencesChangedEventSchema = Type.Object({
  type: Type.Literal('preferences.changed'), seq: Seq, preferences: PreferencesSchema,
}, { additionalProperties: false });

export const WorkbenchEventSchema = Type.Union([
  WorkbenchPreferencesChangedEventSchema,
  WorkbenchConnectedEventSchema,
  WorkbenchSessionChangedEventSchema,
  WorkbenchWorkspaceChangedEventSchema,
  WorkbenchSceneChangedEventSchema,
  WorkbenchGrantChangedEventSchema,
  WorkbenchProposalChangedEventSchema,
  WorkbenchWindowNavigateEventSchema,
]);
export type WorkbenchEvent = Type.Static<typeof WorkbenchEventSchema>;
export type WorkbenchChangeEvent = Exclude<WorkbenchEvent, { type: 'workbench.connected' }>;
