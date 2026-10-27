import type { ManagedProcess } from '@multivac/contracts';

export interface BashInput {
  command: string;
  cwd?: string;
  mode?: 'foreground' | 'background';
  timeout?: number;
  name?: string;
}

/** 任务委托原有受限执行器；普通工作会话使用独立进程组。 */
export type IsolatedBashExecution = (command: string, options: {
  signal: AbortSignal;
  timeoutMs?: number;
  onData: (data: Buffer) => void;
  onSpawn: (pid: number) => void;
}) => Promise<{ code: number | null; output: Buffer }>;

/** 执行器提交工具调用，服务端绑定可信身份并核对本次目录。 */
export interface BashExecutionPort {
  execute(sessionId: string, directory: string, toolCallId: string, input: BashInput, signal: AbortSignal | undefined,
    onData: (data: Buffer) => void, isolated?: IsolatedBashExecution): Promise<{ process: ManagedProcess; exitCode: number | null }>;
}
