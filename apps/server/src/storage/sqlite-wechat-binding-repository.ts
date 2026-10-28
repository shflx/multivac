import type { DatabaseSync } from 'node:sqlite';
import type { WechatBindingIdentity } from './private-wechat-store.js';

export const WECHAT_BINDING_MIGRATION = `
  CREATE TABLE IF NOT EXISTS notification_wechat_binding (
    channel_id TEXT PRIMARY KEY, identity_json TEXT NOT NULL,
    FOREIGN KEY(channel_id) REFERENCES notification_channel(id)
  ) STRICT;
`;
/** 独立核对绑定身份；不进入公开配置、日志或事件。此表不保存任何凭据。 */
export class SqliteWechatBindingRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): WechatBindingIdentity | null {
    const row = this.db.prepare('SELECT identity_json FROM notification_wechat_binding WHERE channel_id=?').get(id);
    return row ? JSON.parse(String(row.identity_json)) : null;
  }
  save(identity: WechatBindingIdentity): void {
    this.db.prepare('INSERT INTO notification_wechat_binding VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET identity_json=excluded.identity_json')
      .run(identity.channelId, JSON.stringify(identity));
  }
  clear(id: string): void { this.db.prepare('DELETE FROM notification_wechat_binding WHERE channel_id=?').run(id); }
}
