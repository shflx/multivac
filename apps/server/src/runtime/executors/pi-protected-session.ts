import { SessionManager, parseSessionEntries } from '@earendil-works/pi-coding-agent';
import type { ProtectedTranscriptStore } from '../../modules/notes/protected-transcript.js';

/** Pi 使用原生内存会话；每次追加直接写入受保护仓储，不生成明文临时文件。 */
export function protectedPiSession(store: ProtectedTranscriptStore, sessionId: string, path: string, cwd: string, existing: boolean): SessionManager {
  const manager = SessionManager.inMemory(cwd, undefined, existing ? parseSessionEntries(store.read(path)) : undefined);
  const serialize = () => [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  if (!existing) store.create(sessionId, path, serialize());
  manager.getSessionFile = () => path;
  manager._persist = () => { store.write(path, serialize()); };
  // 笔记讨论的会话身份由宿主固定；禁止 SDK 绕过仓储另建文件。
  manager.setSessionFile = () => { throw new Error('受保护讨论不能切换会话文件。'); };
  manager.newSession = () => { throw new Error('请使用笔记讨论入口创建新讨论。'); };
  manager.createBranchedSession = () => { throw new Error('请使用笔记讨论入口创建分层讨论。'); };
  return manager;
}
