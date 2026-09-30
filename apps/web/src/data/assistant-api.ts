import {
  AssistantApiErrorResponseSchema,
  AssistantCommandReceiptSchema,
  AssistantCommandReconciliationResponseSchema,
  AssistantEventRangeResponseSchema,
  AssistantPageStateSchema,
  AssistantPublicEventSchema,
  AssistantSessionPageResponseSchema,
  AssistantToolExecutionDetailSchema,
  ProposalDecisionResponseSchema,
  ProposalListResponseSchema,
  ToolAuthorizationDecisionResponseSchema,
  ToolAuthorizationGrantListResponseSchema,
  ToolAuthorizationGrantResponseSchema,
  ToolAuthorizationHistoryResponseSchema,
  ToolAuthorizationListResponseSchema,
  type AssistantApiErrorCode,
  type AssistantPageState,
  type AssistantPageStatePut,
  type AssistantCommandReceipt,
  type AssistantCommandReconciliationResponse,
  type AssistantEventRangeResponse,
  type AssistantPublicEvent,
  type AssistantToolExecutionDetail,
  type CancelAssistantTurnCommand,
  type SendAssistantMessageCommand,
  type AssistantSessionPageResponse,
  type ProposalDecision,
  type ProposalDecisionResponse,
  type ProposalListResponse,
  type ToolAuthorizationDecision,
  type ToolAuthorizationDecisionResponse,
  type ToolAuthorizationGrantListResponse,
  type ToolAuthorizationGrantResponse,
  type ToolAuthorizationHistoryResponse,
  type ToolAuthorizationListResponse,
  ASSISTANT_SSE_EVENT_NAME,
  GLOBAL_ASSISTANT_SESSION_ID,
  GLOBAL_EVENTS_PATH,
  WINDOW_ID_HEADER,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { windowId } from './window-id.js';

export class AssistantApiError extends Error {
  constructor(
    readonly code: AssistantApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AssistantApiError('INTERNAL_ERROR', '服务返回了无法解析的响应。', response.status);
  }
}

/** 写请求（GET 以外）带上本窗口的 id：服务端据此在工作台变更事件中注明发起窗口。 */
function withWindowId(init: RequestInit | undefined): RequestInit | undefined {
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return init;
  const headers = new Headers(init?.headers);
  headers.set(WINDOW_ID_HEADER, windowId());
  return { ...init, headers };
}

/** 请求并按契约校验 JSON 响应；错误响应转换为带错误码的 AssistantApiError。 */
export async function fetchJson<T>(url: string, init: RequestInit | undefined, schema: object): Promise<T> {
  const response = await fetch(url, withWindowId(init));
  const body = await responseJson(response);
  if (!response.ok) {
    if (Check(AssistantApiErrorResponseSchema, body)) {
      throw new AssistantApiError(body.error.code, body.error.message, response.status);
    }
    throw new AssistantApiError('INTERNAL_ERROR', 'Multivac 服务请求失败。', response.status);
  }
  if (!Check(schema, body)) {
    throw new AssistantApiError('INTERNAL_ERROR', '服务响应不符合 Multivac 契约。', response.status);
  }
  return body as T;
}

/**
 * 会话级接口前缀：全局协调会话沿用 `/api/assistant`，其他会话走 `/api/sessions/:id`。
 */
export function assistantApiBase(sessionId: string): string {
  return sessionId === GLOBAL_ASSISTANT_SESSION_ID
    ? '/api/assistant'
    : `/api/sessions/${encodeURIComponent(sessionId)}`;
}

export function getAssistantSessionPage(
  sessionId: string,
  before?: string,
  limit = 30,
): Promise<AssistantSessionPageResponse> {
  const parameters = new URLSearchParams({ limit: String(limit) });
  if (before) parameters.set('before', before);
  return fetchJson(
    `${assistantApiBase(sessionId)}/session?${parameters.toString()}`,
    undefined,
    AssistantSessionPageResponseSchema,
  );
}

export function getAssistantPageState(sessionId: string): Promise<AssistantPageState> {
  return fetchJson(`${assistantApiBase(sessionId)}/page-state`, undefined, AssistantPageStateSchema);
}

/** 工具执行明细按需读取；会话快照只携带摘要层。 */
export function getAssistantToolExecution(
  sessionId: string,
  toolCallId: string,
): Promise<AssistantToolExecutionDetail> {
  return fetchJson(
    `${assistantApiBase(sessionId)}/tools/${encodeURIComponent(toolCallId)}`,
    undefined,
    AssistantToolExecutionDetailSchema,
  );
}

export function putAssistantPageState(
  sessionId: string,
  state: AssistantPageStatePut,
  keepalive = false,
): Promise<AssistantPageState> {
  return fetchJson(`${assistantApiBase(sessionId)}/page-state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
    keepalive,
  }, AssistantPageStateSchema);
}

export function sendAssistantMessage(
  command: SendAssistantMessageCommand,
): Promise<AssistantCommandReceipt> {
  return fetchJson(`${assistantApiBase(command.assistantSessionId)}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  }, AssistantCommandReceiptSchema);
}

export function cancelAssistantTurn(
  command: CancelAssistantTurnCommand,
): Promise<AssistantCommandReceipt> {
  return fetchJson(`${assistantApiBase(command.assistantSessionId)}/turns/current/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  }, AssistantCommandReceiptSchema);
}

export function getAssistantCommand(
  sessionId: string,
  commandId: string,
): Promise<AssistantCommandReconciliationResponse> {
  return fetchJson(
    `${assistantApiBase(sessionId)}/commands/${encodeURIComponent(commandId)}`,
    undefined,
    AssistantCommandReconciliationResponseSchema,
  );
}

/** 会话的目录外访问授权请求（含历史），按创建时间升序。 */
export function listToolAuthorizations(sessionId: string): Promise<ToolAuthorizationListResponse> {
  return fetchJson(`${assistantApiBase(sessionId)}/authorizations`, undefined, ToolAuthorizationListResponseSchema);
}

/**
 * 对待授权请求作出决定。按请求 id 幂等；请求已作出另一个决定时报 AUTHORIZATION_CONFLICT，
 * 已取消、已过期或已失效时报 AUTHORIZATION_NOT_PENDING，两者都不会执行任何操作。
 */
export function decideToolAuthorization(
  sessionId: string,
  requestId: string,
  decision: ToolAuthorizationDecision,
): Promise<ToolAuthorizationDecisionResponse> {
  return fetchJson(
    `${assistantApiBase(sessionId)}/authorizations/${encodeURIComponent(requestId)}/decision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
    ToolAuthorizationDecisionResponseSchema,
  );
}

/** 全局 Multivac 对话内的提议（确认卡，含历史），按提出的先后。 */
export function listProposals(): Promise<ProposalListResponse> {
  return fetchJson('/api/assistant/proposals', undefined, ProposalListResponseSchema);
}

/**
 * 对提议作出决定（确认或取消），按提议 id 幂等。确认时服务端按当前状态重新校验，目标已变化则记为已过期、不执行；
 * 与已有定论冲突（已取消后确认、已确认后取消）时报 PROPOSAL_CONFLICT。
 * options 是用户在卡上作出的选择（如归入项目时是否一并移入文件），只随确认提交；没有可选择内容的卡不带。
 */
export function decideProposal(
  proposalId: string,
  decision: ProposalDecision,
  options?: Record<string, unknown>,
): Promise<ProposalDecisionResponse> {
  return fetchJson(
    `/api/assistant/proposals/${encodeURIComponent(proposalId)}/decision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options === undefined ? { decision } : { decision, options }),
    },
    ProposalDecisionResponseSchema,
  );
}

/** 仍有效的记住的授权，最近记住的在前。 */
export function listAuthorizationGrants(): Promise<ToolAuthorizationGrantListResponse> {
  return fetchJson('/api/authorization-grants', undefined, ToolAuthorizationGrantListResponseSchema);
}

/** 撤销记住的授权，即时生效；按授权 id 幂等。 */
export function revokeAuthorizationGrant(grantId: string): Promise<ToolAuthorizationGrantResponse> {
  return fetchJson(
    `/api/authorization-grants/${encodeURIComponent(grantId)}/revoke`,
    { method: 'POST' },
    ToolAuthorizationGrantResponseSchema,
  );
}

/**
 * 最近的授权请求（含按已记住的授权放行的记录），最近的在前，最多 50 条。
 * 给出会话时只取这个会话的（已归档的会话同样可查），否则跨全部会话。
 */
export function listRecentAuthorizations(sessionId?: string): Promise<ToolAuthorizationHistoryResponse> {
  const query = sessionId === undefined ? '' : `?${new URLSearchParams({ sessionId })}`;
  return fetchJson(`/api/authorization-requests${query}`, undefined, ToolAuthorizationHistoryResponseSchema);
}


/**
 * 补漏读取：会话在 (after, until] 中的公共事件，按 cursor 升序，一页最多 500 条；`hasMore` 时以本页最后一条续读。
 * 打开会话时，快照游标与全局事件流已覆盖的起点之间的事件用它补齐；游标过期时报 EVENT_CURSOR_EXPIRED。
 */
export function readAssistantEventRange(
  sessionId: string,
  after: string,
  until: string,
): Promise<AssistantEventRangeResponse> {
  const query = new URLSearchParams({ after, until });
  return fetchJson(`${assistantApiBase(sessionId)}/events?${query}`, undefined, AssistantEventRangeResponseSchema);
}

/** 逐条读取 SSE 消息（事件名与 data），直到流结束或被中止；只有注释的消息（连接确认、心跳）不回调。 */
async function readEventStream(
  response: Response,
  signal: AbortSignal,
  onMessage: (eventName: string, data: string) => void,
): Promise<void> {
  if (!response.body) {
    throw new AssistantApiError('INTERNAL_ERROR', '事件流响应缺少流式正文。', response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/u);
        const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        if (!eventName) continue;
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        onMessage(eventName, data);
      }
      if (result.done) return;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 响应可能已由 AbortController 或服务端关闭；继续释放 reader 引用。
    }
    reader.releaseLock();
  }
}

export interface GlobalEventHandlers {
  /** 连接已建立（服务端接受了游标）。 */
  onOpen(): void;
  /** 一条会话公共事件（已按契约校验），按 cursor 升序。 */
  onAssistantEvent(event: AssistantPublicEvent): void;
}

/**
 * 打开一次全局事件流 `GET /api/events?after=<全局游标>`，读到流结束为止（不重连，由调用方决定）。
 * 连接失败时以 AssistantApiError 结束，游标过期为 EVENT_CURSOR_EXPIRED。会话事件不符合契约时同样以错误结束
 * （调用方从最后处理的游标续传）。工作台变更仍经工作台通道接收，这里忽略。
 */
export async function streamGlobalEvents(
  after: string,
  signal: AbortSignal,
  handlers: GlobalEventHandlers,
): Promise<void> {
  const query = new URLSearchParams({ after });
  const response = await fetch(`${GLOBAL_EVENTS_PATH}?${query}`, {
    headers: { accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok) {
    const body = await responseJson(response);
    if (Check(AssistantApiErrorResponseSchema, body)) {
      throw new AssistantApiError(body.error.code, body.error.message, response.status);
    }
    throw new AssistantApiError('INTERNAL_ERROR', '事件流连接失败。', response.status);
  }
  handlers.onOpen();

  await readEventStream(response, signal, (eventName, data) => {
    if (eventName !== ASSISTANT_SSE_EVENT_NAME) return;
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      throw new AssistantApiError('INTERNAL_ERROR', '公共事件无法解析。', response.status);
    }
    if (!Check(AssistantPublicEventSchema, body)) {
      throw new AssistantApiError('INTERNAL_ERROR', '公共事件不符合契约。', response.status);
    }
    handlers.onAssistantEvent(body);
  });
}
