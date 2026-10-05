import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SkillImport, SkillPreview, SkillRecord, SkillStateSchema } from '@multivac/contracts';
import type { Static } from 'typebox';
import { SqliteSkillRepository } from '../storage/sqlite-skill-repository.js';
import { SkillError, SkillPackages, readSkillDirectory, skillHash } from '../modules/skills/skill-package.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class SkillService {
  constructor(readonly repository: SqliteSkillRepository, readonly packages: SkillPackages, private readonly events: WorkbenchEventPublisher, private readonly requireProject: (id: string) => unknown) {}
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
    if (readSkillDirectory(input.source).manifest.version !== preview.manifest.version) throw new SkillError('源目录已变化，请重新预览。', 409);
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
      return { skillId: old?.skillId ?? randomUUID(), version: preview.manifest.version, name: preview.manifest.name, description: preview.manifest.description, displayName: input.displayName || preview.manifest.name, source: input.source, projectId: input.projectId, revision: (old?.revision ?? 0) + 1, enabled: old?.enabled ?? true, removed: false, createdAt: old?.createdAt ?? now, updatedAt: now };
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
