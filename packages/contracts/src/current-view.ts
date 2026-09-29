import { Type } from 'typebox';
import {
  WORKSPACE_MAX_PARALLEL,
  WORKSPACE_PARALLEL_OPTIONS,
  WorkspaceSessionIdSchema,
  WorkspaceViewModeSchema,
} from './workspace-session.js';

/**
 * 发起窗口的当前视图快照：向全局 Multivac 发送消息时由窗口一并带上，Multivac 据此理解
 * “这个 / 第二栏那个 / 当前工作区”。当前面板、当前工作区与各栏位只在窗口本机，服务端不另行保存。
 *
 * 快照只含面板、布局与对象 id，不含任何标题或正文：名称由服务端按 id 从注册表读取，
 * 已不存在的对象如实说明。快照不改变任何权限，也不进入命令的幂等指纹与回执。
 */

/** 管理中已实现的页面（与界面的管理页注册表一致）。 */
export const MANAGEMENT_PAGE_IDS = ['sessions', 'projects', 'models', 'preferences'] as const;
export const ManagementPageIdSchema = Type.Union([
  Type.Literal('sessions'), Type.Literal('projects'), Type.Literal('models'), Type.Literal('preferences'),
]);
export type ManagementPageIdValue = (typeof MANAGEMENT_PAGE_IDS)[number];

/** 管理页在对话与说明里的称呼。 */
export const MANAGEMENT_PAGE_LABELS: Readonly<Record<ManagementPageIdValue, string>> = {
  sessions: '管理 · 会话',
  projects: '设置 · 项目',
  models: '设置 · 模型',
  preferences: '设置 · 偏好',
};

const ObjectId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });

/** 工作区界面实际呈现的现场：并排数、视图、各栏的会话（第 1 栏在前）与当前会话。 */
export const CurrentViewSceneSchema = Type.Object(
  {
    parallelCount: Type.Integer({ minimum: WORKSPACE_PARALLEL_OPTIONS[0], maximum: WORKSPACE_MAX_PARALLEL }),
    viewMode: WorkspaceViewModeSchema,
    slots: Type.Array(WorkspaceSessionIdSchema, { maxItems: WORKSPACE_MAX_PARALLEL }),
    focusedSessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type CurrentViewScene = Type.Static<typeof CurrentViewSceneSchema>;

export const CurrentViewSnapshotSchema = Type.Object(
  {
    /** 发送消息时窗口所在的面板：Multivac 首页、工作区或管理。 */
    panel: Type.Union([Type.Literal('home'), Type.Literal('workspace'), Type.Literal('management')]),
    /** 窄屏（只保留 Multivac 首页，工作区与管理不显示）。 */
    narrow: Type.Boolean(),
    /**
     * 窗口的当前工作区（不在工作区面板时是上次所在、再进入工作区时回到的那个）。
     * scene 是界面呈现的现场；工作区尚未在本窗口打开、现场还没读完时为 null，由服务端以保存的现场补充。
     */
    workspace: Type.Union([
      Type.Object(
        {
          workspaceId: ObjectId,
          scene: Type.Union([CurrentViewSceneSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** 管理中所在的页面与该页选中的对象（会话页的会话、项目页的项目）；不在管理中时为 null。 */
    management: Type.Union([
      Type.Object(
        {
          page: ManagementPageIdSchema,
          selection: Type.Union([
            Type.Object({ kind: Type.Literal('session'), sessionId: ObjectId }, { additionalProperties: false }),
            Type.Object({ kind: Type.Literal('project'), projectId: ObjectId }, { additionalProperties: false }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type CurrentViewSnapshot = Type.Static<typeof CurrentViewSnapshotSchema>;
