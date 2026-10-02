import { Type } from 'typebox';
import {
  ToolAuthorizationApprovalSchema,
  ToolAuthorizationScopeSchema,
  ToolAuthorizationStatusSchema,
  type ToolAuthorizationApproval,
  type ToolAuthorizationScope,
  type ToolAuthorizationStatus,
} from './tool-authorization-status.js';
import { WorkingDirectorySchema } from './workspace-session.js';

export {
  ToolAuthorizationApprovalSchema,
  ToolAuthorizationScopeSchema,
  ToolAuthorizationStatusSchema,
  type ToolAuthorizationApproval,
  type ToolAuthorizationScope,
  type ToolAuthorizationStatus,
};

/** 授权等待的默认时限：30 分钟内没有决定，请求过期，本轮结束。 */
export const TOOL_AUTHORIZATION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** 请求授权的工具：按目标路径判定目录边界的文件工具。 */
export const ToolAuthorizationToolNameSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('edit'),
  Type.Literal('write'),
]);
export type ToolAuthorizationToolName = Type.Static<typeof ToolAuthorizationToolNameSchema>;

/**
 * 记住的授权按工具类别区分：read 只覆盖读取；write 覆盖修改与写入（edit、write），不含读取。
 * 两类互不包含，记住“修改”不会顺带放开读取。
 */
export const ToolAuthorizationAccessSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('write'),
]);
export type ToolAuthorizationAccess = Type.Static<typeof ToolAuthorizationAccessSchema>;

/** 工具所属的类别。 */
export function toolAuthorizationAccess(toolName: ToolAuthorizationToolName): ToolAuthorizationAccess {
  return toolName === 'read' ? 'read' : 'write';
}

const Timestamp = Type.String({ minLength: 1 });
const Identifier = Type.String({ minLength: 1, maxLength: 512 });
const SessionId = Type.String({ minLength: 1, maxLength: 128 });
const AbsolutePath = Type.String({ minLength: 1 });

/**
 * 这次请求可以记住的范围，由服务端在创建请求时按解析后的目标路径算出并随请求保存：
 * 选择“本会话内 / 本项目内”时记住的正是这里写明的目录，授权卡照原样展示，不接受客户端另给范围。
 */
export const ToolAuthorizationRememberSchema = Type.Object(
  {
    /** 记住后放行的目录（真实绝对路径）：目标所在的目录，含其中的子目录。 */
    directory: AbsolutePath,
    /** 会话所属的项目；为 null 时不提供“本项目内始终允许”。 */
    projectId: Type.Union([Identifier, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ToolAuthorizationRemember = Type.Static<typeof ToolAuthorizationRememberSchema>;

/** 一次目录外访问的授权请求。字段只描述请求本身，不含文件内容或工具输出。 */
export const ToolAuthorizationRequestSchema = Type.Object(
  {
    requestId: Identifier,
    /** 发起请求的会话（全局 Multivac 为 global-coordinator）。 */
    sessionId: SessionId,
    /** 本轮对应的发送命令；与运行轨迹、命令回执中的 commandId 一致。 */
    commandId: Type.Union([Identifier, Type.Null()]),
    toolName: ToolAuthorizationToolNameSchema,
    /** Pi 工具调用 id，与 assistant.tool.* 事件和工具执行记录中的 toolCallId 一致。 */
    toolCallId: Identifier,
    /** Agent 在工具参数中给出的原始路径。 */
    requestedPath: Type.String({ minLength: 1 }),
    /** 解析后的真实绝对路径，即工具实际访问的位置。 */
    targetPath: Type.String({ minLength: 1 }),
    /** 请求发出时会话的工作目录（类型 + 路径）。 */
    workingDirectory: WorkingDirectorySchema,
    status: ToolAuthorizationStatusSchema,
    createdAt: Timestamp,
    /** 等待时限：到这个时间仍待授权则过期。 */
    expiresAt: Timestamp,
    /** 离开待授权的时间；待授权时为 null。 */
    decidedAt: Type.Union([Timestamp, Type.Null()]),
    /** 批准的范围与来源；未批准时为 null。 */
    approval: Type.Union([ToolAuthorizationApprovalSchema, Type.Null()]),
    /**
     * 可以记住的范围；为 null 时只能“仅这一次”或拒绝（目标所在目录范围过大，
     * 例如根目录、用户主目录或包含 Multivac 数据与工作文件根目录的目录；或者按已记住的授权放行的记录）。
     */
    remember: Type.Union([ToolAuthorizationRememberSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ToolAuthorizationRequest = Type.Static<typeof ToolAuthorizationRequestSchema>;

/** 会话的授权请求（含历史），按创建时间升序。 */
export const ToolAuthorizationListResponseSchema = Type.Object(
  {
    sessionId: SessionId,
    requests: Type.Array(ToolAuthorizationRequestSchema),
  },
  { additionalProperties: false },
);
export type ToolAuthorizationListResponse = Type.Static<typeof ToolAuthorizationListResponseSchema>;

/**
 * 用户对待授权请求的决定：once 为“仅这一次”，session 为“本会话内允许”，
 * project 为“本项目内始终允许”（只有会话属于项目时可用），deny 为“拒绝”。
 * session 与 project 按请求中保存的 remember 范围记住决定。
 */
export const ToolAuthorizationDecisionSchema = Type.Union([
  ToolAuthorizationScopeSchema,
  Type.Literal('deny'),
]);
export type ToolAuthorizationDecision = Type.Static<typeof ToolAuthorizationDecisionSchema>;

export const DecideToolAuthorizationSchema = Type.Object(
  { decision: ToolAuthorizationDecisionSchema },
  { additionalProperties: false },
);
export type DecideToolAuthorization = Type.Static<typeof DecideToolAuthorizationSchema>;

export const ToolAuthorizationDecisionResponseSchema = Type.Object(
  { request: ToolAuthorizationRequestSchema },
  { additionalProperties: false },
);
export type ToolAuthorizationDecisionResponse = Type.Static<typeof ToolAuthorizationDecisionResponseSchema>;

/**
 * 记住的授权：在 scope 所指的会话或项目中，access 类别的工具访问 directory（含子目录）时直接放行，不再确认。
 * 只能由用户在授权卡上选择“本会话内 / 本项目内”产生；撤销后即时失效，记录保留以便追溯。
 */
export const ToolAuthorizationGrantSchema = Type.Object(
  {
    grantId: Identifier,
    scope: Type.Union([Type.Literal('session'), Type.Literal('project')]),
    /** scope 为 session 时的会话（全局 Multivac 为 global-coordinator），否则为 null。 */
    sessionId: Type.Union([SessionId, Type.Null()]),
    /** scope 为 project 时的项目，否则为 null。 */
    projectId: Type.Union([Identifier, Type.Null()]),
    access: ToolAuthorizationAccessSchema,
    /** 放行的目录（真实绝对路径），含其中的子目录。 */
    directory: AbsolutePath,
    /** 产生这条授权的请求（用户在它的授权卡上作出了决定）。 */
    sourceRequestId: Identifier,
    createdAt: Timestamp,
    /** 最近一次按这条授权放行的时间；还没有用过时为 null。 */
    lastUsedAt: Type.Union([Timestamp, Type.Null()]),
    /** 按这条授权放行的次数。 */
    useCount: Type.Integer({ minimum: 0 }),
    /** 撤销时间；仍有效时为 null。 */
    revokedAt: Type.Union([Timestamp, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ToolAuthorizationGrant = Type.Static<typeof ToolAuthorizationGrantSchema>;

/** 仍有效的记住的授权，最近记住的在前。 */
export const ToolAuthorizationGrantListResponseSchema = Type.Object(
  { grants: Type.Array(ToolAuthorizationGrantSchema) },
  { additionalProperties: false },
);
export type ToolAuthorizationGrantListResponse = Type.Static<typeof ToolAuthorizationGrantListResponseSchema>;

/** 撤销的结果（按授权 id 幂等，重复撤销返回同一条记录）。 */
export const ToolAuthorizationGrantResponseSchema = Type.Object(
  { grant: ToolAuthorizationGrantSchema },
  { additionalProperties: false },
);
export type ToolAuthorizationGrantResponse = Type.Static<typeof ToolAuthorizationGrantResponseSchema>;

/** 最近的授权请求接口一次返回的条数上限（会话授权窗口按会话列出）。 */
export const TOOL_AUTHORIZATION_HISTORY_LIMIT = 50;

/**
 * 最近的授权请求（含按已记住的授权放行的记录），最近的在前，只读。
 * `GET /api/authorization-requests` 跨全部会话；`?sessionId=` 只取这个会话的。
 */
export const ToolAuthorizationHistoryResponseSchema = Type.Object(
  { requests: Type.Array(ToolAuthorizationRequestSchema, { maxItems: TOOL_AUTHORIZATION_HISTORY_LIMIT }) },
  { additionalProperties: false },
);
export type ToolAuthorizationHistoryResponse = Type.Static<typeof ToolAuthorizationHistoryResponseSchema>;
