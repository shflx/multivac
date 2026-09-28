import { Type } from 'typebox';

// 授权状态单独成模块：工具执行记录（assistant-session）也引用它，
// 放在 tool-authorization 里会与 workspace-session 形成循环导入。

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
