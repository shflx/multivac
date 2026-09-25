import type { SessionRecord } from '../modules/sessions/session-registry.js';
import type { SessionRuntimeHandle, WorkspaceSessionRuntimes } from './workspace-session-service.js';

/** 会话运行时：同一会话在进程内只有一份，释放时解除它持有的 Pi 与订阅资源。 */
export interface SessionRuntime extends SessionRuntimeHandle {
  readonly sessionId: string;
  dispose(): void;
}

/**
 * 按会话 id 管理运行时集合。
 *
 * 常驻运行时（全局协调会话）在构造时注册且不会被释放；其余会话首次访问时创建，
 * 归档后释放，互不影响。
 */
export class SessionRuntimeRegistry<T extends SessionRuntime> implements WorkspaceSessionRuntimes {
  private readonly runtimes = new Map<string, T>();
  private readonly pinned = new Set<string>();

  constructor(
    private readonly factory: (record: SessionRecord) => T,
    resident: readonly T[] = [],
  ) {
    for (const runtime of resident) {
      this.runtimes.set(runtime.sessionId, runtime);
      this.pinned.add(runtime.sessionId);
    }
  }

  acquire(record: SessionRecord): T {
    const existing = this.runtimes.get(record.sessionId);
    if (existing) return existing;
    const runtime = this.factory(record);
    this.runtimes.set(record.sessionId, runtime);
    return runtime;
  }

  get(sessionId: string): T | undefined {
    return this.runtimes.get(sessionId);
  }

  release(sessionId: string): void {
    if (this.pinned.has(sessionId)) return;
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    runtime.dispose();
  }

  /** 释放全部非常驻运行时；常驻运行时由其所有者关闭。 */
  releaseAll(): void {
    for (const sessionId of [...this.runtimes.keys()]) this.release(sessionId);
  }
}
