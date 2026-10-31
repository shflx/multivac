import { Type } from 'typebox';
import { CreateScheduleSchema, UpdateScheduleSchema, ControlScheduleSchema, ScheduleQuerySchema, ScheduleDraftSchema } from '@multivac/contracts';
import { defineInternalTool } from './internal-tool-service.js';
import { taskToolFailure } from './task-tool-errors.js';
import { TaskServiceError } from '../../modules/tasks/task-error.js';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
function failure(error: unknown, commandId: string): never {
  if (error instanceof TaskServiceError) return taskToolFailure('管理定时安排', error);
  throw new InternalToolError(`结果未能核对。请用 reconcile_schedule_command 和原 commandId「${commandId}」只读对账，不能换身份重建或重复触发。`);
}
const guidance = 'Schedule 是独立安排，不创建 Task/TaskRun，不进入任务验收。单次、每日、每周多个星期几均按明确 IANA 时区计算。先读取 get_schedule_context；时区、日期、动作类型或范围不清楚时集中澄清。周期及 Agent 默认跳过离线错过，可选只补最近一次；同安排不重叠。';
export const SCHEDULE_TOOLS = [
  defineInternalTool({ name: 'get_schedule_context', effect: 'query', requires: ['schedules'],
    parameters: Type.Object({ timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }, { additionalProperties: false }),
    description: '创建安排前读取当前时间、用户时区、每轮默认预算及边界。优先用户明确时区，其次本轮浏览器时区，缺失时询问；不使用服务器时区，不自行增加预算。',
    async execute(params, context) { return { content: JSON.stringify(context.services.schedules.context(params.timeZone ?? context.originView?.timeZone)), result: { summary: '当前时间与定时执行默认额度', refs: [] } }; },
  }),
  defineInternalTool({ name: 'create_schedule', effect: 'manage', requires: ['schedules'], parameters: CreateScheduleSchema,
    description: `${guidance} 提醒动作只存通知文本；Agent 动作需用户明确指令、范围和 Agent。采用 context 返回的有限预算，只有用户明确调整才改预算。单次必须提供含偏移的 scheduledAt 和 localTime YYYY-MM-DDTHH:mm:ss，DST 重复须澄清偏移。commandId 为稳定唯一身份；未知结果先对账。保存后启用，仅真实回执后回复已安排。`,
    async execute(params, context) { try { const item = context.services.schedules.create(context.sessionId, params); return { content: JSON.stringify({ receipt: item, current: context.services.schedules.get(item.scheduleId) }), result: { summary: `已保存安排：${item.name}`, refs: [] } }; } catch (error) { return failure(error, params.commandId); } },
  }),
  defineInternalTool({ name: 'list_schedules', effect: 'query', requires: ['schedules'], parameters: ScheduleQuerySchema,
    description: '按类型、状态和名称分页查询定时安排。查询不触发；同名须核对稳定 ID，第一页不能证明唯一。返回 revision 和 nextAt，按 nextOffset 继续读取。',
    async execute(params, context) { return { content: JSON.stringify(context.services.schedules.page(params)), result: { summary: '已读取定时安排', refs: [] } }; },
  }),
  defineInternalTool({ name: 'get_schedule', effect: 'query', requires: ['schedules'], parameters: Type.Object({ scheduleId: Id, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    description: '按已查询到的 scheduleId 读取最新版本、当前轮次、分页触发历史和未来预览。修改前先读取；等待人工去 Inbox，结果未知仅核对，不重发指令。',
    async execute(params, context) { try { return { content: JSON.stringify(context.services.schedules.detail(params.scheduleId, params.offset, params.limit)), result: { summary: '已读取安排及触发历史', refs: [] } }; } catch (error) { return taskToolFailure('读取定时安排', error); } },
  }),
  defineInternalTool({ name: 'update_schedule', effect: 'manage', requires: ['schedules'], parameters: UpdateScheduleSchema,
    description: `${guidance} 按已读取的稳定 scheduleId/revision 提交完整新配置，只影响后续触发并保留原快照。不得自行提高预算，须有用户明确调整要求。动作类型创建后不可变。冲突先重新查询，未知结果用原 commandId 对账。`,
    async execute(params, context) { try { const item = context.services.schedules.update(context.sessionId, params); return { content: JSON.stringify({ receipt: item, current: context.services.schedules.get(item.scheduleId) }), result: { summary: '安排已保存，只影响之后的触发', refs: [] } }; } catch (error) { return failure(error, params.commandId); } },
  }),
  defineInternalTool({ name: 'control_schedule', effect: 'manage', requires: ['schedules'], parameters: ControlScheduleSchema,
    description: '用户明确要求时按稳定 scheduleId/revision 控制安排。pause 仅阻止后续，不杀当前；enable 从未来继续，不补暂停轮次；trigger 立即执行一次，不改原计划且遵守不重叠；stop 仅停止本次，不暂停周期；delete 须明确删除意图，活动执行须先停止或等待，历史/会话/通知保留。使用稳定 commandId，结果未知只读对账，不换身份重复触发。',
    async execute(params, context) { try { return { content: JSON.stringify(context.services.schedules.control(context.sessionId, params)), result: { summary: '安排控制命令已保存，请按当前事实核对', refs: [] } }; } catch (error) { return failure(error, params.commandId); } },
  }),
  defineInternalTool({ name: 'reconcile_schedule_command', effect: 'query', requires: ['schedules'], parameters: Type.Object({ commandId: Id }, { additionalProperties: false }),
    description: '响应丢失时按当前会话原 commandId 只读核对安排命令。saved=true 仅表示原事务已提交，不能推断执行成功；saved=false 不回复已安排。此工具不重建、不触发、不重放外部操作。',
    async execute(params, context) { return { content: JSON.stringify(context.services.schedules.reconcile(context.sessionId, params.commandId)), result: { summary: '已核对原安排命令', refs: [] } }; },
  }),
  defineInternalTool({ name: 'preview_schedule', effect: 'query', requires: ['schedules'], parameters: ScheduleDraftSchema,
    description: '按完整安排草稿只读预览最近三次时间；同正式调度规则。DST 缺失显示跳过、重复取较早偏移。预览不保存、不触发，不替代单次时间偏移澄清。',
    async execute(params, context) { try { return { content: JSON.stringify(context.services.schedules.preview(params)), result: { summary: '已读取触发预览', refs: [] } }; } catch (error) { return taskToolFailure('预览定时安排', error); } },
  }),
];
