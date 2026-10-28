import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './notification-outbox.test.mjs';
import { PrivateWechatStore } from '../dist/storage/private-wechat-store.js';
import { SqliteWechatBindingRepository, WECHAT_BINDING_MIGRATION } from '../dist/storage/sqlite-wechat-binding-repository.js';
import { WechatBindingService, WECHAT_CHANNEL_ID } from '../dist/application/wechat-binding-service.js';
import { IlinkClient, checkedIlinkBase, checkedQrUrl } from '../dist/modules/notifications/wechat/client.js';
import { parseWeixinApiJson } from '../dist/modules/notifications/wechat/lossless-json.js';

const now='2026-10-28T00:00:00.000Z';
function wechatFixture() {
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

test('绑定与本人入站原子保存游标、无损ID和非空上下文；入站正文无业务效力',async()=>{
  const f=wechatFixture();try{
    await f.login();assert.equal(f.service.status().state,'waiting-context');
    f.queue.push('{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"self","to_user_id":"bot","message_type":1,"context_token":"private-context","item_list":[{"type":1,"text_item":{"text":"知道了"}}]}],"get_updates_buf":"cursor1"}');
    await f.service.pollOnce(new AbortController().signal);
    let binding=f.secrets.load();assert.equal(binding.seenIds[0],'18446744073709551615');assert.equal(binding.cursor,'cursor1');assert.equal(binding.contextToken,'private-context');
    assert.equal(f.service.status().state,'ready');assert.equal(f.reminders.notifications().length,0);
    assert.equal(statSync(join(f.root,'binding.json')).mode&0o777,0o600);
    f.queue.push({ret:0,msgs:[{message_id:'18446744073709551615',from_user_id:'self',to_user_id:'bot',message_type:1,context_token:'duplicate'},
      {message_id:'2',from_user_id:'other',to_user_id:'bot',message_type:1,context_token:'foreign'},
      {message_id:'3',from_user_id:'self',to_user_id:'bot',message_type:1,context_token:''}],get_updates_buf:'cursor2'});
    await f.service.pollOnce(new AbortController().signal);
    binding=f.secrets.load();assert.equal(binding.contextToken,'private-context');assert.equal(binding.contextObservedAt,now);assert.equal(binding.cursor,'cursor2');
    assert.equal(JSON.stringify(f.outbox.channel(WECHAT_CHANNEL_ID)).includes('private-'),false);
    assert.equal(JSON.stringify(f.service.status()).includes('private-'),false);
    const restored=new WechatBindingService(f.outbox,f.identities,f.secrets,undefined,()=>now,false);restored.initialize();assert.equal(restored.status().state,'ready');
    f.identities.save({...f.identities.get(WECHAT_CHANNEL_ID),userId:'wrong'});
    assert.equal(restored.binding(f.outbox.channel(WECHAT_CHANNEL_ID)),null);
  }finally{f.close();}
});

test('二维码验证码、跳转核验、有限刷新与缺完整身份不能恢复',async()=>{
  const f=wechatFixture();try{
    f.queue.push({qrcode:'qr-private',qrcode_img_content:'https://liteapp.weixin.qq.com/test'});
    await f.service.begin(1);
    f.queue.push({status:'need_verifycode'});await f.service.pollOnce(new AbortController().signal);
    f.service.verify(f.outbox.channel(WECHAT_CHANNEL_ID).version,'1234');
    f.queue.push({status:'scaned'});await f.service.pollOnce(new AbortController().signal);
    assert.equal(f.calls.at(-1).url.searchParams.get('verify_code'),'1234');
    f.queue.push({status:'scaned_but_redirect',redirect_host:'evil.example'});
    await assert.rejects(()=>f.service.pollOnce(new AbortController().signal));
    for(let i=0;i<2;i++){f.queue.push({status:'expired'},{qrcode:'qr'+i,qrcode_img_content:'https://liteapp.weixin.qq.com/test'});await f.service.pollOnce(new AbortController().signal);}
    f.queue.push({status:'expired'});await f.service.pollOnce(new AbortController().signal);assert.equal(f.service.status().state,'expired');
    f.queue.push({qrcode:'qr-private',qrcode_img_content:'https://liteapp.weixin.qq.com/test'});await f.service.begin(f.outbox.channel(WECHAT_CHANNEL_ID).version);
    f.queue.push({status:'binded_redirect'});await f.service.pollOnce(new AbortController().signal);assert.equal(f.service.status().state,'failed');assert.equal(f.secrets.load(),null);
  }finally{f.close();}
});

test('凭据失效暂停，重绑隔离；私有保存失败不推进游标',async()=>{
  const f=wechatFixture();try{
    await f.login();
    f.queue.push({ret:0,msgs:[],get_updates_buf:'cursor'});
    const save=f.secrets.save.bind(f.secrets);f.secrets.save=()=>{throw Error('storage failure');};
    await assert.rejects(()=>f.service.pollOnce(new AbortController().signal));assert.equal(f.secrets.load().cursor,'');f.secrets.save=save;
    f.queue.push({ret:-14});await f.service.pollOnce(new AbortController().signal);
    assert.equal(f.outbox.channel(WECHAT_CHANNEL_ID).readiness,'invalid');
    const previous=f.outbox.channel(WECHAT_CHANNEL_ID);f.outbox.resetBinding(WECHAT_CHANNEL_ID,previous.version,now);
    assert.equal(f.service.binding(f.outbox.channel(WECHAT_CHANNEL_ID)),null);
  }finally{f.close();}
});

test('HTTPS地址拒绝凭据/端口/外域；解析器不修改正文字符串中的数字',()=>{
  for(const url of ['http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.test','https://evil.test','https://user@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com:8443','https://ilinkai.weixin.qq.com/path']) assert.throws(()=>checkedIlinkBase(url));
  assert.throws(()=>checkedQrUrl('javascript:alert(1)'));
  assert.equal(checkedIlinkBase('https://ilinkai.weixin.qq.com/'),'https://ilinkai.weixin.qq.com');
  const parsed=parseWeixinApiJson('{"message_id":18446744073709551615,"text":"\\\"message_id\\\":18446744073709551615"}');
  assert.equal(parsed.message_id,'18446744073709551615');assert.equal(parsed.text,'"message_id":18446744073709551615');
});
