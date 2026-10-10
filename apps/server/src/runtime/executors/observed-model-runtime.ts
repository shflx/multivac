import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { diagnosticError, type ExecutionDiagnostics, type ModelRequestObservation, type DiagnosticModel } from '../../application/execution-diagnostics.js';

/** 只记录白名单响应标识；不记录 URL 路径、查询参数、请求头或任意响应头。 */
function responseIds(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['x-request-id', 'request-id', 'openai-request-id', 'x-amzn-requestid', 'cf-ray']) {
    const value = headers.get(name);
    if (value && /^[A-Za-z0-9._:-]{1,200}$/.test(value) && !/^(sk-|Bearer)/i.test(value)) result[name] = value;
  }
  return result;
}

export function observedFetch(original: typeof fetch, observation: ModelRequestObservation): typeof fetch {
  return async (input, init) => {
    let host = 'unknown';
    try { host = new URL(input instanceof Request ? input.url : String(input)).host; } catch { /* 不记录原始无效 URL。 */ }
    const attempt = observation.fetchStarted(host);
    let response: Response;
    try { response = await original(input, init); }
    catch (error) { observation.record('model.http.failed', { attempt, ...diagnosticError(error) }); throw error; }
    observation.headers(attempt, response.status, responseIds(response.headers));
    const observeRead = async (read: () => Promise<ReadableStreamReadResult<Uint8Array>>) => {
      try {
        const chunk = await read();
        if (chunk.done) observation.record('model.http.body_ended', { attempt });
        else observation.body(chunk.value.byteLength);
        return chunk;
      } catch (error) { observation.record('model.http.body_failed', { attempt, ...diagnosticError(error) }); throw error; }
    };
    // 只代理 SDK 实际使用的 reader/iterator，不创建第二条流、不提前读取或改变背压。
    let observedBody: typeof response.body = null;
    return new Proxy(response, { get(target, property) {
      if (property === 'body' && target.body) return observedBody ??= new Proxy(target.body, { get(body, key) {
        if (key === 'getReader') return (...args: Parameters<ReadableStream<Uint8Array>['getReader']>) => {
          const reader = body.getReader(...args);
          return new Proxy(reader, { get(current, member) {
            if (member === 'read') return (...params: unknown[]) => observeRead(() => Reflect.apply(current.read, current, params));
            if (member === 'cancel') return (reason: unknown) => { observation.record('model.http.body_cancelled', { attempt }); return current.cancel(reason); };
            const value = Reflect.get(current, member, current) as unknown;
            return typeof value === 'function' ? value.bind(current) : value;
          } });
        };
        if (key === Symbol.asyncIterator || key === 'values') return (...args: Parameters<ReadableStream<Uint8Array>['values']>) => {
          const iterator = body.values(...args);
          return { next: () => observeRead(() => iterator.next()),
            return: async (reason?: unknown) => { observation.record('model.http.body_cancelled', { attempt }); return Reflect.apply(iterator.return!, iterator, [reason]); },
            [Symbol.asyncIterator]() { return this; } };
        };
        const value = Reflect.get(body, key, body) as unknown;
        return typeof value === 'function' ? value.bind(body) : value;
      } });
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
}

/** 代理仍从 getter 取得当前运行时；选模 activate/rollback 不改变观测身份或 SDK 调用语义。 */
export function observedModelRuntime(current: () => ModelRuntime, sessionId: string, diagnostics?: ExecutionDiagnostics): ModelRuntime {
  return new Proxy(current(), { get(_target, property) {
    const runtime = current();
    const value = Reflect.get(runtime, property, runtime) as unknown;
    if (diagnostics && ['stream', 'streamSimple', 'complete', 'completeSimple'].includes(String(property)) && typeof value === 'function') {
      return (model: DiagnosticModel, context: unknown, options: Record<string, unknown> = {}) => {
        if (!diagnostics.enabled) return value.call(runtime, model, context, options);
        // 仅向已验证支持 fetch 注入的协议添加传输观测；其他协议仍记录 SDK 阶段，避免改变能力。
        const httpObserved = ['openai-responses', 'openai-completions', 'anthropic-messages'].includes(model.api ?? '');
        const observation = diagnostics.beginRequest(sessionId, model, httpObserved);
        if (!observation) return value.call(runtime, model, context, options);
        const payload = options.onPayload as ((...args: unknown[]) => unknown) | undefined;
        const originalFetch = options.fetch as typeof fetch | undefined;
        const observedOptions = { ...options,
          onPayload: async (...args: unknown[]) => { const result = await payload?.(...args); observation.payloadReady(); return result; },
          ...(httpObserved ? { fetch: observedFetch(originalFetch ?? globalThis.fetch, observation) } : {}),
        };
        try {
          const result = value.call(runtime, model, context, observedOptions);
          if (property === 'complete' || property === 'completeSimple') {
            return Promise.resolve(result).then(message => { observation.finish(message); return message; }, error => { observation.finish(undefined, error); throw error; });
          }
          // result() 不消费第二份流；等待已开始的迭代结束，避免终态先到而漏计队列中的输出。
          let iterating = false;
          let terminal: Parameters<typeof observation.finish> | undefined;
          const settle = (...args: Parameters<typeof observation.finish>) => {
            terminal = args;
            if (!iterating) observation.finish(...args);
          };
          void result.result().then(settle, (error: unknown) => settle(undefined, error));
          return new Proxy(result, { get(target, key) {
            if (key === Symbol.asyncIterator) return async function* () {
              iterating = true;
              try { for await (const event of target) { observation.event(event); yield event; } }
              finally { iterating = false; if (terminal) observation.finish(...terminal); }
            };
            const member = Reflect.get(target, key, target) as unknown;
            return typeof member === 'function' ? member.bind(target) : member;
          } });
        } catch (error) { observation.finish(undefined, error); throw error; }
      };
    }
    return typeof value === 'function' ? value.bind(runtime) : value;
  } });
}
