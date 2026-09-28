import type {
  AssistantPublicEvent,
  ToolAuthorizationRequest,
  ToolAuthorizationStatus,
} from '@multivac/contracts';

/** 请求离开待授权后的状态。 */
export type ResolvedToolAuthorizationStatus = Exclude<ToolAuthorizationStatus, 'pending'>;

/** 新建授权请求所需的字段；状态总是从待授权开始。 */
export type NewToolAuthorizationRequest = Omit<ToolAuthorizationRequest, 'status' | 'decidedAt'>;

/**
 * 请求的写入与对应公共事件在同一个 SQLite 事务中提交；
 * event 为 null 表示这次调用没有改变请求（例如请求早已离开待授权）。
 */
export interface ToolAuthorizationMutation {
  request: ToolAuthorizationRequest;
  event: AssistantPublicEvent | null;
}

export interface ToolAuthorizationRepository {
  get(requestId: string): ToolAuthorizationRequest | undefined;
  /** 会话的全部请求（含历史），按创建顺序。 */
  listBySession(sessionId: string): ToolAuthorizationRequest[];
  /** 写入待授权请求，并追加 assistant.authorization.requested 事件。 */
  create(request: NewToolAuthorizationRequest): ToolAuthorizationMutation;
  /**
   * 只有仍待授权的请求才会转为 status，并追加 assistant.authorization.resolved 事件；
   * 请求已离开待授权时原样返回、不追加事件。请求不存在时抛错。
   */
  resolve(requestId: string, status: ResolvedToolAuthorizationStatus, decidedAt: string): ToolAuthorizationMutation;
  /** 把全部待授权请求置为已失效，返回每条请求的变更；用于启动对账。 */
  invalidatePending(decidedAt: string): ToolAuthorizationMutation[];
}
