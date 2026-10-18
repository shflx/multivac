import type { InboxState, UpdateInboxState } from '@multivac/contracts';

/** Inbox 的查看与草稿状态：属于共享用户状态，不写入原业务请求的版本。 */
export interface InboxStateRepository {
  /** 命令身份永久绑定输入；实际决定与副作用仍由原服务按请求身份互斥。 */
  claimCommand(commandId: string, fingerprint: string): void;
  get(id: string): InboxState;
  update(id: string, input: UpdateInboxState): InboxState;
}
