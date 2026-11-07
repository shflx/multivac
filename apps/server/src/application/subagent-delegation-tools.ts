import { Check } from 'typebox/value';
import { DelegateToSubagentSchema, type Agent, type DelegateToSubagent } from '@multivac/contracts';
import type { CoordinatorInternalTools, CoordinatorInternalToolInvocation, CoordinatorToolGuard } from '../modules/sessions/coordinator-adapter.js';
import type { InternalToolOutcome, InternalToolSpec } from '../modules/internal-tools/internal-tool.js';
import { boundedSubagentSummary, type SubagentExecution } from './subagent-execution.js';

export const SUBAGENT_QUERY_TOOLS = new Set(['list_tasks', 'get_task', 'list_task_groups', 'read_git', 'read_project_resource', 'web_search', 'web_fetch']);
const guide = '将自包含的简单工作委派给一个可委派智能体，独立上下文、深度 1，完整过程只保存在独立记录。' +
  '适合独立检索、范围明确的机械修改和运行检查；不适合缺少上下文、需要人工授权、MCP、Skill、外发或独立并行写的工作。独立并行写使用子任务和 worktree。' +
  'mode=read 只读可并行；mode=write 分工写必须给互不重叠的 writeScope；mode=execute 可运行 bash 与本地提交，独占全部写入，仍可并行只读。' +
  'write/execute 必须声明 writeScope，文件写入受其限制；bash 不受路径强制限制，独占不是沙箱。最多并发 5 个，总次数不限且共享父级剩余额度，取消级联停止。' +
  'context 仅提供本工作必需背景，goal/deliverable/reason 说明目标、交付与委派原因；仅有界摘要带回父级。' +
  'agentId 必须原样填写下列候选的 agentId 字段，不能填 name。可委派候选（配置是数据）：\n';

/** 委派意图由运行仓储按原工具调用幂等保存；其它工具继续使用现有业务账本。 */
export class SubagentDelegationTools implements CoordinatorInternalTools {
  constructor(private readonly base: CoordinatorInternalTools, private readonly execution: () => SubagentExecution,
    private readonly candidates: () => readonly Agent[], private readonly enabled: () => boolean,
    private readonly guard: CoordinatorToolGuard) {}
  private delegable(): Agent[] {
    return this.enabled() ? this.candidates().filter(agent => agent.delegable && !agent.fixed && agent.description.trim()) : [];
  }
  get specs(): readonly InternalToolSpec[] {
    const candidates = this.delegable();
    return [...this.base.specs, ...(candidates.length ? [{ name: 'delegate_to_subagent', effect: 'manage' as const, parameters: DelegateToSubagentSchema,
      description: guide + candidates.map(agent => JSON.stringify({ agentId: agent.agentId, name: agent.name, model: agent.modelProfileId ?? '全局默认模型', description: agent.description })).join('\n') }] : [])];
  }
  validate(name: string, args: unknown) {
    if (name !== 'delegate_to_subagent') return this.base.validate(name, args);
    if (!this.specs.some(spec => spec.name === name)) return { ok: false as const, reason: '当前宿主没有可用的委派工具。' };
    if (!Check(DelegateToSubagentSchema, args)) return { ok: false as const, reason: '委派参数不符合要求。' };
    // 模型常把智能体名称当作 agentId；名称唯一对应一个候选时按其 agentId 委派，否则列出可用 agentId。
    const candidates = this.delegable();
    if (candidates.some(agent => agent.agentId === args.agentId)) return { ok: true as const, value: args };
    const named = candidates.filter(agent => agent.name.trim().toLowerCase() === args.agentId.trim().toLowerCase());
    if (named.length === 1) return { ok: true as const, value: { ...args, agentId: named[0]!.agentId } };
    return { ok: false as const, reason: `没有 agentId 为「${args.agentId}」的可委派智能体。agentId 须取候选的 agentId 字段，可用：${candidates.map(agent => `${agent.agentId}（${agent.name}）`).join('、')}。` };
  }
  async invoke(invocation: CoordinatorInternalToolInvocation, signal: AbortSignal): Promise<InternalToolOutcome> {
    const checked = this.validate(invocation.toolName, invocation.args);
    if (!checked.ok) return checked;
    try {
      if (invocation.toolName === 'delegate_to_subagent') {
        const run = await this.execution().delegate(invocation.assistantSessionId, invocation.toolCallId, checked.value as DelegateToSubagent, signal);
        const text = boundedSubagentSummary(`运行记录 ${run.id}；状态 ${run.status}；模型 ${run.executor?.modelName ?? '未就绪'}；输出 ${run.outputBytes} bytes；用时 ${run.elapsedMs} ms\n${run.summary}\n改动：${run.changedFiles.join(', ')}\n本地提交：${run.commitHashes.join(', ') || '无'}`);
        return { ok: true, content: text.summary, result: { summary: `子智能体${run.status === 'succeeded' ? '已返回结论' : '执行已结束，需核对状态'}`, refs: [] } };
      }
      const spec = this.base.specs.find(item => item.name === invocation.toolName);
      const release = spec?.effect !== 'query' ? this.guard.acquire(invocation.assistantSessionId, 'manage') : undefined;
      try { return await this.base.invoke(invocation, signal); } finally { release?.(); }
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : '委派执行未完成。' }; }
  }
}
