/** 业务库无渠道秘密。启用区间使用同库通知行序号，避免同一毫秒内启停的时间歧义。 */
export const NOTIFICATION_CHANNEL_MIGRATION = `
  CREATE TABLE IF NOT EXISTS notification_channel (
    id TEXT PRIMARY KEY, record_json TEXT NOT NULL, owner TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS notification_channel_range (
    id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL,
    config_version INTEGER NOT NULL, binding_generation INTEGER NOT NULL,
    start_seq INTEGER NOT NULL, end_seq INTEGER, scanned_seq INTEGER NOT NULL,
    FOREIGN KEY(channel_id) REFERENCES notification_channel(id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS notification_delivery (
    id TEXT PRIMARY KEY, notification_id TEXT, channel_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','waiting','sending','accepted','unknown','failed','cancelled','expired')),
    next_attempt_at TEXT NOT NULL, record_json TEXT NOT NULL, content_json TEXT NOT NULL,
    UNIQUE(notification_id, channel_id),
    FOREIGN KEY(channel_id) REFERENCES notification_channel(id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS notification_delivery_due ON notification_delivery(channel_id,state,next_attempt_at);
  CREATE TABLE IF NOT EXISTS notification_delivery_attempt (
    delivery_id TEXT NOT NULL, attempt INTEGER NOT NULL, intent_at TEXT NOT NULL,
    result_json TEXT, PRIMARY KEY(delivery_id,attempt),
    FOREIGN KEY(delivery_id) REFERENCES notification_delivery(id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS notification_channel_command (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
  ) STRICT;
`;
