import { Check } from 'typebox/value';
import { Type } from 'typebox';
import {
  AgentIdSchema,
  AssistantContextRefSchema,
  AssistantQuoteSchema,
  type AssistantContextRef,
  type AssistantPageState,
  type AssistantQuote,
  type AssistantStreamingBehavior,
} from '@multivac/contracts';
import { sameQuote } from './message-quote.js';
import { ReadingDraftQuoteSchema, type ReadingDraftQuote } from './submission-recovery.js';

/**
 * 待对账发送命令的持久模型与纯规则：存储格式校验、旧格式迁移、命令身份比较，
 * 以及重新进入会话时草稿的恢复决定。不读写 React 状态或浏览器存储。
 */

export interface CommandIdentity {
  commandId: string;
  generation: number;
}

export interface PendingCommand extends CommandIdentity {
  agentId?: string;
  imageIds?: string[];
  text: string;
  quote: AssistantQuote | null;
  /** 发送时附带的上下文引用，属于命令指纹；按原命令重试时必须原样带上。 */
  contextRefs: AssistantContextRef[];
  draftVersion: number;
  cleared: boolean;
  unknown: boolean;
  streamingBehavior: AssistantStreamingBehavior | null;
  /** 书伴即时移交输入；清稿不代表服务端已接收。 */
  clearOnSubmit?: boolean;
  omitQuote?: boolean;
  readingQuote?: ReadingDraftQuote | null;
  confirmed?: boolean;
  echoCreatedAt?: string;
  echoBaseline?: number;
}

/** 旧版本只保存了命令身份或缺少正文与草稿版本，需在读取会话后迁移。 */
export interface LegacyPendingCommand extends CommandIdentity {
  agentId?: string;
  imageIds?: string[];
  text: string | null;
  quote: AssistantQuote | null;
  contextRefs: AssistantContextRef[];
  draftVersion: number | null;
  cleared: boolean;
  unknown: boolean;
  streamingBehavior: AssistantStreamingBehavior | null;
}

export type StoredPendingCommand = PendingCommand | LegacyPendingCommand;

const ContextRefsSchema = Type.Array(AssistantContextRefSchema, { maxItems: 1 });

export function isCommandId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

export function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** 命令身份由 commandId 与本页发送代数共同确定；同一 commandId 的旧代回执不属于新发送。 */
export function sameCommand(left: CommandIdentity | null, right: CommandIdentity): boolean {
  return left?.commandId === right.commandId && left.generation === right.generation;
}

export function isPendingCommand(command: StoredPendingCommand | null): command is PendingCommand {
  return command !== null && command.text !== null && command.draftVersion !== null;
}

function legacyIdentity(commandId: string): LegacyPendingCommand {
  return { commandId, generation: 0, text: null, quote: null, contextRefs: [], draftVersion: null, cleared: false, unknown: false, streamingBehavior: null };
}

/**
 * 解析浏览器中保存的待对账命令。本地存储可能来自更早版本或被改写：
 * 字段逐项按契约重新校验，不合法时整体丢弃；裸 commandId 迁移为旧格式等待读取会话后补齐。
 */
export function parsePendingCommand(stored: string): StoredPendingCommand | null {
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return isCommandId(stored) ? legacyIdentity(stored) : null; }
  if (isCommandId(value)) return legacyIdentity(value);
  if (
    typeof value !== 'object' || value === null ||
    !('commandId' in value) || !isCommandId(value.commandId) ||
    ('text' in value && typeof value.text !== 'string') ||
    ('agentId' in value && !Check(AgentIdSchema, value.agentId)) ||
    ('draftVersion' in value && !Number.isSafeInteger(value.draftVersion)) ||
    ('cleared' in value && typeof value.cleared !== 'boolean') ||
    ('unknown' in value && typeof value.unknown !== 'boolean') ||
    ('generation' in value && !isGeneration(value.generation)) ||
    ('streamingBehavior' in value && value.streamingBehavior !== null && value.streamingBehavior !== 'steer' && value.streamingBehavior !== 'followUp')
  ) return null;
  return {
    commandId: value.commandId,
    ...('agentId' in value ? { agentId: value.agentId as string } : {}),
    generation: 'generation' in value ? value.generation as number : 0,
    text: 'text' in value ? value.text as string : null,
    imageIds: 'imageIds' in value && Array.isArray(value.imageIds) && value.imageIds.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)) ? value.imageIds.slice(0, 4) : [],
    quote: 'quote' in value && Check(AssistantQuoteSchema, value.quote) ? value.quote as AssistantQuote : null,
    // 旧版本没有该字段即为不带上下文；内容同样按契约重新校验。
    contextRefs: 'contextRefs' in value && Check(ContextRefsSchema, value.contextRefs) ? value.contextRefs as AssistantContextRef[] : [],
    draftVersion: 'draftVersion' in value ? value.draftVersion as number : null,
    cleared: 'cleared' in value ? value.cleared as boolean : false,
    unknown: 'unknown' in value ? value.unknown as boolean : false,
    streamingBehavior: 'streamingBehavior' in value ? value.streamingBehavior as AssistantStreamingBehavior | null : null,
    clearOnSubmit: 'clearOnSubmit' in value && value.clearOnSubmit === true,
    omitQuote: 'omitQuote' in value && value.omitQuote === true,
    readingQuote: 'readingQuote' in value && Check(ReadingDraftQuoteSchema, value.readingQuote) ? value.readingQuote : null,
    confirmed: 'confirmed' in value && value.confirmed === true,
    ...('echoCreatedAt' in value && typeof value.echoCreatedAt === 'string' ? { echoCreatedAt: value.echoCreatedAt } : {}),
    ...('echoBaseline' in value && isGeneration(value.echoBaseline) ? { echoBaseline: value.echoBaseline } : {}),
  } as StoredPendingCommand;
}

/** 重新进入会话时对草稿的处理。 */
export type PendingDraftRestoration =
  /** 命令已清稿且服务端草稿仍是这次发送的内容：清空草稿，不让已发送内容回到输入框。 */
  | { kind: 'clear' }
  /** 命令未清稿且服务端草稿为空：把待对账命令的正文、智能体与引用放回输入框。 */
  | { kind: 'restore' }
  /** 草稿已被新编辑占用或版本不一致：保留服务端草稿，不覆盖新输入。 */
  | { kind: 'keep' };

/**
 * 待对账命令与服务端草稿的衔接规则。只有草稿版本与命令记录一致时才清空或恢复，
 * 迟到的旧命令不能清除或覆盖新编辑。
 */
export function pendingDraftRestoration(
  pending: PendingCommand,
  state: Pick<AssistantPageState, 'draft' | 'agentId' | 'quote'>,
  context: { draftVersion: number; latestPrompt: CommandIdentity | null },
): PendingDraftRestoration {
  if (context.draftVersion !== pending.draftVersion) return { kind: 'keep' };
  if (
    pending.cleared && sameCommand(context.latestPrompt, pending) &&
    pending.text === state.draft && (state.agentId ?? undefined) === pending.agentId && sameQuote(state.quote, pending.quote)
  ) return { kind: 'clear' };
  if (!pending.cleared && state.draft === '' && (!state.agentId || state.agentId === pending.agentId) && state.quote === null) return { kind: 'restore' };
  return { kind: 'keep' };
}
