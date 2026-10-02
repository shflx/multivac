import { Type } from 'typebox';
import { defineInternalTool } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';

export const requestTaskInputTool = defineInternalTool({
  name: 'request_task_input', effect: 'manage',
  description: '仅为当前真实任务提出澄清问题。创建原人工请求后停止推进，等待用户回应；不扩大文件或工具权限，不自行作出决定，不把普通讨论强制转为任务。重复调用不会创建重复请求。',
  parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.taskRequests) throw new InternalToolError('任务人工请求尚未接入。');
    const request = context.services.taskRequests.askSession(context.sessionId, context.commandId, params.question);
    return { content: `澄清请求 ${request.requestId} 已保存，等待用户回应。请求不扩大原执行边界。`, result: { summary: '等待用户回应任务澄清', refs: [] } };
  },
});
export const TASK_EXECUTION_TOOLS = [requestTaskInputTool];
