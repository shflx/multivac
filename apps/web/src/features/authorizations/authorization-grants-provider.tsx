import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ToolAuthorizationGrant } from '@multivac/contracts';
import { listAuthorizationGrants, revokeAuthorizationGrant } from '../../data/assistant-api.js';
import { AuthorizationGrants, grantsOf, type GrantOwner } from './authorization-grants.js';

const AuthorizationGrantsContext = createContext<AuthorizationGrants | null>(null);

/** 应用级的记住的授权：项目详情、会话页详情与标题栏的工作目录浮层共用同一份。 */
export function AuthorizationGrantsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new AuthorizationGrants({
    list: async () => (await listAuthorizationGrants()).grants,
    revoke: revokeAuthorizationGrant,
  }));
  return <AuthorizationGrantsContext.Provider value={store}>{children}</AuthorizationGrantsContext.Provider>;
}

function useStore(): AuthorizationGrants {
  const store = useContext(AuthorizationGrantsContext);
  if (!store) throw new Error('记住的授权必须在 AuthorizationGrantsProvider 内使用。');
  return store;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface OwnedGrants {
  /** 这个会话或项目的授权，最近记住的在前；尚未读取成功时为 null。 */
  grants: ToolAuthorizationGrant[] | null;
  /** 最近一次读取失败的原因；成功后清空。 */
  error: string;
  retry: () => void;
  /** 撤销（服务端即时生效），成功后三处同时去掉这一条；失败时抛出错误。 */
  revoke: (grantId: string) => Promise<void>;
}

/**
 * 一个会话或项目的记住的授权。visible 变为 true 时（页面显示、浮层打开）重新读取，
 * 看得到刚在授权卡上记住的决定；隐藏期间不读取。
 */
export function useOwnedGrants(owner: GrantOwner, visible: boolean): OwnedGrants {
  const store = useStore();
  const all = useSyncExternalStore(store.subscribe, store.snapshot);
  const [error, setError] = useState('');
  const ownerKey = 'sessionId' in owner ? `session:${owner.sessionId}` : `project:${owner.projectId}`;

  const load = useCallback(() => {
    setError('');
    store.refresh().catch((cause: unknown) => setError(errorText(cause, '记住的授权读取失败。')));
  }, [store]);

  useEffect(() => {
    if (visible) load();
  }, [visible, ownerKey, load]);

  // 按归属筛选只在列表或归属变化时重新计算，行的引用保持稳定。
  const grants = useMemo(() => all && grantsOf(all, owner), [all, ownerKey]);
  return { grants, error, retry: load, revoke: store.revoke };
}
