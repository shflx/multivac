import { Type } from 'typebox';
import {
  WORKSPACE_MAX_PARALLEL,
  WORKSPACE_PARALLEL_OPTIONS,
  WorkspaceSessionIdSchema,
  WorkspaceViewModeSchema,
} from './workspace-session.js';
import { ManagementPageIdSchema } from './management-pages.js';

/**
 * 发起窗口的当前视图快照：向全局 Multivac 发送消息时由窗口一并带上，Multivac 据此理解
 * “这个 / 第二栏那个 / 当前工作区”。当前面板、当前工作区与各栏位只在窗口本机，服务端不另行保存。
 *
 * 快照只含面板、布局、对象 id 和可选文件阅读位置，不含任何标题或正文：名称由服务端按 id 从注册表读取，
 * 已不存在的对象如实说明。快照不改变任何权限，也不进入命令的幂等指纹与回执。
 */

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

/** 管理页中选中的对象：归档页的会话或项目页的项目。 */
export const ManagementSelectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('session'), sessionId: ObjectId }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('project'), projectId: ObjectId }, { additionalProperties: false }),
  Type.Null(),
]);
export type ManagementSelection = Type.Static<typeof ManagementSelectionSchema>;

export const CurrentFileReadingSchema = Type.Object({
  sessionId: ObjectId, root: Type.String({ minLength: 1, maxLength: 4096 }), path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\u0000]*$' }),
  focus: Type.Union([Type.Literal('file'), Type.Literal('discussion')]),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), section: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
export type CurrentFileReading = Type.Static<typeof CurrentFileReadingSchema>;

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
          reading: Type.Optional(Type.Union([CurrentFileReadingSchema, Type.Null()])),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** 管理中所在的页面与该页选中的对象（归档页的会话、项目页的项目）；不在管理中时为 null。 */
    management: Type.Union([
      Type.Object(
        {
          page: ManagementPageIdSchema,
          selection: ManagementSelectionSchema,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type CurrentViewSnapshot = Type.Static<typeof CurrentViewSnapshotSchema>;
