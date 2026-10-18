import type { McpCredentialVault, McpPrivateCredentials } from '../../modules/mcp/credentials.js';
import { McpError } from '../../modules/mcp/mcp.js';
import { createPiCredentialStore } from './pi-guarded-credential-store.js';

/** 复用 Pi 原生锁和凭据存储，使用独立实例路径；不交给模型认证解析器。 */
export async function createMcpCredentialVault(path: string, instanceId: string): Promise<McpCredentialVault> {
  const store = await createPiCredentialStore(path);
  const key = (ref: string) => {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(ref)) throw new McpError('invalid-config', 'MCP 凭据引用无效。');
    return `mcp:${instanceId}:${ref}`;
  };
  const decode = (credential: Awaited<ReturnType<typeof store.read>>): McpPrivateCredentials | null => {
    if (!credential) return null;
    if (credential.type !== 'api_key' || !credential.key) throw new McpError('credential-unavailable', 'MCP 私有凭据格式不可用。');
    try {
      const value = JSON.parse(credential.key) as McpPrivateCredentials;
      if (!value || value.instanceId !== instanceId || typeof value.accountId !== 'string' || typeof value.serviceId !== 'string'
        || !Number.isSafeInteger(value.accountRevision) || !['pending', 'exchanging', 'ready', 'refreshing', 'revoked', 'unknown'].includes(value.state)) throw new Error();
      return value;
    } catch { throw new McpError('credential-unavailable', 'MCP 私有凭据不可用。'); }
  };
  return {
    instanceId,
    async read(ref) {
      try { return decode(await store.read(key(ref))); }
      catch { throw new McpError('credential-unavailable', 'MCP 私有凭据读取失败。'); }
    },
    async modify(ref, operation) {
      try { await store.modify(key(ref), async credential => {
        const value = await operation(decode(credential));
        if (value === undefined) return undefined;
        if (value.instanceId !== instanceId) throw new McpError('identity-changed', 'MCP 凭据实例不匹配。');
        return { type: 'api_key', key: JSON.stringify(value) };
      }); } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError('credential-unavailable', 'MCP 私有凭据保存失败。');
      }
    },
  };
}
