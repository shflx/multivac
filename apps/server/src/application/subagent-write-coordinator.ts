import { isPathWithin } from '../modules/sessions/working-directory.js';
import type { SubagentRecord, SubagentRepository } from '../modules/agents/subagent-run.js';
import type { CoordinatorToolGuard } from '../modules/sessions/coordinator-adapter.js';
import { resolveRealTargetPath, resolveToolInputPath } from '../modules/sessions/tool-path.js';

const overlaps = (a: string, b: string) => isPathWithin(a, b) || isPathWithin(b, a);
interface Writer { sessionId: string; parentSessionId: string; path: string | null }

/** 进程内操作租约补足持久委派占用：委派与已经开始的父级 I/O 也互斥。 */
export class SubagentWriteCoordinator implements CoordinatorToolGuard {
  private readonly writers = new Set<Writer>();
  constructor(private readonly repository: SubagentRepository,
    private readonly permitted: (parentSessionId: string, path: string) => Promise<boolean>,
    private readonly parentBashActive: (parentSessionId: string) => boolean = () => false) {}

  async normalize(record: SubagentRecord): Promise<void> {
    if (record.run.mode === 'read') return;
    const normalized: string[] = [];
    for (const scope of record.run.writeScope) {
      const path = await resolveRealTargetPath(resolveToolInputPath(scope, record.workingDirectory.path));
      if (!await this.permitted(record.run.parentSessionId, path)) throw new Error('writeScope 超出父级当前许可目录；委派不发起授权。');
      normalized.push(path);
    }
    record.run.writeScope = [...new Set(normalized)];
  }
  admit(record: SubagentRecord): void {
    const run = record.run;
    if (run.mode === 'read') return;
    const siblings = this.repository.unsettled(run.parentSessionId).filter(r => r.run.mode !== 'read');
    if (siblings.some(r => run.mode === 'execute' || r.run.mode === 'execute' || r.run.writeScope.some(a => run.writeScope.some(b => overlaps(a, b))))) {
      throw new Error('委派写入范围冲突，或已有执行方式独占写入。');
    }
    if (this.parentBashActive(run.parentSessionId) || [...this.writers].some(writer => writer.parentSessionId === run.parentSessionId &&
      (run.mode === 'execute' || writer.path === null || run.writeScope.some(scope => overlaps(scope, writer.path!))))) {
      throw new Error('父级写入或 bash 尚未结束，不能取得委派写入占用。');
    }
  }
  acquire(sessionId: string, tool: string, path?: string): (succeeded?: boolean) => void {
    const child = this.repository.bySession(sessionId);
    const parentId = child?.run.parentSessionId ?? sessionId;
    const writing = ['write', 'edit', 'bash', 'commit_task_code', 'commit_subagent_code'].includes(tool) || tool === 'manage';
    if (!writing) return () => {};
    if (child) {
      if (child.run.stopConfirmed || !['running', 'preparing'].includes(child.run.status)) throw new Error('子智能体执行已失效。');
      if (child.run.mode === 'read' || tool === 'bash' && child.run.mode !== 'execute') throw new Error('该委派方式不能调用写入或 bash。');
      if (path && !child.run.writeScope.some(scope => isPathWithin(scope, path))) throw new Error('写入超出本次 writeScope。');
    } else {
      for (const record of this.repository.unsettled(parentId)) {
        if (record.run.mode === 'read') continue;
        if (record.run.mode === 'execute' || !path || record.run.writeScope.some(scope => overlaps(scope, path))) {
          throw new Error('子智能体持有写入范围或执行独占，父级本次写入未执行。');
        }
      }
    }
    const writer: Writer = { sessionId, parentSessionId: parentId, path: path ?? null };
    this.writers.add(writer);
    let released = false;
    return (succeeded = false) => {
      if (released) return;
      released = true; this.writers.delete(writer);
      if (child && path && succeeded) {
        this.repository.transaction(() => {
          const current = this.repository.bySession(sessionId)!;
          current.run.changedFiles = [...new Set([...current.run.changedFiles, path])];
          this.repository.save(current);
        });
      }
    };
  }
}
