import type { AssistantSession } from './assistant-session.js';
import { pendingAuthorizations } from './tool-authorizations.js';

/** 判断“用完即收”所需的会话状态。 */
export type SidebarCollapseInput = Pick<
  AssistantSession,
  'status' | 'pageState' | 'submitting' | 'cancelling' | 'runBusy' | 'runTraces' | 'authorizations'
>;

/**
 * 用户点回工作区时，工作区 Multivac 侧栏该怎么办：
 * - collapse：Multivac 已处理完，立即收起；
 * - after-processing：还在处理（发送中、运行中、等待授权），保持展开，处理完再收起；
 * - keep：侧栏里还有没发出的草稿或引用（或会话尚未就绪），保持展开，不打断用户。
 */
export type SidebarCollapseDecision = 'collapse' | 'after-processing' | 'keep';

/**
 * Multivac 是否仍在处理：本页发起的一轮尚未结束、命令还在对账，
 * 或会话里最近一轮仍在运行（可能由其他窗口发起），或有等你决定的授权请求。
 */
export function multivacProcessing(session: SidebarCollapseInput): boolean {
  return session.submitting || session.cancelling || session.runBusy ||
    session.runTraces.at(-1)?.status === 'running' ||
    pendingAuthorizations(session.authorizations).length > 0;
}

/** 按“用完即收”的规则决定点回工作区时侧栏的去留；未发出的内容优先于处理状态。 */
export function sidebarCollapseDecision(session: SidebarCollapseInput): SidebarCollapseDecision {
  if (session.status !== 'ready') return 'keep';
  if (session.pageState.draft.trim() || session.pageState.quote) return 'keep';
  return multivacProcessing(session) ? 'after-processing' : 'collapse';
}
