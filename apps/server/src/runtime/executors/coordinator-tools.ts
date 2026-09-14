import type { CoordinatorAuthorizedContext, CoordinatorBusinessProposal } from '@multivac/contracts';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const COORDINATOR_TOOL_ALLOWLIST = [
  'list_authorized_context',
  'read_authorized_context',
  'search_authorized_context',
  'propose_task',
  'propose_status_change',
] as const;

function textResult(text: string, details: unknown = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

/**
 * 只读工具仅访问本次调用注入的快照，不能通过路径或自动发现扩大资料范围。
 */
export function createCoordinatorTools(
  authorizedContext: readonly CoordinatorAuthorizedContext[],
): ToolDefinition[] {
  const contextById = new Map(authorizedContext.map((context) => [context.referenceId, context]));

  const listContext = defineTool({
    name: 'list_authorized_context',
    label: '列出已授权资料',
    description: '列出本次会话已授权的资料引用，不读取任何其他来源。',
    parameters: Type.Object({}),
    execute: async () =>
      textResult(
        JSON.stringify(
          authorizedContext.map(({ referenceId, label }) => ({ referenceId, label })),
        ),
      ),
  });

  const readContext = defineTool({
    name: 'read_authorized_context',
    label: '读取已授权资料',
    description: '按引用 ID 读取本次会话已授权的文本快照。',
    parameters: Type.Object({
      referenceId: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const context = contextById.get(params.referenceId);

      if (!context) {
        return textResult(`未找到已授权资料：${params.referenceId}`, { code: 'CONTEXT_NOT_AUTHORIZED' });
      }

      return textResult(context.content, { referenceId: context.referenceId, label: context.label });
    },
  });

  const searchContext = defineTool({
    name: 'search_authorized_context',
    label: '搜索已授权资料',
    description: '在本次会话已授权的文本快照内进行大小写不敏感搜索。',
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const query = params.query.toLocaleLowerCase();
      const matches = authorizedContext.flatMap((context) =>
        context.content
          .split('\n')
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter(({ line }) => line.toLocaleLowerCase().includes(query))
          .slice(0, 20)
          .map(({ line, lineNumber }) => ({
            referenceId: context.referenceId,
            lineNumber,
            text: line,
          })),
      );

      return textResult(JSON.stringify(matches.slice(0, 50)));
    },
  });

  const proposeTask = defineTool({
    name: 'propose_task',
    label: '提出任务建议',
    description: '生成结构化任务提案。该工具不会创建任务或修改任何业务状态。',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(
        Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('urgent')]),
      ),
    }),
    execute: async (toolCallId, params) => {
      const proposal: CoordinatorBusinessProposal = {
        kind: 'task.create',
        proposalId: toolCallId,
        title: params.title,
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.priority === undefined ? {} : { priority: params.priority }),
      };

      return textResult(JSON.stringify(proposal), { proposal });
    },
  });

  const proposeStatusChange = defineTool({
    name: 'propose_status_change',
    label: '提出状态变更建议',
    description: '生成结构化状态变更提案。该工具不会执行状态变更。',
    parameters: Type.Object({
      targetType: Type.Union([Type.Literal('task'), Type.Literal('project')]),
      targetId: Type.String({ minLength: 1 }),
      status: Type.String({ minLength: 1 }),
      reason: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => {
      const proposal: CoordinatorBusinessProposal = {
        kind: 'status.change',
        proposalId: toolCallId,
        targetType: params.targetType,
        targetId: params.targetId,
        status: params.status,
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      };

      return textResult(JSON.stringify(proposal), { proposal });
    },
  });

  return [listContext, readContext, searchContext, proposeTask, proposeStatusChange];
}
