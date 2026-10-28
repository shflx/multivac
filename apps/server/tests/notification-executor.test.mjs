import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixtures/notification-channels.mjs';
import { NotificationDeliveryService } from '../src/application/notification-delivery-service.js';
const now = '2026-10-28T00:00:00.000Z';
const adapter = (type, send, ready = () => ({ state: 'ready' })) => ({ type, capabilities: { idempotency: false, resultQuery: false }, readiness: ready, format: c => c.text, send });

test('发送前持久意图；接受、拒绝、未发出与未知分类，未知不重放', async () => {
  for (const outcome of ['accepted','rejected','not-sent','unknown']) {
    const f = fixture(); let calls = 0, clock = now;
    try {
      f.enable(); f.notification(outcome);
      const worker = new NotificationDeliveryService(f.outbox, [adapter('wechat', async (text, ctx) => {
        calls++;
        const record = f.records('wechat')[0]; assert.equal(record.state, 'sending');
        assert.equal(record.localMessageId, ctx.localMessageId);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM notification_delivery_attempt WHERE delivery_id=? AND result_json IS NULL').get(record.id).n, 1);
        return outcome === 'accepted' ? { outcome, serverMessageId: 'remote' } : { outcome, diagnostic: '受控结果' };
      })], () => clock);
      await worker.tick();
      assert.equal(f.records('wechat')[0].state, { accepted: 'accepted', rejected: 'failed', 'not-sent': 'pending', unknown: 'unknown' }[outcome]);
      await worker.tick(); assert.equal(calls, 1);
      clock = '2026-10-28T00:01:00.000Z'; await worker.tick();
      assert.equal(calls, outcome === 'not-sent' ? 2 : 1);
      assert.equal(f.reminders.notifications()[0].acknowledgedAt, null);
      await worker.close();
    } finally { f.db.close(); }
  }
});

test('单渠道持久互斥与串行，其他渠道不受等待影响；知道了阻止新请求', async () => {
  const f = fixture(); let release, calls = 0, second = 0;
  try {
    f.enable(); f.enable('second'); f.notification('one'); f.notification('two');
    const adapters = [adapter('wechat', async () => { calls++; return new Promise(resolve => { release = resolve; }); }),
      adapter('second', async () => { second++; return { outcome: 'accepted', serverMessageId: null }; })];
    const worker = new NotificationDeliveryService(f.outbox, adapters, () => now);
    const duplicate = new NotificationDeliveryService(f.outbox, adapters, () => now);
    const pending = worker.tick();
    await duplicate.tick();
    assert.equal(calls, 1); assert.ok(second >= 1);
    const n = f.reminders.notification('notification:two:1'); f.reminders.acknowledge(n.id,n.revision,'ack','ack',now);
    release({ outcome: 'accepted', serverMessageId: 'old' }); await pending;
    await worker.tick(); assert.equal(calls, 1);
    assert.equal(f.records('wechat').find(d=>d.notificationId===n.id).state, 'cancelled');
    await worker.close(); await duplicate.close();
  } finally { f.db.close(); }
});

test('超时和关闭仅结束本地等待；遗留发送中恢复未知；旧结果不污染新绑定', async () => {
  const f = fixture();
  try {
    const channel = f.enable(); f.notification('timeout');
    const worker = new NotificationDeliveryService(f.outbox, [adapter('wechat', () => new Promise(()=>{}))], () => now, 5);
    await worker.tick(); assert.equal(f.records('wechat')[0].state,'unknown');
    f.notification('close'); const pending = worker.tick(); await worker.close(); await pending;
    assert.equal(f.records('wechat').find(d=>d.notificationId==='notification:close:1').state,'unknown');
    f.notification('crash'); f.outbox.reconcile(now);
    const record = f.outbox.acquire('wechat','crashed',now); f.outbox.beginSend(record.id,'crashed',now);
    f.outbox.recover(now); assert.equal(f.outbox.delivery(record.id).state,'unknown');
    assert.equal(f.outbox.acquire('wechat','another',now),null);
    f.notification('rebind'); let resolve;
    const oldWorker = new NotificationDeliveryService(f.outbox,[adapter('wechat', async()=>new Promise(r=>{resolve=r;}))],()=>now);
    const flight = oldWorker.tick();
    const next = f.outbox.resetBinding('wechat',channel.version,now);
    resolve({outcome:'rejected',diagnostic:'旧凭据失效',credentialsInvalid:true}); await flight;
    assert.equal(f.outbox.channel('wechat').bindingGeneration,next.bindingGeneration);
    assert.equal(f.outbox.channel('wechat').readiness,'waiting');
    await oldWorker.close();
  } finally { f.db.close(); }
});

test('等待初始化不产生尝试；确定未发出有界退避；到期不请求', async()=>{
  const f=fixture(); let clock=now, ready=false, calls=0;
  try {
    f.enable(); f.notification('one');
    const worker=new NotificationDeliveryService(f.outbox,[adapter('wechat',async()=>{calls++;return {outcome:'not-sent',diagnostic:'本地明确未发出'};},()=>ready?{state:'ready'}:{state:'waiting',diagnostic:'等待初始化'})],()=>clock);
    await worker.tick(); assert.equal(f.records('wechat')[0].state,'waiting'); assert.equal(f.records('wechat')[0].attempts,0);
    ready=true;
    for(let i=1;i<=7;i++){clock=new Date(Date.parse(now)+i*60000).toISOString();await worker.tick();}
    assert.equal(calls,5);assert.equal(f.records('wechat')[0].state,'failed');
    f.notification('expired');clock='2026-10-29T00:00:00.000Z';await worker.tick();assert.equal(calls,5);
    assert.equal(f.records('wechat').find(d=>d.notificationId==='notification:expired:1').state,'expired');
    await worker.close();
  } finally {f.db.close();}
});
