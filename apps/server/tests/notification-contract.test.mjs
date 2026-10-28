import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Value } from 'typebox/value';
import { NotificationChannelSchema, NOTIFICATION_DELIVERY_TTL_MS } from '@multivac/contracts';
import { NOTIFICATION_CHANNEL_MIGRATION } from '../src/storage/notification-channel-schema.ts';

test('投递唯一身份不包含绑定代次，测试编号与正式通知分离', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(NOTIFICATION_CHANNEL_MIGRATION);
    db.exec(NOTIFICATION_CHANNEL_MIGRATION);
    db.prepare('INSERT INTO notification_channel VALUES (?,?,NULL)').run('wechat', '{}');
    db.prepare('INSERT INTO notification_channel VALUES (?,?,NULL)').run('test-channel', '{}');
    const insert = db.prepare("INSERT INTO notification_delivery VALUES (?,?,?,'pending','now','{}','{}')");
    insert.run('d1', 'notification:r:1', 'wechat');
    insert.run('d2', 'notification:r:1', 'test-channel');
    assert.throws(() => insert.run('rebound', 'notification:r:1', 'wechat'), /UNIQUE/);
    insert.run('test:1', null, 'wechat'); insert.run('test:2', null, 'wechat');
    assert.equal(db.prepare('SELECT count(*) AS n FROM notification_delivery').get().n, 4);
  } finally { db.close(); }
});

test('公开渠道契约拒绝秘密与私有存储引用；外发期限为已确认的24小时', () => {
  const channel = { id: 'wechat', type: 'wechat', enabled: false, version: 1, bindingGeneration: 1,
    scope: 'notification', readiness: 'waiting', diagnostic: null, testedDeliveryId: null, phoneConfirmedAt: null };
  assert.equal(Value.Check(NotificationChannelSchema, channel), true);
  for (const name of ['token', 'context_token', 'secretRef', 'qrSession']) {
    assert.equal(Value.Check(NotificationChannelSchema, { ...channel, [name]: 'secret' }), false);
  }
  assert.equal(NOTIFICATION_DELIVERY_TTL_MS, 86_400_000);
});
