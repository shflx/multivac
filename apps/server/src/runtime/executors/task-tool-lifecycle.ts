import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { NativeTaskLease } from './native-task-tools.js';

/** 运行管理叠加在共用工具之上，不决定文件、网络或工具权限。 */
export class TaskToolLifecycle {
  private pending = 0;
  private disposed = false;
  constructor(private readonly lease: NativeTaskLease) {}
  get stopped(): boolean { return this.pending === 0; }
  dispose(): void { this.disposed = true; }
  wrap(tool: ToolDefinition): ToolDefinition {
    return { ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
      const marker = `tool:${randomUUID()}`;
      const check = () => {
        if (this.disposed || args[2]?.aborted) throw new Error('任务工具已停止。');
        this.lease('check', marker, 0);
      };
      check();
      const limit = this.lease('starting', marker, Buffer.byteLength(JSON.stringify(args[1])));
      this.pending++;
      let bytes = 0;
      try {
        const result = await tool.execute(...args);
        bytes = Buffer.byteLength(JSON.stringify(result));
        check();
        if (bytes > Math.min(limit, this.lease('check', marker, 0))) throw new Error('任务工具输出超过共享额度。');
        return result;
      } finally {
        try { this.lease('settled', marker, bytes); }
        finally { this.pending--; }
      }
    } };
  }
}
