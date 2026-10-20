/** 状态补读只影响前端查询，不取消任务或进程执行。 */
export const STATUS_QUERY_TIMEOUT_MS = 10_000;

/** 覆盖响应头及正文读取；即使读取未响应 abort，也按时释放缓存的 loading。 */
export async function readStatus<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMessage: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), STATUS_QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([stopped, controller.signal.aborted ? stopped : read(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}
