import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { isObject, type ModelUsageRecorder } from '../../modules/usage/model-usage.js';

/** 统计每次 SDK 调用，不另读 HTTP 流，不启用模型请求，诊断开关不影响采集。 */
export function usageModelRuntime(runtime: ModelRuntime, sessionId: string, runtimeSessionId: string, recorder?: ModelUsageRecorder): ModelRuntime {
  if (!recorder) return runtime;
  return new Proxy(runtime, { get(target, property) {
    const member = Reflect.get(target, property, target) as unknown;
    if (!['stream', 'streamSimple', 'complete', 'completeSimple'].includes(String(property)) || typeof member !== 'function') {
      return typeof member === 'function' ? member.bind(target) : member;
    }
    return (...args: unknown[]) => {
      let finish: ReturnType<ModelUsageRecorder['begin']> = () => {};
      try { finish = recorder.begin(sessionId, runtimeSessionId, args[0]); }
      catch { console.warn('模型用量采集初始化失败，当前调用没有完整统计。'); }
      try {
        const result = Reflect.apply(member, target, args);
        if (property === 'complete' || property === 'completeSimple') {
          return Promise.resolve(result).then(message => { finish(message); return message; }, error => { finish(undefined, error); throw error; });
        }
        // 同一 finish 幂等；result() 观察终态而不消费另一份流。
        void result.result().then((message: unknown) => finish(message), (error: unknown) => finish(undefined, error));
        return new Proxy(result, { get(stream, key) {
          if (key === Symbol.asyncIterator) return async function* () {
            for await (const event of stream) {
              // 标准流的 done.message/error.error 均为 AssistantMessage，只更新账本，不改写响应。
              if (isObject(event) && event.type === 'done') finish(event.message);
              if (isObject(event) && event.type === 'error') finish(event.error);
              yield event;
            }
          };
          const value = Reflect.get(stream, key, stream) as unknown;
          return typeof value === 'function' ? value.bind(stream) : value;
        } });
      } catch (error) { finish(undefined, error); throw error; }
    };
  } });
}
