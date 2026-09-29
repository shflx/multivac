import { assistantToolDisplayName } from '@multivac/contracts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { InternalToolSpec } from '../../modules/internal-tools/internal-tool.js';
import type { InternalToolBoundary } from './pi-tool-boundary.js';
import type { CoordinatorInternalTools } from './coordinator-adapter.js';

/** 注入一个 Pi 会话的内部工具：说明（写进提示词、边界规则）与 Pi 工具定义（customTools）。 */
export interface PiInternalToolSet {
  specs: readonly InternalToolSpec[];
  definitions: ToolDefinition[];
}

/**
 * 把全局 Multivac 的内部工具转成 Pi 的 customTools。Pi 只负责向模型声明工具与按时机调用，
 * 参数校验、幂等与执行都交给服务端注册表（CoordinatorInternalTools）：
 * - prepareArguments 先按同一 schema 校验，失败原因以中文回传模型（Pi 自带的校验说明是英文）；
 * - execute 调用 invoke；失败时抛出原因，Pi 据此把这次调用记为失败（isError），原因原样交给模型；
 * - 成功时 details 只放公开的结果（白名单），事件映射只转发通过契约校验的这一项。
 */
export function createPiInternalToolSet(
  assistantSessionId: string,
  tools: CoordinatorInternalTools,
): PiInternalToolSet {
  const definitions = tools.specs.map((spec): ToolDefinition => ({
    name: spec.name,
    label: assistantToolDisplayName(spec.name),
    description: spec.description,
    parameters: spec.parameters,
    // 有副作用的调用逐个执行，同一批中的管理动作与提议不相互交错。
    executionMode: spec.effect === 'query' ? 'parallel' : 'sequential',
    prepareArguments: (args) => {
      const checked = tools.validate(spec.name, args);
      if (!checked.ok) throw new Error(checked.reason);
      return checked.value as never;
    },
    execute: async (toolCallId, params, signal) => {
      const outcome = await tools.invoke(
        { assistantSessionId, toolName: spec.name, toolCallId, args: params },
        signal ?? new AbortController().signal,
      );
      if (!outcome.ok) throw new Error(outcome.reason);
      return { content: [{ type: 'text', text: outcome.content }], details: outcome.result };
    },
  }));
  return { specs: tools.specs, definitions };
}

/** 目录边界使用的内部工具规则表：工具名 → 效果类别。 */
export function internalToolBoundary(specs: readonly InternalToolSpec[]): InternalToolBoundary {
  return Object.fromEntries(specs.map((spec) => [spec.name, spec.effect]));
}
