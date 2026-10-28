import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { wechatFixture } from './fixtures/notification-channels.mjs';
import { WechatNotificationAdapter, formatWechatNotification } from '../src/modules/notifications/wechat/adapter.js';
import { IlinkClient } from '../src/modules/notifications/wechat/client.js';
import { NotificationDeliveryService } from '../src/application/notification-delivery-service.js';
import { WECHAT_CHANNEL_ID } from '../src/application/wechat-binding-service.js';
const now='2026-10-28T00:00:00.000Z';

async function initialize(f){
  await f.login();f.queue.push({ret:0,msgs:[{message_id:'1',from_user_id:'self',to_user_id:'bot',message_type:1,context_token:'private-context'}],get_updates_buf:'cursor'});
  await f.service.pollOnce(new AbortController().signal);
}

test('Unicode格式不截断emoji，总长1000，保留原时间、截断和Inbox提示',()=>{
  const content={text:'😀'.repeat(1200),scheduledAt:now,localTime:'2026-10-28T08:00:00',timeZone:'Asia/Shanghai'};
  const formatted=formatWechatNotification(content);
  assert.equal(Array.from(formatted).length,1000);assert.ok(formatted.includes('全文保留在 Inbox'));assert.ok(formatted.includes(content.localTime));
  assert.ok(formatted.endsWith('请到Multivac Inbox查看。'));assert.equal(formatted.includes('\ufffd'),false);
});

test('本人身份、持久编号和原始上下文请求，兼容省略状态码，拒绝及未知结果独立分类',async()=>{
  const f=wechatFixture();try{
    await initialize(f);const adapter=new WechatNotificationAdapter(f.service);
    const channel=f.outbox.channel(WECHAT_CHANNEL_ID),ctx={channel,localMessageId:'multivac:fixed',signal:new AbortController().signal};
    const outcomes=[[{ret:0,message_id:'18446744073709551615'},'accepted'],[{},'accepted'],[{ret:1},'rejected'],[{ret:-14},'rejected'],['not-json','unknown']];
    for(const [reply,outcome]of outcomes){f.queue.push(reply);assert.equal((await adapter.send('提醒',ctx)).outcome,outcome);}
    const request=f.calls.find(c=>c.url.pathname.endsWith('sendmessage'));
    const body=JSON.parse(request.options.body);
    assert.equal(body.msg.to_user_id,'self');assert.equal(body.msg.client_id,'multivac:fixed');assert.equal(body.msg.context_token,'private-context');
    assert.equal(body.msg.item_list[0].text_item.text,'提醒');assert.equal(body.base_info.bot_agent,'Multivac/0.1.0');
    assert.equal(request.options.headers.Authorization,'Bearer private-token');assert.equal(request.options.headers['iLink-App-ClientVersion'],'132106');
    assert.equal(request.options.redirect,'manual');assert.deepEqual(adapter.capabilities,{idempotency:false,resultQuery:false});
    const rebound=f.outbox.resetBinding(channel.id,channel.version,now);const before=f.calls.length;
    assert.equal((await adapter.send('stale',{...ctx,channel:rebound})).outcome,'not-sent');assert.equal(f.calls.length,before);
  }finally{f.close();}
});

test('真实HTTP响应体停滞受超时约束；HTTP成功无业务成功仍为未知',async()=>{
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{"ret":');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;
  const client=new IlinkClient((url,options)=>fetch(`http://127.0.0.1:${port}/`,options),20);
  try{await assert.rejects(()=>client.request('https://ilinkai.weixin.qq.com','sendmessage',{token:'fixture',body:{}}),e=>e.kind==='timeout');}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('与通用执行器集成：测试独立编号无Inbox，接受后需本人确认才能正式启用',async()=>{
  const f=wechatFixture();try{
    await initialize(f);const adapter=new WechatNotificationAdapter(f.service);
    const channel=f.outbox.channel(WECHAT_CHANNEL_ID),d=f.outbox.createTest(channel.id,channel.version,now);
    assert.throws(()=>f.outbox.setEnabled(channel.id,channel.version,true,now));
    const worker=new NotificationDeliveryService(f.outbox,[adapter],()=>now);
    f.queue.push({ret:0,message_id:'99'});await worker.tick();
    assert.equal(f.outbox.delivery(d.id).state,'accepted');assert.equal(f.outbox.delivery(d.id).serverMessageId,'99');
    assert.equal(f.reminders.notifications().length,0);assert.equal(f.outbox.channel(channel.id).receivedConfirmedAt,null);
    f.outbox.confirmTest(channel.id,channel.version,d.id,now);f.outbox.setEnabled(channel.id,channel.version,true,now);
    f.notification('actual');f.queue.push('not-json');await worker.tick();await worker.tick();
    const record=f.records(channel.id)[0];assert.equal(record.state,'unknown');assert.equal(record.attempts,1);
    assert.equal(f.reminders.notifications().length,1);assert.equal(f.reminders.notifications()[0].acknowledgedAt,null);
    await worker.close();
  }finally{f.close();}
});
