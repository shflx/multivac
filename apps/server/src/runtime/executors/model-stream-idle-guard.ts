/**
 * 模型流式响应的空闲超时。
 *
 * pi-ai 的 openai-responses 等协议没有流式空闲超时，SDK 的 timeout 只覆盖到响应头到达；
 * 中转或代理在响应头之后挂起时，请求会一直等待，任务长时间无进展。
 * 这里在响应正文连续 idleMs 未收到任何字节时主动中断连接，并以包含 "timeout" 的错误结束读取，
 * 交由 Pi 既有的可重试错误判定与自动重试恢复；本模块不重试、不改写请求。
 */

/** 真实流量中正常请求的正文最大间隔约 20 秒；三分钟留足推理静默余量，又能及时止损。 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

type ResponseBody = NonNullable<Response['body']>;
type BodyChunk = ResponseBody extends ReadableStream<infer Chunk> ? Chunk : never;

export class ModelStreamIdleTimeoutError extends Error {
  constructor(idleMs: number) {
    // 英文关键词供 Pi 的可重试错误判定匹配（timeout），不能移除。
    super(`模型流式响应 ${Math.round(idleMs / 1000)} 秒未收到数据，已中断连接（stream idle timeout）。`);
    this.name = 'ModelStreamIdleTimeoutError';
  }
}

/** 包装模型请求的 fetch：只替换 SDK 读取的 body，json()/text() 等其他成员仍由原响应提供。 */
export function idleGuardedFetch(original: typeof fetch, idleMs = MODEL_STREAM_IDLE_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const response = await original(input, init);
    const source = response.body;
    if (!source) return response;

    let guarded: ResponseBody | undefined;
    return new Proxy(response, { get(target, property) {
      if (property === 'body') return guarded ??= guardBody(source, idleMs);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
}

/**
 * 按需拉取原始正文：只在下游等待数据时计时，下游消费慢（背压）不计入空闲。
 * highWaterMark 为 0，不预读、不改变 SDK 的背压语义。
 */
function guardBody(source: ResponseBody, idleMs: number): ResponseBody {
  let reader: ReadableStreamDefaultReader<BodyChunk> | undefined;
  let cancelled = false;
  const cancel = async (reason: unknown) => {
    cancelled = true;
    try { await (reader ? reader.cancel(reason) : source.cancel(reason)); }
    finally { reader?.releaseLock(); }
  };

  return new ReadableStream<BodyChunk>({
    async pull(controller) {
      // 首次读取时才锁定原始流，仅访问 body 判空不影响其他读取方式。
      reader ??= source.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ModelStreamIdleTimeoutError(idleMs)), idleMs);
      });

      try {
        const chunk = await Promise.race([reader.read(), idle]);
        if (cancelled) return;
        if (chunk.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (cancelled) return;
        // 保留原始读取错误；取消完成后释放 reader，不将取消请求冒充资源已释放。
        try { await cancel(error); } catch { /* 取消异常不覆盖原始读取错误。 */ }
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel,
  }, { highWaterMark: 0 });
}
