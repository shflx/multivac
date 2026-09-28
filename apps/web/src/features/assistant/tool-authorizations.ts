import type {
  AssistantPublicEvent,
  ToolAuthorizationRequest,
  ToolAuthorizationStatus,
  ToolAuthorizationToolName,
  WorkingDirectoryKind,
} from '@multivac/contracts';
import { AssistantApiError } from '../../data/assistant-api.js';

/**
 * 会话内的目录外访问授权请求。
 *
 * 状态以服务端请求记录为准：进入会话时经查询接口读取全部请求（含历史），之后由
 * assistant.authorization.requested / resolved 事件增量更新。请求只有“待授权”一个非终态，
 * 离开后不会再变化，所以合并时终态总是优先于待授权，查询结果与事件先后到达都不会回退。
 */
export type ToolAuthorizationRecords = readonly ToolAuthorizationRequest[];

function byCreation(left: ToolAuthorizationRequest, right: ToolAuthorizationRequest): number {
  return left.createdAt.localeCompare(right.createdAt);
}

/** 写入一条请求快照；已记录终态的请求不会被较早的待授权快照覆盖。 */
export function upsertAuthorization(
  records: ToolAuthorizationRecords,
  request: ToolAuthorizationRequest,
): ToolAuthorizationRequest[] {
  const index = records.findIndex((record) => record.requestId === request.requestId);
  if (index < 0) return [...records, request].sort(byCreation);
  const current = records[index]!;
  if (current.status !== 'pending' && request.status === 'pending') return [...records];
  return records.map((record, position) => position === index ? request : record);
}

/** 合并查询接口返回的全部请求（与已有记录按同一规则合并，期间到达的事件不会丢失）。 */
export function mergeAuthorizations(
  records: ToolAuthorizationRecords,
  fetched: readonly ToolAuthorizationRequest[],
): ToolAuthorizationRequest[] {
  return fetched.reduce<ToolAuthorizationRequest[]>(
    (current, request) => upsertAuthorization(current, request),
    [...records],
  );
}

export function applyAuthorizationEvent(
  records: ToolAuthorizationRecords,
  event: AssistantPublicEvent,
): ToolAuthorizationRequest[] {
  if (event.type !== 'assistant.authorization.requested' && event.type !== 'assistant.authorization.resolved') {
    return [...records];
  }
  return upsertAuthorization(records, event.data.request);
}

export function pendingAuthorizations(records: ToolAuthorizationRecords): ToolAuthorizationRequest[] {
  return records.filter((record) => record.status === 'pending');
}

/** 工具动作与工具行的写法一致：读取 / 修改 / 写入。 */
export const AUTHORIZATION_TOOL_ACTIONS: Record<ToolAuthorizationToolName, string> = {
  read: '读取',
  edit: '修改',
  write: '写入',
};

/**
 * 工作目录类型与目录内的规则。规则只描述已经生效的行为：目录内自动执行，目录外需要确认。
 */
export const WORKING_DIRECTORY_KINDS: Record<WorkingDirectoryKind, { label: string; rule: string }> = {
  'session-temp': { label: '临时目录', rule: '会话专用，目录内的读写自动执行。' },
  multivac: { label: 'Multivac 工作目录', rule: '全局 Multivac 长期使用，目录内的读写自动执行。' },
  'project-managed': { label: '项目托管目录', rule: '由 Multivac 托管，目录内的读写自动执行。' },
  'project-mounted': { label: '挂载目录', rule: '目录内的读写自动执行。' },
  worktree: { label: 'worktree', rule: '在独立的 worktree 里修改，目录内的读写自动执行。' },
};

/** 请求离开待授权后的结果文案：卡片与工具行共用，各终态口径一致。 */
export const AUTHORIZATION_OUTCOMES: Record<Exclude<ToolAuthorizationStatus, 'pending'>, {
  /** 工具行上的短标签。 */
  short: string;
  /** 卡片上的结果说明。 */
  detail: string;
}> = {
  approved: { short: '已批准', detail: '已批准（仅这一次）' },
  denied: { short: '已拒绝', detail: '已拒绝：没有执行，Multivac 已收到原因' },
  cancelled: { short: '已取消', detail: '已取消：本轮已停止，没有执行' },
  expired: { short: '已过期', detail: '已过期：等待超时，本轮已结束，没有执行' },
  invalidated: { short: '已失效', detail: '已失效：服务已重启，原来的等待无法恢复，没有执行' },
};

/** 待授权卡上的有效期：请求在这个时间之后过期。无法解析时不显示。 */
export function authorizationDeadline(request: ToolAuthorizationRequest): string | null {
  const expiresAt = new Date(request.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return null;
  const time = expiresAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${time} 前有效`;
}

/**
 * 提交决定失败时的说明。请求已被另一处决定（冲突）或已离开待授权时，沿用服务端的说明，
 * 调用方随即按服务端状态刷新卡片；其他失败保留按钮供重试。
 */
export function authorizationDecisionError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof AssistantApiError) {
    if (error.code === 'AUTHORIZATION_CONFLICT' || error.code === 'AUTHORIZATION_NOT_PENDING') {
      return { message: error.message, refresh: true };
    }
    if (error.code === 'NOT_FOUND') {
      return { message: '授权请求已不存在，卡片已按服务端状态更新。', refresh: true };
    }
    return { message: `决定没有提交：${error.message}`, refresh: false };
  }
  return { message: '决定没有提交：网络连接不可用，请重试。', refresh: false };
}
