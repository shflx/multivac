import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { NOTIFICATION_CHANNEL_MIGRATION } from "../../src/storage/notification-channel-schema.js";
import { SqliteNotificationChannelRepository } from "../../src/storage/sqlite-notification-channel-repository.js";
import { REMINDER_MIGRATION, SqliteReminderRepository } from "../../src/storage/sqlite-reminder-repository.js";
import { PrivateWechatStore } from "../../src/storage/private-wechat-store.js";
import { SqliteWechatBindingRepository, WECHAT_BINDING_MIGRATION } from "../../src/storage/sqlite-wechat-binding-repository.js";
import { WechatBindingService, WECHAT_CHANNEL_ID } from "../../src/application/wechat-binding-service.js";
import { IlinkClient } from "../../src/modules/notifications/wechat/client.js";
const now="2026-10-28T00:00:00.000Z";
export function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(REMINDER_MIGRATION); db.exec(NOTIFICATION_CHANNEL_MIGRATION);
  const outbox = new SqliteNotificationChannelRepository(db), reminders = new SqliteReminderRepository(db);
  function enable(id = 'wechat') {
    let channel = outbox.ensureChannel(id, id);
    outbox.setReadiness(id, 'ready', null);
    const result = outbox.createTest(id, channel.version, now);
    outbox.saveDelivery({ ...result, state: 'accepted' });
    outbox.confirmTest(id, channel.version, result.id, now);
    channel = outbox.setEnabled(id, channel.version, true, now);
    return channel;
  }
  function notification(id, at = now) {
    const reminder = { reminderId: id, revision: 1, text: '提醒'+id, scheduledAt: at, timeZone: 'UTC', localTime: at.slice(0, 19),
      sourceSessionId: 'global-coordinator', status: 'scheduled', createdAt: at, updatedAt: at, notificationId: null, failure: null };
    reminders.transaction(() => { reminders.save(reminder); reminders.schedule(reminder); });
    return reminders.deliver(reminders.claim(`notification:${id}:1`, at), at);
  }
  const records = id => outbox.deliveries(id, 0, 100).items.filter(d => d.kind === 'notification');
  return { db, outbox, reminders, enable, notification, records };
}

export function wechatFixture() {
  const f=fixture(); f.db.exec(WECHAT_BINDING_MIGRATION);
  mkdirSync('.tmp',{recursive:true}); const root=mkdtempSync('.tmp/wechat-test-');
  const secrets=new PrivateWechatStore(root), identities=new SqliteWechatBindingRepository(f.db);
  const queue=[], calls=[];
  const client=new IlinkClient(async (url,options)=>{
    calls.push({url:new URL(url),options});
    const entry=queue.shift(); if(!entry)throw Error('unexpected request');
    return new Response(typeof entry==='string'?entry:JSON.stringify(entry),{status:200});
  },50);
  const service=new WechatBindingService(f.outbox,identities,secrets,client,()=>now,false);
  service.initialize();
  async function login(){
    queue.push({qrcode:'qr-private',qrcode_img_content:'https://liteapp.weixin.qq.com/test'});
    await service.begin(f.outbox.channel(WECHAT_CHANNEL_ID).version);
    queue.push({status:'confirmed',ilink_bot_id:'bot',ilink_user_id:'self',baseurl:'https://ilinkai.weixin.qq.com',bot_token:'private-token'},{ret:0});
    await service.pollOnce(new AbortController().signal);
  }
  const close=()=>{f.db.close();rmSync(root,{recursive:true,force:true});};
  return {...f,root,secrets,identities,queue,calls,service,login,close};
}

