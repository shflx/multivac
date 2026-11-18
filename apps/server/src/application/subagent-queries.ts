import type { SubagentPage, SubagentProcessPage } from '@multivac/contracts';
import type { SubagentRepository } from '../modules/agents/subagent-run.js';
import type { CoordinatorAdapter } from '../modules/sessions/coordinator-adapter.js';
import type { AssistantSessionBindingRepository } from '../modules/sessions/assistant-session.js';
import type { UsageRepository } from '../modules/usage/model-usage.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';

/** 过程查询只使用已存在的绑定；不创建运行时、不重发命令、不提供发送入口。 */
export class SubagentQueries {
  constructor(private readonly repository: SubagentRepository,
    private readonly bindings: AssistantSessionBindingRepository, private readonly adapter: CoordinatorAdapter,
    private readonly parentTitle: (id: string) => string, private readonly usage: UsageRepository) {}
  page(query: { parentSessionId?: string; taskId?: string; activeOnly?: boolean; offset: number; limit: number }): SubagentPage {
    const page = this.repository.listPage(query);
    const nextOffset = query.offset + query.limit < page.total ? query.offset + query.limit : null;
    if (!page.items.length) return { ...page, items: [], nextOffset };
    const totals = this.usage.subagentTotals(page.items.map(record => record.run.id));
    return { ...page, items: page.items.map(({ run }) => ({
      ...run, totalTokens: totals.get(run.id) ?? null, parentTitle: this.parentTitle(run.parentSessionId),
    })), nextOffset };
  }
  process(id: string, offset: number, limit: number): SubagentProcessPage {
    const record = this.repository.get(id);
    if (!record) throw new TaskServiceError('NOT_FOUND', '子智能体记录不存在。');
    const binding = this.bindings.get(record.run.sessionId);
    const result = binding ? this.adapter.readExecutionProcess?.(record.run.sessionId, binding, record.workingDirectory.path) : undefined;
    if (!result?.ok) return { items: [], total: 0, nextOffset: null, available: false };
    return { items: result.value.slice(offset, offset + limit), total: result.value.length,
      nextOffset: offset + limit < result.value.length ? offset + limit : null, available: true };
  }
}
