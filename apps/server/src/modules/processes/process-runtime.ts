import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * 任务执行隔离：目录只有在经过验证的文件、网络与凭据隔离可用时才能执行任务工具或托管进程。
 * 隔离能力未验证时抛错，调用方拒绝启动；cwd、worktree 或提示词不能替代隔离。
 */
export interface TaskIsolation {
  /** 核对目录可用隔离执行；protectedPaths 为执行不得触及的内部目录。 */
  verify(directory: string, protectedPaths?: readonly string[]): Promise<void>;
  /** 托管进程使用的隔离配置；port 为允许监听的本地端口。 */
  managedProfile(directory: string, protectedPaths: readonly string[], port: number | null): Promise<string>;
}

/**
 * 进程监护：每个后台进程由独立的监护进程按进程组托管，经标准输入输出的私有协议汇报 pid 与真实退出。
 * 监护进程不继承服务环境变量与模型密钥。
 */
export interface ProcessSupervisor {
  /** 任务托管进程（受隔离配置约束的 node 脚本）。 */
  managed(): ChildProcessWithoutNullStreams;
  /** 工作会话后台 bash 进程组。 */
  bash(): ChildProcessWithoutNullStreams;
}

/** 兼容既有服务构造参数，统一装配入口使用单数接口。 */
export type ProcessSupervisors = ProcessSupervisor;
