import { Type } from 'typebox';
import { WorkingDirectorySchema } from './workspace-session.js';

/** 授权等待的默认时限：30 分钟内没有决定，请求过期，本轮结束。 */
export const TOOL_AUTHORIZATION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 授权请求的状态：
 * - pending：待授权，Agent 的这次工具调用正在等待决定，本轮保持运行；
 * - approved：已批准（仅这一次），工具随后执行；
 * - denied：已拒绝，工具没有执行，拒绝原因回传 Agent，本轮继续；
 * - cancelled：已取消，等待期间用户停止了本轮；
 * - expired：已过期，等待超过时限，工具没有执行，本轮结束；
 * - invalidated：已失效，等待期间服务重启，原来的等待无法恢复，本轮按中断处理。
 * 只有 pending 可以转为其他状态；其余都是终态。
 */
export const ToolAuthorizationStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('denied'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
  Type.Literal('invalidated'),
]);
export type ToolAuthorizationStatus = Type.Static<typeof ToolAuthorizationStatusSchema>;

/** 请求授权的工具：按目标路径判定目录边界的文件工具。 */
export const ToolAuthorizationToolNameSchema = Type.Union([
  Type.Literal('read'),
  Type.Literal('edit'),
  Type.Literal('write'),
]);
export type ToolAuthorizationToolName = Type.Static<typeof ToolAuthorizationToolNameSchema>;

const Timestamp = Type.String({ minLength: 1 });
const Identifier = Type.String({ minLength: 1, maxLength: 512 });
const SessionId = Type.String({ minLength: 1, maxLength: 128 });

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
 * 用户对待授权请求的决定：once 为“仅这一次”，deny 为“拒绝”。
 * 记住决定（本会话内 / 本项目内始终允许）尚未提供。
 */
export const ToolAuthorizationDecisionSchema = Type.Union([
  Type.Literal('once'),
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
