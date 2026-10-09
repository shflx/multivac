import { Type } from 'typebox';
import { createBashToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BashInput, IsolatedBashExecution } from '../../application/bash-process-service.js';
import type { ManagedProcess } from '@multivac/contracts';
import type { NativeTaskTools } from './native-task-tools.js';

export interface BashExecutionPort {
  execute(sessionId: string, directory: string, toolCallId: string, input: BashInput, signal: AbortSignal | undefined,
    onData: (data: Buffer) => void, isolated?: IsolatedBashExecution): Promise<{ process: ManagedProcess; exitCode: number | null }>;
}
const Parameters = Type.Object({
  command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483,
    description: '秒。foreground 限制命令运行时间；background 仅限制等待进程启动的时间，启动后不因该参数自动结束。任务仍受自身执行时限和额度限制。' })),
  mode: Type.Optional(Type.Union([Type.Literal('foreground'), Type.Literal('background')])),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, { additionalProperties: false });

/** 复用 SDK 的前台输出、截断与错误呈现，后台由同一执行端口登记并返回稳定身份。 */
export function managedBashTool(sessionId: string, directory: string, processes: BashExecutionPort, native?: NativeTaskTools): ToolDefinition<typeof Parameters> {
  const isolated: IsolatedBashExecution | undefined = native ? (command, options) => native.execute('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    signal: options.signal, timeoutMs: Math.min(options.timeoutMs ?? 60000, 60000), onData: options.onData, onSpawn: options.onSpawn, fenced: true,
  }) : undefined;
  return {
    name: 'bash', label: 'bash', description: '在当前会话工作目录执行 bash，所有执行均登记。mode 默认 foreground，等待命令结果；持续服务使用 background，返回 processId，可查询日志和停止。后台直接填写持续运行的命令，由管理器保持运行。timeout 为秒，可选：前台限制运行时间，后台只限制启动等待；任务自身时限和额度仍有效。',
    promptSnippet: '执行并管理 bash 命令，支持前台与后台模式。',
    promptGuidelines: ['普通命令默认前台。用户要求启动并保持服务时选择 mode=background；使用返回的 processId 查询日志和停止。切换会话和一轮回答结束不停止后台进程。',
      'background 的 timeout 只限制启动等待，不限制服务寿命。返回 processId 只证明进程启动；确认服务可用时还须核对实际访问和进程状态。'],
    parameters: Parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.mode === 'background') {
        const result = await processes.execute(sessionId, directory, toolCallId, params, signal, () => {}, isolated);
        if (result.process.state === 'failed') throw new Error(result.process.reason);
        return { content: [{ type: 'text', text: JSON.stringify(result.process) }], details: undefined };
      }
      const foreground = createBashToolDefinition(directory, { exposeSessionEnvironment: false, operations: {
        exec: async (_command, _cwd, options) => {
          const result = await processes.execute(sessionId, directory, toolCallId, params, options.signal, options.onData, isolated);
          if (result.process.state === 'failed' && result.exitCode === null) throw new Error(result.process.reason);
          return { exitCode: result.exitCode };
        },
      } });
      return foreground.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
