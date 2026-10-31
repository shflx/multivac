import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { Check } from 'typebox/value';
import { SchedulePageSchema, ScheduleDetailSchema, previewSchedule } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('管理 HTTP 契约、命令回执、历史分页及版本冲突；本机门禁不因新增路由放宽', async () => {
  await mkdir('.tmp',{recursive:true});const root=await mkdtemp(resolve('.tmp/schedule-http-'));
  const app=createMultivacApplication(testApplicationEnvironment(root));
  try {
    await app.ready;await new Promise<void>(done=>app.server.listen(0,'127.0.0.1',done));
    const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
    const get=(path:string,headers?:Record<string,string>)=>fetch(origin+path,{headers});
    const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const draft={name:'管理提醒',action:{kind:'reminder',text:'喝水'},timeZone:'UTC',rule:{kind:'daily',time:'09:00'},missedPolicy:'skip'};
    const response=await post('/api/schedules',{...draft,commandId:'create'});assert.equal(response.status,200);const item=await response.json();
    assert.deepEqual(await (await post('/api/schedules',{...draft,commandId:'create'})).json(),item);
    const receipt=await (await get('/api/schedules/commands/create')).json();assert.equal(receipt.saved,true);assert.equal(receipt.result.scheduleId,item.scheduleId);
    assert.equal((await get('/api/schedules/commands/missing')).status,200);
    const page=await (await get('/api/schedules?query=管理&limit=1')).json();assert.equal(Check(SchedulePageSchema,page),true);assert.equal(page.total,1);
    assert.equal((await get('/api/schedules?offset=-1')).status,400);
    assert.equal((await post('/api/schedules/control',{scheduleId:item.scheduleId,revision:9,operation:'pause',commandId:'conflict'})).status,409);
    for(const commandId of ['one','two']) await post('/api/schedules/control',{scheduleId:item.scheduleId,revision:1,operation:'trigger',commandId});
    const detail=await (await get(`/api/schedules/${item.scheduleId}?limit=1`)).json();assert.equal(Check(ScheduleDetailSchema,detail),true);assert.equal(detail.history.total,2);assert.equal(detail.history.nextOffset,1);
    const now=await (await get('/api/schedules/context?timeZone=UTC')).json();
    const preview=await (await post('/api/schedules/preview',draft)).json();assert.deepEqual(preview.items,previewSchedule(draft.rule as any,'UTC',new Date(now.currentTime)));
    const badHost = await new Promise<number>((done,reject) => { const req = request(origin+'/api/schedules',{headers:{host:'untrusted.example'}},response => {response.resume();done(response.statusCode!);});req.on('error',reject);req.end(); });
    assert.equal(badHost,403);
    assert.equal((await get('/api/schedules',{origin:'https://untrusted.example'})).status,403);
    assert.equal((await post('/api/schedules',{...draft,commandId:'bad',action:{kind:'agent',instruction:'执行',agentId:'general',projectId:null,directory:'/tmp',budget:{maxMillis:1000,maxOutputBytes:1024,maxToolCalls:1}}})).status,400);
  } finally {
    app.server.closeAllConnections();await new Promise<void>(done=>app.server.close(()=>done()));await app.close();await rm(root,{recursive:true,force:true});
  }
});
