export interface WechatBindingIdentity {
  channelId: string; generation: number; botId: string; userId: string; apiBase: string;
}
export interface PrivateWechatBinding extends WechatBindingIdentity {
  token: string; cursor: string; seenIds: string[]; contextToken: string | null; contextObservedAt: string | null;
}
export function sameWechatIdentity(a: WechatBindingIdentity, b: WechatBindingIdentity): boolean {
  return a.channelId === b.channelId && a.generation === b.generation && a.botId === b.botId && a.userId === b.userId && a.apiBase === b.apiBase;
}

/** 身份与私有凭据分开持久化；应用层只依赖端口，不接触具体文件或数据库实现。 */
export interface WechatBindingRepository {
  get(id: string): WechatBindingIdentity | null;
  save(identity: WechatBindingIdentity): void;
  clear(id: string): void;
}
export interface PrivateWechatBindingStore {
  load(): PrivateWechatBinding | null;
  save(value: PrivateWechatBinding): void;
  clear(): void;
}
