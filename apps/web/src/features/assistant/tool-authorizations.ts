import type { ToolAuthorizationStatus } from '@multivac/contracts';

/** 请求离开待授权后的结果文案：各终态口径一致。 */
export const AUTHORIZATION_OUTCOMES: Record<Exclude<ToolAuthorizationStatus, 'pending'>, {
  /** 工具行上的短标签。 */
  short: string;
}> = {
  approved: { short: '已批准' },
  denied: { short: '已拒绝' },
  cancelled: { short: '已取消' },
  expired: { short: '已过期' },
  invalidated: { short: '已失效' },
};
