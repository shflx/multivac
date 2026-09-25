import { Type } from 'typebox';
import { AssistantQuoteSchema } from './assistant-session.js';

/** 首版只有一个默认工作区；数据按工作区 id 保存，后续接入项目时不返工。 */
export const DEFAULT_WORKSPACE_ID = 'default';
export const WORKSPACE_SESSION_TITLE_MAX_LENGTH = 80;
export const WORKSPACE_SESSION_BODY_LIMIT_BYTES = 4 * 1024;

/** 会话 id 由客户端生成并作为新建命令的幂等键，与 commandId 使用相同字符集。 */
export const WorkspaceSessionIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9._:-]+$',
});

const Title = Type.String({ minLength: 1, maxLength: WORKSPACE_SESSION_TITLE_MAX_LENGTH });
const Timestamp = Type.String({ minLength: 1 });

/** coordinator 是全局 Multivac 会话；work 是用户在工作区里新建的工作会话。 */
export const WorkspaceSessionKindSchema = Type.Union([
  Type.Literal('coordinator'),
  Type.Literal('work'),
]);
export type WorkspaceSessionKind = Type.Static<typeof WorkspaceSessionKindSchema>;

export const WorkspaceSessionSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    title: Title,
    kind: WorkspaceSessionKindSchema,
    workspaceId: Type.String({ minLength: 1 }),
    createdAt: Timestamp,
    archivedAt: Type.Union([Timestamp, Type.Null()]),
    /** 栈式深入的父会话；顶层会话为 null。 */
    parentSessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
    /** 深入时在父会话中选中的内容；顶层会话为 null。 */
    originText: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type WorkspaceSession = Type.Static<typeof WorkspaceSessionSchema>;

export const WorkspaceSessionListResponseSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    sessions: Type.Array(WorkspaceSessionSchema),
  },
  { additionalProperties: false },
);
export type WorkspaceSessionListResponse = Type.Static<typeof WorkspaceSessionListResponseSchema>;

export const CreateWorkspaceSessionSchema = Type.Object(
  {
    sessionId: WorkspaceSessionIdSchema,
    title: Title,
    /** 栈式深入：基于父会话中选中的一段内容新建子会话。 */
    parent: Type.Optional(Type.Object(
      {
        sessionId: WorkspaceSessionIdSchema,
        quote: AssistantQuoteSchema,
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);
export type CreateWorkspaceSession = Type.Static<typeof CreateWorkspaceSessionSchema>;

export const RenameWorkspaceSessionSchema = Type.Object(
  { title: Title },
  { additionalProperties: false },
);
export type RenameWorkspaceSession = Type.Static<typeof RenameWorkspaceSessionSchema>;

/** 标题去掉首尾空白后才计算长度；全空白视为未填写。 */
export function normalizeWorkspaceSessionTitle(title: string): string | null {
  const normalized = title.trim();
  if (!normalized || normalized.length > WORKSPACE_SESSION_TITLE_MAX_LENGTH) return null;
  return normalized;
}

/** 并排最多展示的会话数。 */
export const WORKSPACE_MAX_PARALLEL = 2;
/** 现场中记住的会话顺序上限；超出部分按创建顺序跟在后面，不需要记忆。 */
export const WORKSPACE_SCENE_MAX_ORDER = 200;

export const WorkspaceViewModeSchema = Type.Union([Type.Literal('parallel'), Type.Literal('focus')]);
export type WorkspaceViewMode = Type.Static<typeof WorkspaceViewModeSchema>;

/**
 * 工作区现场：会话展示顺序（前两个并排）、当前会话、并排 / 聚焦、两栏宽度与工作区条显隐。
 * 保存在服务端，按工作区 id 区分；刷新或重启后原样恢复。
 */
export const WorkspaceSceneStateSchema = Type.Object(
  {
    order: Type.Array(WorkspaceSessionIdSchema, { maxItems: WORKSPACE_SCENE_MAX_ORDER }),
    focusedSessionId: Type.Union([WorkspaceSessionIdSchema, Type.Null()]),
    viewMode: WorkspaceViewModeSchema,
    /** 并排两栏时左栏的宽度占比。 */
    split: Type.Number({ minimum: 0, maximum: 1 }),
    barVisible: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WorkspaceSceneState = Type.Static<typeof WorkspaceSceneStateSchema>;

export const WorkspaceSceneSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1 }),
    scene: WorkspaceSceneStateSchema,
  },
  { additionalProperties: false },
);
export type WorkspaceScene = Type.Static<typeof WorkspaceSceneSchema>;

export const DEFAULT_WORKSPACE_SCENE: WorkspaceSceneState = {
  order: [],
  focusedSessionId: null,
  viewMode: 'parallel',
  split: 0.5,
  barVisible: true,
};
