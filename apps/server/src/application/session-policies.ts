import type { AssistantContextRef, CoordinatorRuntimeConfig, CoordinatorSessionContext, SendAssistantMessageCommand, TaskRun } from '@multivac/contracts';
import type { AssistantSessionRuntimeOptions } from './assistant-session-runtime.js';
import { AssistantTurnCommandServiceError } from './assistant-turn-command-service.js';

/**
 * 一种会话宿主的固定策略：运行时配置、实际开放的内部工具、发送校验与上下文解析集中在一处。
 * 会话运行时的通用部分（工作目录、引用来源、初始上下文等）由装配方统一提供，不在策略中重复。
 */
export type SessionPolicy = Pick<AssistantSessionRuntimeOptions, 'runtimeConfig' | 'prepareText' | 'internalTools' | 'authorizeSend' | 'resolveContext' | 'resolveAgentExecution'> & {
  /** 新建 Pi 会话时采用的配置；缺省时按全局默认模型与本策略的运行时配置解析。 */
  resolveNewSessionRuntimeConfig?: () => Promise<CoordinatorRuntimeConfig>;
};

type PrepareText = NonNullable<AssistantSessionRuntimeOptions['prepareText']>;
type InternalTools = NonNullable<AssistantSessionRuntimeOptions['internalTools']>;

function rejected(message: string): never { throw new AssistantTurnCommandServiceError('INVALID_REQUEST', message); }

/** 把业务服务的拒绝原因转成发送拒绝，原因保持原样。 */
async function asSendRejection<T>(resolve: () => T | Promise<T>): Promise<T> {
  try { return await resolve(); }
  catch (error) { return rejected((error as Error).message); }
}

/**
 * 笔记梳理讨论：受限模型运行时，不注入任何内部工具，不提供 Skill。
 * 每次发送只能带当前讨论的冻结正文快照，不接受跨应用引用、图片或运行中追加。
 */
export function noteSessionPolicy(input: {
  sessionId: string; noteId: string; runtimeConfig: CoordinatorRuntimeConfig;
  requireNote: (noteId: string) => void;
  context: (sessionId: string, snapshotId: string) => CoordinatorSessionContext;
}): SessionPolicy {
  return {
    runtimeConfig: input.runtimeConfig,
    authorizeSend: (command: SendAssistantMessageCommand) => {
      try { input.requireNote(input.noteId); }
      catch { rejected('笔记已不可用，消息未发送。'); }
      if (command.contextRefs.length !== 1 || command.contextRefs[0]?.kind !== 'note' || command.quote || command.imageIds?.length || command.streamingBehavior) {
        rejected('笔记助手发送必须带当前讨论的冻结正文快照，不接受跨应用引用、图片或运行中追加。');
      }
    },
    resolveContext: async (refs: readonly AssistantContextRef[]) => {
      const ref = refs[0];
      if (ref?.kind !== 'note') rejected('笔记助手需要正文快照。');
      return asSendRejection(() => input.context(input.sessionId, ref.snapshotId));
    },
  };
}

/** 书伴会话：只开放相邻页只读工具；每次发送必须带当前书籍的有效原文来源。 */
export function readingSessionPolicy(input: {
  sessionId: string; bookId: string; runtimeConfig: CoordinatorRuntimeConfig;
  internalTools: InternalTools; prepareText: PrepareText;
  contextForRefs: (sessionId: string, refs: readonly AssistantContextRef[]) => Promise<CoordinatorSessionContext>;
}): SessionPolicy {
  return {
    runtimeConfig: input.runtimeConfig,
    internalTools: input.internalTools,
    prepareText: input.prepareText,
    authorizeSend: (command: SendAssistantMessageCommand) => {
      const ref = command.contextRefs[0];
      if (command.contextRefs.length !== 1 || ref?.kind !== 'book' || ref.reference.bookId !== input.bookId || command.quote) rejected('书伴发送必须带当前书籍的有效原文来源。');
    },
    resolveContext: async (refs: readonly AssistantContextRef[]) => {
      if (refs[0]?.kind !== 'book') rejected('书伴需要原文引用。');
      return asSendRejection(() => input.contextForRefs(input.sessionId, refs));
    },
  };
}

/**
 * 任务执行会话：按任务选定的智能体装配运行时，开放工作会话与任务执行工具。
 * 只有本次运行的首条命令或运行中的追加可以推进；停止意图或停止确认后不再受理发送。
 */
export function taskSessionPolicy(input: {
  sessionId: string; run: TaskRun;
  runtime: { runtimeConfig: CoordinatorRuntimeConfig; resolveNewSessionRuntimeConfig: () => Promise<CoordinatorRuntimeConfig> };
  internalTools: InternalTools; prepareText: PrepareText;
  currentRun: () => { run: TaskRun | null; task: { status: string; sessionId: string | null; currentRunId: string | null } | null };
  currentPromptCommandId: () => string | null;
}): SessionPolicy {
  return {
    runtimeConfig: input.runtime.runtimeConfig,
    resolveNewSessionRuntimeConfig: input.runtime.resolveNewSessionRuntimeConfig,
    internalTools: input.internalTools,
    prepareText: input.prepareText,
    authorizeSend: (command: SendAssistantMessageCommand) => {
      const { run, task } = input.currentRun();
      if (!run || !task) return;
      const initial = command.commandId === run.commandId && ['queued', 'running'].includes(task.status) && run.status === 'running';
      const followUp = task.status === 'running' && input.currentPromptCommandId() === run.commandId;
      if (task.sessionId !== input.sessionId || task.currentRunId !== run.runId || (!initial && !followUp) || run.stopIntent || run.stopConfirmed) {
        rejected('任务当前不允许推进，请先通过任务控制继续执行。');
      }
    },
  };
}

/** 普通工作会话：开放工作会话任务工具，可在单轮显式调用其他智能体执行。 */
export function workSessionPolicy(input: {
  runtimeConfig: CoordinatorRuntimeConfig;
  internalTools: InternalTools; prepareText: PrepareText;
  resolveAgentExecution: NonNullable<AssistantSessionRuntimeOptions['resolveAgentExecution']>;
}): SessionPolicy {
  return {
    runtimeConfig: input.runtimeConfig,
    internalTools: input.internalTools,
    prepareText: input.prepareText,
    resolveAgentExecution: input.resolveAgentExecution,
  };
}
