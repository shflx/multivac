import type { AssistantSession } from './assistant-session.js';
import { pendingAuthorizations } from './tool-authorizations.js';

/** 判断“开始干活即收起”所需的会话状态。 */
export type SidebarCollapseInput = Pick<
  AssistantSession,
  'status' | 'pageState' | 'submitting' | 'cancelling' | 'runBusy' | 'runTraces' | 'authorizations'
>;

/**
 * Multivac 是否仍在处理：本页发起的一轮尚未结束、命令还在对账，
 * 或会话里最近一轮仍在运行（可能由其他窗口发起），或有等你决定的授权请求。
 */
export function multivacProcessing(session: SidebarCollapseInput): boolean {
  return session.submitting || session.cancelling || session.runBusy ||
    session.runTraces.at(-1)?.status === 'running' ||
    pendingAuthorizations(session.authorizations).length > 0;
}

/**
 * 开始在页面里干活时，Multivac 侧栏能否随之收起：只有 Multivac 已处理完、侧栏里也没有
 * 未发出的草稿（去掉首尾空白后非空）或引用时才收起；还在处理（发送中、运行中、等待授权）、
 * 有未发出的内容或会话尚未就绪时保持展开，不打断用户。处理结束本身不会收起侧栏。
 */
export function sidebarCollapsesWhenWorking(session: SidebarCollapseInput): boolean {
  if (session.status !== 'ready') return false;
  if (session.pageState.draft.trim() || session.pageState.quote) return false;
  return !multivacProcessing(session);
}

/**
 * 算作“开始干活”的焦点位置：页面里的输入框（勾选框、单选框与按钮类输入除外）、
 * 多行输入与可编辑区域。搜索框只是找东西，不算干活。
 */
const WORK_INPUT_SELECTOR = [
  'textarea',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])' +
    ':not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="search"])',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

export function startsWork(target: Element): boolean {
  return target.matches(WORK_INPUT_SELECTOR) && !target.closest('.search-field');
}
