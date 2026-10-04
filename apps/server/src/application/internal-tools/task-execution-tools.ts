import { ClarificationScopeSchema } from '@multivac/contracts';
import { TASK_GIT_TOOLS } from './task-git-tools.js';
import { Type } from 'typebox';
import { ManagedStartSchema } from '@multivac/contracts';
import { defineInternalTool } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';

export const requestTaskInputTool = defineInternalTool({
  name: 'request_task_input', effect: 'manage',
  description: '仅为当前真实任务提出澄清问题。创建原人工请求后停止推进，等待用户回应；不扩大文件或工具权限，不自行作出决定，不把普通讨论强制转为任务。重复调用不会创建重复请求。',
  parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), scope: Type.Optional(ClarificationScopeSchema) }, { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.taskRequests) throw new InternalToolError('任务人工请求尚未接入。');
    const request = context.services.taskRequests.askSession(context.sessionId, context.commandId, params.question, params.scope);
    return { content: `澄清请求 ${request.requestId} 已保存，等待用户回应。请求不扩大原执行边界。`, result: { summary: '等待用户回应任务澄清', refs: [] } };
  },
});
export const submitTaskResultTool = defineInternalTool({
  name: 'submit_task_result', effect: 'manage',
  description: '为当前任务登记成果文件（任务目录内相对路径）和标题。只有执行已终结、停止已确认、文件与验证证据核对后才保存固定版本并发起验收。登记本身不表示完成，不能批准验收或发布。',
  parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), path: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.taskArtifacts) throw new InternalToolError('任务成果尚未接入。');
    context.services.taskArtifacts.registerSession(context.sessionId, context.commandId, params.title, params.path);
    return { content: '成果提交意图已记录，待当前执行结束后核对文件与停止事实。尚未完成或验收。', result: { summary: '成果待执行终结后核对', refs: [] } };
  },
});
export const startManagedProcessTool = defineInternalTool({
  name: 'start_managed_process', effect: 'manage',
  description: '仅在当前真实任务目录中启动不派生子进程的 Node 脚本。禁止外连和凭据继承，可声明一个回环监听端口；端口声明不等于可用。requiredWhileRunning 表示随本轮停止，false 表示独立长期进程（仍受预算和服务退出约束）。不支持 npm、Vite 或任意 shell。',
  parameters: Type.Omit(ManagedStartSchema, ['commandId'], { additionalProperties: false }),
  async execute(params, context) {
    if (!context.services.managedStart) throw new InternalToolError('此会话不能启动托管进程。');
    const process = await context.services.managedStart.startSession(context.sessionId, { ...params, commandId: context.commandId });
    return { content: JSON.stringify(process), result: { summary: `托管进程：${process.state}，${process.reason}`, refs: [] } };
  },
});
export const TASK_EXECUTION_TOOLS = [requestTaskInputTool, submitTaskResultTool, startManagedProcessTool, ...TASK_GIT_TOOLS];
