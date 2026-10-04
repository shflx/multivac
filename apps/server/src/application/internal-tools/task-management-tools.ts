import { Type } from 'typebox';
import { TaskProposalPayloadSchema, CompleteTaskSchema, TaskIdSchema, UpdateTaskSchema, TaskControlSchema, DeleteTaskSchema, CreateTaskGroupSchema } from '@multivac/contracts';
import { defineInternalTool, proposedToolResult } from './internal-tool-service.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { taskRef, taskLink, summaryOf } from './tool-text.js';
import { taskToolFailure } from './task-tool-errors.js';

/** 创建只登记待办，复用任务服务的幂等与关系校验，不启动执行或分配目录。 */
export const createTaskTool = defineInternalTool({
  name: 'create_task', effect: 'manage',
  parameters: Type.Object({ ...Type.Omit(TaskProposalPayloadSchema, ['budget']).properties, userConfirmation: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) }, { additionalProperties: false }),
  description: '用户要求创建任务或将已梳理的需求落地为一组任务时直接创建，无需再次确认或逐项确认。返回真实任务 ID、revision 与关系，可继续创建子任务和后续任务。先创建父任务与前置任务，再用返回的 ID 建立关系；只讨论方案时不创建。创建不启动执行，不挂载目录或扩大权限，使用默认预算。默认是 Agent 任务；humanOnly=true 仅在用户明确表示我来处理或确认后设置，并在 userConfirmation 引用该表达，不根据标题推断。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskManagement) throw new InternalToolError('任务管理尚未接入。');
    try {
      const { userConfirmation, ...input } = params;
      if (input.humanOnly && !userConfirmation?.trim()) throw new InternalToolError('标记“我来处理”需要用户明确表达或确认，请在 userConfirmation 引用原意。');
      const { task } = services.taskManagement.create({ ...input, commandId }, origin);
      return {
        content: `已创建 ${taskLink(task)}（id: ${task.taskId}），revision ${task.revision}，状态 ${task.status}，尚未启动。父任务：${task.parentTaskId ?? '无'}；前置任务：${task.dependencyIds.join('、') || '无'}。`,
        result: { summary: summaryOf(`任务「${task.title}」已创建，尚未启动`), refs: [taskRef(task)] },
      };
    } catch (error) {
      return taskToolFailure('创建任务', error);
    }
  },
});

export const proposeCreateTaskTool = defineInternalTool({
  name: 'propose_create_task', effect: 'propose', parameters: TaskProposalPayloadSchema,
  description: '仅当用户明确要求先看创建预览、确认后再创建时使用，展示目标、项目、范围、优先级与验收。用户已要求创建时使用 create_task，不重复索要确认。此工具确认前不创建或启动。项目、父任务和依赖使用真实已有 ID；不能挂载目录、扩大工具权限或代替用户验收。',
  async execute(params, context) { return proposedToolResult(await context.propose({ kind: 'task.create', payload: params })); },
});
export const updateTaskTool = defineInternalTool({
  name: 'update_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }), patch: UpdateTaskSchema.properties.patch, userConfirmation: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) }, { additionalProperties: false }),
  description: '按已读取的任务 ID 和 revision 修改标题、目标、优先级、范围、父子与依赖等合法属性。执行中不能改变边界，终态只读；预算仅在用户明确要求调整时修改，不为绕过资源限制自行提高。不能扩大目录或工具权限，也不能代替用户作出验收决定。先查询当前事实再修改。设置或移除 humanOnly 必须有用户明确表达或确认，并在 userConfirmation 引用该表达，不能为了执行自行移除标记。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskManagement) throw new InternalToolError('任务管理尚未接入。');
    try {
      if (params.patch.humanOnly !== undefined && !params.userConfirmation?.trim()) throw new InternalToolError('设置或移除“我来处理”需要用户明确表达或确认。');
      const result = services.taskManagement.update(params.taskId, { commandId, revision: params.revision, patch: params.patch }, origin);
      return { content: `任务属性已保存，revision ${result.task.revision}，状态 ${result.task.status}。`, result: { summary: summaryOf(`更新任务「${result.task.title}」`), refs: [taskRef(result.task)] } };
    } catch (error) { return taskToolFailure('修改任务', error); }
  },
});
export const controlTaskTool = defineInternalTool({
  name: 'control_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }), action: TaskControlSchema.properties.action }, { additionalProperties: false }),
  description: '用户要求启动、暂停、继续或取消任务时使用真实控制用例。参数必须基于最新查询的 ID/revision。回执区分接受请求与实际运行结果；不能绕过人工请求、依赖、预算、停止确认、成果验收或终态。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskControl) throw new InternalToolError('任务执行管理尚未接入。');
    try {
      const result = await services.taskControl.control(params.taskId, { commandId, revision: params.revision, action: params.action }, origin);
      return { content: `任务动作已受理：${params.action}。${result.task.reason} 当前 revision ${result.task.revision}；实际状态以任务服务后续事实为准。`, result: { summary: summaryOf(`任务${params.action}已受理`), refs: [taskRef(result.task)] } };
    } catch (error) { return taskToolFailure('控制任务', error); }
  },
});

export const deleteTaskTool = defineInternalTool({
  name: 'delete_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, revision: DeleteTaskSchema.properties.revision }, { additionalProperties: false }),
  description: '用户要求删除任务时，按最新 ID/revision 从待办移除，保留会话、运行与成果历史。无需再逐项确认。必须先查任务、子任务和依赖它的后续任务；执行已停止且无待处理请求、无子任务或被依赖时才能删除。不级联删除；整组删除按后续任务先于前置任务、子任务先于父任务的顺序处理，不删除或修改用户指定范围外的任务。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskManagement) throw new InternalToolError('任务管理尚未接入。');
    try {
      const { task } = services.taskManagement.remove(params.taskId, { commandId, revision: params.revision }, origin);
      return { content: `任务「${task.title}」（id: ${task.taskId}）已从待办删除，会话、运行与成果历史保留。`, result: { summary: summaryOf(`已删除任务「${task.title}」`), refs: [] } };
    } catch (error) { return taskToolFailure('删除任务', error); }
  },
});

export const createTaskGroupTool = defineInternalTool({
  name: 'create_task_group', effect: 'manage',
  parameters: Type.Omit(CreateTaskGroupSchema, ['commandId'], { additionalProperties: false }),
  description: '用户要求分组整理任务时创建任务分组，返回真实 groupId。先查询避免重建已有分组，再通过 create_task 或 update_task 的 groupId 归组；分组不等于父子关系或执行依赖，不启动任务。',
  async execute(params, { services, commandId, origin }) {
    if (!services.taskManagement) throw new InternalToolError('任务管理尚未接入。');
    try {
      const group = services.taskManagement.createGroup({ ...params, commandId }, origin);
      return { content: `已创建任务分组「${group.title}」（groupId: ${group.groupId}；项目: ${group.projectId ?? '日常'}）。`, result: { summary: summaryOf(`已创建任务分组「${group.title}」`), refs: [] } };
    } catch (error) { return taskToolFailure('创建任务分组', error); }
  },
});

/** 来源会话由调用上下文提供，模型不能伪造；状态由完成用例决定。 */
export const completeTaskTool = defineInternalTool({
  name: 'complete_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, ...Type.Omit(CompleteTaskSchema, ['commandId']).properties }, { additionalProperties: false }),
  description: '在本工作会话内完成用户安排的任务后，提交具体结果、验证情况和交付位置，按最新 taskId/revision 写回完成状态。无需人工验收时标记完成，需要验收时进入审核中，不能自行批准。前置依赖和待处理请求必须已解决。已有后台运行的任务须走原运行成果流程，不用本工具替代停止证明或验收；不能把计划、口头承诺或未完成的工作报告为完成。',
  async execute(params, { services, commandId, sessionId, origin }) {
    if (!services.taskCompletion) throw new InternalToolError('工作会话完成任务服务尚未接入。');
    try {
      const { taskId, ...input } = params;
      const { task } = services.taskCompletion.completeSession(taskId, { ...input, commandId }, sessionId, origin);
      return { content: `完成说明已保存，任务状态：${task.status}；revision：${task.revision}。${task.reason}`, result: { summary: summaryOf(`「${task.title}」${task.status === 'done' ? '已完成' : '审核中'}`), refs: [taskRef(task)] } };
    } catch (error) { return taskToolFailure('提交任务完成说明', error); }
  },
});

export const confirmHumanTaskTool = defineInternalTool({
  name: 'confirm_human_task', effect: 'manage',
  parameters: Type.Object({ taskId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }), userConfirmation: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
  description: '仅在用户明确说已做完“我来处理”的任务时，代为记录完成；在 userConfirmation 引用用户完成确认。不能从时间已到、日历或模型判断推断完成。先读取最新任务 ID/revision。不能完成 Agent 任务或绕过前置条件、待处理请求。',
  async execute(params, { services, commandId, origin }) {
    if (!services.humanTaskCompletion || !params.userConfirmation.trim()) throw new InternalToolError('需要用户明确确认完成。');
    try {
      const { task } = services.humanTaskCompletion.confirmHumanCompletion(params.taskId, { commandId, revision: params.revision }, origin);
      return { content: `已按用户确认将「${task.title}」标记完成，revision ${task.revision}。`, result: { summary: summaryOf(`「${task.title}」已由用户确认完成`), refs: [taskRef(task)] } };
    } catch (error) { return taskToolFailure('记录用户完成确认', error); }
  },
});
