import { Type } from 'typebox';

// 授权状态与批准范围单独成模块：工具执行记录（assistant-session）也引用它们，
// 放在 tool-authorization 里会与 workspace-session 形成循环导入。

/**
 * 授权请求的状态：
 * - pending：待授权，Agent 的这次工具调用正在等待决定，本轮保持运行；
 * - approved：已批准（范围见 approval：仅这一次、本会话内或本项目内），工具随后执行；
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

/**
 * 批准的范围：once 为“仅这一次”；session 为“本会话内允许”，project 为“本项目内始终允许”，
 * 这两种会记住决定，之后同一范围内的同类操作不再确认。
 */
export const ToolAuthorizationScopeSchema = Type.Union([
  Type.Literal('once'),
  Type.Literal('session'),
  Type.Literal('project'),
]);
export type ToolAuthorizationScope = Type.Static<typeof ToolAuthorizationScopeSchema>;

/**
 * 已批准请求的范围与来源：source 为 user 时是用户在授权卡上作出的决定，
 * 为 grant 时是按已记住的授权自动放行（没有出现授权卡）。grantId 是创建或命中的那条记住的授权，
 * 仅这一次时为 null。
 */
export const ToolAuthorizationApprovalSchema = Type.Object(
  {
    scope: ToolAuthorizationScopeSchema,
    source: Type.Union([Type.Literal('user'), Type.Literal('grant')]),
    grantId: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ToolAuthorizationApproval = Type.Static<typeof ToolAuthorizationApprovalSchema>;
