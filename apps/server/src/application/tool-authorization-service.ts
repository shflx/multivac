import { randomUUID } from 'node:crypto';
import {
  TOOL_AUTHORIZATION_DEFAULT_TIMEOUT_MS,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from '@multivac/contracts';
import type {
  CoordinatorToolAuthorizationDecision,
  CoordinatorToolAuthorizationRequest,
} from '../runtime/executors/coordinator-adapter.js';
import type {
  ResolvedToolAuthorizationStatus,
  ToolAuthorizationRepository,
} from '../modules/tool-authorization/tool-authorization.js';
import type { AssistantEventStream } from './assistant-event-stream.js';

export class ToolAuthorizationServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'AUTHORIZATION_CONFLICT' | 'AUTHORIZATION_NOT_PENDING',
    message: string,
  ) {
    super(message);
    this.name = 'ToolAuthorizationServiceError';
  }
}

export interface ToolAuthorizationServiceOptions {
  repository: ToolAuthorizationRepository;
  eventStream: AssistantEventStream;
  /** 会话当前这一轮的发送命令；授权请求以它关联命令回执与运行轨迹。 */
  currentCommandId: (sessionId: string) => string | null;
  /** 等待时限（毫秒），缺省 30 分钟。 */
  timeoutMs?: number;
  now?: () => Date;
}

/** 进程内一次授权等待：settle 把请求的终态交还给等待中的工具调用。 */
interface PendingWait {
  settle: (request: ToolAuthorizationRequest) => void;
  /** 清除超时计时器与取消监听。 */
  release: () => void;
}

const TOOL_VERBS: Record<ToolAuthorizationRequest['toolName'], string> = {
  read: '读取',
  edit: '编辑',
  write: '写入',
};

/** 决定接口遇到已离开待授权、且不能再改的请求时的说明。 */
const NOT_PENDING_MESSAGES: Record<'cancelled' | 'expired' | 'invalidated', string> = {
  cancelled: '授权请求已取消（本轮已停止），批准不会执行任何操作。',
  expired: '授权请求已过期（等待超时，本轮已结束），批准不会执行任何操作。',
  invalidated: '授权请求已失效（服务重启前的等待无法恢复），批准不会执行任何操作。',
};

/**
 * 目录外访问的授权：请求持久化、等待用户决定、取消、超时与重启失效。
 *
 * 每次越界的 read / edit / write 调用都生成一条请求并等待，等待期间本轮保持运行。
 * 请求只有“待授权”一个非终态，离开待授权的途径互斥且只发生一次：
 * 用户批准或拒绝、用户停止本轮（取消）、等待超时（过期），以及服务重启（启动对账时失效）。
 * 进程内的等待无法跨重启恢复，所以旧请求一律失效，对它的批准不会执行任何操作。
 *
 * 批准只作用于这一次工具调用。权限扩大只能经由 decide（用户在界面或接口中确认）完成，
 * Agent 的工具不能调用它。
 */
export class ToolAuthorizationService {
  private readonly waits = new Map<string, PendingWait>();
  private readonly defaultTimeoutMs: number;
  private timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: ToolAuthorizationServiceOptions) {
    this.defaultTimeoutMs = options.timeoutMs ?? TOOL_AUTHORIZATION_DEFAULT_TIMEOUT_MS;
    this.timeoutMs = this.defaultTimeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 启动对账：上一进程遗留的待授权请求都已没有等待方，置为已失效。
   * 必须在接受新命令之前执行；对应的 Turn 由命令回执的启动对账按中断处理。
   */
  invalidateOnStartup(): ToolAuthorizationRequest[] {
    const mutations = this.options.repository.invalidatePending(this.now().toISOString());
    for (const mutation of mutations) this.options.eventStream.publish(mutation.event);
    return mutations.map((mutation) => mutation.request);
  }

  /**
   * 授权决定（CoordinatorToolAuthorizer）：生成请求并等待，直到用户决定、本轮取消或超时。
   * 超时的决定带 endTurn，适配器在该调用结束后中止本轮。
   */
  readonly authorize = (
    request: CoordinatorToolAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<CoordinatorToolAuthorizationDecision> => {
    if (signal.aborted) {
      return Promise.resolve({ allowed: false, reason: `本轮已停止，没有${TOOL_VERBS[request.toolName]} ${request.targetPath}。` });
    }

    const createdAt = this.now();
    const mutation = this.options.repository.create({
      requestId: randomUUID(),
      sessionId: request.assistantSessionId,
      commandId: this.options.currentCommandId(request.assistantSessionId),
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      requestedPath: request.requestedPath,
      targetPath: request.targetPath,
      workingDirectory: { ...request.workingDirectory },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs).toISOString(),
    });
    this.options.eventStream.publish(mutation.event);
    const { requestId } = mutation.request;

    // 写入请求与登记等待之间没有 await：决定、取消与超时只会作用于已登记的等待。
    return new Promise((resolve) => {
      const onAbort = () => this.resolvePending(requestId, 'cancelled');
      const timer = setTimeout(() => this.resolvePending(requestId, 'expired'), this.timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waits.set(requestId, {
        settle: (resolved) => resolve(this.decisionFor(resolved)),
        release: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        },
      });
    });
  };

  /** 会话的全部授权请求（含历史），按创建顺序。 */
  list(sessionId: string): ToolAuthorizationRequest[] {
    return this.options.repository.listBySession(sessionId);
  }

  /**
   * 用户的决定，按请求 id 幂等：重复提交同一决定返回同一结果，与已作出的决定冲突时报冲突；
   * 只接受仍待授权的请求，已取消、已过期、已失效的请求不会因此执行任何操作。
   */
  decide(sessionId: string, requestId: string, decision: ToolAuthorizationDecision): ToolAuthorizationRequest {
    const current = this.options.repository.get(requestId);
    if (!current || current.sessionId !== sessionId) {
      throw new ToolAuthorizationServiceError('NOT_FOUND', '授权请求不存在。');
    }

    const target = decision === 'once' ? 'approved' : 'denied';
    if (current.status === 'pending') {
      // 待授权却没有等待方（理论上只有上一进程遗留、尚未对账的请求）：不能放行，按失效处理。
      if (!this.waits.has(requestId)) {
        this.resolvePending(requestId, 'invalidated');
        throw new ToolAuthorizationServiceError('AUTHORIZATION_NOT_PENDING', NOT_PENDING_MESSAGES.invalidated);
      }
      return this.resolvePending(requestId, target);
    }
    if (current.status === target) return current;
    if (current.status === 'approved' || current.status === 'denied') {
      throw new ToolAuthorizationServiceError(
        'AUTHORIZATION_CONFLICT',
        `授权请求已${current.status === 'approved' ? '批准' : '拒绝'}，不能改为另一个决定。`,
      );
    }
    throw new ToolAuthorizationServiceError('AUTHORIZATION_NOT_PENDING', NOT_PENDING_MESSAGES[current.status]);
  }

  /** 仅供 Fake E2E 调整等待时限；传 null 恢复启动时的配置。只影响之后发出的请求。 */
  setTimeoutForTest(timeoutMs: number | null): void {
    this.timeoutMs = timeoutMs ?? this.defaultTimeoutMs;
  }

  /**
   * 服务停止：只清除计时器与监听，不改记录、也不恢复等待中的工具调用（与进程退出一致），
   * 仍待授权的请求在下次启动时失效。
   */
  dispose(): void {
    for (const wait of this.waits.values()) wait.release();
    this.waits.clear();
  }

  /** 把仍待授权的请求转为终态、发布事件，并把结果交还等待方；请求已离开待授权时沿用其状态。 */
  private resolvePending(requestId: string, status: ResolvedToolAuthorizationStatus): ToolAuthorizationRequest {
    const mutation = this.options.repository.resolve(requestId, status, this.now().toISOString());
    this.options.eventStream.publish(mutation.event);
    const wait = this.waits.get(requestId);
    if (wait && mutation.request.status !== 'pending') {
      this.waits.delete(requestId);
      wait.release();
      wait.settle(mutation.request);
    }
    return mutation.request;
  }

  /** 请求终态对应的工具调用结果；拒绝原因面向 Agent，说明操作没有执行以及接下来该怎么做。 */
  private decisionFor(request: ToolAuthorizationRequest): CoordinatorToolAuthorizationDecision {
    const target = `${TOOL_VERBS[request.toolName]} ${request.targetPath}`;
    switch (request.status) {
      case 'approved':
        return { allowed: true };
      case 'denied':
        return {
          allowed: false,
          reason: `用户拒绝了这次授权：没有${target}（位于会话工作目录 ${request.workingDirectory.path} 之外）。` +
            '请不要重复尝试同一操作；改用工作目录内的方式继续，或向用户说明为什么需要访问这个路径。',
        };
      case 'expired':
        return {
          allowed: false,
          reason: `等待用户授权超时，请求已过期：没有${target}。本轮到此结束。`,
          endTurn: true,
        };
      case 'cancelled':
        return { allowed: false, reason: `用户停止了本轮，授权请求已取消：没有${target}。` };
      default:
        return { allowed: false, reason: `授权请求已失效：没有${target}。` };
    }
  }
}
