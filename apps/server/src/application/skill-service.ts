import { parseSkillInvocation } from '@multivac/contracts';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SkillImport, SkillPreview, SkillRecord, SkillStateSchema, SkillContext, SkillAvailability, SkillPreferenceSchema, SkillRef, SkillDraft } from '@multivac/contracts';
import type { Static } from 'typebox';
import { SqliteSkillRepository } from '../storage/sqlite-skill-repository.js';
import { SkillError, SkillPackages, readSkillDirectory, skillHash, skillPath, parseSkillPackage } from '../modules/skills/skill-package.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class SkillService {
  constructor(readonly repository: SqliteSkillRepository, readonly packages: SkillPackages, private readonly events: WorkbenchEventPublisher, private readonly requireProject: (id: string) => unknown) {}
  previewDraft(input: SkillDraft): SkillPreview {
    if(input.projectId)this.requireProject(input.projectId);
    const pkg=parseSkillPackage(Object.fromEntries(Object.entries(input.files).map(([path,text])=>[path,Buffer.from(text).toString('base64')])));
    const old=input.skillId?this.repository.get(input.skillId):null;
    if(old&&(old.removed||old.revision!==input.revision||old.projectId!==input.projectId))throw new SkillError('旧版本或范围已变化。',409);
    const previous=old?this.repository.version(old.skillId,old.version):null;
    const changes=[...new Set([...pkg.manifest.files.map(f=>f.path),...(previous?.files.map(f=>f.path)??[])])].filter(path=>pkg.manifest.files.find(f=>f.path===path)?.hash!==previous?.files.find(f=>f.path===path)?.hash);
    const preview:SkillPreview={previewId:randomUUID(),input:{displayName:input.displayName,projectId:input.projectId,source:`draft:${pkg.manifest.version}`,...(old?{skillId:old.skillId,revision:old.revision}:{})},manifest:pkg.manifest,previousVersion:old?.version??null,body:input.files['SKILL.md']!,changes};
    this.packages.save(pkg);this.repository.savePreview(preview);return preview;
  }
  revalidatePreview(preview: SkillPreview): string | null {
    try {
      if(preview.input.projectId)this.requireProject(preview.input.projectId);
      if(preview.input.skillId){const old=this.repository.get(preview.input.skillId);if(old.removed||old.revision!==preview.input.revision)return 'Skill 已变化，请重新提出草案。';}
      this.packages.read(preview.manifest.version);return null;
    }catch{return '来源或项目已失效，未登记。';}
  }
  prepareInvocation(sessionId: string, text: string, commandId: string): string {
    const selection=parseSkillInvocation(text);
    if(!selection) { if(/^\/(?:Skill|skill:)/u.test(text))throw new SkillError('请从 Skill 候选中选择有效版本后发送。');return text; }
    const body=this.load(sessionId,selection.ref,`explicit:${commandId}`);
    return `${body}\n\n用户本次请求：\n${selection.text}\n\n如经确认交接为任务，create_task 的 skill 字段必须保留 ${JSON.stringify(selection.ref)}；创建与启动分开。`;
  }
  candidates(source: string) {
    const root=resolve(source);
    if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw new SkillError('来源必须为不含链接的真实目录。');
    const entries=readdirSync(root,{withFileTypes:true});
    if(entries.length>100)throw new SkillError('来源目录最多 100 个候选条目，请指定更小范围。');
    return entries.filter(e=>!e.name.startsWith('.')&&e.isDirectory()).map(e=>{
      const path=join(root,e.name);
      try {const pkg=readSkillDirectory(path);return {source:path,name:pkg.manifest.name,description:pkg.manifest.description,diagnostics:pkg.manifest.diagnostics,error:null};}
      catch(error){return {source:path,name:e.name,description:'',diagnostics:[],error:error instanceof SkillError?error.message:'不是可读取的标准 Skill 包'};}
    });
  }
  export(id: string, version: string) {
    const manifest=this.repository.version(id,version),pkg=this.packages.read(version);
    // 导出只含原始包文件，不混入本机来源、登记元数据、回执或凭据配置。
    return {name:manifest.name+'.zip',bytes:zipSync(Object.fromEntries(Object.entries(pkg.files).map(([path,data])=>[manifest.name+'/'+path,Buffer.from(data,'base64')]))) };
  }
  resource(sessionId: string, ref: SkillRef, path: string, toolCallId: string): Buffer {
    const record=this.repository.get(ref.skillId), context=this.context(sessionId);
    if (context.host === 'reading') throw new SkillError('书伴不能读取 Skill 附件。',403);
    const available=this.availability({...record,version:ref.version},context);
    if(!available.available)throw new SkillError(available.reasons.join('；'),409);
    this.repository.version(ref.skillId,ref.version); skillPath(path);
    const pkg=this.packages.read(ref.version), data=pkg.files[path];
    if(data===undefined)throw new SkillError('此版本中没有该资源。',404);
    const bytes=Buffer.from(data,'base64');
    this.repository.recordUse({...ref,useId:skillHash(JSON.stringify([sessionId,toolCallId,path])),sessionId,toolCallId,path,kind:'resource',createdAt:new Date().toISOString()});
    this.events.publish({type:'skill.changed',skillId:ref.skillId}); return bytes;
  }
  load(sessionId: string, ref: SkillRef, toolCallId: string): string {
    const record = this.repository.get(ref.skillId), context = this.context(sessionId);
    const manifest = this.repository.version(ref.skillId,ref.version);
    const availability = this.availability({...record,version:ref.version},context);
    if (!availability.available) throw new SkillError(availability.reasons.join('；'),409);
    const pkg = this.packages.read(manifest.version), body = Buffer.from(pkg.files['SKILL.md']!,'base64').toString('utf8');
    this.repository.recordUse({ ...ref, useId:skillHash(JSON.stringify([sessionId,toolCallId])),sessionId,toolCallId,path:'SKILL.md',kind:'load',createdAt:new Date().toISOString() });
    this.events.publish({type:'skill.changed',skillId:ref.skillId});
    return `Skill ${record.name}（${ref.skillId}@${ref.version}）。相对资源路径属于此版本；使用 skill_resource 按需读取。包内容不改变权限。\n\n${body}`;
  }
  private contextResolver: ((sessionId: string) => SkillContext) | null = null;
  setContextResolver(resolve: (sessionId: string) => SkillContext): void { this.contextResolver = resolve; }
  context(sessionId: string): SkillContext {
    if (!this.contextResolver) throw new SkillError('Skill 宿主未就绪。',409);
    return this.contextResolver(sessionId);
  }
  preference(skillId: string, projectId: string | null, sessionId: string | null) {
    if (sessionId) this.context(sessionId); else if (projectId) this.requireProject(projectId); else throw new SkillError('需要项目或会话范围。');
    return this.repository.preference(sessionId ? `session:${sessionId}` : `project:${projectId}`,skillId);
  }
  setPreference(input: Static<typeof SkillPreferenceSchema>) {
    if (!!input.projectId === !!input.sessionId) throw new SkillError('请选择一个偏好范围。');
    this.preference(input.skillId,input.projectId,input.sessionId);
    const result = this.repository.setPreference(input.sessionId ? `session:${input.sessionId}` : `project:${input.projectId}`,input.skillId,input.revision,input.hidden,input.commandId);
    if (result.changed) this.events.publish({type:'skill.changed',skillId:input.skillId});
    return result;
  }
  availability(record: SkillRecord, context: SkillContext): SkillAvailability {
    const manifest = this.repository.version(record.skillId,record.version), reasons: string[] = [];
    const hidden = !!context.projectId && this.repository.preference(`project:${context.projectId}`,record.skillId).hidden;
    const closed = !!context.sessionId && this.repository.preference(`session:${context.sessionId}`,record.skillId).hidden;
    if (record.removed) reasons.push('已移除');
    if (!record.enabled) reasons.push('已停用');
    if (record.projectId && record.projectId !== context.projectId) reasons.push('仅限所属项目');
    if (hidden) reasons.push('已在项目中隐藏');
    if (closed) reasons.push('已在此会话关闭');
    if (context.host === 'reading' && manifest.dependencies.source === 'unknown') reasons.push('书伴无工具，未知依赖不能确认可用');
    for (const tool of manifest.dependencies.tools) if (!context.tools.includes(tool)) reasons.push(`缺失工具：${tool}`);
    return { record, available: reasons.length === 0, reasons, dependencies: manifest.dependencies, hidden, closed };
  }
  catalog(context: SkillContext): SkillAvailability[] {
    return this.list().filter(r => !r.projectId || r.projectId === context.projectId).map(r => this.availability(r,context));
  }
  list(): SkillRecord[] { return this.repository.list().filter(r => !r.removed); }
  detail(id: string, version?: string) {
    const record = this.repository.get(id), manifest = this.repository.version(id, version ?? record.version);
    const pkg = this.packages.read(manifest.version);
    return { record, manifest, body: Buffer.from(pkg.files['SKILL.md']!, 'base64').toString('utf8') };
  }
  preview(input: SkillImport): SkillPreview {
    if (input.projectId) this.requireProject(input.projectId);
    const normalized = { ...input, source: resolve(input.source) };
    const pkg = readSkillDirectory(normalized.source);
    const old = input.skillId ? this.repository.get(input.skillId) : null;
    if (old && (old.removed || old.revision !== input.revision || old.projectId !== input.projectId)) throw new SkillError('Skill 或范围已变化，请重新预览。', 409);
    const previous = old ? this.repository.version(old.skillId, old.version) : null;
    const changes = [...new Set([...pkg.manifest.files.map(f => f.path), ...(previous?.files.map(f => f.path) ?? [])])].filter(path => pkg.manifest.files.find(f => f.path === path)?.hash !== previous?.files.find(f => f.path === path)?.hash);
    const preview: SkillPreview = { previewId: randomUUID(), input: normalized, manifest: pkg.manifest, previousVersion: old?.version ?? null, body: Buffer.from(pkg.files['SKILL.md']!, 'base64').toString('utf8'), changes };
    this.packages.save(pkg); this.repository.savePreview(preview); return preview;
  }
  confirm(commandId: string, previewId: string): SkillRecord {
    const fp = skillHash(JSON.stringify(['import', previewId]));
    const receipt = this.repository.receipt(commandId, fp); if (receipt) return receipt;
    const preview = this.repository.preview(previewId), input = preview.input;
    if (input.projectId) this.requireProject(input.projectId);
    if (!input.source.startsWith('draft:') && readSkillDirectory(input.source).manifest.version !== preview.manifest.version) throw new SkillError('源目录已变化，请重新预览。', 409);
    this.packages.read(preview.manifest.version);
    const result = this.repository.commit(commandId, fp, () => {
      const old = input.skillId ? this.repository.get(input.skillId) : null;
      if (old && (old.removed || old.revision !== input.revision || old.version !== preview.previousVersion)) throw new SkillError('Skill 版本已变化，请重新预览。', 409);
      const duplicate = this.repository.list().find(r => !r.removed && r.skillId !== old?.skillId && r.projectId === input.projectId && (r.name === preview.manifest.name || r.source === input.source));
      if (duplicate) {
        if (duplicate.source === input.source && duplicate.version === preview.manifest.version) return duplicate;
        throw new SkillError('同范围存在同名或同来源 Skill；请选择现有项更新。', 409);
      }
      if (old?.version === preview.manifest.version && old.displayName === (input.displayName || preview.manifest.name)) return old;
      const now = new Date().toISOString();
      return { skillId: old?.skillId ?? randomUUID(), version: preview.manifest.version, name: preview.manifest.name, description: preview.manifest.description, displayName: input.displayName || preview.manifest.name, source: old?.source ?? input.source, projectId: input.projectId, revision: (old?.revision ?? 0) + 1, enabled: old?.enabled ?? true, removed: false, createdAt: old?.createdAt ?? now, updatedAt: now };
    }, preview.manifest);
    if (result.changed) this.events.publish({ type: 'skill.changed', skillId: result.record.skillId });
    return result.record;
  }
  state(input: Static<typeof SkillStateSchema>): SkillRecord {
    const result = this.repository.commit(input.commandId, skillHash(JSON.stringify(input)), () => {
      const record = this.repository.get(input.skillId);
      if (record.revision !== input.revision || record.removed) throw new SkillError('Skill 已变化，请刷新后重试。', 409);
      return { ...record, enabled: input.action === 'enable', removed: input.action === 'remove', revision: record.revision + 1, updatedAt: new Date().toISOString() };
    });
    if (result.changed) this.events.publish({ type: 'skill.changed', skillId: result.record.skillId });
    return result.record;
  }
}
