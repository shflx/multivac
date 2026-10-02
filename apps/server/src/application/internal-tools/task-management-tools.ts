import { Type } from 'typebox';
import { TaskProposalPayloadSchema, TaskIdSchema, UpdateTaskSchema, TaskControlSchema } from '@multivac/contracts';
import { defineInternalTool, proposedToolResult } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { taskRef, summaryOf } from './tool-text.js';
export const proposeCreateTaskTool = defineInternalTool({
  name: 'propose_create_task', effect: 'propose', parameters: TaskProposalPayloadSchema,
  description: '用户明确要建立任务时提出创建确认卡，展示目标、项目、范围、优先级与验收。确认前不创建或启动，不把普通讨论强制任务化。项目、父任务和依赖使用真实已有 ID；不能挂载目录、扩大工具权限或代替用户验收。',
  async execute(params, context) { return proposedToolResult(await context.propose({ kind: 'task.create', payload: params })); },
});
export const updateTaskTool = defineInternalTool({
  name: 'update_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }), patch: UpdateTaskSchema.properties.patch }, { additionalProperties: false }),
  description: '按已读取的任务 ID 和 revision 修改标题、目标、优先级、范围、父子与依赖等合法属性。执行中不能改变边界，终态只读；不扩大目录或工具权限、不批准验收，不通过提高预算绕过资源限制。先查询当前事实再修改。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskManagement) throw new InternalToolError('任务管理尚未接入。');
    if (params.patch.budget) throw new InternalToolError('预算只能由用户在任务界面明确调整。');
    const result = services.taskManagement.update(params.taskId, { commandId, revision: params.revision, patch: params.patch }, origin);
    return { content: `任务属性已保存，revision ${result.task.revision}，状态 ${result.task.status}。`, result: { summary: summaryOf(`更新任务「${result.task.title}」`), refs: [taskRef(result.task)] } };
  },
});
export const controlTaskTool = defineInternalTool({
  name: 'control_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }), action: TaskControlSchema.properties.action }, { additionalProperties: false }),
  description: '用户要求启动、暂停、继续或取消任务时使用真实控制用例。参数必须基于最新查询的 ID/revision。回执区分接受请求与实际运行结果；不能绕过人工请求、依赖、预算、停止确认、成果验收或终态。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskControl) throw new InternalToolError('任务执行管理尚未接入。');
    const result = await services.taskControl.control(params.taskId, { commandId, revision: params.revision, action: params.action }, origin);
    return { content: `任务动作已受理：${params.action}。${result.task.reason} 当前 revision ${result.task.revision}；实际状态以任务服务后续事实为准。`, result: { summary: summaryOf(`任务${params.action}已受理`), refs: [taskRef(result.task)] } };
  },
});
