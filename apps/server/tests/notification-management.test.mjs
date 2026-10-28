import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { wechatFixture } from './wechat-binding.test.mjs';
import { NotificationChannelManagementService } from '../dist/application/notification-channel-management-service.js';
import { createNotificationChannelRequestHandler } from '../dist/adapters/http/notification-channel-routes.js';
import { remoteRouteAllowed, markRemoteRequest } from '../dist/adapters/http/remote-policy.js';
import { WECHAT_CHANNEL_ID } from '../dist/application/wechat-binding-service.js';
const now='2026-10-28T00:00:00.000Z';

test('本机管理真实HTTP：只读不分发、测试去重、手机确认门禁、秘密保护及微信专有流程',async()=>{
  const f=wechatFixture();
  const service=new NotificationChannelManagementService(f.outbox,f.service,()=>now),handler=createNotificationChannelRequestHandler(service);
  const server=createServer((req,res)=>{if(req.headers['x-fixture-remote'])markRemoteRequest(req);void handler(req,res).then(found=>{if(!found){res.writeHead(404);res.end();}});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api/notification-channels`;
  const get=path=>fetch(base+path),post=(path,input,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)});
  const id=WECHAT_CHANNEL_ID;
  try{
    assert.equal((await get('')).status,200);assert.equal((await get(`/${id}/deliveries`)).status,200);assert.equal(f.outbox.deliveries(id).total,0);
    assert.equal((await get(`/${id}/deliveries?offset=bad`)).status,400);
    assert.equal((await post(`/${id}/enabled`,{commandId:'enable',version:1,enabled:true})).status,409);
    assert.equal((await post(`/${id}/test`,{commandId:'remote',version:1},{'x-fixture-remote':'1'})).status,403);
    assert.equal(f.outbox.deliveries(id).total,0);
    const input={commandId:'test',version:1};const first=await(await post(`/${id}/test`,input)).json();const second=await(await post(`/${id}/test`,input)).json();
    assert.equal(first.id,second.id);assert.equal(f.outbox.deliveries(id).total,1);assert.equal(f.reminders.notifications().length,0);
    assert.ok(f.outbox.content(first.id).text.includes(first.localMessageId));
    f.outbox.setReadiness(id,'ready',null);f.outbox.saveDelivery({...first,state:'accepted'});
    const confirmed=await post(`/${id}/confirm-test`,{commandId:'confirm',version:1,deliveryId:first.id,received:true});assert.equal(confirmed.status,200);
    const enabled=await post(`/${id}/enabled`,{commandId:'enable2',version:1,enabled:true});assert.equal(enabled.status,200);assert.equal((await enabled.json()).enabled,true);
    assert.equal((await post(`/${id}/test`,{commandId:'active-test',version:2})).status,409);
    f.queue.push({qrcode:'private-qr',qrcode_img_content:'https://liteapp.weixin.qq.com/test'});
    const bindInput={commandId:'bind',version:2};assert.equal((await post(`/${id}/wechat/bind`,bindInput)).status,200);
    const calls=f.calls.length;assert.equal((await post(`/${id}/wechat/bind`,bindInput)).status,200);assert.equal(f.calls.length,calls);
    const status=await(await get(`/${id}/wechat`)).json();assert.equal(status.qrAvailable,true);assert.equal(JSON.stringify(status).includes('private-qr'),false);
    const qr=await get(`/${id}/wechat/qr`);assert.equal(qr.status,200);assert.equal(qr.headers.get('content-type'),'image/png');assert.equal(qr.headers.get('cache-control'),'no-store');assert.ok((await qr.arrayBuffer()).byteLength>100);
    assert.equal((await get('')).status,200);assert.equal((await get(`/${id}/deliveries`)).status,200);
    assert.equal(f.outbox.deliveries(id).total,1); // 查看不产生新测试或补发。
    assert.equal((await(await get('/commands/bind')).json()).state,'done');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.close();}
});

test('远程默认拒绝所有通知管理与图片路径；遗留异步管理意图只读核对未知',()=>{
  const f=wechatFixture();try{
    for(const method of ['GET','POST','PUT','DELETE'])for(const path of ['',`/${WECHAT_CHANNEL_ID}/test`,`/${WECHAT_CHANNEL_ID}/wechat/qr`,'/commands/original']){
      assert.equal(remoteRouteAllowed(method,'/api/notification-channels'+path),false);
    }
    assert.equal(f.outbox.beginOperation('original','bind'),true);f.outbox.recover(now);
    assert.equal(f.outbox.operation('original').state,'unknown');assert.equal(f.outbox.beginOperation('original','bind'),false);
  }finally{f.close();}
});
