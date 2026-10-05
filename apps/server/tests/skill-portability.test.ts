import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {fixture} from './skill-service.test.js';
import {parseSkillPackage} from '../src/modules/skills/skill-package.js';
test('指定候选目录发现与标准 ZIP 导出再次解析保持内容版本',()=>{
 const f=fixture();try {
  const candidates=f.service.candidates(f.root);assert.equal(candidates.find(c=>c.name==='sample')?.error,null);
  const p=f.service.preview({source:f.source,displayName:'',projectId:null}),r=f.service.confirm('create',p.previewId);
  const archive=f.service.export(r.skillId,r.version),files=unzipSync(archive.bytes);
  const pkg=parseSkillPackage(Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path.replace(/^sample\//u,''),Buffer.from(bytes).toString('base64')])));
  assert.equal(pkg.manifest.version,r.version);assert.ok(!Object.keys(files).some(p=>p.includes('auth')));
 }finally{f.close();}
});
