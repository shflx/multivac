import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { SkillService } from '../src/application/skill-service.js';
import { SkillPackages } from '../src/modules/skills/skill-package.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
export function fixture() {
 const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-service-'))), source = join(root,'sample'); mkdirSync(source);
 const write = (body: string) => writeFileSync(join(source,'SKILL.md'), `---\nname: sample\ndescription: 示例\n---\n${body}`); write('first');
 const store = new SqliteAssistantStore(join(root,'db')), events = new WorkbenchEvents(), changes: unknown[] = []; events.subscribe(e=>changes.push(e));
 const service = new SkillService(store.skills,new SkillPackages(join(root,'packages')),events, id=>{if(id!=='project')throw Error('missing project');});
 return { root, source, store, service, changes, write, close:()=>{store.close();rmSync(root,{recursive:true,force:true});} };
}
test('显式预览确认、取消、重复导入、版本竞争和移除历史',()=>{
 const f=fixture();try {
  const preview=f.service.preview({source:f.source,projectId:null,displayName:'示例'}); assert.equal(f.service.list().length,0);
  const first=f.service.confirm('create',preview.previewId);assert.equal(f.service.confirm('create',preview.previewId).skillId,first.skillId); assert.equal(f.changes.length,1);
  const repeat=f.service.preview({source:f.source,projectId:null,displayName:'示例'});assert.equal(f.service.confirm('repeat',repeat.previewId).skillId,first.skillId); assert.equal(f.changes.length,1);
  f.write('second');const update=f.service.preview({source:f.source,projectId:null,displayName:'示例',skillId:first.skillId,revision:first.revision});
  const second=f.service.confirm('update',update.previewId);assert.notEqual(second.version,first.version);assert.match(f.service.detail(first.skillId,first.version).body,/first/);
  assert.throws(()=>f.service.state({commandId:'stale',skillId:first.skillId,revision:first.revision,action:'disable'}),/已变化/);
  const disabled=f.service.state({commandId:'disable',skillId:second.skillId,revision:second.revision,action:'disable'});assert.equal(disabled.enabled,false);
  const removed=f.service.state({commandId:'remove',skillId:disabled.skillId,revision:disabled.revision,action:'remove'});assert.equal(removed.removed,true);assert.equal(f.service.list().length,0);
  rmSync(f.source,{recursive:true});assert.match(f.service.detail(first.skillId,first.version).body,/first/);assert.equal(f.service.confirm('create',preview.previewId).skillId,first.skillId);
 }finally{f.close();}
});
test('确认前来源变化拒绝登记，已登记快照不随源目录变化',()=>{
 const f=fixture();try {const p=f.service.preview({source:f.source,projectId:null,displayName:''});f.write('changed');assert.throws(()=>f.service.confirm('c',p.previewId),/源目录已变化/);assert.equal(f.service.list().length,0);}finally{f.close();}
});
