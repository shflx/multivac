import type { TerminalPreset, TerminalSize } from '@multivac/contracts';

/** 项目终端的进程端口；具体 PTY 与后代停止核对由运行时实现，bootstrap 负责装配。 */
export interface TerminalProcess {
  readonly pty: {
    readonly pid: number;
    pause(): void;
    resume(): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
  };
  readonly result: { exitCode: number; signal?: number } | undefined;
  onOutput: (data: Buffer) => void;
  onExit: (exit: { exitCode: number; signal?: number }) => void;
  stop(): Promise<boolean>;
  dispose(): void;
}

export type TerminalProcessFactory = (directory: string, preset: TerminalPreset, size: TerminalSize) => TerminalProcess;
