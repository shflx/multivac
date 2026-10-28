import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./fixtures/notification-channels.mjs";
import { SqliteNotificationChannelRepository } from "../src/storage/sqlite-notification-channel-repository.js";
const now="2026-10-28T00:00:00.000Z";

test('提交后崩溃由补查恢复，多渠道去重；首次启用与停用期间无历史补发', () => {
  const f = fixture();
  try {
    f.notification('before'); let channel = f.enable(); f.enable('second');
    f.notification('one'); // 模拟 Inbox 提交后进程停止，没有事件分发。
    const restarted = new SqliteNotificationChannelRepository(f.db);
    assert.equal(restarted.reconcile(now), 2); assert.equal(restarted.reconcile(now), 0);
    assert.equal(f.records('wechat').length, 1); assert.equal(f.records('second').length, 1);
    assert.equal(f.reminders.notifications().length, 2);
    f.notification('before-disable');
    channel = f.outbox.setEnabled('wechat', channel.version, false, now);
    f.notification('during-disable');
    channel = f.outbox.setEnabled('wechat', channel.version, true, now);
    f.notification('after-enable'); restarted.reconcile(now);
    assert.deepEqual(f.records('wechat').map(d => d.notificationId).sort(), ['notification:one:1','notification:before-disable:1','notification:after-enable:1'].sort());
    assert.equal(f.records('wechat').find(d => d.notificationId==='notification:before-disable:1').state, 'cancelled');
    assert.equal(f.records('wechat').find(d => d.notificationId==='notification:after-enable:1').state, 'pending');
  } finally { f.db.close(); }
});

test('查看不取消；知道了与关闭取消未开始投递，在途状态保留；重绑不迁移', () => {
  const f = fixture();
  try {
    let channel = f.enable(); const n = f.notification('one'); f.outbox.reconcile(now);
    const d = f.records('wechat')[0];
    f.reminders.notification(n.id); f.outbox.reconcile(now);
    assert.equal(f.outbox.delivery(d.id).state, 'pending');
    f.reminders.acknowledge(n.id, n.revision, 'ack', 'ack', now); f.outbox.reconcile(now);
    assert.equal(f.outbox.delivery(d.id).state, 'cancelled');
    const n2 = f.notification('two'); f.outbox.reconcile(now);
    const sending = f.records('wechat').find(d => d.notificationId===n2.id);
    f.outbox.saveDelivery({ ...sending, state: 'sending' });
    channel = f.outbox.resetBinding('wechat', channel.version, now);
    f.outbox.reconcile(now);
    assert.equal(f.outbox.delivery(sending.id).state, 'sending');
    assert.equal(f.outbox.delivery(sending.id).bindingGeneration, 1);
    assert.equal(channel.bindingGeneration, 2);
    assert.equal(f.records('wechat').length, 2);
  } finally { f.db.close(); }
});

test('发件箱事务失败不回滚原提醒；进度回滚后可重试；24小时从生成时间计', () => {
  const f = fixture();
  try {
    f.enable(); f.notification('one');
    f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_delivery WHEN NEW.notification_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'failure'); END");
    assert.throws(() => f.outbox.reconcile(now));
    assert.equal(f.reminders.get('one').status, 'delivered'); assert.equal(f.reminders.notifications().length, 1);
    f.db.exec('DROP TRIGGER fail_outbox');
    assert.equal(f.outbox.reconcile('2026-10-29T00:00:00.000Z'), 1);
    assert.equal(f.records('wechat')[0].state, 'expired');
    assert.equal(f.reminders.notification('notification:one:1').acknowledgedAt, null);
  } finally { f.db.close(); }
});

test('仅提醒来源、独立测试不创建Inbox；未确认手机不能启用', () => {
  const f = fixture();
  try {
    f.outbox.ensureChannel('wechat', 'wechat'); f.outbox.setReadiness('wechat','ready', null);
    assert.throws(() => f.outbox.setEnabled('wechat',1,true,now));
    f.enable();
    for (const kind of ['clarification','tool-authorization','external','acceptance','recovery','mcp-authorization']) {
      f.db.prepare('INSERT INTO inbox_notification VALUES (?,?)').run(kind, JSON.stringify({ id: kind, reminderId: kind, reminderRevision: 1 }));
    }
    f.outbox.reconcile(now); assert.equal(f.records('wechat').length, 0);
    assert.equal(f.outbox.deliveries('wechat').items.filter(d => d.kind==='test').length, 1);
  } finally { f.db.close(); }
});
