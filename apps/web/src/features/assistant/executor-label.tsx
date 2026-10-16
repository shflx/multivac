import type { AssistantExecutor } from '@multivac/contracts';
import { MultivacIcon } from '../../components/multivac-icon.js';

/** 只展示受理回执或历史快照，不读取后来改名、删除后的智能体配置。 */
export function ExecutorLabel({ executor }: { executor?: AssistantExecutor | null }) {
  if (!executor) return null;
  return <div className="assistant-executor" data-agent-id={executor.agentId}>
    <span className="avatar" aria-hidden="true"><MultivacIcon /></span>
    <strong>{executor.name}</strong>
  </div>;
}
