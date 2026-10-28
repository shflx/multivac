import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';

// 只验证真实组件的交互；所有渠道响应为夹具，不接触微信账号。
const root=resolve('.');await mkdir('.tmp/notification-ui',{recursive:true});
await writeFile('.tmp/notification-ui/index.html','<html lang="zh"><meta charset="UTF-8"><div id="root"></div><script type="module" src="/\.tmp/notification-ui/main.jsx"></script></html>');
await writeFile('.tmp/notification-ui/main.jsx',`import React from 'react';import{createRoot}from'react-dom/client';import{ConfirmProvider}from'/apps/web/src/components/confirm-card.tsx';import{NotificationChannelsPage}from'/apps/web/src/features/notifications/notification-channels-page.tsx';import'/apps/web/src/styles/base.css';createRoot(document.getElementById('root')).render(<ConfirmProvider><NotificationChannelsPage active={true}/></ConfirmProvider>);`);
// 组件位于 web workspace，验收入口位于仓库根；统一 React 身份，避免两份运行时导致 Hook 初始化失败。
const server=await createServer({root,configFile:false,plugins:[react()],resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0}});await server.listen();
let browser;
try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1120,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const channel={id:'wechat-self',type:'wechat',enabled:false,version:1,bindingGeneration:1,scope:'notification',readiness:'ready',diagnostic:null,testedDeliveryId:null,receivedConfirmedAt:null};
  const other={...channel,id:'fixture-channel',type:'fixture'};const records=[];const mutations=[];
  await page.route('**/api/notification-channels**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/notification-channels'.length);
    let body;
    if(request.method()==='POST'){
      const input=request.postDataJSON();mutations.push(path);
      if(path.endsWith('/test')){
        body={id:'test:fixed',kind:'test',notificationId:null,channelId:channel.id,configVersion:1,bindingGeneration:1,state:'accepted',localMessageId:'multivac:unique-phone-test',serverMessageId:'server:1',attempts:1,createdAt:'2026-10-28T00:00:00Z',expiresAt:'2026-10-29T00:00:00Z',nextAttemptAt:'2026-10-28T00:00:00Z',startedAt:'2026-10-28T00:00:00Z',completedAt:'2026-10-28T00:00:00Z',diagnostic:null};records.unshift(body);channel.testedDeliveryId=body.id;
      }else if(path.endsWith('/confirm-test')){assert.equal(input.received,true);assert.equal(input.deliveryId,'test:fixed');channel.receivedConfirmedAt='2026-10-28T00:00:01Z';body=channel;}
      else if(path.endsWith('/enabled')){channel.enabled=input.enabled;channel.version++;body=channel;}
      else throw Error('unexpected mutation '+path);
    }else if(!path)body={items:[channel,other]};
    else if(path.endsWith('/deliveries'))body={items:path.includes('fixture-channel')?[]:records,total:path.includes('fixture-channel')?0:records.length,nextOffset:null};
    else if(path.endsWith('/wechat'))body={state:'ready',qrAvailable:false,diagnostic:null,contextObservedAt:'2026-10-28T00:00:00Z'};
    else throw Error('unexpected GET '+path);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  const address=server.httpServer.address();await page.goto(`http://127.0.0.1:${address.port}/.tmp/notification-ui/index.html`);
  // 设置完成前不出现正式通知开关；按步骤测试、确认后才出现。
  const toggle=page.getByRole('switch',{name:'微信正式通知'});
  const fixtureTest=page.getByRole('region',{name:'通知渠道 · fixture',exact:true}).getByRole('button',{name:'发送新编号测试'});
  await fixtureTest.waitFor();assert.equal(await fixtureTest.isDisabled(),false);
  await page.getByRole('button',{name:'发送新编号测试'}).first().waitFor();assert.equal(await toggle.count(),0);
  await page.getByRole('button',{name:'发送新编号测试'}).first().click();
  await page.getByText('multivac:unique-phone-test',{exact:true}).first().waitFor();
  assert.equal(await toggle.count(),0);
  await page.getByRole('button',{name:'确认手机已收到'}).first().click();await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'我已收到此编号',exact:true}).click();
  await toggle.waitFor();assert.equal(await toggle.isDisabled(),false);
  await toggle.click();await page.waitForFunction(()=>document.querySelector('[aria-label="微信正式通知"]').getAttribute('aria-checked')==='true');
  assert.equal(await page.getByRole('heading',{name:'微信通知',exact:true}).count(),1);
  assert.equal(await page.getByRole('heading',{name:'通知渠道 · fixture',exact:true}).count(),1);
  assert.deepEqual(mutations,['/wechat-self/test','/wechat-self/confirm-test','/wechat-self/enabled']);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'.tmp/notification-ui/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'微信通知说明'}).click();
  const tip=page.getByRole('tooltip');await tip.waitFor();
  const bounds=await tip.boundingBox();assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=390);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'.tmp/notification-ui/mobile.png',fullPage:true,animations:'disabled'});
  console.log('PASS: 真实浏览器组件验证测试→本人确认→启用门禁、通用第二渠道、桌面/窄屏，无微信API或手机实收验证。');
}finally{await browser?.close();await server.close();}
