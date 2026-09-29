import { Type } from 'typebox';
import { WorkspaceSchema } from './project.js';
import { ToolAuthorizationGrantSchema } from './tool-authorization.js';
import { WorkspaceSceneSchema, WorkspaceSessionSchema } from './workspace-session.js';

/**
 * 工作台变更事件：会话、项目（随同名工作区）、工作区现场与记住的授权在服务端发生变化后推给所有打开的窗口，
 * 让各窗口不刷新即看到别处（另一个窗口、Multivac 的内部工具）的改动。
 *
 * 通道是一条 WebSocket（`WORKBENCH_EVENTS_PATH`），与按会话的 SSE 公共事件流分开：
 * 变更事件不属于任何会话，也不持久化、不重放；断线重连后由窗口整体重读一次。
 */
export const WORKBENCH_EVENTS_PATH = '/api/workbench/events';

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

export const WorkbenchEventSchema = Type.Union([
  WorkbenchConnectedEventSchema,
  WorkbenchSessionChangedEventSchema,
  WorkbenchWorkspaceChangedEventSchema,
  WorkbenchSceneChangedEventSchema,
  WorkbenchGrantChangedEventSchema,
]);
export type WorkbenchEvent = Type.Static<typeof WorkbenchEventSchema>;
export type WorkbenchChangeEvent = Exclude<WorkbenchEvent, { type: 'workbench.connected' }>;
