import type { CoordinatorInternalTools } from '../modules/sessions/coordinator-adapter.js';
import type { SubagentRecord } from '../modules/agents/subagent-run.js';
import { AssistantSessionRuntime, type AssistantSessionRuntimeDependencies } from './assistant-session-runtime.js';

/** 独立执行会话只由委派器持有；不写会话注册表，不提供发送、选模或栈式导航入口。 */
export class SubagentSessionRuntimes {
  private readonly runtimes = new Map<string, AssistantSessionRuntime>();
  constructor(private readonly dependencies: AssistantSessionRuntimeDependencies, private readonly sessionDir: string,
    private readonly tools: (record: SubagentRecord) => CoordinatorInternalTools,
    private readonly assertActive: (record: SubagentRecord) => void) {}

  get(id: string): AssistantSessionRuntime | undefined { return this.runtimes.get(id); }
  acquire(record: SubagentRecord): AssistantSessionRuntime {
    const existing = this.runtimes.get(record.run.sessionId);
    if (existing) return existing;
    if (!record.execution || !record.runtimeConfig) throw new Error('子智能体冻结配置尚未就绪。');
    const execution = record.execution, config = record.runtimeConfig;
    const runtime = new AssistantSessionRuntime(this.dependencies, {
      sessionId: record.run.sessionId, kind: 'work', runtimeConfig: config, initialModel: execution.model,
      sessionDir: this.sessionDir, supportsContextManagement: () => false,
      internalTools: this.tools(record), resolveNewSessionRuntimeConfig: async () => config,
      resolveWorkingDirectory: () => record.workingDirectory,
      beforeSend: () => this.assertActive(record),
      authorizeSend: command => {
        this.assertActive(record);
        if (command.commandId !== `subagent-send:${record.run.id}` || command.contextRefs.length || command.quote || command.imageIds?.length || command.streamingBehavior) {
          throw new Error('子智能体只接受本次冻结委派。');
        }
      },
      resolveAgentExecution: async id => {
        if (id !== record.run.agent.agentId) throw new Error('委派智能体身份不一致。');
        return execution;
      },
    });
    this.runtimes.set(record.run.sessionId, runtime);
    return runtime;
  }
  release(id: string): void { this.runtimes.get(id)?.dispose(); this.runtimes.delete(id); }
  dispose(): void { for (const id of this.runtimes.keys()) this.release(id); }
}
