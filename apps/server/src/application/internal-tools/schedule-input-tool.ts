import { Type } from 'typebox';
import { defineInternalTool } from './internal-tool-service.js';
export const requestScheduleInputTool = defineInternalTool({
  name: 'request_schedule_input', effect: 'manage', requires: ['scheduleInputs'],
  parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }),
  description: '仅为当前独立定时执行提出澄清；原请求进入 Inbox 并等待用户回应，期间不继续推进。回应不扩大目录、工具、凭据或外发权限。停止、额度耗尽或重启会使原等待失效，不创建 Task。',
  async execute(params, context) {
    const result = await context.services.scheduleInputs.ask(context.sessionId, context.commandId, params.question, context.signal);
    return { content: `用户对原问题的回应（不扩大权限）：${result.answer}`, result: { summary: '已读取定时执行的用户回应', refs: [] } };
  },
});
