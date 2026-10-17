/**
 * 测试用的占位能力：满足内部工具注册时的必需能力核对，但本用例不应调用它。
 * 一旦被调用即抛错，避免用空实现掩盖意外的工具执行。
 */
export function unusedCapability<T>(name: string): T {
  return new Proxy({}, {
    get: (_target, property) => {
      // 不伪装成 thenable 或其他协议对象。
      if (property === 'then' || typeof property === 'symbol') return undefined;
      return () => { throw new Error(`测试未接入能力 ${name}.${property}。`); };
    },
  }) as T;
}
