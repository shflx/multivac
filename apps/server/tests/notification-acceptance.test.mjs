import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { SqliteNotificationChannelRepository } from '../src/storage/sqlite-notification-channel-repository.js';
import { ReminderService } from '../src/application/reminder-service.js';
import { ReminderScheduler } from '../src/application/reminder-scheduler.js';
import { NotificationDeliveryService } from '../src/application/notification-delivery-service.js';
import { InboxService } from '../src/application/inbox-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { WechatBindingService, WECHAT_CHANNEL_ID } from '../src/application/wechat-binding-service.js';
import { WechatNotificationAdapter } from '../src/modules/notifications/wechat/adapter.js';
import { wechatFixture } from './fixtures/notification-channels.mjs';

test('受控10分钟与重启保留上下文观察时间，空轮询不延长有效时间',async()=>{
  const f=wechatFixture();let worker;
  try{
    await f.login();f.queue.push({ret:0,msgs:[{message_id:'1',from_user_id:'self',to_user_id:'bot',message_type:1,context_token:'fixture-context'}],get_updates_buf:'cursor'});
    await f.service.pollOnce(new AbortController().signal);
    const original=f.service.status().contextObservedAt,later='2026-10-28T00:10:00.000Z';
    const restored=new WechatBindingService(f.outbox,f.identities,f.secrets,f.service.client,()=>later,false);restored.initialize();
    f.queue.push({ret:0,msgs:[],get_updates_buf:'next'});await restored.pollOnce(new AbortController().signal);
    assert.equal(restored.status().contextObservedAt,original);assert.equal(Date.parse(later)-Date.parse(original),600000);
    const c=f.outbox.channel(WECHAT_CHANNEL_ID),d=f.outbox.createTest(c.id,c.version,later);
    worker=new NotificationDeliveryService(f.outbox,[new WechatNotificationAdapter(restored)],()=>later);
    f.queue.push({ret:0,message_id:'10'});await worker.tick();assert.equal(f.outbox.delivery(d.id).state,'accepted');
    // 这是时钟与协议夹具，不是实际等待10分钟，也不是微信上下文寿命的证据。
  }finally{await worker?.close();f.close();}
});

// 所有外部渠道都是测试适配器，不发微信消息，不伪造真实手机证据。
test('磁盘SQLite重启后同一提醒分别分发；响应未知与第二渠道隔离，外发不改Inbox状态',async()=>{
  mkdirSync('.tmp',{recursive:true});const root=mkdtempSync(resolve('.tmp/notification-acceptance-')),path=join(root,'db.sqlite');
  let store=new SqliteAssistantStore(path);let worker;
  let clock=new Date('2026-10-28T00:00:00.000Z');const now=()=>clock.toISOString();
  try{
    for(const id of ['wechat-fixture','second-fixture']){
      const c=store.notificationChannels.ensureChannel(id,id);store.notificationChannels.setReadiness(id,'ready',null);
      const test=store.notificationChannels.createTest(id,c.version,now());store.notificationChannels.saveDelivery({...test,state:'accepted'});
      store.notificationChannels.confirmTest(id,c.version,test.id,now());store.notificationChannels.setEnabled(id,c.version,true,now());
    }
    const service=new ReminderService(store.reminders,()=>{},()=>clock),events=new WorkbenchEvents();
    const reminder=service.create('global-coordinator',{commandId:'real-sqlite',text:'磁盘持久提醒测试',scheduledAt:'2026-10-28T00:01:00.000Z',timeZone:'UTC',localTime:'2026-10-28T00:01:00'});
    clock=new Date('2026-10-28T00:01:00.000Z');new ReminderScheduler(store.reminders,events,()=>clock).tick();
    assert.equal(store.notificationChannels.deliveries('wechat-fixture').total,1); // 只有设置测试，尚未分发。
    store.close();store=new SqliteAssistantStore(path);
    const sent=[];
    const adapters=['wechat-fixture','second-fixture'].map(type=>({type,capabilities:{idempotency:false,resultQuery:false},readiness:()=>({state:'ready'}),format:c=>c.text,
      send:async(text,ctx)=>{sent.push({type,text,localMessageId:ctx.localMessageId});return type==='wechat-fixture'?{outcome:'unknown',diagnostic:'测试模拟远端已接收但响应丢失'}:{outcome:'accepted',serverMessageId:'fixture:accepted'};}}));
    worker=new NotificationDeliveryService(store.notificationChannels,adapters,now);worker.start(events);await worker.tick();await worker.tick();
    assert.equal(sent.length,2);assert.equal(store.reminders.notifications().length,1);assert.equal(store.reminders.get(reminder.reminderId).status,'delivered');
    const records=id=>store.notificationChannels.deliveries(id).items.filter(d=>d.kind==='notification');
    assert.equal(records('wechat-fixture')[0].state,'unknown');assert.equal(records('second-fixture')[0].state,'accepted');
    const inbox=new InboxService({list:()=>[]},{all:()=>[]},store.inbox,events,undefined,store.reminders);
    const n=store.reminders.notifications()[0];assert.equal(inbox.get(n.id).state.seen,false);assert.equal(inbox.page().pendingCount,1);
    inbox.updateState(n.id,{revision:0,seen:true,draft:'只编辑草稿'});await worker.tick();
    assert.equal(inbox.page().pendingCount,1);assert.equal(sent.length,2);assert.equal(store.reminders.notification(n.id).acknowledgedAt,null);
    await inbox.decide(n.id,{commandId:'know',revision:1,decision:'acknowledge'});await worker.tick();
    assert.equal(inbox.page().pendingCount,0);assert.equal(sent.length,2);
    assert.equal(records('wechat-fixture')[0].state,'unknown'); // 不虚构撤回。
    await worker.close();worker=null;
  }finally{await worker?.close();store.close();rmSync(root,{recursive:true,force:true});}
});

test('跨连接持久领取；落盘发送意图后崩溃只能恢复未知，不重复执行',()=>{
  mkdirSync('.tmp',{recursive:true});const root=mkdtempSync(resolve('.tmp/notification-lock-')),path=join(root,'db.sqlite');let store=new SqliteAssistantStore(path);
  const now='2026-10-28T00:00:00.000Z';let other;
  try{
    const c=store.notificationChannels.ensureChannel('fixture','fixture');store.notificationChannels.setReadiness(c.id,'ready',null);
    const d=store.notificationChannels.createTest(c.id,c.version,now);assert.ok(store.notificationChannels.acquire(c.id,'owner',now));
    other=new DatabaseSync(path);const duplicate=new SqliteNotificationChannelRepository(other);assert.equal(duplicate.acquire(c.id,'other',now),null);
    assert.equal(store.notificationChannels.beginSend(d.id,'owner',now).attempts,1);other.close();other=null;store.close();store=new SqliteAssistantStore(path);
    store.notificationChannels.recover(now);assert.equal(store.notificationChannels.delivery(d.id).state,'unknown');assert.equal(store.notificationChannels.acquire(c.id,'restart',now),null);
  }finally{other?.close();store.close();rmSync(root,{recursive:true,force:true});}
});
