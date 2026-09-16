import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import { ModelAccessError } from '../../modules/model-settings/model-access.js';

type Store = NonNullable<CreateModelRuntimeOptions['credentials']>;
type Options = Parameters<Store['read']>[1];
interface LockResult<T> { result: T; next?: string }
interface Backend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>, options?: Options): Promise<T>;
}
interface PiStorageModule {
  FileAuthStorageBackend: new (path: string) => Backend;
  AuthStorage: { create(path: string): Store; fromStorage(backend: Backend): Store };
}
async function loadPiStorage(): Promise<PiStorageModule> {
  return await import(new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href) as PiStorageModule;
}
export async function createPiCredentialStore(path: string): Promise<Store> { return (await loadPiStorage()).AuthStorage.create(path); }

/** Pi 0.85.1 未从根入口导出 AuthStorage；仅适配其原生存储接口，不解析/生成凭据 JSON。 */
export async function createGuardedPiCredentialStore(path: string, version: string,
  readVersion: () => Promise<string>): Promise<Store> {
  const sdk = await loadPiStorage();
  const file = new sdk.FileAuthStorageBackend(path);
  const reader = sdk.AuthStorage.create(path);
  async function transaction<T>(provider: string, operation: (store: Store) => Promise<T>, options?: Options): Promise<T> {
    return file.withLockAsync(async (original) => {
      let current = original;
      let next: string | undefined;
      function apply<T>(result: LockResult<T>): T {
        if (result.next !== undefined) { current = result.next; next = result.next; }
        return result.result;
      }
      // 锁已经由 Pi 文件 backend 持有；内层只转交 SDK 的不透明序列化结果，不能再获取同一锁。
      const locked: Backend = {
        withLock: (fn) => apply(fn(current)),
        withLockAsync: async (fn) => apply(await fn(current)),
      };
      const store = sdk.AuthStorage.fromStorage(locked);
      await store.modify(provider, async (credential) => {
        if (credential?.type === 'oauth' || await readVersion() !== version) throw new ModelAccessError('ACCESS_CONFLICT');
        options?.signal?.throwIfAborted();
        return undefined;
      }, options);
      const result = await operation(store);
      return next === undefined ? { result } : { result, next };
    }, options);
  }
  return {
    read: (provider, options) => reader.read(provider, options),
    list: (options) => reader.list(options),
    modify: (provider, fn, options) => transaction(provider, (store) => store.modify(provider, fn, options), options),
    delete: (provider, options) => transaction(provider, (store) => store.delete(provider, options), options),
  };
}

export function isPiCredentialConflict(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth += 1) {
    if (error instanceof ModelAccessError && error.code === 'ACCESS_CONFLICT') return true;
    error = error.cause;
  }
  return false;
}
