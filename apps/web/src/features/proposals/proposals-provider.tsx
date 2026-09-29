import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { decideProposal, listProposals } from '../../data/assistant-api.js';
import { Proposals, type ProposalsSnapshot } from './proposals.js';

const ProposalsContext = createContext<Proposals | null>(null);

/** 应用级的对话内提议：首页与 Multivac 侧栏中的卡片共用同一份。 */
export function ProposalsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new Proposals({
    list: async () => (await listProposals()).proposals,
    decide: async (proposalId, decision, options) => (await decideProposal(proposalId, decision, options)).proposal,
  }));
  return <ProposalsContext.Provider value={store}>{children}</ProposalsContext.Provider>;
}

/** 共享的提议本身（工作台变更同步据此写回别处的变化）。 */
export function useProposalsStore(): Proposals {
  const store = useContext(ProposalsContext);
  if (!store) throw new Error('对话内的提议必须在 ProposalsProvider 内使用。');
  return store;
}

/** 不在 Provider 内（只挂载对话本身的测试页面）时：没有提议，卡片不出现。 */
const NO_PROPOSALS: ProposalsSnapshot = { proposals: null, decisions: {}, seenPending: new Set() };
const noSubscription = () => () => undefined;
const noProposals = () => NO_PROPOSALS;
const noDecision = async () => undefined;

/**
 * 全局 Multivac 的提议与卡上进行中的决定。enabled 为 true 时（呈现全局 Multivac 的对话）确保已读取；
 * 之后由工作台事件保持最新。
 */
export function useProposals(enabled: boolean): ProposalsSnapshot & { decide: Proposals['decide'] } {
  const store = useContext(ProposalsContext);
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.snapshot ?? noProposals);
  useEffect(() => {
    if (enabled) store?.ensureLoaded();
  }, [enabled, store]);
  return { ...snapshot, decide: store?.decide ?? noDecision };
}
