import { randomUUID } from 'node:crypto';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  TOOL_AUTHORIZATION_DEFAULT_TIMEOUT_MS,
  TOOL_AUTHORIZATION_HISTORY_LIMIT,
  toolAuthorizationAccess,
  UNKNOWN_CHANGE_ORIGIN,
  type ToolAuthorizationDecision,
  type ToolAuthorizationGrant,
  type ToolAuthorizationRequest,
  type WorkbenchChangeOrigin,
} from '@multivac/contracts';
import type {
  CoordinatorToolAuthorizationDecision,
  CoordinatorToolAuthorizationRequest,
} from '../runtime/executors/coordinator-adapter.js';
import {
  rememberableDirectory,
  rememberGuard,
  type RememberBoundary,
  type RememberGuard,
  type ResolvedToolAuthorizationStatus,
  type ToolAuthorizationRepository,
  type ToolAuthorizationUserApproval,
} from '../modules/tool-authorization/tool-authorization.js';
import type { AssistantEventStream } from './assistant-event-stream.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class ToolAuthorizationServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'AUTHORIZATION_CONFLICT' | 'AUTHORIZATION_NOT_PENDING' | 'INVALID_DECISION',
    message: string,
  ) {
    super(message);
    this.name = 'ToolAuthorizationServiceError';
  }
}

export interface ToolAuthorizationServiceOptions {
  repository: ToolAuthorizationRepository;
  eventStream: AssistantEventStream;
  /** 工作台变更事件：记住的授权产生或撤销后发布，推给各窗口；未提供时不发布。 */
  workbenchEvents?: WorkbenchEventPublisher;
  /** 会话当前这一轮的发送命令；授权请求以它关联命令回执与运行轨迹。 */
  currentCommandId: (sessionId: string) => string | null;
  /** 会话当前所属的项目；不属于项目（含全局 Multivac）时为 null。 */
  projectOf: (sessionId: string) => string | null;
  /** 记住的授权不得覆盖的位置（用户主目录、工作文件根目录、内部数据目录）。 */
  rememberBoundary: RememberBoundary;
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
/** 批准范围在冲突说明中的写法。 */
const SCOPE_LABELS: Record<ToolAuthorizationDecision, string> = {
  once: '批准（仅这一次）',
  session: '批准（本会话内）',
  project: '批准（本项目内始终）',
  deny: '拒绝',
};

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
 * 记住的决定：用户在授权卡上选择“本会话内 / 本项目内”时，按请求创建时算出并展示的范围
 * （目标所在目录，含子目录；读取与修改分开）记住授权。之后同一会话或同一项目的会话再次访问这个范围时，
 * 在创建请求之前直接放行，留下一条“按已记住的授权放行”的已批准记录，不再出现授权卡。撤销即时生效。
 * 全局 Multivac 不记住授权，只能单次批准或拒绝。
 *
 * 权限扩大只能经由 decide（用户在界面或接口中确认）完成，范围只取服务端保存的请求记录，
 * Agent 的工具、引用与工具返回内容都不能扩大它。
 */
export class ToolAuthorizationService {
  private readonly waits = new Map<string, PendingWait>();
  private readonly defaultTimeoutMs: number;
  private timeoutMs: number;
  private readonly now: () => Date;
  private readonly rememberGuard: RememberGuard;

  constructor(private readonly options: ToolAuthorizationServiceOptions) {
    this.defaultTimeoutMs = options.timeoutMs ?? TOOL_AUTHORIZATION_DEFAULT_TIMEOUT_MS;
    this.timeoutMs = this.defaultTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.rememberGuard = rememberGuard(options.rememberBoundary);
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
   * 授权决定（CoordinatorToolAuthorizer）：先按记住的授权匹配，命中时直接放行；
   * 否则生成请求并等待，直到用户决定、本轮取消或超时。超时的决定带 endTurn，适配器在该调用结束后中止本轮。
   */
  readonly authorize = (
    request: CoordinatorToolAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<CoordinatorToolAuthorizationDecision> => {
    if (signal.aborted) {
      return Promise.resolve({ allowed: false, reason: `本轮已停止，没有${TOOL_VERBS[request.toolName]} ${request.targetPath}。` });
    }

    const createdAt = this.now();
    const sessionId = request.assistantSessionId;
    const projectId = this.options.projectOf(sessionId);
    const base = {
      requestId: randomUUID(),
      sessionId,
      commandId: this.options.currentCommandId(sessionId),
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      requestedPath: request.requestedPath,
      targetPath: request.targetPath,
      workingDirectory: { ...request.workingDirectory },
      createdAt: createdAt.toISOString(),
    };

    // 全局 Multivac 不记住授权：它不是工作会话，记住的授权在会话授权窗口、标题栏与项目设置里查看和撤销，
    // 这些地方都不包括它；它又一直不会结束，记住的决定会成为看不到、撤不掉的长期授权。
    // 过去为它记住的会话范围授权也不再匹配。
    const rememberable = sessionId !== GLOBAL_ASSISTANT_SESSION_ID;

    // 记住的授权：匹配与放行之间没有 await，撤销（同步写入）之后到达的调用一定会重新确认。
    const grant = rememberable ? this.options.repository.findGrant({
      sessionId, projectId, access: toolAuthorizationAccess(request.toolName), targetPath: request.targetPath,
    }) : undefined;
    if (grant) {
      const remembered = this.options.repository.createRemembered(
        { ...base, expiresAt: base.createdAt, remember: null },
        grant.grantId,
      );
      this.options.eventStream.publish(remembered.event);
      return Promise.resolve({ allowed: true });
    }

    const directory = rememberable ? rememberableDirectory(request.targetPath, this.rememberGuard) : null;
    const mutation = this.options.repository.create({
      ...base,
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs).toISOString(),
      remember: directory ? { directory, projectId } : null,
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
   * 最近的授权请求（含按已记住的授权放行的记录），最近的在前，最多 TOOL_AUTHORIZATION_HISTORY_LIMIT 条。
   * 给出会话时只取这个会话的（含已归档的会话，授权窗口按会话查看），否则跨全部会话。
   */
  recent(sessionId?: string): ToolAuthorizationRequest[] {
    return this.options.repository.listRecent(TOOL_AUTHORIZATION_HISTORY_LIMIT, sessionId);
  }

  /**
   * 用户的决定，按请求 id 幂等：重复提交同一决定返回同一结果，与已作出的决定冲突时报冲突；
   * 只接受仍待授权的请求，已取消、已过期、已失效的请求不会因此执行任何操作。
   * “本会话内 / 本项目内”按请求中保存的可记住范围记住授权，与批准在同一事务中写入。
   */
  decide(
    sessionId: string,
    requestId: string,
    decision: ToolAuthorizationDecision,
    origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN,
  ): ToolAuthorizationRequest {
    const current = this.options.repository.get(requestId);
    if (!current || current.sessionId !== sessionId) {
      throw new ToolAuthorizationServiceError('NOT_FOUND', '授权请求不存在。');
    }

    if (current.status === 'pending') {
      // 待授权却没有等待方（理论上只有上一进程遗留、尚未对账的请求）：不能放行，按失效处理。
      if (!this.waits.has(requestId)) {
        this.resolvePending(requestId, 'invalidated');
        throw new ToolAuthorizationServiceError('AUTHORIZATION_NOT_PENDING', NOT_PENDING_MESSAGES.invalidated);
      }
      if (decision === 'deny') return this.resolvePending(requestId, 'denied');
      const approval = this.userApproval(current, decision);
      const resolved = this.resolvePending(requestId, 'approved', approval);
      // 选择记住时授权与批准在同一事务中写入：批准落地（授权已存在）后才发布新的授权。
      const grant = approval.scope === 'once' ? undefined : this.options.repository.getGrant(approval.grant.grantId);
      if (grant) this.options.workbenchEvents?.publish({ type: 'grant.changed', origin, change: 'created', grant });
      return resolved;
    }
    const decided = current.status === 'denied' ? 'deny'
      : current.status === 'approved' && current.approval?.source === 'user' ? current.approval.scope : null;
    if (decided === decision) return current;
    if (current.status === 'approved' || current.status === 'denied') {
      const label = decided ? SCOPE_LABELS[decided] : '按已记住的授权放行';
      throw new ToolAuthorizationServiceError('AUTHORIZATION_CONFLICT', `授权请求已${label}，不能改为另一个决定。`);
    }
    throw new ToolAuthorizationServiceError('AUTHORIZATION_NOT_PENDING', NOT_PENDING_MESSAGES[current.status]);
  }

  /**
   * 仍有效的记住的授权，最近记住的在前。全局 Multivac 过去记住的会话范围授权已不再生效（见 authorize），
   * 不列出。
   */
  listGrants(): ToolAuthorizationGrant[] {
    return this.options.repository.listGrants().filter((grant) => grant.sessionId !== GLOBAL_ASSISTANT_SESSION_ID);
  }

  /**
   * 撤销记住的授权，即时生效：之后到达的同类访问重新产生待授权请求。按授权 id 幂等，
   * 已撤销的授权原样返回；已经按它放行的记录不受影响。
   */
  revokeGrant(grantId: string, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): ToolAuthorizationGrant {
    const active = this.options.repository.getGrant(grantId)?.revokedAt === null;
    const grant = this.options.repository.revokeGrant(grantId, this.now().toISOString());
    if (!grant) throw new ToolAuthorizationServiceError('NOT_FOUND', '记住的授权不存在。');
    // 重复撤销原样返回，不再发布。
    if (active) this.options.workbenchEvents?.publish({ type: 'grant.changed', origin, change: 'revoked', grant });
    return grant;
  }

  /** 仅供 Fake E2E 在用例之间清除全部记住的授权（全局 Multivac 的会话不随重置删除）。 */
  resetGrantsForTest(): void {
    this.options.repository.deleteAllGrantsForTest();
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

  /**
   * 批准的范围。记住的范围只取请求记录中服务端算出、授权卡上展示的那一个，不能由调用方扩大；
   * 这次请求没有可记住的范围，或会话不属于项目时选择“本项目内”，都不接受。
   */
  private userApproval(
    request: ToolAuthorizationRequest,
    scope: Exclude<ToolAuthorizationDecision, 'deny'>,
  ): ToolAuthorizationUserApproval {
    if (scope === 'once') return { scope };
    const remember = request.remember;
    if (request.sessionId === GLOBAL_ASSISTANT_SESSION_ID) {
      throw new ToolAuthorizationServiceError('INVALID_DECISION', 'Multivac 的对话不记住授权，只能选择“仅这一次”或拒绝。');
    }
    if (!remember) {
      throw new ToolAuthorizationServiceError(
        'INVALID_DECISION',
        '这次访问的目标所在目录范围过大（或涉及 Multivac 自身的目录），不能记住，只能选择“仅这一次”或拒绝。',
      );
    }
    if (scope === 'project' && !remember.projectId) {
      throw new ToolAuthorizationServiceError('INVALID_DECISION', '会话不属于项目，不能选择“本项目内始终允许”。');
    }
    return {
      scope,
      grant: {
        grantId: randomUUID(),
        scope,
        sessionId: scope === 'session' ? request.sessionId : null,
        projectId: scope === 'project' ? remember.projectId : null,
        access: toolAuthorizationAccess(request.toolName),
        directory: remember.directory,
        sourceRequestId: request.requestId,
        createdAt: this.now().toISOString(),
      },
    };
  }

  /** 把仍待授权的请求转为终态、发布事件，并把结果交还等待方；请求已离开待授权时沿用其状态。 */
  private resolvePending(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    approval?: ToolAuthorizationUserApproval,
  ): ToolAuthorizationRequest {
    const mutation = this.options.repository.resolve(requestId, status, this.now().toISOString(), approval);
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
