import type { ToolAuthorizationGrant } from '@multivac/contracts';

/** 记住的授权的归属：会话（本会话内允许）或项目（本项目内始终允许）。 */
export type GrantOwner = { sessionId: string } | { projectId: string };

/** 按归属筛选：会话只看会话范围的，项目只看项目范围的（与原型 grantsOf 一致）。 */
export function grantsOf(grants: readonly ToolAuthorizationGrant[], owner: GrantOwner): ToolAuthorizationGrant[] {
  return 'sessionId' in owner
    ? grants.filter((grant) => grant.scope === 'session' && grant.sessionId === owner.sessionId)
    : grants.filter((grant) => grant.scope === 'project' && grant.projectId === owner.projectId);
}

export interface AuthorizationGrantsApi {
  list: () => Promise<readonly ToolAuthorizationGrant[]>;
  revoke: (grantId: string) => Promise<unknown>;
}

/**
 * 记住的授权在应用内的唯一一份：项目详情、会话授权窗口与标题栏的工作目录浮层共用，与界面无关，便于单独测试。
 *
 * 各处在显示时（页面可见、浮层打开）调用 refresh 重新读取；撤销经这里完成，成功后立即从列表中去掉，三处同时更新。
 * 别处（其他窗口的授权卡与撤销）的变化经工作台变更事件写回（applyChange），事件流重连后已读取过的列表重读一次。
 */
export class AuthorizationGrants {
  // 尚未读取成功时为 null；对外快照保持引用稳定，只在变化时替换（useSyncExternalStore 依赖这一点）。
  private grants: readonly ToolAuthorizationGrant[] | null = null;
  // 每次读取的序号：只采用最近一次发起的读取结果，较早发出、较晚返回的旧结果不会覆盖新结果。
  private latestRead = 0;
  // 已撤销的授权：撤销前发出的读取可能晚于撤销返回，结果里仍带着它们，落地时去掉。
  private readonly revoked = new Set<string>();
  // 各个进行中的读取期间推送来的新授权：读取结果可能早于它们，落地时补上。
  private readonly createdDuringReads = new Set<Map<string, ToolAuthorizationGrant>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: AuthorizationGrantsApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): readonly ToolAuthorizationGrant[] | null => this.grants;

  /** 重新读取仍有效的授权；失败时保留已有列表并抛出错误。 */
  refresh = async (): Promise<void> => {
    const read = ++this.latestRead;
    const created = new Map<string, ToolAuthorizationGrant>();
    this.createdDuringReads.add(created);
    try {
      const listed = await this.api.list();
      if (read !== this.latestRead) return;
      const missing = [...created.values()].filter((grant) => !listed.some((item) => item.grantId === grant.grantId));
      this.grants = [...missing.reverse(), ...listed].filter((grant) => !this.revoked.has(grant.grantId));
      this.publish();
    } finally {
      this.createdDuringReads.delete(created);
    }
  };

  /** 已读取过时重读一次（工作台事件流重连后补齐断线期间的变化）；从未读取过时不读，失败时保留列表。 */
  refreshIfLoaded = (): void => {
    if (this.grants) this.refresh().catch(() => undefined);
  };

  /**
   * 写回别处的变化：新记住的授权排在最前（最近记住的在前）；撤销的去掉，之后的读取结果也不再带回。
   * 列表尚未读取时只记下撤销，等首次读取。
   */
  applyChange = (change: 'created' | 'revoked', grant: ToolAuthorizationGrant): void => {
    if (change === 'revoked') {
      this.forget(grant.grantId);
      return;
    }
    if (this.revoked.has(grant.grantId)) return;
    for (const created of this.createdDuringReads) created.set(grant.grantId, grant);
    if (!this.grants || this.grants.some((item) => item.grantId === grant.grantId)) return;
    this.grants = [grant, ...this.grants];
    this.publish();
  };

  /** 撤销（服务端即时生效）；成功后从列表中去掉，失败时抛出错误、列表不变。 */
  revoke = async (grantId: string): Promise<void> => {
    await this.api.revoke(grantId);
    this.forget(grantId);
  };

  private forget(grantId: string): void {
    this.revoked.add(grantId);
    if (this.grants?.some((grant) => grant.grantId === grantId)) {
      this.grants = this.grants.filter((grant) => grant.grantId !== grantId);
      this.publish();
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
