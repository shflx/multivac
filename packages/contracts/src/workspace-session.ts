import { Type } from 'typebox';

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
