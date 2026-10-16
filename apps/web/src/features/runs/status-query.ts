/** 状态补读只影响前端查询，不取消任务或进程执行。 */
export const STATUS_QUERY_TIMEOUT_MS = 10_000;

/** 覆盖响应头及正文读取；即使读取未响应 abort，也按时释放缓存的 loading。 */
export async function readStatus<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMessage: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(timeoutMessage);
      reject(error);
      controller.abort(error);
    }, STATUS_QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
