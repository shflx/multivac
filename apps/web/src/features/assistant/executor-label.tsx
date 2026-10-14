import type { AssistantExecutor } from '@multivac/contracts';

/** 只展示受理回执或历史快照，不读取后来改名、删除后的智能体配置。 */
export function ExecutorLabel({ executor, running = false }: { executor?: AssistantExecutor | null; running?: boolean }) {
  if (!executor) return null;
  return <div className="assistant-executor" data-agent-id={executor.agentId}>
    <strong>{running ? '当前执行者' : '本轮执行者'} · {executor.name}</strong>
    <span>{executor.modelName} · {executor.thinkingLevel}</span>
  </div>;
}
