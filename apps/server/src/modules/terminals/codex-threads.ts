/**
 * Codex 会话端口：由 Multivac 管理的 Codex app-server 创建会话，并提供终端连接地址。
 *
 * 终端里的 Codex 以 `codex resume <会话 ID> --remote <地址>` 接入同一个 app-server，
 * 会话 ID 在终端启动前由 Multivac 取得，不从画面、目录或时间推断。
 */
export interface CodexThreads {
  /** 确保 app-server 可用，返回终端 `--remote` 使用的地址；服务退出后再次调用会重新启动。 */
  endpoint(): Promise<string>;
  /** 在 app-server 中创建持久会话并命名；命名会让会话立即写入磁盘，未发消息也能按 ID 打开。 */
  createThread(cwd: string, name: string): Promise<string>;
  /** 停止 Multivac 启动的 app-server。 */
  close(): Promise<void>;
}
